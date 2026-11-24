# Arbour Pumble bots

Private custom apps for the Arbour workspace. The task and goals bots share a SQLite database, and the weekly digest has its own delivery state.

## In Pumble

- **@it.** Start a channel message with the actual Pumble mentions for `@it` and each assignee, followed by the task. For example, `@it @Sam @Jo Send the report by tomorrow at 3pm`. The default deadline is 24 hours after the message. The bot reminds assignees in the original thread at the deadline and then daily while the task is open.
- **Task replies.** The task creator or any assignee can complete the task for everyone by replying `DONE` in the original thread. To extend it, reply with a later deadline such as `Friday at 5pm` or `+2h`. The latter adds two hours to the current deadline, or to the reply time if the task is overdue.
- **Weekly Goals.** On Monday at 9 am Melbourne time, the bot posts a separate tagged prompt for each active member of `#daily-updates`. At the same time on Friday, it posts one message asking everyone for an update. Each person can reply in the relevant thread to stop their own reminders. The bot tags people who still owe a reply in that thread every six hours, including overnight and on weekends.
- **Weekly Digest.** On Friday at 5 pm Melbourne time, the bot posts one update in `#daily-updates` covering the previous Friday at 5 pm through this Friday's cutoff. It reads accessible public and private channels, replies to older threads sent during the week, and one-to-one and group DMs available to the selected users who have authorized the app.

## Install

1. Run `npm run manifests`. In Arbour's **Configure apps**, create and install `arbour_it.json` and `arbour_weekly_goals.json`. If using Create from scratch, copy the bot scopes and names and leave events and Socket Mode off for Cloud Run. Set up `arbour_weekly_digest.json` separately using the steps below.
2. Add both bots to `#daily-updates` and set `PUMBLE_WORKSPACE_ID`, `GOALS_CHANNEL_ID` and `TASK_CHANNEL_IDS` using the IDs from the channel URL. Add `@it` to any additional task channels before including their IDs in `TASK_CHANNEL_IDS`.
3. Set each app's key and bot token. Use Secret Manager for the four credentials on Cloud Run. `GOALS_HOUR` and `TIME_ZONE` control the weekly schedule. Starting after 9 am on Monday or Friday sends that day's prompts. Prior days are skipped unless their prompts were already recorded and still await replies.

## Cloud Run

Run the Docker image with `node dist/cloud-run.js` as a single-task Cloud Run Job. Provide `PUMBLE_STATE_BUCKET` with the name of a private Cloud Storage bucket and give the runtime service account object access to that bucket. The job saves task and reminder state there between runs.

Set Cloud Scheduler to execute the job every five minutes using OAuth and a service account with Run Invoker on that job. Each execution uses the Pumble API to pick up tagged tasks and thread replies and send reminders that are due.

### Deploy from GitHub

Pushes to `main` run `npm test`, build the image, push it to `australia-southeast1-docker.pkg.dev/arbourhq/arbour/pumble-bots`, and update the `arbour-pumble-bots` Cloud Run job. The workflow updates the image only, so each job keeps its Cloud Run secrets, settings and schedule.

1. Set up a Google Cloud Workload Identity Federation provider for `https://token.actions.githubusercontent.com`. Map `google.subject=assertion.sub` and `attribute.repository_id=assertion.repository_id`. Restrict the provider with `assertion.repository_owner_id == '312090429' && assertion.repository_id == '1468116178' && assertion.ref == 'refs/heads/main' && assertion.event_name == 'push'`. Grant `roles/iam.workloadIdentityUser` on the deployment service account to `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/attribute.repository_id/1468116178`. [Google Cloud Workload Identity Federation setup](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines#github-actions)
2. Give the deployment service account `roles/artifactregistry.writer` on the `arbour` Artifact Registry repository, `roles/run.developer` on the jobs it deploys, and `roles/iam.serviceAccountUser` on their runtime service accounts.
3. Under **Settings → Secrets and variables → Actions → Variables**, set `GCP_WORKLOAD_IDENTITY_PROVIDER` to the full `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER` resource name and `GCP_DEPLOY_SERVICE_ACCOUNT` to the deployment service account email. After creating the digest job, set `GCP_DIGEST_JOB` to `arbour-weekly-digest`.

### Enable the Friday digest

1. Install `manifests/arbour_weekly_digest.json` as a private Pumble app and add its bot to `#daily-updates`. Invite it to each private channel to include. Use the app key and bot token from this app for the digest job.
2. Have Alex and Ben each authorize **Weekly Digest** in **Configure apps** so the app can read their DMs. Exchange each OAuth authorization code at `https://api-ga.pumble.com/oauth2/access` using form fields `client-id`, `client-secret`, and `code`. The manifest uses a localhost redirect. The authorization code is in the redirected address. Save each response's `userId` and `accessToken` for the reader secret. [Pumble OAuth authorization](https://cake-com.github.io/pumble-node-sdk/authorization.html)
3. In Secret Manager, create the four secrets below. The runtime service account needs `roles/secretmanager.secretAccessor` on these secrets and object access to the state bucket. Use the `accessToken` from each user in `PUMBLE_DIGEST_DM_READERS` and add the OpenAI API key when ready. [Cloud Run job secrets](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets)

| Job environment variable | Secret value |
| --- | --- |
| `PUMBLE_DIGEST_APP_KEY` | Weekly Digest app key |
| `PUMBLE_DIGEST_BOT_TOKEN` | Weekly Digest bot token |
| `PUMBLE_DIGEST_DM_READERS` | `[{"userId":"ALEX_ID","token":"ALEX_TOKEN"},{"userId":"BEN_ID","token":"BEN_TOKEN"}]` |
| `OPENAI_API_KEY` | OpenAI API key |

4. Once all four secrets have enabled versions, create the second job from the image built by CI. Use the existing bot job's workspace, channel and bucket settings. `IMAGE` is the full Artifact Registry image from CI and `DIGEST_RUNTIME_SA` is the runtime service account email. The command below uses version `1` of each secret.

   ```sh
   gcloud run jobs create arbour-weekly-digest \
     --project=arbourhq --region=australia-southeast1 --image="$IMAGE" \
     --command=node --args=dist/cloud-digest.js --tasks=1 --task-timeout=15m \
     --max-retries=2 --service-account="$DIGEST_RUNTIME_SA" \
     --set-env-vars="PUMBLE_WORKSPACE_ID=$PUMBLE_WORKSPACE_ID,GOALS_CHANNEL_ID=$GOALS_CHANNEL_ID,PUMBLE_STATE_BUCKET=$PUMBLE_STATE_BUCKET,TIME_ZONE=Australia/Melbourne" \
     --set-secrets="PUMBLE_DIGEST_APP_KEY=PUMBLE_DIGEST_APP_KEY:1,PUMBLE_DIGEST_BOT_TOKEN=PUMBLE_DIGEST_BOT_TOKEN:1,PUMBLE_DIGEST_DM_READERS=PUMBLE_DIGEST_DM_READERS:1,OPENAI_API_KEY=OPENAI_API_KEY:1"
   ```

5. Give the Scheduler service account `roles/run.invoker` on `arbour-weekly-digest`. Set `DIGEST_SCHEDULER_SA` to that service account's email, then create the Friday trigger. [Schedule Cloud Run jobs](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)

   ```sh
   gcloud scheduler jobs create http arbour-weekly-digest \
     --project=arbourhq --location=australia-southeast1 \
     --schedule='0 17 * * 5' --time-zone=Australia/Melbourne --http-method=POST \
     --uri='https://run.googleapis.com/v2/projects/arbourhq/locations/australia-southeast1/jobs/arbour-weekly-digest:run' \
     --oauth-service-account-email="$DIGEST_SCHEDULER_SA"
   ```

The digest sends accessible message text to the OpenAI Responses API with `gpt-6.2-sol` and `store: false`. The prompt asks for shareable work outcomes from private sources and omits quotes and private conversation details from the digest. The job persists only delivery state. [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

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
