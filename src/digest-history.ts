import type { Message } from "./contracts.js";
import type { DigestChannel, PumbleClient } from "./pumble.js";

export type DigestMessage = Message & {
  author: string;
  conversation: string;
  visibility: "channel" | "private";
};

export async function collectDigestHistory(
  bot: PumbleClient,
  readers: readonly { client: PumbleClient; userId: string }[],
  start: number,
  end: number,
): Promise<DigestMessage[]> {
  if (!readers.length) throw new Error("Configure at least one Pumble digest reader");

  const [names, histories] = await Promise.all([
    bot.workspaceUserNames(),
    Promise.all(
      readers.map(async ({ client, userId }) => {
        const channels = await client.digestChannels(userId);
        const channelIds = [...new Set(channels.map(({ id }) => id))];
        return { channels, messages: await client.digestMessages(channelIds, start, end) };
      }),
    ),
  ]);

  const conversations = new Map<string, DigestChannel>();
  const combined = new Map<string, Message>();
  for (const { channels, messages } of histories) {
    for (const channel of channels) {
      const previous = conversations.get(channel.id);
      if (!previous || (previous.type === "PUBLIC" && channel.type !== "PUBLIC")) {
        conversations.set(channel.id, channel);
      }
    }
    // Participants can have different history in the same group DM.
    for (const message of messages) {
      const key = `${message.channelId}\0${message.id}`;
      if (!combined.has(key)) combined.set(key, message);
    }
  }

  const messages: DigestMessage[] = [];
  for (const message of combined.values()) {
    const channel = conversations.get(message.channelId);
    if (!channel) continue;
    const conversation = channel.type === "DIRECT"
      ? `Direct message with ${channel.memberIds.map((id) => names.get(id) ?? id).join(", ")}`
      : `#${channel.name || channel.id}`;
    const text = message.text.replace(/<<@([A-Za-z0-9_-]+)>>/g, (_, id: string) => `@${names.get(id) ?? id}`);
    messages.push({
      ...message,
      author: names.get(message.authorId) ?? message.authorId,
      conversation,
      text,
      visibility: channel.type === "PUBLIC" ? "channel" : "private",
    });
  }
  return messages.sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
}
