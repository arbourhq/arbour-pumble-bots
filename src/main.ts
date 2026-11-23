import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureBots } from "./config.js";
import type { Message } from "./contracts.js";
import { GoalsWorkflow } from "./goals.js";
import { decodeEvent } from "./pumble.js";
import { listen } from "./socket.js";
import { TaskHistory } from "./task-history.js";
import { TaskWorkflow } from "./tasks.js";

function logFailure(operation: string, error: unknown): void {
  console.error(`${operation}. ${error instanceof Error ? error.message : "Unknown error"}`);
}

async function main(): Promise<void> {
  const {
    workspaceId,
    timeZone,
    hour,
    taskChannels,
    goalsChannel,
    taskBot,
    goalsBot,
    taskBotId,
    goalsBotId,
  } = await configureBots(true);

  await Promise.all([
    ...[...taskChannels].map((id) => taskBot.verifyChannel(id)),
    goalsBot.verifyChannel(goalsChannel),
  ]);

  const dbPath = process.env.DB_PATH ?? "data/bots.sqlite";
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  process.umask(0o077);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS inbox (
      bot TEXT NOT NULL,
      id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (bot, id)
    );
  `);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO inbox(bot, id, sent_at, payload) VALUES (?, ?, ?, ?)",
  );
  const pending = db.prepare("SELECT bot, id, payload FROM inbox ORDER BY sent_at, id LIMIT 1000");
  const pendingTask = db.prepare("SELECT 1 FROM inbox WHERE bot = 'it' AND id = ?");
  const remove = db.prepare("DELETE FROM inbox WHERE bot = ? AND id = ?");
  const tasks = new TaskWorkflow(db, taskBotId, taskChannels, timeZone);
  const goals = new GoalsWorkflow(db, goalsChannel, timeZone, hour);
  const history = new TaskHistory(db, taskChannels);

  const receive = (bot: "it" | "goals", payload: unknown): void => {
    const message = decodeEvent(payload, workspaceId);
    if (!message || message.authorId === taskBotId || message.authorId === goalsBotId) return;
    if (bot === "it") {
      if (!taskChannels.has(message.channelId)) return;
      if (message.threadId) {
        if (
          !tasks.tracks(message.channelId, message.threadId) &&
          !pendingTask.get(message.threadId)
        )
          return;
      } else if (!message.mentionIds.includes(taskBotId)) return;
    } else {
      if (message.channelId !== goalsChannel || !message.threadId) return;
      message.text = "";
      message.mentionIds = [];
    }
    insert.run(bot, message.id, message.sentAt, JSON.stringify(message));
  };

  const controller = new AbortController();
  listen(taskBot, "@it", (event) => receive("it", event), controller.signal);
  listen(goalsBot, "Weekly Goals", (event) => receive("goals", event), controller.signal);

  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();
  let nextHistoryScan = 0;

  async function tick(): Promise<void> {
    const now = Date.now();
    if (now >= nextHistoryScan) {
      nextHistoryScan = now + 60_000;
      await Promise.all(
        [...taskChannels].map(async (channel) => {
          try {
            await history.scan(
              taskBot,
              channel,
              taskBotId,
              (message) => {
                if (message.authorId !== taskBotId && message.authorId !== goalsBotId) {
                  insert.run("it", message.id, message.sentAt, JSON.stringify(message));
                }
              },
              now,
            );
          } catch (error) {
            logFailure("Could not check channel history for missed tasks", error);
          }
        }),
      );
    }

    for (const row of pending.all()) {
      if (
        typeof row.payload !== "string" ||
        typeof row.id !== "string" ||
        typeof row.bot !== "string"
      )
        continue;
      try {
        const message = JSON.parse(row.payload) as Message;
        if (row.bot === "it") tasks.receive(message);
        if (row.bot === "goals") goals.receive(message);
        remove.run(row.bot, row.id);
      } catch (error) {
        logFailure("Could not process a Pumble message", error);
      }
    }

    const tickTime = Date.now();
    const results = await Promise.allSettled([
      tasks.tick(taskBot, tickTime),
      goals.tick(goalsBot, tickTime),
    ]);
    results.forEach((result, index) => {
      if (result.status === "rejected")
        logFailure(index === 0 ? "Task check failed" : "Goals check failed", result.reason);
    });
  }

  function schedule(): void {
    current = tick()
      .catch((error: unknown) => logFailure("Pumble checks failed", error))
      .finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(schedule, 15_000);
      });
  }

  function stop(): void {
    if (controller.signal.aborted) return;
    controller.abort();
    clearTimeout(timer);
    void current.finally(() => db.close());
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("Arbour Pumble bots started");
  schedule();
}

void main().catch((error: unknown) => {
  logFailure("Arbour Pumble bots could not start", error);
  process.exitCode = 1;
});
