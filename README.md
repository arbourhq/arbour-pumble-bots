# Arbour Pumble bots

Two private custom apps for the Arbour workspace. The bots share a SQLite database.

## In Pumble

- **@it.** Start a channel message with the actual Pumble mentions for `@it` and each assignee, followed by the task. For example, `@it @Sam @Jo Send the report by tomorrow at 3pm`. The default deadline is 24 hours after the message. The bot reminds assignees in the original thread at the deadline and then daily while the task is open.
- **Task replies.** The task creator or any assignee can complete the task for everyone by replying `DONE` in the original thread. To extend it, reply with a later deadline such as `Friday at 5pm` or `+2h`. The latter adds two hours to the current deadline, or to the reply time if the task is overdue.
- **Weekly Goals.** On Monday at 9 am Melbourne time, the bot posts a separate tagged prompt for each active member of `#daily-updates`. At the same time on Friday, it posts one message asking everyone for an update. Each person can reply in the relevant thread to stop their own reminders. The bot tags people who still owe a reply in that thread every six hours, including overnight and on weekends.

## Install

1. Run `npm run manifests`. In Arbour's **Configure apps**, create and install an app from each JSON file in `manifests/`. These are two bot identities with empty user scopes. If using Create from scratch, copy the bot scopes and names and leave events and Socket Mode off for Cloud Run.
2. Add both bots to `#daily-updates` and set `PUMBLE_WORKSPACE_ID`, `GOALS_CHANNEL_ID` and `TASK_CHANNEL_IDS` using the IDs from the channel URL. Add `@it` to any additional task channels before including their IDs in `TASK_CHANNEL_IDS`.
3. Set each app's key and bot token. Use Secret Manager for the four credentials on Cloud Run. `GOALS_HOUR` and `TIME_ZONE` control the weekly schedule. Starting after 9 am on Monday or Friday sends that day's prompts. Prior days are skipped unless their prompts were already recorded and still await replies.

## Cloud Run

Run the Docker image with `node dist/cloud-run.js` on an authenticated Cloud Run service. Provide `PUMBLE_STATE_BUCKET` with the name of a private Cloud Storage bucket and give the runtime service account object access to that bucket. The service saves task and reminder state there between requests.

Set Cloud Scheduler to send an authenticated `POST /tick` every minute with an OIDC identity that has Run Invoker on this service. `GET /healthz` checks that the container is accepting requests. Cloud Run uses the Pumble API to pick up tagged tasks and thread replies on each scheduled check.

## Local Socket Mode

For a local run, generate apps with `npm run manifests -- --socket`, or enable Socket Mode and the New Message event in Pumble. Copy `.env.example` to `.env` and include each app's ID as well as its key and bot token. Start one instance and retain the SQLite file at `DB_PATH`.

```sh
npm ci
npm test
npm start
```

The Docker image runs the same process. Keep the data volume across upgrades and restarts.

```sh
docker build -t arbour-pumble-bots .
docker run -d --name arbour-pumble-bots --restart unless-stopped \
  --env-file .env -v arbour-pumble-data:/app/data arbour-pumble-bots
```

Pumble setup reference [Custom apps](https://pumble.com/help/integrations/add-pumble-apps/guide-to-pumble-integrations/) and [Socket Mode](https://cake-com.github.io/pumble-node-sdk/basic-concepts.html#pumble-app-components).
