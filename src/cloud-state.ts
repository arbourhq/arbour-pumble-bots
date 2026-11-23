import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GoogleAuth } from "google-auth-library";

const leasePath = "arbour-pumble-bots/tick-lease.json";
const statePath = "arbour-pumble-bots/state.sqlite";
const leaseDuration = 90_000;
const requestTimeout = 5_000;
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/devstorage.read_write"] });

type StoredObject = { contents: Buffer; generation: string };
type CloudObjects = {
  read(path: string): Promise<StoredObject | null>;
  write(path: string, contents: Buffer, match: string, timeout?: number): Promise<string>;
  remove(path: string, match: string): Promise<void>;
};
type Lease = { owner: string; expiresAt: number; generation: string };

function status(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("response" in error)) return;
  const response = error.response;
  if (
    response &&
    typeof response === "object" &&
    "status" in response &&
    typeof response.status === "number"
  ) {
    return response.status;
  }
}

function generation(data: unknown): string {
  if (data && typeof data === "object" && "generation" in data) {
    if (typeof data.generation === "string" && /^[1-9]\d*$/.test(data.generation))
      return data.generation;
    if (
      typeof data.generation === "number" &&
      Number.isSafeInteger(data.generation) &&
      data.generation > 0
    ) {
      return String(data.generation);
    }
  }
  throw new Error("Cloud Storage did not return an object generation");
}

function cloudObjects(bucketName: string): CloudObjects {
  const bucket = encodeURIComponent(bucketName);
  const objectUrl = (path: string) =>
    new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(path)}`);

  return {
    async read(path) {
      // The generation precondition ties the data read to its metadata read.
      for (let attempt = 0; attempt < 3; attempt++) {
        const url = objectUrl(path);
        try {
          const metadata = await auth.request<unknown>({
            url,
            timeout: requestTimeout,
            retry: false,
          });
          const version = generation(metadata.data);
          url.searchParams.set("alt", "media");
          url.searchParams.set("ifGenerationMatch", version);
          const result = await auth.request<ArrayBuffer>({
            url,
            responseType: "arraybuffer",
            timeout: requestTimeout,
            retry: false,
          });
          return { contents: Buffer.from(result.data), generation: version };
        } catch (error) {
          if (status(error) === 404) return null;
          if (status(error) !== 412 || attempt === 2) throw error;
        }
      }
      throw new Error("Cloud Storage object changed during the read");
    },

    async write(path, contents, match, timeout = requestTimeout) {
      const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o`);
      url.searchParams.set("uploadType", "media");
      url.searchParams.set("name", path);
      url.searchParams.set("ifGenerationMatch", match);
      const result = await auth.request<unknown>({
        url,
        method: "POST",
        data: contents,
        headers: { "Content-Type": "application/octet-stream" },
        timeout,
        retry: false,
      });
      return generation(result.data);
    },

    async remove(path, match) {
      const url = objectUrl(path);
      url.searchParams.set("ifGenerationMatch", match);
      await auth.request({ url, method: "DELETE", timeout: requestTimeout, retry: false });
    },
  };
}

function leaseDetails(contents: Buffer): Omit<Lease, "generation"> {
  const value: unknown = JSON.parse(contents.toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("owner" in value) ||
    typeof value.owner !== "string" ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  ) {
    throw new Error("Cloud Storage contains an invalid Pumble lease");
  }
  return { owner: value.owner, expiresAt: value.expiresAt };
}

async function acquire(objects: CloudObjects): Promise<Lease | null> {
  const existing = await objects.read(leasePath);
  if (existing && leaseDetails(existing.contents).expiresAt > Date.now()) return null;

  const lease = { owner: randomUUID(), expiresAt: Date.now() + leaseDuration };
  try {
    const version = await objects.write(
      leasePath,
      Buffer.from(JSON.stringify(lease)),
      existing?.generation ?? "0",
    );
    return { ...lease, generation: version };
  } catch (error) {
    if (status(error) === 412) return null;
    // A write may have committed before the request failed. Confirm ownership before proceeding.
    const current = await objects.read(leasePath).catch(() => null);
    if (current && leaseDetails(current.contents).owner === lease.owner)
      return { ...lease, generation: current.generation };
    throw error;
  }
}

export async function withCloudState(
  run: (db: DatabaseSync, checkpoint: () => Promise<void>) => Promise<void>,
  bucketName: string,
  objects: CloudObjects = cloudObjects(bucketName),
): Promise<boolean> {
  const lease = await acquire(objects);
  if (!lease) return false;
  const { expiresAt, generation: leaseGeneration } = lease;

  let directory: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "arbour-pumble-bots-"));
    const path = join(directory, "state.sqlite");
    let previous = await objects.read(statePath);
    if (previous) await writeFile(path, previous.contents, { mode: 0o600 });
    db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;");

    let saving = Promise.resolve();
    function checkpoint(): Promise<void> {
      const save = saving.then(async () => {
        const timeLeft = expiresAt - Date.now();
        if (timeLeft <= 0) throw new Error("The Pumble state lease expired");
        const contents = readFileSync(path);
        if (previous?.contents.equals(contents)) return;
        try {
          const version = await objects.write(
            statePath,
            contents,
            previous?.generation ?? "0",
            Math.min(requestTimeout, timeLeft),
          );
          previous = { contents, generation: version };
        } catch (error) {
          const current = await objects.read(statePath).catch(() => null);
          if (!current?.contents.equals(contents)) throw error;
          previous = current;
        }
      });
      saving = save.catch(() => {});
      return save;
    }

    try {
      await run(db, checkpoint);
    } catch (error) {
      await checkpoint().catch(() =>
        console.error("Could not checkpoint Pumble state after a failed tick"),
      );
      throw error;
    }
    await checkpoint();
    return true;
  } finally {
    await objects.remove(leasePath, leaseGeneration).catch((error: unknown) => {
      if (status(error) !== 404 && status(error) !== 412)
        console.error("Could not release the Pumble state lease");
    });
    try {
      db?.close();
    } finally {
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => {
          console.error("Could not remove the temporary Pumble state file");
        });
      }
    }
  }
}
