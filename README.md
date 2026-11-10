# Rebrowse

A local Stagehand + TypeScript starter for a browser that anticipates your next action.

Opens a visible browser and a second tab with a live prediction dashboard. Browse normally: the app observes activity and asks SubQ what you might do next. You can also inspect pages or execute explicit commands from the terminal. Predictions do **not** automatically execute actions.

## Run

Requires Node.js 22.18+ and Google Chrome installed.

```sh
npm install
cp .env.example .env
npm start
```

Set `SUBQ_API_KEY` in `.env` for AI commands. `SUBQ_MODEL` defaults to `subq-preview`, which requires access on your SubQ account. Existing `OPENAI_API_KEY` and `STAGEHAND_MODEL` settings are ignored. No Browserbase account is needed. You can launch and inspect pages without an AI key. The first launch may download Stagehand's browser extension runtime.

Stagehand uses a custom model callback that sends requests directly to `https://api.subq.ai/v1/chat/completions`; no inference is sent to OpenAI. The adapter maps text, images, and structured JSON responses, with `store: false`, low reasoning effort, and an 8192-token output cap. The requested JSON schema is also included in the system prompt. Low reasoning keeps analysis separate from the JSON response with the current preview model; using `none` was observed to mix analysis into the response. Incomplete responses and refusals are rejected. General tool-calling generations are not implemented; Stagehand's `act`, `observe`, and `extract` primitives use structured responses. See [SubQ's API](https://docs.subq.ai/using-the-api) and [Stagehand custom models](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/configuration/models.mdx).

Browse in the window, then try these terminal commands:

```text
snapshot
observe What links can I open?
act Open the link to learn more about example domains
goto https://example.com
quit
```

## Live prediction dashboard

`npm start` opens the dashboard automatically in another tab. Switch back to your browsing tab and click, scroll, hover over links/buttons, or interact with a field. The dashboard displays:

- Recent activity and the currently observed page.
- Up to three suspected next actions with confidence estimates and supporting signals.
- Live collection/prediction status, a brief evidence summary, and request counts.
- Pause/resume and a Predict now button. Enter `dashboard` in the terminal to reopen it.
- A repeatable-task panel with steps, progress, evidence, and a downloadable detection journal.

Predictions run after a short activity pause, normally at most once every five seconds, with one request in flight. Address-bar focus/selection is a priority signal: it cancels an older inference and bypasses that cooldown. Old results are discarded when newer activity arrives. The dashboard does not observe itself. Confidence scores are model estimates, not calibrated probabilities or measured accuracy. The explanation is a user-facing summary, not the model's private internal reasoning.

Activity history stays in memory (last 60 events). Recent events and a bounded page context—title, headings, visible action labels, and paragraph excerpts—are sent to SubQ for predictions. Page form values, passwords, and editable page text are excluded. Navigated page URLs have query strings and fragments stripped. Address-bar contents are intentionally read separately and sent to SubQ as described below. Page text can still contain personal information. The dashboard is served on loopback with a random session URL; nothing is published. Pausing stops new events and aborts pending inference. Page observation covers top-level HTTP(S) pages; embedded frames and internal-page DOM are not tracked. A newly opened tab can take about a second to attach.

## Repeatable task detection

The predictor also receives recent observations across browser pages and tabs, not just the current page. The app remembers up to 80 distinct page snapshots, including bounded lists/tables, headings, action labels, outcome text, and the recent activity associated with them. The model receives the latest 35 snapshots plus up to five recent list snapshots, along with previous detected tasks. Unchanged snapshots are deduplicated. No extra model call is made for every snapshot.

For a workflow such as **list → search a person on LinkedIn → open their profile → send an invitation → next name**, the dashboard documents:

- **Suspected:** one confirmed item cycle and an observed list with more work can suggest a repeatable task.
- **Repeating:** at least two distinct items support the repeated sequence. Repeated clicks on one person do not count as different cycles.
- **Uncertain:** the workflow is recognizable but continuation or remaining work is unclear.
- **Complete:** the full observed list is established and every known item has a confirmed outcome.

Assessments require an estimated confidence of at least 70% and citations to real observation IDs. The panel shows the inferred steps, item cycles, confirmed outcomes, known remaining names/count, likely continuation, and supporting page evidence. For the LinkedIn example, a profile changing to **Pending** or showing **Invitation sent** can support an invitation having been sent; it does not mean the recipient accepted. A click on Connect alone stays an attempt. Named visible outcome signals are checked before counting an outcome as confirmed.

A total is established only from a cited complete, untruncated list whose observed row count matches it and whose rows map to known item identities. Partial/paginated lists, unreadable canvas-based lists, and lists outside the observed browser cannot establish a full count. Remaining names must occur in the observed source list or a supported item cycle. Unknown progress stays unknown rather than inventing names or declaring completion. These are AI assessments of limited observations, not guaranteed task recognition. Fast page changes can occur before a snapshot is captured.

New detections and meaningful progress/status changes are appended locally to ignored `session-data/repeatable-tasks.jsonl`, including timestamps, confidence, steps, item outcomes, remaining work, and cited evidence. These records can contain names and page text. The dashboard's **Download journal** exports a Markdown report of the current session's last 60 detection updates. The JSONL journal persists across restarts; inference memory starts fresh in each session. Pausing stops new observation/detection. Nothing is published or sent to LinkedIn, and no predicted action is executed. The observed context is sent to SubQ for analysis.

## Work queue and stopping assessment

Each detected task includes a **Work queue** for the current run. SubQ proposes item identities, list-row mappings and cited states during the existing prediction call. The app validates those citations and computes the counts and stopping assessment locally. The dashboard shows each item, its supporting observation IDs, and one of four states:

- **Ready:** observed in the source list with no confirmed outcome or unresolved attempt.
- **In progress:** a named page supports current work; an outcome still needs checking.
- **Confirmed:** a named, visible outcome passed the completion checks.
- **Needs review:** a visible blocker, ambiguous/no matching result, or an attempt without confirmed success. It is never silently skipped or counted as done.

The assessment suggests **Continue** when a ready or in-progress item exists, **Review needed** when unresolved items remain without a ready item, **Check source list** when the known queue is exhausted but its full extent is unknown, and **Finish** only when every unique item in the verified full list has a confirmed outcome. Ready items may continue while other items remain blocked; those blockers stay outstanding. A model's confidence or `finished` label cannot override remaining work.

Duplicate names are counted once (case and whitespace normalized). Exact totals require every observed source row to map to one known identity. Unknown or partial scope shows **At least N remaining · Total unknown**. A shrinking list does not erase outstanding items. A different source list or cycles outside the source trigger review instead of transferring earlier completions into a new run. Items with identical names are treated as one identity in this prototype; workflows requiring disambiguation need richer item identifiers.

Queue states and meaningful stopping changes are saved with the detection journal and included in its Markdown export. This is a prediction of how the task might continue or end; watching continues until you pause it. There is no queue runner, retry action, or automatic submission.

## Suggested reusable workflows

Each accepted task detection includes a **Suggested reusable workflow** card. It turns the observed pattern into a human-readable draft for a new input list, using `{{items}}` and the per-item variable `{{item}}` instead of the people observed in the current session. A source-list URL becomes `{{source_url}}` when present in the observed steps. The draft includes:

- Named inputs and a loop over the supplied list.
- One generalized instruction for each observed step, with its source-step number and a completion check.
- Rules to skip duplicates/already confirmed items in the current run, stop at the end of the supplied list, and pause when identity or outcomes are unclear.
- Review notes for a suspected pattern, unknown list size, unconfirmed outcomes, and model-suggested gaps.

SubQ suggests the draft's description, inputs and checks during the existing prediction call. The app keeps instructions tied to the observed steps; a proposal cannot add a new step or replace an observed step with an unrelated action. Malformed or unsupported proposals fall back to a basic template of the detected sequence. This does not make the model's assessment guaranteed correct; the draft is explicitly for review.

Open **Review steps, checks and stopping rules** to inspect it, or use **Download draft** to export the Markdown template. Drafts have stable IDs and versions, remain stable as ordinary progress updates arrive, and are revised when the observed pattern or evidence quality changes. They are included in the local JSONL journal and **Download journal** report. Completing the current list does not prevent a draft being reused for a future list; completion state is not carried into a new run.

Every draft is marked `status: draft` and `execution: disabled` by the app. There is no Run button, workflow executor, schedule, or automatic action associated with these suggestions. Reviewing, downloading, or detecting a workflow never sends connection requests or performs any proposed step.

## Browser-level signals on macOS

The app also starts a local Swift helper bound to the Chrome process using this project's browser profile. It samples pointer position about seven times per second while that browser is foreground, including browser controls outside the web page. The dashboard shows live coordinates and a position marker. Recent pointer movement and browser focus are included with predictions; movement alone does not trigger an API call every frame.

With macOS Accessibility access, the helper identifies address-bar focus/selection and reads up to 2048 characters from that confirmed Chrome control. It never reads text from page form fields or collects global keystrokes. The dashboard's **Address bar contents** box shows the current value and retains the last observed value when focus moves away, so you can inspect it from the separate dashboard window. Pausing clears that display. Values are kept in session memory only and are sent to SubQ to inform predictions.

After about 450ms without another text change, an address-edit event triggers an updated prediction using the actual query or URL. For example, entering `wasd` can produce a prediction to submit a search for `wasd`, rather than an unspecified new search. In-flight results for older input are invalidated as text changes. Merely selecting an existing URL is distinguished from editing it. Chrome may include autocomplete in its exposed value, so displayed text is not guaranteed to consist entirely of manually typed characters. Toolbar dwell is weaker evidence than confirmed address-bar focus. Address-bar labeling currently recognizes Chrome's English description or an omnibox/address accessibility identifier.

The browsing and dashboard tabs can be moved into separate windows. Browser-control signals follow Chrome's active tab in its last-focused window, even when address-bar focus means the document itself is unfocused. Address-bar activity in the dashboard window is also accepted, using the last browsed page as background context; ordinary dashboard content remains excluded. The native helper services macOS's main run loop so foreground-window state refreshes as you switch windows or applications. It reports inaccessible focus data and an active Chrome process from a different profile separately instead of silently showing ready.

If the dashboard says access is needed, click **Enable address-bar signals**, then allow Accessibility in **System Settings → Privacy & Security → Accessibility** for the app macOS identifies (often your terminal or Codex). Restart Rebrowse after changing access if it still shows unavailable. No Screen Recording or keystroke collection is used. Pointer/focus samples from other applications are not emitted. Pause watching also suspends the helper.

The helper is built on first launch into ignored `.cache/` and needs Apple's Swift compiler (Command Line Tools). Set `REBROWSE_DESKTOP_CONTEXT=false` to disable it. Other operating systems retain page-only observation for now. These browser-control signals require a native companion if this project later becomes a Chrome extension.

AI commands target the active browser tab and send page context and your instruction to the configured model provider. `act` executes the instruction immediately. `observe` lists candidate actions; it does not watch your browsing history or predict intent.

The browser uses a separate persistent profile in `browser-data/`, so your normal Chrome profile is untouched and logins in this profile can survive restarts. Close the session before opening another instance. `.env` and browser data are ignored by Git.

## Check

```sh
npm run check
npm test
npm run smoke
npm run smoke:predictions
npm run smoke:workflow
```

The smoke check launches a headless browser with a temporary profile, visits a local test page, clicks a button, and verifies page state and its snapshot. It makes no AI calls.

Run `npm run smoke:subq` to additionally verify live SubQ `observe` and `act` calls on that local page. This requires your API key and uses SubQ credits.

`npm run smoke:predictions` verifies the watcher, dashboard, redaction, pause/resume, and responsive layout with simulated predictions. `npm run smoke:predictions:subq` runs the same scenario using actual SubQ predictions on a local test page; this uses API credits.

The live prediction check also injects address-bar selection and text-edit signals, verifies that SubQ predicts search/navigation using the entered `wasd` query, and checks that the text is visible in the dashboard. `npm run smoke:desktop` is an interactive macOS check: it opens an isolated browser titled **Rebrowse browser-controls test**; activate that window and press Cmd+L within 90 seconds. It verifies native selection detection and the resulting live prediction, and uses API credits.

`npm run smoke:workflow` replays a three-name workflow on local test pages with simulated inference. `npm run smoke:workflow:subq` uses actual SubQ inference. Both verify cross-page memory, two confirmed local invitation outcomes, the unprocessed third name, a review-only reusable draft, step/parameter checks, local journal and draft exports, and responsive layout. They verify that reviewing/downloading the draft does not process the third person, then use explicit test-driver navigation/clicks to check a blocker, an in-progress item, and the final finish assessment. The predictor performs no actions. They never visit or send requests on real LinkedIn. Live checks use API credits.

## Next build

Next, measure predictions against subsequent user actions before adding speculative execution. The collector, predictor, dashboard, and Stagehand control adapter are separate modules so a future Chrome extension can reuse the prediction service with a different browser adapter. This Node-based app is not itself an installable extension.

Stagehand references: [quickstart](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/first-steps/quickstart.mdx), [browser configuration](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/configuration/browser.mdx).
