import type { DatabaseSync } from "node:sqlite";

export type DigestState = <T>(
  run: (db: DatabaseSync, checkpoint: () => Promise<void>) => Promise<T>,
) => Promise<T>;

export async function deliverDigest({
  channelId,
  end,
  withState,
  findPost,
  prepare,
  post,
}: {
  channelId: string;
  end: number;
  withState: DigestState;
  findPost: () => Promise<boolean>;
  prepare: () => Promise<string>;
  post: (text: string) => Promise<void>;
}): Promise<boolean> {
  function markDelivered(db: DatabaseSync): void {
    db.prepare("UPDATE digest_runs SET delivered = 1 WHERE channel_id = ? AND end_at = ?")
      .run(channelId, end);
  }

  async function delivered(db: DatabaseSync): Promise<boolean> {
    const run = db.prepare("SELECT delivered FROM digest_runs WHERE channel_id = ? AND end_at = ?")
      .get(channelId, end);
    if (!run) return false;
    if (run.delivered === 1) return true;
    if (!(await findPost())) return false;
    markDelivered(db);
    return true;
  }

  const alreadyDelivered = await withState(async (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS digest_runs (
        channel_id TEXT NOT NULL,
        end_at INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, end_at)
      )
    `);
    return delivered(db);
  });
  if (alreadyDelivered) return false;

  // History and OpenAI calls can take several minutes. Hold the state lease only for delivery.
  const text = await prepare();
  return withState(async (db, checkpoint) => {
    if (await delivered(db)) return false;
    db.prepare("INSERT OR IGNORE INTO digest_runs (channel_id, end_at) VALUES (?, ?)")
      .run(channelId, end);
    // Keep the delivery attempt if Pumble accepts the message but the job loses the response.
    await checkpoint();
    await post(text);
    markDelivered(db);
    return true;
  });
}
