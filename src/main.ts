import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "./contracts.js";
import { GoalsWorkflow } from "./goals.js";
import { decodeEvent, PumbleClient, type Credentials } from "./pumble.js";
import { listen } from "./socket.js";
import { TaskWorkflow } from "./tasks.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before starting the bots`);
  return value;
}

function credentials(name: "IT" | "GOALS"): Credentials {
  return {
    appId: required(`PUMBLE_${name}_APP_ID`),
    appKey: required(`PUMBLE_${name}_APP_KEY`),
    botToken: required(`PUMBLE_${name}_BOT_TOKEN`),
  };
}

function logFailure(operation: string, error: unknown): void {
  console.error(`${operation}. ${error instanceof Error ? error.message : "Unknown error"}`);
}

async function main(): Promise<void> {
  const workspaceId = required("PUMBLE_WORKSPACE_ID");
  const timeZone = process.env.TIME_ZONE ?? "Australia/Melbourne";
  new Intl.DateTimeFormat("en-AU", { timeZone });
  const hour = Number(process.env.GOALS_HOUR ?? 9);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new Error("GOALS_HOUR must be between 0 and 23");

  const taskChannels = new Set(
    required("TASK_CHANNEL_IDS")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (!taskChannels.size) throw new Error("TASK_CHANNEL_IDS needs a channel ID");
  const goalsChannel = required("GOALS_CHANNEL_ID");
  const taskBot = new PumbleClient(credentials("IT"), workspaceId);
  const goalsBot = new PumbleClient(credentials("GOALS"), workspaceId);
  const [taskBotId, goalsBotId] = await Promise.all([taskBot.botId(), goalsBot.botId()]);
  if (taskBotId === goalsBotId) throw new Error("The two Pumble apps need separate bot tokens");

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
    CREATE TABLE IF NOT EXISTS task_history (
      channel_id TEXT PRIMARY KEY,
      scan_from INTEGER NOT NULL
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
  const startHistory = db.prepare("INSERT OR IGNORE INTO task_history VALUES (?, ?)");
  const scanFrom = db.prepare("SELECT scan_from FROM task_history WHERE channel_id = ?");
  const advanceHistory = db.prepare("UPDATE task_history SET scan_from = ? WHERE channel_id = ?");
  for (const id of taskChannels) startHistory.run(id, Date.now());

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
          const from = scanFrom.get(channel)?.scan_from;
          if (typeof from !== "number") return;
          try {
            for (const message of await taskBot.taskMessagesSince(channel, from, taskBotId)) {
              if (message.authorId !== taskBotId && message.authorId !== goalsBotId) {
                insert.run("it", message.id, message.sentAt, JSON.stringify(message));
              }
            }
            advanceHistory.run(Math.max(from, now - 60_000), channel);
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
