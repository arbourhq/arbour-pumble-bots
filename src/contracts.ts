export type Message = {
  id: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  text: string;
  mentionIds: readonly string[];
  sentAt: number;
};

export type Post = {
  channelId: string;
  threadId?: string;
  text: string;
};

export type Pumble = {
  post(post: Post): Promise<string>;
  members(channelId: string): Promise<readonly string[]>;
  replies(channelId: string, threadId: string): Promise<readonly Message[]>;
};

export function mention(id: string): string {
  return `<<@${id}>>`;
}
