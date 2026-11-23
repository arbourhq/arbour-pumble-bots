import { createServer, type ServerResponse } from "node:http";
import { withCloudState } from "./cloud-state.js";
import { configureBots } from "./config.js";
import { GoalsWorkflow } from "./goals.js";
import { TaskHistory } from "./task-history.js";
import { TaskWorkflow } from "./tasks.js";

function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`${message}\n`);
}

async function tick(bucketName: string): Promise<boolean> {
  // Cloud Run can return a timeout before stopping the handler. Bound Pumble calls inside the lease.
  const deadline = AbortSignal.timeout(40_000);
  const boundedFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
    });

  const bots = await configureBots(false, boundedFetch);
  return withCloudState(async (db, checkpoint) => {
    const tasks = new TaskWorkflow(db, bots.taskBotId, bots.taskChannels, bots.timeZone);
    const goals = new GoalsWorkflow(db, bots.goalsChannel, bots.timeZone, bots.hour);
    const history = new TaskHistory(db, bots.taskChannels);
    const scanTime = Date.now();

    const scans = await Promise.allSettled(
      [...bots.taskChannels].map((id) =>
        history.scan(
          bots.taskBot,
          id,
          bots.taskBotId,
          (message) => {
            if (message.authorId !== bots.goalsBotId) tasks.receive(message);
          },
          scanTime,
        ),
      ),
    );
    const replies = await Promise.allSettled([tasks.reconcileOpenReplies(bots.taskBot)]);
    await checkpoint();

    const now = Date.now();
    const sends = await Promise.allSettled([
      tasks.tick(bots.taskBot, now),
      goals.tick(bots.goalsBot, now),
    ]);
    const errors = [...scans, ...replies, ...sends].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "One or more Pumble checks failed");
  }, bucketName);
}

function report(error: unknown): void {
  console.error(error instanceof Error ? error.message : "Pumble checks failed");
  if (error instanceof AggregateError) {
    for (const reason of error.errors as unknown[]) report(reason);
  }
}

const port = Number(process.env.PORT ?? 8080);
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    reply(response, 200, "ok");
    return;
  }

  if (request.method !== "POST" || request.url !== "/tick") {
    reply(response, 404, "not found");
    return;
  }

  const bucket = process.env.PUMBLE_STATE_BUCKET;
  if (!bucket) {
    reply(response, 503, "Pumble state storage has not been configured");
    return;
  }

  void tick(bucket).then(
    (ran) => reply(response, 200, ran ? "ok" : "busy"),
    (error: unknown) => {
      report(error);
      reply(response, 503, "Pumble checks failed");
    },
  );
});

server.listen(port, "0.0.0.0", () => console.log("Arbour Pumble Cloud Run service ready"));
process.once("SIGTERM", () => server.close());
