import { setTimeout as delay } from "node:timers/promises";
import { withCloudState } from "./cloud-state.js";
import { required } from "./config.js";
import { weeklyDigestWindow } from "./deadline.js";
import { collectDigestHistory } from "./digest-history.js";
import { generateDigest } from "./digest-summary.js";
import { deliverDigest, type DigestState } from "./digest.js";
import { PumbleClient } from "./pumble.js";

function dmReaders(): { userId: string; token: string }[] {
  const settings = required("PUMBLE_DIGEST_DM_READERS");
  const invalid = new Error("PUMBLE_DIGEST_DM_READERS needs a JSON array of distinct userId and token pairs");
  let entries: unknown;
  try {
    entries = JSON.parse(settings);
  } catch {
    throw invalid;
  }
  if (!Array.isArray(entries)) throw invalid;
  const ids = new Set<string>();
  return entries.map((entry: unknown) => {
    if (
      !entry || typeof entry !== "object" ||
      !("userId" in entry) || typeof entry.userId !== "string" || !entry.userId.trim() ||
      !("token" in entry) || typeof entry.token !== "string" || !entry.token.trim()
    ) {
      throw invalid;
    }
    const userId = entry.userId.trim();
    if (ids.has(userId)) throw invalid;
    ids.add(userId);
    return { userId, token: entry.token.trim() };
  });
}

async function main(): Promise<void> {
  const bucket = required("PUMBLE_STATE_BUCKET");
  const channelId = required("GOALS_CHANNEL_ID");
  const workspaceId = required("PUMBLE_WORKSPACE_ID");
  const timeZone = process.env.TIME_ZONE ?? "Australia/Melbourne";
  const { start, end } = weeklyDigestWindow(Date.now(), timeZone);
  const date = new Intl.DateTimeFormat("en-AU", { timeZone, dateStyle: "medium" });
  const period = `${date.format(start)} to ${date.format(end)}`;
  const header = `Weekly update | ${period}`;

  // Leave time to release the lease and checkpoint before the 15-minute job timeout.
  const deadline = AbortSignal.timeout(14 * 60_000);
  const boundedFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
    });
  const bot = new PumbleClient(
    { appKey: required("PUMBLE_DIGEST_APP_KEY"), botToken: required("PUMBLE_DIGEST_BOT_TOKEN") },
    workspaceId,
    boundedFetch,
  );
  const botId = await bot.botId();

  const withState: DigestState = async (run) => {
    let result!: Awaited<ReturnType<typeof run>>;
    const runAndSave = async (...args: Parameters<typeof run>) => {
      result = await run(...args);
    };
    while (!(await withCloudState(runAndSave, bucket, undefined, "digest"))) {
      await delay(2_000, undefined, { signal: deadline });
    }
    return result;
  };

  const posted = await deliverDigest({
    channelId,
    end,
    withState,
    findPost: () => bot.hasDigestPost(channelId, botId, header, end),
    prepare: async () => {
      const key = required("OPENAI_API_KEY");
      await bot.verifyChannel(channelId);
      const readers = await Promise.all(dmReaders().map(async ({ userId, token }) => {
        const reader = bot.asUser(token);
        if (userId === botId || (await reader.botId()) !== userId)
          throw new Error("A Pumble digest token does not match its configured user");
        return reader;
      }));
      const messages = await collectDigestHistory(bot, readers, start, end);
      const sources = messages.filter(({ authorId }) => authorId !== botId);
      const body = await generateDigest(key, sources, period, boundedFetch);
      return `${header}\n\n${body}`;
    },
    post: async (text) => {
      await bot.post({ channelId, text });
    },
  });
  console.log(posted ? "Weekly Pumble digest posted" : "Weekly Pumble digest already posted");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Weekly Pumble digest failed");
  process.exitCode = 1;
});
