import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { mention, type Message, type Post, type Pumble } from "./contracts.js";
import { GoalsWorkflow } from "./goals.js";

const channelId = "team-channel";
const timeZone = "Australia/Melbourne";
const monday = Date.parse("2026-11-22T22:00:00Z");
const friday = Date.parse("2026-11-26T22:00:00Z");
const sixHours = 6 * 60 * 60 * 1000;

function fakePumble() {
  const posts: Array<Post & { id: string }> = [];
  const replies: Message[] = [];
  const members = new Set(["alex", "sam"]);
  const failedMentions = new Set<string>();

  const client: Pumble = {
    async members() {
      return [...members];
    },
    async post(post) {
      if ([...failedMentions].some((userId) => post.text.includes(mention(userId)))) {
        throw new Error("Pumble rejected the message");
      }
      const id = `post-${posts.length + 1}`;
      posts.push({ ...post, id });
      return id;
    },
    async replies(channel, threadId) {
      return replies.filter((reply) => reply.channelId === channel && reply.threadId === threadId);
    },
  };

  return { client, posts, replies, members, failedMentions };
}

function reply(authorId: string, threadId: string, sentAt: number): Message {
  return {
    id: `reply-${authorId}`,
    channelId,
    threadId,
    authorId,
    text: "My goals are ready.",
    mentionIds: [],
    sentAt,
  };
}

test("Monday sends one prompt per member and repeats only for members who have not replied", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const workflow = new GoalsWorkflow(db, channelId, timeZone, 9);
  const pumble = fakePumble();

  await workflow.tick(pumble.client, monday - 1);
  assert.equal(pumble.posts.length, 0);
  await workflow.tick(pumble.client, monday);
  await workflow.tick(pumble.client, monday + 1);

  assert.equal(pumble.posts.length, 2);
  const alexPrompt = pumble.posts.find((post) => post.text.includes(mention("alex")));
  const samPrompt = pumble.posts.find((post) => post.text.includes(mention("sam")));
  assert.ok(alexPrompt);
  assert.ok(samPrompt);
  workflow.receive(reply("alex", alexPrompt.id, monday + 2));
  workflow.receive(reply("alex", samPrompt.id, monday + 2));

  await workflow.tick(pumble.client, monday + sixHours - 1);
  assert.equal(pumble.posts.length, 2);
  await workflow.tick(pumble.client, monday + sixHours);
  await workflow.tick(pumble.client, monday + 2 * sixHours);

  assert.deepEqual(
    pumble.posts.slice(2).map((post) => post.threadId),
    [samPrompt.id, samPrompt.id],
  );
  assert.ok(pumble.posts.slice(2).every((post) => post.text.includes(mention("sam"))));

  workflow.receive(reply("sam", samPrompt.id, monday + 2 * sixHours + 1));
  await workflow.tick(pumble.client, monday + 3 * sixHours);
  assert.equal(pumble.posts.length, 4);
});

test("Friday sends one channel update prompt and recovers replies after a restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "arbour-pumble-goals-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = join(directory, "goals.sqlite");
  const pumble = fakePumble();

  const startingDb = new DatabaseSync(storage);
  try {
    await new GoalsWorkflow(startingDb, channelId, timeZone, 9).tick(
      pumble.client,
      friday + 60_000,
    );
  } finally {
    startingDb.close();
  }

  assert.equal(pumble.posts.length, 1);
  const fridayPrompt = pumble.posts[0];
  assert.ok(fridayPrompt);
  assert.equal(fridayPrompt.threadId, undefined);
  assert.match(fridayPrompt.text, /update/i);

  pumble.replies.push(reply("sam", fridayPrompt.id, friday + 90_000));
  const resumedDb = new DatabaseSync(storage);
  try {
    const resumed = new GoalsWorkflow(resumedDb, channelId, timeZone, 9);
    await resumed.tick(pumble.client, friday + sixHours + 60_000);

    assert.equal(pumble.posts.length, 2);
    assert.equal(pumble.posts[1]?.threadId, fridayPrompt.id);
    assert.ok(pumble.posts[1]?.text.includes(mention("alex")));

    pumble.members.delete("alex");
    await resumed.tick(pumble.client, friday + 2 * sixHours + 60_000);
    assert.equal(pumble.posts.length, 2);
  } finally {
    resumedDb.close();
  }
});

test("uses the configured local hour and processes new prompts even if one send fails", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const workflow = new GoalsWorkflow(db, channelId, timeZone, 10);
  const pumble = fakePumble();

  const winterMondayAtTen = Date.parse("2026-07-06T00:00:00Z");
  await workflow.tick(pumble.client, winterMondayAtTen - 1);
  assert.equal(pumble.posts.length, 0);

  pumble.failedMentions.add("alex");
  await assert.rejects(workflow.tick(pumble.client, winterMondayAtTen), AggregateError);
  assert.equal(pumble.posts.length, 1);
  assert.ok(pumble.posts[0]?.text.includes(mention("sam")));

  pumble.failedMentions.clear();
  await workflow.tick(pumble.client, winterMondayAtTen + 60_000);
  assert.equal(pumble.posts.length, 2);
  assert.ok(pumble.posts[1]?.text.includes(mention("alex")));
});

test("does not backfill prompts when the first tick is on a later weekday", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const workflow = new GoalsWorkflow(db, channelId, timeZone, 9);
  const pumble = fakePumble();

  await workflow.tick(pumble.client, monday + 24 * 60 * 60 * 1000);
  assert.deepEqual(pumble.posts, []);
  await workflow.tick(pumble.client, friday);
  assert.equal(pumble.posts.length, 1);
});
