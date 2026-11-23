import type { DatabaseSync } from "node:sqlite";
import type { Message } from "./contracts.js";
import type { PumbleClient } from "./pumble.js";

const overlap = 60_000;

export class TaskHistory {
  constructor(
    private readonly db: DatabaseSync,
    channels: ReadonlySet<string>,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_history (
        channel_id TEXT PRIMARY KEY,
        scan_from INTEGER NOT NULL
      );
    `);
    const insert = db.prepare("INSERT OR IGNORE INTO task_history VALUES (?, ?)");
    for (const id of channels) insert.run(id, Date.now());
  }

  async scan(
    pumble: PumbleClient,
    channelId: string,
    botId: string,
    receive: (message: Message) => void,
    now: number,
  ): Promise<void> {
    const from = this.db
      .prepare("SELECT scan_from FROM task_history WHERE channel_id = ?")
      .get(channelId)?.scan_from;
    if (typeof from !== "number")
      throw new Error("Task channel history is missing its starting timestamp");

    for (const message of await pumble.taskMessagesSince(channelId, from, botId)) {
      receive(message);
    }
    this.db
      .prepare("UPDATE task_history SET scan_from = ? WHERE channel_id = ?")
      .run(Math.max(from, now - overlap), channelId);
  }
}
