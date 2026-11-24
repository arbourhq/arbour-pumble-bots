import type { Message } from "./contracts.js";
import type { DigestChannel, PumbleClient } from "./pumble.js";

export type DigestMessage = Message & {
  author: string;
  conversation: string;
  visibility: DigestChannel["visibility"];
};

export async function collectDigestHistory(
  bot: PumbleClient,
  dmReaders: readonly PumbleClient[],
  start: number,
  end: number,
): Promise<DigestMessage[]> {
  const [names, workspaceChannels, directChannels] = await Promise.all([
    bot.workspaceUserNames(),
    bot.digestChannels(),
    Promise.all(dmReaders.map((reader) => reader.digestChannels(true))),
  ]);
  const claimed = new Set<string>();
  const sources = [
    { reader: bot, channels: workspaceChannels, direct: false },
    ...dmReaders.map((reader, index) => ({ reader, channels: directChannels[index], direct: true })),
  ].map(({ reader, channels, direct }) => {
    const conversations = new Map<string, { name: string; visibility: DigestMessage["visibility"] }>();
    for (const channel of channels) {
      if (claimed.has(channel.id)) continue;
      claimed.add(channel.id);
      const name = direct
        ? `Direct message with ${channel.memberIds.map((id) => names.get(id) ?? id).join(", ")}`
        : `#${channel.name || channel.id}`;
      conversations.set(channel.id, { name, visibility: channel.visibility });
    }
    return { reader, conversations };
  });

  const messages = await Promise.all(
    sources.map(async ({ reader, conversations }) => {
      const rows = await reader.digestMessages([...conversations.keys()], start, end);
      return rows.flatMap((message): DigestMessage[] => {
        const channel = conversations.get(message.channelId);
        if (!channel) return [];
        const text = message.text.replace(
          /<<@([A-Za-z0-9_-]+)>>/g,
          (_, id: string) => `@${names.get(id) ?? id}`,
        );
        return [
          {
            ...message,
            author: names.get(message.authorId) ?? message.authorId,
            conversation: channel.name,
            text,
            visibility: channel.visibility,
          },
        ];
      });
    }),
  );

  return messages.flat().sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
}
