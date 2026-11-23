import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mention, type Message, type Post, type Pumble } from "./contracts.js";
import { day, parseDeadline, taskDeadline } from "./deadline.js";
import { TaskWorkflow } from "./tasks.js";

const hour = 3_600_000;
const mondayMorning = Date.parse("2026-11-23T00:00:00Z");
const timeZone = "Australia/Melbourne";
const channels = new Set(["team"]);
const task: Message = {
  id: "task",
  channelId: "team",
  authorId: "creator",
  sentAt: mondayMorning,
  text: `${mention("it")} ${mention("sam")}, ${mention("jo")} Update the report.`,
  mentionIds: ["it", "sam", "jo"],
};

function reply(id: string, authorId: string, text: string, sentAt: number): Message {
  return { ...task, id, authorId, text, sentAt, threadId: task.id, mentionIds: [] };
}

function fakePumble() {
  const posts: Post[] = [];
  const replies: Message[] = [];
  const service: Pumble = {
    async post(post) {
      posts.push(post);
      return `bot-message-${posts.length}`;
    },
    async members() {
      return ["creator", "sam", "jo"];
    },
    async replies() {
      return replies;
    },
  };
  return { posts, replies, service };
}

test("task reminders default to 24 hours and continue daily in the original thread", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "pumble-tasks-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const file = join(directory, "tasks.sqlite");
  const db = new DatabaseSync(file);
  const bot = new TaskWorkflow(db, "it", channels, timeZone);
  const { posts, service } = fakePumble();

  bot.receive(task);
  bot.receive(task);
  await bot.tick(service, mondayMorning);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.threadId, task.id);
  assert.match(posts[0]?.text ?? "", /Tue, 24 Nov 2026/);

  // Saved reminders survive re-opening the workflow and aren't repeated at the same tick.
  db.close();
  const reopened = new DatabaseSync(file);
  const restartedBot = new TaskWorkflow(reopened, "it", channels, timeZone);
  await restartedBot.tick(service, mondayMorning + day - 1);
  assert.equal(posts.length, 1);
  await restartedBot.tick(service, mondayMorning + day);
  await restartedBot.tick(service, mondayMorning + day);
  assert.equal(posts.length, 2);
  assert.equal(posts[1]?.threadId, task.id);
  assert.ok(posts[1]?.text.startsWith(`${mention("sam")} ${mention("jo")} `));
  await restartedBot.tick(service, mondayMorning + 2 * day);
  assert.equal(posts.length, 3);
  reopened.close();
});

test("only the creator and assignees can extend or complete the task", async () => {
  const db = new DatabaseSync(":memory:");
  const bot = new TaskWorkflow(db, "it", channels, timeZone);
  const { posts, service } = fakePumble();

  bot.receive({ ...task, text: `${task.text.slice(0, -1)} by tomorrow at 3pm.` });
  bot.receive(reply("foreign-done", "stranger", "DONE", mondayMorning + 10));
  bot.receive(reply("creator-extend", "creator", "+2h", mondayMorning + 20));
  bot.receive(reply("creator-extend", "creator", "+2h", mondayMorning + 20));
  bot.receive(reply("assignee-extend", "sam", "Friday at 5pm", mondayMorning + 30));
  await bot.tick(service, mondayMorning + day);
  assert.equal(posts.length, 3);
  assert.match(posts[0]?.text ?? "", /Tue, 24 Nov 2026, 3:00 pm/);
  assert.match(posts[1]?.text ?? "", /Tue, 24 Nov 2026, 5:00 pm/);
  assert.match(posts[2]?.text ?? "", /Fri, 27 Nov 2026, 5:00 pm/);

  bot.receive(reply("assignee-done", "jo", " DONE ", mondayMorning + 40));
  await bot.tick(service, mondayMorning + 5 * day);
  assert.equal(posts.length, 4);
  assert.equal(posts[3]?.text, "Marked as done.");
  db.close();
});

test("checks the thread for a missed completion before sending an overdue reminder", async () => {
  const db = new DatabaseSync(":memory:");
  const bot = new TaskWorkflow(db, "it", channels, timeZone);
  const { posts, replies, service } = fakePumble();

  bot.receive(task);
  replies.push(reply("assignee-done", "sam", "DONE", mondayMorning + hour));
  await bot.tick(service, mondayMorning + day);
  assert.equal(posts.length, 2);
  assert.equal(posts[1]?.text, "Marked as done.");
  await bot.tick(service, mondayMorning + 2 * day);
  assert.equal(posts.length, 2);
  db.close();
});

test("polling applies extensions and completions before their deadline", async () => {
  const db = new DatabaseSync(":memory:");
  const bot = new TaskWorkflow(db, "it", channels, timeZone);
  const { posts, service } = fakePumble();
  const checked: string[] = [];
  const pumble: Pumble = {
    ...service,
    async replies(_channel, thread) {
      checked.push(thread);
      return thread === task.id
        ? [reply("extend", "sam", "+2h", mondayMorning + 100)]
        : [{ ...reply("complete", "jo", "DONE", mondayMorning + 100), threadId: "other-task" }];
    },
  };

  bot.receive(task);
  bot.receive({ ...task, id: "other-task" });
  await bot.reconcileOpenReplies(pumble);
  await bot.tick(pumble, mondayMorning + 200);
  assert.deepEqual(new Set(checked), new Set([task.id, "other-task"]));
  assert.equal(bot.tracks(task.channelId, "other-task"), false);
  assert.equal(posts.filter(post => post.text.startsWith("Deadline extended")).length, 1);
  assert.equal(posts.filter(post => post.text === "Marked as done.").length, 1);

  checked.length = 0;
  await bot.reconcileOpenReplies(pumble);
  await bot.tick(pumble, mondayMorning + day);
  assert.deepEqual(checked, [task.id]);
  assert.equal(posts.length, 4);
  await bot.tick(pumble, mondayMorning + day + 2 * hour);
  assert.equal(posts.length, 5);
  db.close();
});

test("one failed thread poll does not prevent reconciling other tasks", async () => {
  const db = new DatabaseSync(":memory:");
  const bot = new TaskWorkflow(db, "it", channels, timeZone);
  const { service } = fakePumble();
  const pumble: Pumble = {
    ...service,
    async replies(_channel, thread) {
      if (thread === task.id) throw new Error("Thread temporarily unavailable");
      return [{ ...reply("complete", "sam", "DONE", mondayMorning + 200), threadId: "other-task" }];
    },
  };

  bot.receive(task);
  bot.receive({ ...task, id: "other-task", sentAt: mondayMorning + 100 });
  await assert.rejects(bot.reconcileOpenReplies(pumble), AggregateError);
  assert.equal(bot.tracks(task.channelId, task.id), true);
  assert.equal(bot.tracks(task.channelId, "other-task"), false);
  db.close();
});

test("requires an actual assignee mention and an allowed channel", async () => {
  const db = new DatabaseSync(":memory:");
  const bot = new TaskWorkflow(db, "it", channels, timeZone);
  const { posts, service } = fakePumble();

  bot.receive({ ...task, channelId: "other" });
  bot.receive({ ...task, id: "plain-text", mentionIds: [] });
  bot.receive({ ...task, id: "spoofed-assignees", mentionIds: ["it"] });
  await bot.tick(service, mondayMorning);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.threadId, "spoofed-assignees");
  await bot.tick(service, mondayMorning + day);
  assert.equal(posts.length, 1);
  db.close();
});

test("a failed acknowledgement retries without reapplying the command", async () => {
  const db = new DatabaseSync(":memory:");
  const bot = new TaskWorkflow(db, "it", channels, timeZone);
  const { posts, service } = fakePumble();
  const unavailable: Pumble = {
    ...service,
    async post() {
      throw new Error("unavailable");
    },
  };

  bot.receive(task);
  await assert.rejects(bot.tick(unavailable, mondayMorning));
  bot.receive(task);
  await bot.tick(service, mondayMorning + 1);
  assert.equal(posts.length, 0);
  await bot.tick(service, mondayMorning + 60_000);
  assert.equal(posts.length, 1);
  db.close();
});

test("interprets local deadlines, relative times and the daylight-saving transition", () => {
  assert.equal(
    parseDeadline("3pm Friday", mondayMorning, timeZone),
    Date.parse("2026-11-27T04:00:00Z"),
  );
  assert.equal(
    parseDeadline("tomorrow at 17:00", mondayMorning, timeZone),
    Date.parse("2026-11-24T06:00:00Z"),
  );
  assert.equal(
    parseDeadline("27/11/2026 at 5 pm", mondayMorning, timeZone),
    Date.parse("2026-11-27T06:00:00Z"),
  );
  assert.equal(
    parseDeadline("2 hours", mondayMorning, timeZone, mondayMorning + day),
    mondayMorning + day + 2 * hour,
  );
  assert.equal(parseDeadline("2026-10-04 at 02:30", Date.parse("2026-10-03"), timeZone), undefined);
  assert.equal(parseDeadline("2026-02-31 at 12:00", Date.parse("2026-02-01"), timeZone), undefined);
  assert.equal(
    taskDeadline("Check the project by month", mondayMorning, timeZone),
    mondayMorning + day,
  );
  assert.equal(
    taskDeadline("Update the due date field", mondayMorning, timeZone),
    mondayMorning + day,
  );
  assert.equal(
    taskDeadline("Send the report in 30 minutes.", mondayMorning, timeZone),
    mondayMorning + hour / 2,
  );
});
