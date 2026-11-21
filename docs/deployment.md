# Self-host Rebrowse

Deploy [`render.yaml`](../render.yaml) as a Render Blueprint, or run `npm ci` and `npm run start:hosted` on a single Node.js service. Configure `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, and a Savant-enabled `SUBQ_API_KEY` as server-side environment variables. On other hosts, set `PORT` and `REBROWSE_PUBLIC_URL` to the assigned port and HTTPS origin. The local hosted server defaults to `http://localhost:3000`.

The Blueprint allows two simultaneous browsers. A standalone server defaults to one. Adjust `REBROWSE_CONCURRENT_SESSIONS` and `REBROWSE_DAILY_SESSIONS` to match your provider quotas. The default daily limit is 12 launch attempts per UTC day per process.

## Automatic updates on Render

Install the Render GitHub App for the repository so Render receives push events. [Connect GitHub to Render](https://render.com/docs/git-provider#github-details)

The Blueprint specifies `main` as the service branch and enables deploys on each commit. For an existing Blueprint, select `main` in its settings, sync the Blueprint, and confirm that the web service lists **On Commit** under **Auto-Deploy**. Keep the three provider settings in Render's environment variables.

For each visitor, the app creates a temporary Browserbase session. The last Rebrowse tab closing starts a short reconnect window before the browser is released. Five minutes is the maximum session length.
