import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { weeklyDigestWindow } from "./deadline.js";
import { deliverDigest, type DigestState } from "./digest.js";

test("uses completed Friday 5 pm Melbourne cutoffs across daylight saving", () => {
  const timeZone = "Australia/Melbourne";
  const cutoff = Date.parse("2026-10-09T06:00:00Z");

  assert.deepEqual(weeklyDigestWindow(cutoff, timeZone), {
    start: Date.parse("2026-10-02T07:00:00Z"),
    end: cutoff,
  });
  assert.equal(weeklyDigestWindow(cutoff - 1, timeZone).end, Date.parse("2026-10-02T07:00:00Z"));
  assert.equal(weeklyDigestWindow(cutoff + 86_400_000, timeZone).end, cutoff);
});

test("reconciles a successful Pumble post when its response is lost", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const withState: DigestState = (run) => run(db, async () => {});
  const prepare = t.mock.fn(async () => "A weekly update");
  const post = t.mock.fn(async () => { throw new Error("Response lost"); });
  const findPost = t.mock.fn(async () => true);
  const options = { channelId: "daily-updates", end: 1000, withState, prepare, post, findPost };

  await assert.rejects(deliverDigest(options), /Response lost/);
  assert.equal(await deliverDigest(options), false);
  assert.equal(await deliverDigest(options), false);
  assert.equal(findPost.mock.callCount(), 1);
  assert.equal(prepare.mock.callCount(), 1);
  assert.equal(post.mock.callCount(), 1);
});

test("concurrent digests check the delivery state before posting", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let lease = Promise.resolve();
  const withState: DigestState = (run) => {
    const result = lease.then(() => run(db, async () => {}));
    lease = result.then(() => {}, () => {});
    return result;
  };
  const post = t.mock.fn(async () => {});
  const options = {
    channelId: "daily-updates",
    end: 1000,
    withState,
    prepare: async () => "A weekly update",
    post,
    findPost: async () => false,
  };

  assert.deepEqual((await Promise.all([deliverDigest(options), deliverDigest(options)])).sort(), [false, true]);
  assert.equal(post.mock.callCount(), 1);
});
