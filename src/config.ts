import { PumbleClient } from "./pumble.js";

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before starting the bots`);
  return value;
}

export async function configureBots(socketMode: boolean, request: typeof fetch = fetch) {
  const workspaceId = required("PUMBLE_WORKSPACE_ID");
  const timeZone = process.env.TIME_ZONE ?? "Australia/Melbourne";
  new Intl.DateTimeFormat("en-AU", { timeZone });

  const hour = Number(process.env.GOALS_HOUR ?? 9);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("GOALS_HOUR must be between 0 and 23");
  }

  const taskChannels = new Set(
    required("TASK_CHANNEL_IDS")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (!taskChannels.size) throw new Error("TASK_CHANNEL_IDS needs a channel ID");
  const goalsChannel = required("GOALS_CHANNEL_ID");

  function client(name: "IT" | "GOALS"): PumbleClient {
    return new PumbleClient(
      {
        appId: socketMode ? required(`PUMBLE_${name}_APP_ID`) : undefined,
        appKey: required(`PUMBLE_${name}_APP_KEY`),
        botToken: required(`PUMBLE_${name}_BOT_TOKEN`),
      },
      workspaceId,
      request,
    );
  }

  const taskBot = client("IT");
  const goalsBot = client("GOALS");
  const [taskBotId, goalsBotId] = await Promise.all([taskBot.botId(), goalsBot.botId()]);
  if (taskBotId === goalsBotId) throw new Error("The two Pumble apps need separate bot tokens");

  return {
    workspaceId,
    timeZone,
    hour,
    taskChannels,
    goalsChannel,
    taskBot,
    goalsBot,
    taskBotId,
    goalsBotId,
  };
}
