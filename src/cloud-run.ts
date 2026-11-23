import { withCloudState } from "./cloud-state.js";
import { configureBots } from "./config.js";
import { GoalsWorkflow } from "./goals.js";
import { TaskHistory } from "./task-history.js";
import { TaskWorkflow } from "./tasks.js";

async function tick(bucketName: string): Promise<boolean> {
  // Leave time to persist the SQLite checkpoint before the Cloud Run task times out.
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

async function main(): Promise<void> {
  const bucket = process.env.PUMBLE_STATE_BUCKET;
  if (!bucket) throw new Error("Set PUMBLE_STATE_BUCKET before starting the bots");
  const ran = await tick(bucket);
  console.log(ran ? "Pumble check complete" : "Another Pumble check is in progress");
}

void main().catch((error: unknown) => {
  report(error);
  process.exitCode = 1;
});
