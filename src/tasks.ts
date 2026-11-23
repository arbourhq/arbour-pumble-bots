import type { DatabaseSync } from "node:sqlite";
import { mention, type Message, type Pumble } from "./contracts.js";
import { day, displayDeadline, parseDeadline, taskDeadline } from "./deadline.js";

type Task = {
  channel_id: string;
  message_id: string;
  creator_id: string;
  assignees: string;
  created_at: number;
  changed_at: number;
  due_at: number;
  remind_at: number | null;
};

type Acknowledgement = { channel_id: string; event_id: string; thread_id: string; text: string };

const taskExample =
  "Tag @it and the assignees first, then describe the task. For example, @it @Sam Send the report by tomorrow at 3pm.";
const deadlineHelp = "Use a deadline such as `tomorrow at 3pm`, `Friday at 17:00` or `in 2 hours`.";
const nextSteps =
  "Reply `DONE` when it’s complete, or reply with a new deadline such as `tomorrow at 3pm` or `+2h`.";

export class TaskWorkflow {
  constructor(
    private readonly db: DatabaseSync,
    private readonly botId: string,
    private readonly channels: ReadonlySet<string>,
    private readonly timeZone: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS it_tasks (
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        assignees TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        changed_at INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        remind_at INTEGER,
        PRIMARY KEY (channel_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS it_tasks_remind_at ON it_tasks(remind_at) WHERE remind_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS it_acknowledgements (
        channel_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        text TEXT,
        retry_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS it_acknowledgements_pending ON it_acknowledgements(retry_at) WHERE text IS NOT NULL;
    `);
  }

  receive(message: Message): void {
    if (!this.channels.has(message.channelId) || message.authorId === this.botId) return;
    if (message.threadId) {
      this.handleReply(message, message.threadId);
    } else if (message.mentionIds.includes(this.botId)) {
      this.createTask(message);
    }
  }

  tracks(channelId: string, threadId: string): boolean {
    const task = this.findTask(channelId, threadId);
    return task !== undefined && task.remind_at !== null;
  }

  private findTask(channelId: string, messageId: string): Task | undefined {
    return this.db
      .prepare("SELECT * FROM it_tasks WHERE channel_id = ? AND message_id = ?")
      .get(channelId, messageId) as Task | undefined;
  }

  private acknowledge(message: Message, text: string, change?: () => void): void {
    this.db.exec("SAVEPOINT it_message");
    try {
      const result = this.db
        .prepare(`
        INSERT INTO it_acknowledgements (channel_id, event_id, thread_id, text)
        VALUES (?, ?, ?, ?) ON CONFLICT (channel_id, event_id) DO NOTHING
      `)
        .run(message.channelId, message.id, message.threadId ?? message.id, text);
      if (result.changes) change?.();
      this.db.exec("RELEASE it_message");
    } catch (error) {
      this.db.exec("ROLLBACK TO it_message; RELEASE it_message");
      throw error;
    }
  }

  private createTask(message: Message): void {
    const text = message.text.trim();
    const botMention = mention(this.botId);
    if (!text.startsWith(botMention)) return;

    const remainder = text.slice(botMention.length).replace(/^[\s,:]+/, "");
    const leadingMentions = /^<<@[\w-]+>>(?:[\s,]*<<@[\w-]+>>)*/.exec(remainder)?.[0] ?? "";
    const description = remainder.slice(leadingMentions.length).replace(/^[\s,:–—-]+/, "");
    const assignees = new Set<string>();
    for (const [, id] of leadingMentions.matchAll(/<<@([\w-]+)>>/g)) {
      if (id && id !== this.botId && message.mentionIds.includes(id)) assignees.add(id);
    }
    if (!assignees.size || !description) {
      this.acknowledge(message, taskExample);
      return;
    }

    const dueAt = taskDeadline(description, message.sentAt, this.timeZone);
    if (dueAt === undefined) {
      this.acknowledge(
        message,
        `I couldn’t read that deadline. ${deadlineHelp} Send the task again with the updated deadline.`,
      );
      return;
    }

    this.acknowledge(
      message,
      `Task due ${displayDeadline(dueAt, this.timeZone)}. ${nextSteps}`,
      () => {
        this.db
          .prepare(`
        INSERT INTO it_tasks (channel_id, message_id, creator_id, assignees, created_at, changed_at, due_at, remind_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
          .run(
            message.channelId,
            message.id,
            message.authorId,
            [...assignees].join(","),
            message.sentAt,
            message.sentAt,
            dueAt,
            dueAt,
          );
      },
    );
  }

  private handleReply(message: Message, threadId: string): void {
    const task = this.findTask(message.channelId, threadId);
    if (!task || task.remind_at === null || message.sentAt < task.created_at) return;
    if (
      message.authorId !== task.creator_id &&
      !task.assignees.split(",").includes(message.authorId)
    )
      return;

    const reply = message.text.trim();
    if (/^done$/i.test(reply)) {
      this.acknowledge(message, "Marked as done.", () => {
        this.db
          .prepare("UPDATE it_tasks SET remind_at = NULL WHERE channel_id = ? AND message_id = ?")
          .run(message.channelId, threadId);
      });
      return;
    }

    if (message.sentAt < task.changed_at) return;
    const input = reply.replace(/^(?:extend\s+to|by|due)\s+/i, "");
    const changedAt = Math.max(task.due_at, message.sentAt);
    const dueAt = parseDeadline(input, message.sentAt, this.timeZone, changedAt);
    if (dueAt === undefined) {
      if (/^extend\b/i.test(reply)) this.acknowledge(message, deadlineHelp);
      return;
    }
    if (dueAt <= changedAt) {
      this.acknowledge(
        message,
        `Choose a time after ${displayDeadline(changedAt, this.timeZone)} to extend this task.`,
      );
      return;
    }

    this.acknowledge(
      message,
      `Deadline extended to ${displayDeadline(dueAt, this.timeZone)}.`,
      () => {
        this.db
          .prepare(
            "UPDATE it_tasks SET due_at = ?, remind_at = ?, changed_at = ? WHERE channel_id = ? AND message_id = ?",
          )
          .run(dueAt, dueAt, message.sentAt, message.channelId, threadId);
      },
    );
  }

  private async reconcileReplies(pumble: Pumble, task: Task): Promise<void> {
    const replies = await pumble.replies(task.channel_id, task.message_id);
    for (const reply of [...replies].sort((a, b) => a.sentAt - b.sentAt)) this.receive(reply);
  }

  async reconcileOpenReplies(pumble: Pumble): Promise<void> {
    const open = this.db
      .prepare("SELECT * FROM it_tasks WHERE remind_at IS NOT NULL ORDER BY remind_at")
      .all() as Task[];
    const errors: unknown[] = [];
    for (const task of open) {
      if (!this.channels.has(task.channel_id)) continue;
      try {
        await this.reconcileReplies(pumble, task);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Pumble task replies could not be checked");
  }

  async tick(pumble: Pumble, now: number): Promise<void> {
    const errors: unknown[] = [];
    const due = this.db
      .prepare("SELECT * FROM it_tasks WHERE remind_at <= ? ORDER BY remind_at")
      .all(now) as Task[];
    const toRemind: Task[] = [];
    for (const task of due) {
      if (!this.channels.has(task.channel_id)) continue;
      try {
        await this.reconcileReplies(pumble, task);
        const current = this.findTask(task.channel_id, task.message_id);
        if (current && current.remind_at !== null && current.remind_at <= now)
          toRemind.push(current);
      } catch (error) {
        errors.push(error);
      }
    }

    const acknowledgements = this.db
      .prepare(`
      SELECT channel_id, event_id, thread_id, text FROM it_acknowledgements
      WHERE text IS NOT NULL AND retry_at <= ? ORDER BY rowid
    `)
      .all(now) as Acknowledgement[];
    for (const ack of acknowledgements) {
      if (!this.channels.has(ack.channel_id)) continue;
      try {
        await pumble.post({ channelId: ack.channel_id, threadId: ack.thread_id, text: ack.text });
        this.db
          .prepare(
            "UPDATE it_acknowledgements SET text = NULL WHERE channel_id = ? AND event_id = ?",
          )
          .run(ack.channel_id, ack.event_id);
      } catch (error) {
        this.db
          .prepare(
            "UPDATE it_acknowledgements SET retry_at = ? WHERE channel_id = ? AND event_id = ?",
          )
          .run(now + 60_000, ack.channel_id, ack.event_id);
        errors.push(error);
      }
    }

    for (const task of toRemind) {
      try {
        await pumble.post({
          channelId: task.channel_id,
          threadId: task.message_id,
          text: `${task.assignees.split(",").map(mention).join(" ")} This task was due ${displayDeadline(task.due_at, this.timeZone)}. ${nextSteps}`,
        });
        this.db
          .prepare("UPDATE it_tasks SET remind_at = ? WHERE channel_id = ? AND message_id = ?")
          .run(now + day, task.channel_id, task.message_id);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length)
      throw new AggregateError(errors, "Pumble task messages could not be delivered or checked");
  }
}
