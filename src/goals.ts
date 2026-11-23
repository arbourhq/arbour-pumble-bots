import type { DatabaseSync } from "node:sqlite";

import { mention, type Message, type Pumble } from "./contracts.js";

const SIX_HOURS = 6 * 60 * 60 * 1000;

type Phase = "monday" | "friday";

type PendingGoal = {
  localDate: string;
  phase: Phase;
  memberId: string;
  threadId: string | null;
};

export class GoalsWorkflow {
  private readonly db: DatabaseSync;
  private readonly channelId: string;
  private readonly hour: number;
  private readonly localTime: Intl.DateTimeFormat;

  constructor(db: DatabaseSync, channelId: string, timeZone: string, hour: number) {
    this.db = db;
    this.channelId = channelId;
    this.hour = hour;
    this.localTime = new Intl.DateTimeFormat("en-AU", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    });

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_runs (
        channel_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('monday', 'friday')),
        PRIMARY KEY (channel_id, local_date)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS pending_goals (
        channel_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        member_id TEXT NOT NULL,
        thread_id TEXT,
        next_reminder_at INTEGER,
        PRIMARY KEY (channel_id, local_date, member_id),
        FOREIGN KEY (channel_id, local_date) REFERENCES goal_runs (channel_id, local_date)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS pending_goals_thread
        ON pending_goals (channel_id, thread_id, member_id);
    `);
  }

  receive(message: Message): void {
    if (message.channelId !== this.channelId || !message.threadId) return;
    this.db
      .prepare(`
      DELETE FROM pending_goals WHERE channel_id = ? AND thread_id = ? AND member_id = ?
    `)
      .run(this.channelId, message.threadId, message.authorId);
  }

  async tick(pumble: Pumble, now: number): Promise<void> {
    const run = this.newRun(now);
    let due = this.pendingAt(now);
    if (!run && due.length === 0) return;

    const members = new Set(await pumble.members(this.channelId));
    if (run) {
      this.startRun(run.localDate, run.phase, members);
      due = this.pendingAt(now);
    }

    const attemptedFridayRuns = new Set<string>();
    const repliesByThread = new Map<string, Promise<Set<string>>>();
    const errors: unknown[] = [];
    for (const request of due) {
      if (!members.has(request.memberId)) {
        this.db
          .prepare(`
          DELETE FROM pending_goals WHERE channel_id = ? AND local_date = ? AND member_id = ?
        `)
          .run(this.channelId, request.localDate, request.memberId);
        continue;
      }

      try {
        if (request.threadId) {
          let replies = repliesByThread.get(request.threadId);
          if (!replies) {
            replies = this.respondents(pumble, request.threadId);
            repliesByThread.set(request.threadId, replies);
          }
          if (!(await replies).has(request.memberId)) {
            await this.sendReminder(pumble, request, request.threadId, now);
          }
        } else if (request.phase === "monday") {
          await this.sendMondayPrompt(pumble, request, now);
        } else if (!attemptedFridayRuns.has(request.localDate)) {
          attemptedFridayRuns.add(request.localDate);
          await this.sendFridayPrompt(pumble, request.localDate, now);
        }
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length)
      throw new AggregateError(errors, "Weekly goals messages could not be processed");
  }

  private newRun(now: number): { localDate: string; phase: Phase } | undefined {
    const parts = Object.fromEntries(
      this.localTime.formatToParts(now).map(({ type, value }) => [type, value]),
    );
    const phase = parts.weekday === "Mon" ? "monday" : parts.weekday === "Fri" ? "friday" : null;
    if (!phase || Number(parts.hour) < this.hour) return;

    const localDate = `${parts.year}-${parts.month}-${parts.day}`;
    const existing = this.db
      .prepare(`
      SELECT 1 FROM goal_runs WHERE channel_id = ? AND local_date = ?
    `)
      .get(this.channelId, localDate);
    if (!existing) return { localDate, phase };
  }

  private startRun(localDate: string, phase: Phase, members: Set<string>): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`
        INSERT INTO goal_runs (channel_id, local_date, phase) VALUES (?, ?, ?)
      `)
        .run(this.channelId, localDate, phase);
      const insert = this.db.prepare(`
        INSERT INTO pending_goals (channel_id, local_date, member_id) VALUES (?, ?, ?)
      `);
      for (const memberId of members) insert.run(this.channelId, localDate, memberId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private pendingAt(now: number): PendingGoal[] {
    return this.db
      .prepare(`
      SELECT
        p.local_date AS localDate,
        r.phase,
        p.member_id AS memberId,
        p.thread_id AS threadId
      FROM pending_goals p
      JOIN goal_runs r USING (channel_id, local_date)
      WHERE p.channel_id = ? AND (p.thread_id IS NULL OR p.next_reminder_at <= ?)
      ORDER BY p.local_date DESC, p.member_id
    `)
      .all(this.channelId, now) as PendingGoal[];
  }

  private async respondents(pumble: Pumble, threadId: string): Promise<Set<string>> {
    const respondents = new Set<string>();
    for (const reply of await pumble.replies(this.channelId, threadId)) {
      if (reply.channelId !== this.channelId || reply.threadId !== threadId) continue;
      this.receive(reply);
      respondents.add(reply.authorId);
    }
    return respondents;
  }

  private async sendMondayPrompt(pumble: Pumble, request: PendingGoal, now: number): Promise<void> {
    const threadId = await pumble.post({
      channelId: this.channelId,
      text: `Hi ${mention(request.memberId)}, what are your goals for this week? Reply in this thread.`,
    });
    this.db
      .prepare(`
      UPDATE pending_goals SET thread_id = ?, next_reminder_at = ?
      WHERE channel_id = ? AND local_date = ? AND member_id = ?
    `)
      .run(threadId, now + SIX_HOURS, this.channelId, request.localDate, request.memberId);
  }

  private async sendFridayPrompt(pumble: Pumble, localDate: string, now: number): Promise<void> {
    const threadId = await pumble.post({
      channelId: this.channelId,
      text: "How did you go with your goals this week? Reply in this thread with an update.",
    });
    this.db
      .prepare(`
      UPDATE pending_goals SET thread_id = ?, next_reminder_at = ?
      WHERE channel_id = ? AND local_date = ?
    `)
      .run(threadId, now + SIX_HOURS, this.channelId, localDate);
  }

  private async sendReminder(
    pumble: Pumble,
    request: PendingGoal,
    threadId: string,
    now: number,
  ): Promise<void> {
    const question =
      request.phase === "monday"
        ? "could you share your goals for the week in this thread?"
        : "could you post an update on your goals in this thread?";
    await pumble.post({
      channelId: this.channelId,
      threadId,
      text: `Hi ${mention(request.memberId)}, ${question}`,
    });
    this.db
      .prepare(`
      UPDATE pending_goals SET next_reminder_at = ?
      WHERE channel_id = ? AND local_date = ? AND member_id = ?
    `)
      .run(now + SIX_HOURS, this.channelId, request.localDate, request.memberId);
  }
}
