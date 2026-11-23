import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("manifests", { recursive: true });
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
];

for (const { name, displayName, botTitle, botScopes } of apps) {
  const manifest = {
    name,
    displayName,
    botTitle,
    bot: true,
    socketMode: true,
    shortcuts: [],
    slashCommands: [],
    redirectUrls: [],
    scopes: { botScopes, userScopes: [] },
    eventSubscriptions: { url: "https://localhost/events", events: ["NEW_MESSAGE"] },
  };
  const filename = `manifests/${name}.json`;
  writeFileSync(filename, JSON.stringify(manifest, null, 2) + "\n");
  console.log(filename);
}
