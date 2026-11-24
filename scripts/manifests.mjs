import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("manifests", { recursive: true });
const defaultSocketMode = process.argv.includes("--socket");
const apps = [
  {
    name: "arbour_it",
    displayName: "it",
    botTitle: "Assign tasks and manage deadlines in a thread",
    botScopes: ["channels:read", "messages:read", "messages:write"],
  },
  {
    name: "arbour_weekly_goals",
    displayName: "Weekly Goals",
    botTitle: "Ask for weekly goals and progress updates",
    botScopes: ["channels:read", "messages:read", "messages:write", "users:list"],
  },
  {
    name: "arbour_weekly_digest",
    displayName: "Weekly Digest",
    botTitle: "Summarise the week in daily updates",
    botScopes: ["channels:list", "channels:read", "messages:read", "messages:write", "users:list"],
    userScopes: ["channels:list", "channels:read", "messages:read"],
    redirectUrls: ["https://localhost/pumble-digest"],
    socketMode: false,
  },
];

for (const app of apps) {
  const {
    name, displayName, botTitle, botScopes,
    userScopes = [], redirectUrls = [], socketMode = defaultSocketMode,
  } = app;
  const manifest = {
    name,
    displayName,
    botTitle,
    bot: true,
    socketMode,
    shortcuts: [],
    slashCommands: [],
    redirectUrls,
    scopes: { botScopes, userScopes },
    eventSubscriptions: {
      url: "https://localhost/events",
      events: socketMode ? ["NEW_MESSAGE"] : [],
    },
  };
  const filename = `manifests/${name}.json`;
  writeFileSync(filename, JSON.stringify(manifest, null, 2) + "\n");
  console.log(filename);
}
