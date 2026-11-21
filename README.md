# Rebrowse

Rebrowse opens a dedicated Chrome session, watches your browsing, and uses SubQ to predict what you might do next. When it detects a repeatable task with usable targets, it can start a bounded workflow automatically. For example, opening two related course reviews can lead Rebrowse to find and open the next few reviews in separate tabs.

## Quick start

Install Node.js 22.18 or newer and Google Chrome. If Stagehand cannot find Chrome, set `CHROME_PATH` to its executable.

```sh
npm ci
cp -n .env.example .env
npm start
```

Chrome opens a browsing tab and a local dashboard. Switch to the browsing tab to generate activity. Basic browsing and terminal commands such as `goto` and `snapshot` work without an API key. To enable predictions, workflows, and live replay, set `SUBQ_API_KEY` in `.env` and restart. The key needs access to the Savant Chat Completions API. [SubQ authentication](https://docs.subq.ai/using-the-api/authentication/) · [Chat Completions](https://docs.subq.ai/endpoints/chat-completions-api/)

| Setting | Default | What it controls |
| --- | --- | --- |
| `SUBQ_API_KEY` | Empty | SubQ authentication |
| `SUBQ_MODEL` | `subq-savant-1.4` | Model used for predictions, browser actions, and replay |
| `START_URL` | `https://example.com` | First page in a new browser session |
| `REBROWSE_DESKTOP_CONTEXT` | `true` | macOS pointer, focus, and address-bar signals |
| `REBROWSE_CLIPBOARD_CONTEXT` | `true` | Clipboard context from page events and, on macOS, the foreground browser |

Rebrowse maps the former default `subq-preview` to `subq-savant-1.4` in existing configurations. [SubQ release notes](https://docs.subq.ai/using-the-api/release-notes/)

On macOS, browser controls require the Apple Swift compiler. In the dashboard, use **Enable address-bar signals** to open the Accessibility settings and grant access to the app macOS identifies. Page observation works with desktop context disabled.

Use `help` in the terminal to list commands, `dashboard` to reopen the dashboard, and `quit` to close the session. The dedicated `browser-data/` profile retains logins. On macOS and Linux, Rebrowse can reconnect to a surviving Chrome process and keep its tabs. A second live agent using the profile is rejected.

## Host Rebrowse for visitors

Hosted mode opens an interactive Browserbase Chrome session next to the Rebrowse dashboard. Visitors can enter public website addresses, use tabs, and get live predictions and automatic workflows without installing anything or supplying an API key. The browser closes a few seconds after the last Rebrowse tab disconnects, or after five minutes at most. The hosted session uses page activity for predictions and omits desktop signals, clipboard observation, and recording.

Set `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, and a Savant-enabled `SUBQ_API_KEY` on the host. Run `npm ci` and `npm run start:hosted` to try it at `http://localhost:3000`. These packages run on the host and the keys stay there.

For a public link, deploy the included `render.yaml` as a Render Blueprint, or run `npm run start:hosted` on a Node.js host with `PORT` and `REBROWSE_PUBLIC_URL` set to the assigned port and HTTPS origin. Render provides its origin automatically. Use one service instance. Hosted mode defaults to one concurrent session and 12 launch attempts per UTC day per process. Set `REBROWSE_CONCURRENT_SESSIONS` and `REBROWSE_DAILY_SESSIONS` to adjust those limits to your Browserbase and SubQ quotas.

## Dashboard

- **Predictions** show likely next actions and the browsing activity behind them. **Pause watching** pauses observation and stops workflows.
- **Repeatable tasks** shows the inferred goal, supporting observations, work queue, and run log. A run starts automatically when there are usable targets. **Stop workflow** stops further actions after any action already dispatched. Use **Download workflow** or **Download journal** to export Markdown.
- **Record & replay** saves a browsing session when you click **Record browsing**, then **Stop & save**. Live workflows can continue during recording. **Replay saved activity** asks SubQ to analyze up to 12 observed checkpoints without acting in the browser. Download the JSONL recording and Markdown report from this panel.

An automatic batch can process up to 12 planned targets. Resource runs allow up to three navigations per target, and the runner checks time and action limits before dispatch. It reuses open resources when possible and skips unavailable targets. For list workflows, a submission needs a visible outcome before an item counts as complete. Workflow actions can supply outcome evidence and only new human activity can trigger another batch.

## Local data and SubQ

The dashboard is served on a loopback address with a random session URL. Browser state lives in `browser-data/`. Task and run journals, recordings, and replay reports live in `session-data/`. Git ignores both directories and `.env`.

Predictions send relevant page text, links, and activity to SubQ. Enabled address-bar signals and eligible clipboard text can also be sent. Clipboard context expires after two minutes and clears when paused or when the browser loses foreground. Ordinary field values and recognized password and payment fields are excluded from observation.

Recordings contain filtered page state, activity, and model findings. Raw clipboard and address-bar text are excluded. Visible page text, public search queries, and model summaries can still contain personal information. Recordings are stored locally. Live replay sends context from the recording to SubQ.

## Verify a change

```sh
npm run verify
```

This runs the TypeScript check, including unused local and parameter checks, then unit tests and headless Chrome smoke tests. The smoke tests use local fixtures and temporary browser profiles. AI responses in this suite are simulated.

| User flow | Check | Expected result |
| --- | --- | --- |
| Browse and pause predictions | `npm run smoke:predictions` | A fixture click updates the dashboard. Pausing suppresses subsequent activity. |
| Continue a repeatable task | `npm run smoke:automatic` | Two related pages trigger a bounded run. An existing tab is reused and the run is saved to the journal. |
| Record, save, and replay | `npm run smoke:recording` | The dashboard saves a downloadable recording and shows a result for each recorded checkpoint. |
| Follow a workflow's queue | `npm run smoke:workflow` and `npm run smoke:runner` | Queue states and exports reflect browser actions and verified outcomes. |
| Detect a pattern across background tabs | `npm run smoke:patterns` | Related background pages appear in the prediction history and support a detected workflow. |
| Reconnect to Chrome | `npm run smoke:restart` on macOS or Linux | The existing tab and profile survive reconnection. Duplicate agents are rejected. |
| Check clipboard and address-bar behavior | `npm run smoke:clipboard` and, on macOS, `npm run smoke:focus` | Protected fields are excluded. The native focus check preserves address-bar selection and skips without Accessibility access. |

Dashboard smoke tests save named screenshots under `/tmp/rebrowse-*.png`. For a live provider check, run `npm run smoke:subq` with a configured key. It uses API credits and verifies that Stagehand can identify and click a button on a local test page.

### Replay from the terminal

```sh
npm run replay -- path/to/recording.jsonl
npm run replay -- path/to/recording.jsonl --live --max-steps 12
npm run replay:calc -- --max-steps 6
npm run replay:mixed
```

Plain replay reads saved findings. Live replay re-evaluates each checkpoint using the observations available at that point. The last two commands use SubQ to score checked-in synthetic scenarios. Reports are saved as JSON and Markdown in `session-data/replay-reports/`. Use `--out` to provide a new output path.

## Repository layout

| Path | Responsibility |
| --- | --- |
| [`src/index.ts`](src/index.ts), [`src/browser.ts`](src/browser.ts), [`src/browser-session.ts`](src/browser-session.ts) | CLI, Chrome lifecycle, and profile recovery |
| [`src/observer.ts`](src/observer.ts), [`native/`](native/) | Page observation and macOS browser controls |
| [`src/predictor.ts`](src/predictor.ts), [`src/subq.ts`](src/subq.ts) | Prediction prompts, response schema, and provider adapter |
| [`src/tasks.ts`](src/tasks.ts), [`src/work-queue.ts`](src/work-queue.ts), [`src/workflow-runner.ts`](src/workflow-runner.ts) | Evidence, queue state, and execution |
| [`src/dashboard.ts`](src/dashboard.ts), [`src/dashboard/`](src/dashboard/) | Local dashboard server and browser UI |
| [`src/recording.ts`](src/recording.ts), [`src/replay.ts`](src/replay.ts), [`fixtures/recordings/`](fixtures/recordings/) | Recording format, replay, and sample trajectories |
| [`scripts/`](scripts/) | Browser smoke tests and replay CLI |
