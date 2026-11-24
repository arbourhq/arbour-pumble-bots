import assert from "node:assert/strict";
import { test } from "node:test";
import { collectDigestHistory } from "./digest-history.js";
import { PumbleClient } from "./pumble.js";

const workspaceId = "workspace";
const start = 1_000;
const end = 2_000;

function channel(id: string, channelType: string, users: string[] = [], info = {}) {
  return { channel: { id, workspaceId, channelType, name: id, ...info }, users };
}

function row(id: string, channelId: string, timestampMilli: number, fields = {}) {
  return { id, channelId, workspaceId, timestampMilli, author: "alex", text: id, ...fields };
}

test("collects and deduplicates channel and thread activity visible to both digest readers", async () => {
  const sharedDm = channel("shared-dm", "DIRECT", ["alex", "ben", "cat"]);
  const publicChannel = channel("public", "PUBLIC", [], { isMember: false, isArchived: true });
  const threadReply = row("thread-reply", "public", start, { threadReplyInfo: { rootId: "old-thread" } });
  const sharedMessage = row("shared", "shared-dm", 1_800, { author: "ben" });
  const bot = new PumbleClient({ appKey: "app", botToken: "bot" }, workspaceId, async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("token");
    assert.equal(new Headers(init?.headers).get("x-app-token"), "app");
    if (url.pathname === "/v1/workspaceUsers") {
      assert.equal(token, "bot");
      return Response.json([
        { workspaceId, id: "alex", name: "Alex" },
        { workspaceId, id: "ben", name: "Ben" },
      ]);
    }
    if (url.pathname === "/v1/channels") {
      assert.equal(url.searchParams.get("types"), "PUBLIC,PRIVATE,DIRECT");
      if (token === "alex") {
        return Response.json([
          publicChannel,
          channel("private", "PRIVATE", [], { isMember: true }),
          channel("other-private", "PRIVATE", [], { isMember: false }),
          sharedDm,
          channel("other-dm", "DIRECT", ["ben"]),
          channel("self", "SELF", ["alex"]),
        ]);
      }
      assert.equal(token, "ben");
      return Response.json([
        publicChannel,
        channel("ben-private", "PRIVATE", [], { isMember: true }),
        sharedDm,
        channel("group-dm", "DIRECT", ["ben", "cat", "dee"]),
      ]);
    }

    assert.equal(url.pathname, "/v1/messages/search");
    const search: Record<string, unknown> = JSON.parse(String(init?.body));
    assert.equal(search.afterTs, start - 1);
    assert.equal(search.beforeTs, end);
    assert.equal(search.fromMyChannelsOnly, false);
    if (token === "alex") {
      assert.deepEqual(search.in, ["public", "private", "shared-dm"]);
      if (search.skip === 0) {
        return Response.json({
          hasMore: true,
          content: [
            row("next-week", "public", end),
            row("integration", "public", end - 1, { authorAppId: "integration" }),
            row("deleted", "public", 1_500, { deleted: true }),
          ],
        });
      }
      assert.equal(search.skip, 3);
      return Response.json({
        hasMore: false,
        content: [
          row("private-message", "private", 1_750),
          threadReply,
          sharedMessage,
          row("previous-week", "public", start - 1),
          row("unexpected-channel", "other-private", 1_100),
        ],
      });
    }
    assert.equal(token, "ben");
    assert.deepEqual(search.in, ["public", "ben-private", "shared-dm", "group-dm"]);
    return Response.json({
      hasMore: false,
      content: [
        row("file", "group-dm", 1_900, { text: null, files: [{ name: "proposal.pdf" }] }),
        sharedMessage,
        row("ben-private-message", "ben-private", 1_650),
        row("earlier-shared", "shared-dm", 1_600),
        threadReply,
      ],
    });
  });

  const readers = ["alex", "ben"].map((userId) => ({ client: bot.asUser(userId), userId }));
  const messages = await collectDigestHistory(bot, readers, start, end);
  assert.deepEqual(messages.map(({ id, visibility }) => [id, visibility]), [
    ["thread-reply", "channel"],
    ["earlier-shared", "private"],
    ["ben-private-message", "private"],
    ["private-message", "private"],
    ["shared", "private"],
    ["file", "private"],
    ["integration", "channel"],
  ]);
  assert.equal(messages[0].threadId, "old-thread");
  assert.equal(messages[4].author, "Ben");
  assert.equal(messages[4].conversation, "Direct message with Alex, Ben, cat");
  assert.equal(messages[5].text, "[File proposal.pdf]");
});

test("matches an existing digest only when the digest bot posted the exact heading at the top level", async () => {
  const header = "Weekly digest, 20–27 November";
  const bot = new PumbleClient({ appKey: "app", botToken: "bot" }, workspaceId, async () => {
    return Response.json({
      hasMoreBefore: false,
      messages: [
        row("thread", "updates", 1_500, { text: header, author: "digest-bot", threadReplyInfo: {} }),
        row("user", "updates", 1_600, { text: header }),
        row("digest", "updates", 1_700, { text: `${header}\nUpdates`, author: "digest-bot", authorAppId: "app" }),
      ],
    });
  });

  assert.equal(await bot.hasDigestPost("updates", "digest-bot", header, 1_600), true);
  assert.equal(await bot.hasDigestPost("updates", "digest-bot", header, 1_701), false);
  assert.equal(await bot.hasDigestPost("updates", "digest-bot", "Weekly digest", 1_000), false);
});
