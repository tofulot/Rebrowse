# Use Rebrowse

## Run locally

Install [Node.js](https://nodejs.org/) 22.18 or newer and Google Chrome. Run these commands in a terminal.

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

## Record and replay

In the local dashboard, select **Record browsing**, then **Stop & save**. Download the recording or select **Replay saved activity** to evaluate up to 12 observed checkpoints without running browser actions.

```sh
npm run replay -- path/to/recording.jsonl
npm run replay -- path/to/recording.jsonl --live --max-steps 12
```

Plain replay reads saved findings. Live replay makes fresh predictions at each observed checkpoint. Reports default to `session-data/replay-reports/`. Use `--out` to choose a path.

## Privacy

- Local Chrome state is stored in `browser-data/`. Journals, recordings, and replay reports are stored in `session-data/`. Git ignores both directories and `.env`.
- SubQ receives relevant page text, links, and activity. Enabled desktop and clipboard signals can also be sent. Clipboard context expires after two minutes and clears when you pause watching or Chrome loses foreground. Ordinary field values and recognized password and payment fields are excluded.
- Recordings exclude raw clipboard and address-bar text. Visible page text, public search queries, and model summaries can still contain personal information. Live replay sends recording context to SubQ.
- Hosted sessions use page activity in the cloud browser. Desktop signals, clipboard observation, and recording are available in local mode.
