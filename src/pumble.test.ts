import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEvent, postBody, PumbleClient } from "./pumble.js";

const workspaceId = "workspace";
const credentials = { appId: "app", appKey: "key", botToken: "token" };
const channel = "channel";
const mentionBlocks = [
  {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "user", user_id: "it" },
          { type: "text", text: " " },
          { type: "user", user_id: "sam" },
          { type: "text", text: " Send the report" },
        ],
      },
    ],
  },
];

test("decodes a selected Pumble mention and its thread without treating plain text as a mention", () => {
  const body = {
    wId: workspaceId,
    cId: channel,
    mId: "message",
    aId: "alex",
    trId: "",
    tsm: 123_456,
    tx: "@it @Sam Send the report",
    bl: mentionBlocks,
    md: ["it", "sam"],
  };
  const event = {
    messageType: "PUMBLE_EVENT",
    eventType: "NEW_MESSAGE",
    workspaceId,
    body: JSON.stringify(body),
  };
  const message = decodeEvent(event, workspaceId);
  assert.equal(message?.text, "<<@it>> <<@sam>> Send the report");
  assert.deepEqual(message?.mentionIds, ["it", "sam"]);
  assert.equal(message?.threadId, undefined);
  assert.equal(decodeEvent(event, "other"), undefined);

  const reply = { ...body, tx: "<<@it>>", bl: null, md: [], trId: "root" };
  const threaded = decodeEvent({ ...event, body: JSON.stringify(reply) }, workspaceId);
  assert.equal(threaded?.threadId, "root");
  assert.deepEqual(threaded?.mentionIds, []);
});

test("uses rich text user mentions when posting a tagged reminder", async () => {
  const text = "Hi <<@sam>>, could you reply?";
  const client = new PumbleClient(credentials, workspaceId, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v1/channels/channel/messages/root");
    assert.deepEqual(init?.headers, {
      "x-app-token": "key",
      token: "token",
      "Content-Type": "application/json",
    });
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), postBody(text));
    return Response.json({ id: "posted" });
  });

  assert.equal(await client.post({ channelId: channel, threadId: "root", text }), "posted");
  assert.deepEqual(postBody(text), {
    text,
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Hi " },
              { type: "user", user_id: "sam" },
              { type: "text", text: ", could you reply?" },
            ],
          },
        ],
      },
    ],
  });
});

test("finds active human channel members", async () => {
  const user = { workspaceId, status: "ACTIVATED", isPumbleBot: false, isAddonBot: false };
  const client = new PumbleClient(credentials, workspaceId, async (input) => {
    if (new URL(String(input)).pathname === "/v1/workspaceUsers") {
      return Response.json([
        { ...user, id: "sam" },
        { ...user, id: "away", status: "DEACTIVATED" },
        { ...user, id: "bot", isAddonBot: true },
        { ...user, id: "different-channel" },
      ]);
    }
    return Response.json({
      channel: { workspaceId, id: channel, isMember: true },
      users: ["sam", "away", "bot"],
    });
  });
  assert.deepEqual(await client.members(channel), ["sam"]);
});

test("reconciles missed top-level mentions and excludes plain-text lookalikes", async () => {
  const row = { workspaceId, channelId: channel, author: "alex", timestampMilli: 2_000 };
  const client = new PumbleClient(credentials, workspaceId, async (input) => {
    assert.equal(new URL(String(input)).pathname, "/v1/channels/channel/messages");
    return Response.json({
      hasMoreBefore: false,
      messages: [
        { ...row, id: "new", text: "@it @Sam Send the report", blocks: mentionBlocks },
        { ...row, id: "old", timestampMilli: 1_000, blocks: mentionBlocks },
        { ...row, id: "plain", text: "<<@it>> <<@sam>> Send the report" },
        { ...row, id: "reply", threadReplyInfo: { rootId: "root" }, blocks: mentionBlocks },
      ],
    });
  });

  const [message, ...extra] = await client.taskMessagesSince(channel, 1_500, "it");
  assert.deepEqual(extra, []);
  assert.equal(message?.id, "new");
  assert.equal(message?.text, "<<@it>> <<@sam>> Send the report");
});

test("thread checks normalise replies with attachments and ignore deleted messages", async () => {
  const message = {
    workspaceId,
    channelId: channel,
    author: "sam",
    timestampMilli: 2_000,
    text: null,
  };
  const client = new PumbleClient(credentials, workspaceId, async (input) => {
    assert.equal(new URL(String(input)).pathname, "/v1/channels/channel/messages/root/replies");
    return Response.json([
      { ...message, id: "root" },
      { ...message, id: "attachment" },
      { ...message, id: "deleted", deleted: true },
    ]);
  });
  assert.deepEqual(await client.replies(channel, "root"), [
    {
      id: "attachment",
      channelId: channel,
      threadId: "root",
      text: "",
      authorId: "sam",
      sentAt: 2_000,
      mentionIds: [],
    },
  ]);
});
