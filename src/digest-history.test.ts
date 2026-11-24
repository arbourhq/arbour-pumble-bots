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

test("collects dated channel and thread activity and searches shared DMs once", async () => {
  const sharedDm = channel("shared-dm", "DIRECT", ["alex", "ben"]);
  const bot = new PumbleClient({ appKey: "app", botToken: "bot" }, workspaceId, async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("token");
    assert.equal(new Headers(init?.headers).get("x-app-token"), "app");
    if (url.pathname === "/oauth2/me") {
      return Response.json({ workspaceId, workspaceUserId: token });
    }
    if (url.pathname === "/v1/workspaceUsers") {
      assert.equal(token, "bot");
      return Response.json([
        { workspaceId, id: "alex", name: "Alex" },
        { workspaceId, id: "ben", name: "Ben" },
      ]);
    }
    if (url.pathname === "/v1/channels") {
      if (token === "bot") {
        assert.equal(url.searchParams.get("types"), "PUBLIC,PRIVATE");
        return Response.json([
          channel("public", "PUBLIC", [], { isMember: false, isArchived: true }),
          channel("private", "PRIVATE", [], { isMember: true }),
          channel("other-private", "PRIVATE", [], { isMember: false }),
          sharedDm,
        ]);
      }
      assert.equal(url.searchParams.get("types"), "DIRECT");
      if (token === "alex") return Response.json([sharedDm, channel("other-dm", "DIRECT", ["ben"])]);
      assert.equal(token, "ben");
      return Response.json([sharedDm, channel("group-dm", "DIRECT", ["ben", "cat", "dee"])]);
    }

    assert.equal(url.pathname, "/v1/messages/search");
    const search: Record<string, unknown> = JSON.parse(String(init?.body));
    assert.equal(search.afterTs, start - 1);
    assert.equal(search.beforeTs, end);
    assert.equal(search.fromMyChannelsOnly, false);
    if (token === "bot") {
      assert.deepEqual(search.in, ["public", "private"]);
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
          row("thread-reply", "public", start, { threadReplyInfo: { rootId: "old-thread" } }),
          row("previous-week", "public", start - 1),
          row("unexpected-channel", "other-private", 1_100),
        ],
      });
    }
    if (token === "alex") {
      assert.deepEqual(search.in, ["shared-dm"]);
      return Response.json({ hasMore: false, content: [row("shared", "shared-dm", 1_800, { author: "ben" })] });
    }
    assert.equal(token, "ben");
    assert.deepEqual(search.in, ["group-dm"]);
    return Response.json({
      hasMore: false,
      content: [row("file", "group-dm", 1_900, { text: null, files: [{ name: "proposal.pdf" }] })],
    });
  });

  const messages = await collectDigestHistory(bot, [bot.asUser("alex"), bot.asUser("ben")], start, end);
  assert.deepEqual(messages.map(({ id, visibility }) => [id, visibility]), [
    ["thread-reply", "channel"],
    ["private-message", "private"],
    ["shared", "private"],
    ["file", "private"],
    ["integration", "channel"],
  ]);
  assert.equal(messages[0].threadId, "old-thread");
  assert.equal(messages[2].author, "Ben");
  assert.equal(messages[2].conversation, "Direct message with Alex, Ben");
  assert.equal(messages[3].text, "[File proposal.pdf]");
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
