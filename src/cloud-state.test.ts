import assert from "node:assert/strict";
import { test } from "node:test";
import { withCloudState } from "./cloud-state.js";

const bucket = "test-bucket";
const leasePath = "arbour-pumble-bots/tick-lease.json";
const statePath = "arbour-pumble-bots/state.sqlite";

function preconditionFailed(): Error {
  return Object.assign(new Error("Conditional write failed"), { response: { status: 412 } });
}

function fakeStorage() {
  const files = new Map<string, { contents: Buffer; generation: string }>();
  const writes: { path: string; match: string }[] = [];
  const removals: { path: string; match: string }[] = [];
  let sequence = 9_007_199_254_740_992n;

  const storage: NonNullable<Parameters<typeof withCloudState>[2]> = {
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, contents, match) {
      if ((files.get(path)?.generation ?? "0") !== match) throw preconditionFailed();
      const generation = String(++sequence);
      files.set(path, { contents: Buffer.from(contents), generation });
      writes.push({ path, match });
      return generation;
    },
    async remove(path, match) {
      if (files.get(path)?.generation !== match) throw preconditionFailed();
      files.delete(path);
      removals.push({ path, match });
    },
  };

  return { files, writes, removals, storage };
}

test("restores SQLite state and uses generation-matching checkpoints and release", async () => {
  const { storage, files, writes, removals } = fakeStorage();

  await withCloudState(
    async (db, checkpoint) => {
      db.exec("CREATE TABLE runs (value TEXT); INSERT INTO runs VALUES ('first');");
      await checkpoint();
    },
    bucket,
    storage,
  );

  assert.deepEqual(
    writes.filter(({ path }) => path === statePath),
    [{ path: statePath, match: "0" }],
  );
  assert.deepEqual(removals[0], { path: leasePath, match: "9007199254740993" });
  assert.equal(files.has(leasePath), false);
  const stateGeneration = files.get(statePath)?.generation;

  await withCloudState(
    async (db) => {
      assert.equal(db.prepare("SELECT value FROM runs").get()?.value, "first");
      db.exec("UPDATE runs SET value = 'second';");
    },
    bucket,
    storage,
  );
  assert.deepEqual(writes.at(-1), { path: statePath, match: stateGeneration });
});

test("one invocation wins a create-only lease when two start together", async () => {
  const { storage } = fakeStorage();
  let executed = 0;
  const run = async () => {
    executed += 1;
  };

  const results = await Promise.all([
    withCloudState(run, bucket, storage),
    withCloudState(run, bucket, storage),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(executed, 1);
});

test("claims an expired lease using its exact generation", async () => {
  const { storage, files, writes } = fakeStorage();
  const expired = "9007199254741017";
  files.set(leasePath, {
    contents: Buffer.from('{"owner":"old","expiresAt":0}'),
    generation: expired,
  });

  assert.equal(await withCloudState(async () => {}, bucket, storage), true);
  assert.deepEqual(writes[0], { path: leasePath, match: expired });
  assert.equal(files.has(leasePath), false);
});

test("checkpoints committed work on callback failure and rethrows the original error", async () => {
  const { storage, files } = fakeStorage();
  const failure = new Error("Pumble call failed");

  await assert.rejects(
    withCloudState(
      async (db) => {
        db.exec("CREATE TABLE runs (value TEXT); INSERT INTO runs VALUES ('saved');");
        throw failure;
      },
      bucket,
      storage,
    ),
    (error) => error === failure,
  );
  assert.equal(files.has(leasePath), false);

  await withCloudState(
    async (db) => {
      assert.equal(db.prepare("SELECT value FROM runs").get()?.value, "saved");
    },
    bucket,
    storage,
  );
});
