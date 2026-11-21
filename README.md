# Rebrowse

Rebrowse watches activity in a dedicated Chrome session and uses SubQ to predict what you might do next. When it recognizes a repeatable task, it can continue it automatically, such as opening the next few resources in a series.

**[Try the live demo](https://rebrowse-live.onrender.com/)** · [Run locally](#run-locally) · [Self-host](#self-host) · [Contribute](#contributing)

## Try it

Click **Start browsing** in the live demo, enter a public website or search, and browse while the dashboard updates. The demo runs in a temporary cloud browser with no installation or API key required. Sessions last up to five minutes and release the browser a few seconds after the last Rebrowse tab closes.

## Features

- **Live predictions** show likely next actions and the browsing activity that informed them.
- **Repeatable tasks** turn recurring browsing patterns into bounded workflows. The dashboard shows the evidence, queue, and run log. Use **Stop workflow** to interrupt a run or **Pause watching** to stop observation and execution.
- **Record and replay** lets you save a local session, download its JSONL recording, and evaluate up to 12 checkpoints without acting in the browser.
- **Dedicated Chrome profile** keeps local logins between runs. On macOS and Linux, Rebrowse can reconnect to a surviving Chrome process and recover its tabs.

## Run locally

Install [Node.js](https://nodejs.org/) 22.18 or newer and Google Chrome.

```sh
git clone https://github.com/tofulot/Rebrowse.git
cd Rebrowse
npm ci
cp -n .env.example .env
npm start
```

Chrome opens a browsing tab and the Rebrowse dashboard. Enter `help` in the terminal for commands, `dashboard` to reopen the dashboard, or `quit` to end the session.

Basic browsing and commands such as `goto` and `snapshot` work immediately. For predictions, workflows, and live replay, set `SUBQ_API_KEY` in `.env` and restart. Your key needs access to SubQ Savant. [SubQ authentication](https://docs.subq.ai/using-the-api/authentication/) · [Chat Completions API](https://docs.subq.ai/endpoints/chat-completions-api/)

| Setting | Default | Purpose |
| --- | --- | --- |
| `SUBQ_API_KEY` | Empty | Enables AI features |
| `SUBQ_MODEL` | `subq-savant-1.4` | Model for predictions, workflows, and live replay |
| `START_URL` | `https://example.com` | First URL in a new session |
| `CHROME_PATH` | Auto-detected | Chrome executable if automatic detection fails |
| `REBROWSE_DESKTOP_CONTEXT` | `true` | macOS pointer, focus, and address-bar signals |
| `REBROWSE_CLIPBOARD_CONTEXT` | `true` | Eligible copy, cut, and paste context |

On macOS, native browser signals require the Apple Swift compiler. Select **Enable address-bar signals** in the dashboard to grant Accessibility access. You can browse and get page-based predictions with desktop context disabled.

## Self-host

Deploy [`render.yaml`](render.yaml) as a Render Blueprint, or run `npm ci` and `npm run start:hosted` on a single Node.js service. Configure `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, and a Savant-enabled `SUBQ_API_KEY` as server-side environment variables. On other hosts, set `PORT` and `REBROWSE_PUBLIC_URL` to the assigned port and HTTPS origin. The local hosted server defaults to `http://localhost:3000`.

The Blueprint allows two simultaneous browsers. A standalone server defaults to one. Adjust `REBROWSE_CONCURRENT_SESSIONS` and `REBROWSE_DAILY_SESSIONS` to match your provider quotas. The default daily limit is 12 launch attempts per UTC day per process.

## Privacy

- Local Chrome state is stored in `browser-data/`. Journals, recordings, and replay reports are stored in `session-data/`. Git ignores both directories and `.env`.
- SubQ receives relevant page text, links, and activity. Enabled desktop and clipboard signals can also be sent. Clipboard context expires after two minutes and clears when you pause watching or Chrome loses foreground. Ordinary field values and recognized password and payment fields are excluded.
- Recordings exclude raw clipboard and address-bar text. Visible page text, public search queries, and model summaries can still contain personal information. Live replay sends recording context to SubQ.
- Hosted sessions use page activity in the cloud browser. Desktop signals, clipboard observation, and recording are available in local mode.

## Contributing

Bug reports and pull requests are welcome. For a bug report, include your OS, Node.js version, whether you used local or hosted mode, and steps to reproduce it. [Open an issue](https://github.com/tofulot/Rebrowse/issues/new)

Run the full verification suite before submitting a change.

```sh
npm ci
npm run verify
```

This runs TypeScript checks, unit tests, and headless Chrome smoke tests against local fixtures with simulated model responses. `npm run smoke:subq` checks live model access and uses API credits.

<details>
<summary>Targeted project checks</summary>

| Flow | Command |
| --- | --- |
| Predictions and pause | `npm run smoke:predictions` |
| Automatic workflows | `npm run smoke:automatic` |
| Recording and replay | `npm run smoke:recording` |
| Workflow queue and execution | `npm run smoke:workflow`, `npm run smoke:runner` |
| Pattern detection across tabs | `npm run smoke:patterns` |
| Browser recovery on macOS or Linux | `npm run smoke:restart` |
| Clipboard and macOS address-bar signals | `npm run smoke:clipboard`, `npm run smoke:focus` |

Dashboard smoke tests save screenshots to `/tmp/rebrowse-*.png`.

</details>

<details>
<summary>Replay a recording from the terminal</summary>

```sh
npm run replay -- path/to/recording.jsonl
npm run replay -- path/to/recording.jsonl --live --max-steps 12
```

Plain replay reads saved findings. Live replay makes fresh predictions at each observed checkpoint. `npm run replay:calc` and `npm run replay:mixed` score included synthetic recordings with SubQ. Reports default to `session-data/replay-reports/`. Use `--out` to choose a path.

</details>

| Path | What lives there |
| --- | --- |
| [`src/index.ts`](src/index.ts), [`src/hosted.ts`](src/hosted.ts) | Local CLI and hosted server |
| [`src/observer.ts`](src/observer.ts), [`native/`](native/) | Page activity and macOS browser signals |
| [`src/predictor.ts`](src/predictor.ts), [`src/subq.ts`](src/subq.ts) | Prediction schema, prompts, and SubQ adapter |
| [`src/tasks.ts`](src/tasks.ts), [`src/workflow-runner.ts`](src/workflow-runner.ts) | Task evidence and workflow execution |
| [`src/dashboard/`](src/dashboard/), [`src/hosted/`](src/hosted/) | Dashboard and hosted browser interface |
| [`fixtures/recordings/`](fixtures/recordings/), [`scripts/`](scripts/) | Sample recordings, smoke tests, and replay tools |

## License

The [package metadata](package.json) declares ISC.
