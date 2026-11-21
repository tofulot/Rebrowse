# Development

Bug reports and pull requests are welcome. For a bug report, include your OS, Node.js version, whether you used local or hosted mode, and steps to reproduce it. [Open an issue](https://github.com/tofulot/Rebrowse/issues/new)

Run the full verification suite before submitting a change.

```sh
npm ci
npm run verify
```

This runs TypeScript checks, unit tests, and headless Chrome smoke tests against local fixtures with simulated model responses. `npm run smoke:subq` checks live model access and uses API credits.

## Targeted checks

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

## Repository layout

| Path | What lives there |
| --- | --- |
| [`src/index.ts`](../src/index.ts), [`src/hosted.ts`](../src/hosted.ts) | Local CLI and hosted server |
| [`src/observer.ts`](../src/observer.ts), [`native/`](../native/) | Page activity and macOS browser signals |
| [`src/predictor.ts`](../src/predictor.ts), [`src/subq.ts`](../src/subq.ts) | Prediction schema, prompts, and SubQ adapter |
| [`src/tasks.ts`](../src/tasks.ts), [`src/workflow-runner.ts`](../src/workflow-runner.ts) | Task evidence and workflow execution |
| [`src/dashboard/`](../src/dashboard/), [`src/hosted/`](../src/hosted/) | Dashboard and hosted browser interface |
| [`scripts/`](../scripts/) | Smoke tests and replay tools |
