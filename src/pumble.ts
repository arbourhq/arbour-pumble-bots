import { mention, type Message, type Post, type Pumble } from "./contracts.js";

const api = "https://api-ga.pumble.com";
const segment = encodeURIComponent;

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readBlocks(blocks: unknown, mentions: Set<string>): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((entry: unknown) => {
      const block = record(entry);
      if (block.type === "user" && typeof block.user_id === "string") {
        mentions.add(block.user_id);
        return mention(block.user_id);
      }
      if (block.type === "text") return string(block.text);
      if (block.type === "link") return string(block.text) || string(block.url);
      if (block.type === "emoji") return string(block.unicode) || `:${string(block.name)}:`;
      if (block.type === "channel") return string(block.channel_id);
      if (block.type === "broadcast") return `@${string(block.range)}`;
      return readBlocks(block.elements, mentions);
    })
    .join("");
}

function messageText(plain: unknown, blocks: unknown, mentions: Set<string>): string {
  const rendered = readBlocks(blocks, mentions);
  const text = string(plain);
  return !text || [...mentions].some((id) => !text.includes(mention(id))) ? rendered || text : text;
}

export function decodeEvent(payload: unknown, workspaceId: string): Message | undefined {
  const event = record(payload);
  if (
    event.messageType !== "PUMBLE_EVENT" ||
    event.eventType !== "NEW_MESSAGE" ||
    event.workspaceId !== workspaceId ||
    typeof event.body !== "string"
  )
    return;

  const body = record(JSON.parse(event.body));
  if (body.wId !== workspaceId || body.eph === true || body.st || body.aaId) return;
  const id = string(body.mId);
  const channelId = string(body.cId);
  const authorId = string(body.aId);
  if (!id || !channelId || !authorId || typeof body.tsm !== "number" || !Number.isFinite(body.tsm))
    return;

  const mentions = new Set(texts(body.md));
  const text = messageText(body.tx, body.bl, mentions);
  return {
    id,
    channelId,
    authorId,
    text,
    threadId: string(body.trId) || undefined,
    mentionIds: [...mentions],
    sentAt: body.tsm,
  };
}

function readMessage(
  row: Record<string, unknown>,
  workspaceId: string,
  channelId: string,
  threadId?: string,
): Message | undefined {
  const id = string(row.id);
  const authorId = string(row.author);
  if (
    !id ||
    id === threadId ||
    !authorId ||
    row.deleted ||
    row.subtype ||
    row.authorAppId ||
    row.workspaceId !== workspaceId ||
    row.channelId !== channelId ||
    typeof row.timestampMilli !== "number" ||
    !Number.isFinite(row.timestampMilli)
  )
    return;
  const mentions = new Set<string>();
  const text = messageText(row.text, row.blocks, mentions);
  return {
    id,
    channelId,
    threadId,
    authorId,
    text,
    mentionIds: [...mentions],
    sentAt: row.timestampMilli,
  };
}

export function postBody(text: string): Record<string, unknown> {
  const pieces = text.split(/<<@([A-Za-z0-9_-]+)>>/);
  if (pieces.length === 1) return { text };

  const elements = pieces.flatMap((piece, index) => {
    if (!piece) return [];
    const element = index % 2 ? { type: "user", user_id: piece } : { type: "text", text: piece };
    return [element];
  });
  return {
    text,
    blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements }] }],
  };
}

export type Credentials = {
  appId: string;
  appKey: string;
  botToken: string;
};

export class PumbleClient implements Pumble {
  constructor(
    private readonly credentials: Credentials,
    private readonly workspaceId: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async connectUrl(): Promise<string> {
    const query = new URLSearchParams({ appKey: this.credentials.appKey });
    const result = record(
      await this.read(
        `/apps/${segment(this.credentials.appId)}/websocket-connection?${query}`,
        "open socket",
        false,
      ),
    );
    const url = new URL(string(result.url));
    if (url.protocol !== "wss:") throw new Error("Pumble returned a socket without TLS");
    return url.href;
  }

  async botId(): Promise<string> {
    const profile = record(await this.read("/oauth2/me", "verify bot"));
    const id = string(profile.workspaceUserId);
    if (profile.workspaceId !== this.workspaceId || !id) {
      throw new Error("Pumble credentials do not match the configured workspace");
    }
    return id;
  }

  async post({ channelId, threadId, text }: Post): Promise<string> {
    const path = `/v1/channels/${segment(channelId)}/messages${threadId ? `/${segment(threadId)}` : ""}`;
    const response = record(await this.read(path, "post message", true, postBody(text)));
    const id = string(response.id);
    if (!id) throw new Error("Pumble did not return a message ID");
    return id;
  }

  async verifyChannel(channelId: string): Promise<void> {
    await this.channelUsers(channelId);
  }

  async members(channelId: string): Promise<readonly string[]> {
    const [members, users] = await Promise.all([
      this.channelUsers(channelId),
      this.read("/v1/workspaceUsers", "list workspace users"),
    ]);
    if (!Array.isArray(users)) throw new Error("Pumble did not return workspace users");
    return users
      .map(record)
      .filter(
        (user) =>
          members.has(string(user.id)) &&
          user.workspaceId === this.workspaceId &&
          user.status === "ACTIVATED" &&
          !user.isPumbleBot &&
          !user.isAddonBot,
      )
      .map((user) => string(user.id));
  }

  async taskMessagesSince(
    channelId: string,
    since: number,
    botId: string,
  ): Promise<readonly Message[]> {
    const path = `/v1/channels/${segment(channelId)}/messages`;
    return this.history(
      async (query) => {
        const page = record(await this.read(`${path}?${query}`, "read channel history"));
        if (!Array.isArray(page.messages)) throw new Error("Pumble did not return channel history");
        return { rows: page.messages.map(record), hasMore: page.hasMoreBefore === true };
      },
      (row) => {
        if (row.threadReplyInfo) return;
        const message = readMessage(row, this.workspaceId, channelId);
        if (message?.mentionIds.includes(botId)) return message;
      },
      since,
    );
  }

  async replies(channelId: string, threadId: string): Promise<readonly Message[]> {
    const path = `/v1/channels/${segment(channelId)}/messages/${segment(threadId)}/replies`;
    return this.history(
      async (query) => {
        const rows = await this.read(`${path}?${query}`, "read thread replies");
        if (!Array.isArray(rows)) throw new Error("Pumble did not return thread replies");
        return { rows: rows.map(record), hasMore: rows.length >= 50 };
      },
      (row) => readMessage(row, this.workspaceId, channelId, threadId),
    );
  }

  private async history(
    load: (
      query: URLSearchParams,
    ) => Promise<{ rows: Record<string, unknown>[]; hasMore: boolean }>,
    parse: (row: Record<string, unknown>) => Message | undefined,
    since?: number,
  ): Promise<Message[]> {
    const messages = new Map<string, Message>();
    const seenCursors = new Set<string>();
    let cursor = "";
    for (;;) {
      const query = new URLSearchParams({ limit: "50", strategy: "BEFORE" });
      if (cursor) query.set("cursor", cursor);
      const { rows, hasMore } = await load(query);
      for (const row of rows) {
        const message = parse(row);
        if (message && (since === undefined || message.sentAt >= since))
          messages.set(message.id, message);
      }
      if (!hasMore || !rows.length) break;
      rows.sort(
        (a, b) =>
          Number(a.timestampMilli) - Number(b.timestampMilli) ||
          string(a.id).localeCompare(string(b.id)),
      );
      if (since !== undefined && Number(rows[0]?.timestampMilli) < since) break;
      cursor = string(rows[0]?.id);
      if (!cursor || seenCursors.has(cursor))
        throw new Error("Pumble history pagination did not advance");
      seenCursors.add(cursor);
    }
    return [...messages.values()].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
  }

  private async channelUsers(channelId: string): Promise<Set<string>> {
    const data = record(await this.read(`/v1/channels/${segment(channelId)}`, "read channel"));
    const channel = record(data.channel);
    if (
      channel.id !== channelId ||
      channel.workspaceId !== this.workspaceId ||
      channel.isArchived ||
      channel.isMember !== true ||
      !Array.isArray(data.users)
    ) {
      throw new Error(`Pumble bot needs to join the active channel ${channelId}`);
    }
    return new Set(texts(data.users));
  }

  private async read(
    path: string,
    operation: string,
    auth = true,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (auth) {
      headers["x-app-token"] = this.credentials.appKey;
      headers.token = this.credentials.botToken;
    }
    if (body) headers["Content-Type"] = "application/json";

    try {
      const response = await this.request(`${api}${path}`, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!response.ok) throw new PumbleRequestError(operation, response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof PumbleRequestError) throw error;
      throw new Error(`Pumble could not ${operation}`);
    }
  }
}

export class PumbleRequestError extends Error {
  constructor(
    operation: string,
    readonly status: number,
  ) {
    super(`Pumble could not ${operation} (HTTP ${status})`);
  }
}
