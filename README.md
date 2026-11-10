# Rebrowse

A local Stagehand + TypeScript starter for a browser that anticipates your next action.

Opens a visible browser and a second tab with a live prediction dashboard. Browse normally: the app observes activity and asks SubQ what you might do next. You can approve a suggested workflow to run its remaining queue, or inspect pages and execute explicit commands from the terminal. Predictions do **not** automatically execute actions.

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

Activity history stays in memory (last 60 events). Recent events and a bounded page context—title, headings, visible action labels, and paragraph excerpts—are sent to SubQ for predictions. Ordinary observation excludes page form values, passwords, and editable page text. Explicit safe clipboard transfers and address-bar contents are intentionally read separately and can be sent to SubQ as described below. Navigated page URLs have query strings and fragments stripped; clipboard text can itself contain full URLs. Page text can still contain personal information. The dashboard is served on loopback with a random session URL; nothing is published. Pausing stops new events and aborts pending inference. Page observation covers top-level HTTP(S) pages; embedded frames and internal-page DOM are not tracked. A newly opened tab can take about a second to attach.

## Clipboard context

The browser watches trusted **copy**, **cut**, and **paste** events in browsing pages. It captures the explicit transferred text (including a selected portion of a normal text/search field), not arbitrary field values or general typing. The dashboard's **Clipboard context** card shows the recent text, operation, target, source, timestamp, truncation, and whether it was included in a prediction request. Copying **Jamie Chen** from a prospect list then focusing LinkedIn search can produce a prediction to paste/search that name; a paste event describes an observed transfer, not a successful search submission or completed workflow.

On macOS, the native helper reports clipboard change-count metadata while this browser is foreground. Before reading text through Stagehand's clipboard API, the browser adapter checks the active browsing tab and excludes protected fields/selections. Reads are checked again after completion so a pause, focus change, or newer clipboard version discards an old result. The helper also observes only **Cmd+C**, **Cmd+X**, and **Cmd+V** shortcuts in this browser's address bar/controls, using the existing Accessibility access; it does not inspect other key characters. Page shortcuts use page events. Menu-based address-bar paste may instead appear as an address edit, which can suggest a possible paste when it matches the clipboard. Other applications and ordinary dashboard page interactions are excluded.

An initial clipboard read or change without an observed shortcut is labeled **available** or **changed**, with its source unknown; it is not claimed to be a copy from the current page or a confirmed paste. The system path requires macOS browser-focus signals; other platforms or disabled desktop observation retain page copy/cut/paste detection. Text-only clipboard reading does not capture images or files, and unsupported/denied reads leave ordinary observation working.

Text is limited to **2048 characters**, expires after **two minutes**, and clears when watching is paused, the browser loses foreground, or an approved workflow starts controlling its tab. Transfers involving recognized password, payment/autocomplete, one-time-code, `data-private`, or `data-sensitive` fields are excluded before their data is read. Obvious API keys, bearer tokens, private keys, and credential assignments are also excluded; this is a heuristic, not a guarantee that arbitrary clipboard text contains no private information. Safe copied/pasted text is sent to SubQ for predictions, so it can contain names or other personal information.

The last transfer text stays only in transient prediction context; the activity stream and workflow observation history keep operation metadata without raw clipboard payloads. Model-generated summaries/task assessments can still mention a copied name or other relevant data. Clipboard text is untrusted data and never authorizes actions, starts a workflow, establishes an item outcome, or changes an approved run. Set `REBROWSE_CLIPBOARD_CONTEXT=false` in `.env` and restart to disable this feature. **Pause watching** also suspends it and clears its context.

## Repeatable task detection

The predictor also receives recent observations across browser pages and tabs, not just the current page. The app remembers up to 80 distinct page snapshots, including bounded lists/tables, headings, action labels, outcome text, and the recent activity associated with them. The model receives the latest 35 snapshots plus up to five recent list snapshots, along with previous detected tasks. Unchanged snapshots are deduplicated. No extra model call is made for every snapshot.

For a workflow such as **list → search a person on LinkedIn → open their profile → send an invitation → next name**, the dashboard documents:

- **Suspected:** one confirmed item cycle and an observed list with more work can suggest a repeatable task.
- **Repeating:** at least two distinct items support the repeated sequence. Repeated clicks on one person do not count as different cycles.
- **Uncertain:** the workflow is recognizable but continuation or remaining work is unclear.
- **Complete:** the full observed list is established and every known item has a confirmed outcome.

Assessments require an estimated confidence of at least 70% and citations to real observation IDs. The panel shows the inferred steps, item cycles, confirmed outcomes, known remaining names/count, likely continuation, and supporting page evidence. For the LinkedIn example, a profile changing to **Pending** or showing **Invitation sent** can support an invitation having been sent; it does not mean the recipient accepted. A click on Connect alone stays an attempt. Named visible outcome signals are checked before counting an outcome as confirmed.

A total is established only from a cited complete, untruncated list whose observed row count matches it and whose rows map to known item identities. Partial/paginated lists, unreadable canvas-based lists, and lists outside the observed browser cannot establish a full count. Remaining names must occur in the observed source list or a supported item cycle. Unknown progress stays unknown rather than inventing names or declaring completion. These are AI assessments of limited observations, not guaranteed task recognition. Fast page changes can occur before a snapshot is captured.

New detections and meaningful progress/status changes are appended locally to ignored `session-data/repeatable-tasks.jsonl`, including timestamps, confidence, steps, item outcomes, remaining work, and cited evidence. These records can contain names and page text. The dashboard's **Download journal** exports a Markdown report of the current session's last 60 detection updates. The JSONL journal persists across restarts; inference memory starts fresh in each session. Pausing stops new observation/detection. Nothing is published. Predictions do not act; separately approved workflows can interact with the actual websites, including submitting the observed connection request. The observed context is sent to SubQ for analysis.

## Work queue and stopping assessment

Each detected task includes a **Work queue** for the current run. SubQ proposes item identities, list-row mappings and cited states during the existing prediction call. The app validates those citations and computes the counts and stopping assessment locally. The dashboard shows each item, its supporting observation IDs, and one of four states:

- **Ready:** observed in the source list with no confirmed outcome or unresolved attempt.
- **In progress:** a named page supports current work; an outcome still needs checking.
- **Confirmed:** a named, visible outcome passed the completion checks.
- **Needs review:** a visible blocker, ambiguous/no matching result, or an attempt without confirmed success. It is never silently skipped or counted as done.

The assessment suggests **Continue** when a ready or in-progress item exists, **Review needed** when unresolved items remain without a ready item, **Check source list** when the known queue is exhausted but its full extent is unknown, and **Finish** only when every unique item in the verified full list has a confirmed outcome. Ready items may continue while other items remain blocked; those blockers stay outstanding. A model's confidence or `finished` label cannot override remaining work.

Duplicate names are counted once (case and whitespace normalized). Exact totals require every observed source row to map to one known identity. Unknown or partial scope shows **At least N remaining · Total unknown**. A shrinking list does not erase outstanding items. A different source list or cycles outside the source trigger review instead of transferring earlier completions into a new run. Items with identical names are treated as one identity in this prototype; workflows requiring disambiguation need richer item identifiers.

Queue states and meaningful stopping changes are saved with the detection journal and included in its Markdown export. The queue assessment predicts how the task might continue or end; it never starts execution. Watching continues until you pause it. A separate explicit approval is required to run the remaining queue as described below.

## Suggested reusable workflows

Each accepted task detection includes a **Suggested reusable workflow** card. It turns the observed pattern into a human-readable draft for a new input list, using `{{items}}` and the per-item variable `{{item}}` instead of the people observed in the current session. A source-list URL becomes `{{source_url}}` when present in the observed steps. The draft includes:

- Named inputs and a loop over the supplied list.
- One generalized instruction for each observed step, with its source-step number and a completion check.
- Rules to skip duplicates/already confirmed items in the current run, stop at the end of the supplied list, and pause when identity or outcomes are unclear.
- Review notes for a suspected pattern, unknown list size, unconfirmed outcomes, and model-suggested gaps.

SubQ suggests the draft's description, inputs and checks during the existing prediction call. The app keeps instructions tied to the observed steps; a proposal cannot add a new step or replace an observed step with an unrelated action. Malformed or unsupported proposals fall back to a basic template of the detected sequence. This does not make the model's assessment guaranteed correct; the draft is explicitly for review.

Open **Review steps, checks and stopping rules** to inspect it, or use **Download draft** to export the Markdown template. Drafts have stable IDs and versions, remain stable as ordinary progress updates arrive, and are revised when the observed pattern or evidence quality changes. They are included in the local JSONL journal and **Download journal** report. Completing the current list does not prevent a draft being reused for a future list; completion state is not carried into a new run.

Every reusable template stays marked `status: draft` and `execution: disabled`; it does not execute by itself. Reviewing, downloading, detecting, or changing confidence never starts actions. **Approve & run** creates a separate, bounded execution of that template version for the currently displayed queue.

## Approving and running a workflow

Review the suggested steps, checks, source URL, and listed remaining items, fill any additional inputs, then click **Approve & run**. This click authorizes actual browser interactions for that workflow version and those queue items, including its observed submission step. The runner opens its own tab, skips confirmed items, and processes one remaining item at a time. In-progress items are rechecked from the approved source; an existing confirmed outcome is never assumed to need resubmission. Approval is refused if the reviewed version or queue changed, another run is active, the full source is unknown, or any item needs review. A new input list is not silently included in an earlier approval.

The live **Approved execution** card shows the current item, step, action count, verified completions, and run activity. The runner checks the live source membership before each item, asks SubQ about one step at a time, resolves one Stagehand action, checks its target, and executes that single Action object. It verifies the visible result before moving on. Human observation and predictions are suspended while a run controls its tab; execution observations and outcomes are labeled as workflow activity rather than human repetition.

Execution stops when the work queue confirms every item complete. A missing or ambiguous match, login challenge, changed list/workflow, unsupported action, unconfirmed submission, repeated action, or bounded step limit pauses the run for review. It does not automatically retry uncertain actions or skip unresolved items. After a final-step click, key press, or selection, another action requires review unless the outcome is confirmed; a new confirmation dialog at that point can require manual completion. Actions are limited to the websites seen in the approved task, and links opening new tabs/windows or sensitive fields require manual review. This first runner supports readable DOM lists and common single page interactions; incomplete/canvas lists and richer identity matching can require manual work.

Use **Pause workflow** to stop dispatching more actions. An already dispatched click or submission may finish; the runner keeps its lock until the operation settles and checks its visible outcome. **Pause watching** and closing the session also stop further execution. Review the owned workflow tab, resolve outstanding outcomes, then refresh predictions and approve the remaining ready queue. Runs never resume automatically, including after restart. Manual terminal `goto`, `observe`, and `act` commands are blocked while the runner is busy.

The frozen item list, approved version, action dispatches, outcome checks, and final complete/paused state are saved to ignored `session-data/workflow-runs.jsonl`. Item states and named outcomes also update the task journal. Local records can contain item names, page text, and action descriptions. A run-log write failure pauses further dispatch. SubQ planning and Stagehand observation use the configured `subq-preview` model and API key; a run makes additional model calls and uses API credits.

## Browser-level signals on macOS

The app also starts a local Swift helper bound to the Chrome process using this project's browser profile. It samples pointer position about seven times per second while that browser is foreground, including browser controls outside the web page. The dashboard shows live coordinates and a position marker. Recent pointer movement and browser focus are included with predictions; movement alone does not trigger an API call every frame.

With macOS Accessibility access, the helper identifies address-bar focus/selection and reads up to 2048 characters from that confirmed Chrome control. It never reads text from page form fields or collects global keystrokes. The dashboard's **Address bar contents** box shows the current value and retains the last observed value when focus moves away, so you can inspect it from the separate dashboard window. Pausing clears that display. Values are kept in session memory only and are sent to SubQ to inform predictions.

After about 450ms without another text change, an address-edit event triggers an updated prediction using the actual query or URL. For example, entering `wasd` can produce a prediction to submit a search for `wasd`, rather than an unspecified new search. In-flight results for older input are invalidated as text changes. Merely selecting an existing URL is distinguished from editing it. Chrome may include autocomplete in its exposed value, so displayed text is not guaranteed to consist entirely of manually typed characters. Toolbar dwell is weaker evidence than confirmed address-bar focus. Address-bar labeling currently recognizes Chrome's English description or an omnibox/address accessibility identifier.

The browsing and dashboard tabs can be moved into separate windows. Browser-control signals follow Chrome's active tab in its last-focused window, even when address-bar focus means the document itself is unfocused. Address-bar activity in the dashboard window is also accepted, using the last browsed page as background context; ordinary dashboard content remains excluded. The native helper services macOS's main run loop so foreground-window state refreshes as you switch windows or applications. It reports inaccessible focus data and an active Chrome process from a different profile separately instead of silently showing ready.

If the dashboard says access is needed, click **Enable address-bar signals**, then allow Accessibility in **System Settings → Privacy & Security → Accessibility** for the app macOS identifies (often your terminal or Codex). Restart Rebrowse after changing access if it still shows unavailable. No Screen Recording or general keystroke recording is used; the clipboard feature recognizes only the three browser-control shortcuts described above. Pointer/focus samples from other applications are not emitted. Pause watching also suspends the helper.

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
npm run smoke:runner
npm run smoke:clipboard
```

The smoke check launches a headless browser with a temporary profile, visits a local test page, clicks a button, and verifies page state and its snapshot. It makes no AI calls.

Run `npm run smoke:subq` to additionally verify live SubQ `observe` and `act` calls on that local page. This requires your API key and uses SubQ credits.

`npm run smoke:predictions` verifies the watcher, dashboard, redaction, pause/resume, and responsive layout with simulated predictions. `npm run smoke:predictions:subq` runs the same scenario using actual SubQ predictions on a local test page; this uses API credits.

The live prediction check also injects address-bar selection and text-edit signals, verifies that SubQ predicts search/navigation using the entered `wasd` query, and checks that the text is visible in the dashboard. `npm run smoke:desktop` is an interactive macOS check: it opens an isolated browser titled **Rebrowse browser-controls test**; activate that window and press Cmd+L within 90 seconds. It verifies native selection detection and the resulting live prediction, and uses API credits.

`npm run smoke:workflow` replays a three-name workflow on local test pages with simulated inference. `npm run smoke:workflow:subq` uses actual SubQ inference. Both verify cross-page memory, two confirmed local invitation outcomes, the unprocessed third name, a review-only reusable draft, step/parameter checks, local journal and draft exports, and responsive layout. They verify that reviewing/downloading the draft does not process the third person, then use explicit test-driver navigation/clicks to check a blocker, an in-progress item, and the final finish assessment. The predictor performs no actions. They never visit or send requests on real LinkedIn. Live checks use API credits.

`npm run smoke:runner` clicks the dashboard approval button and verifies actual Stagehand Action execution on local fixture pages with simulated planning. It checks skipped completed items, multiple remaining items, named outcomes, automatic stopping, a missing-match pause, local journals, and responsive run controls. `npm run smoke:runner:subq` uses actual SubQ step planning and Stagehand observation to complete a local fixture queue. Neither visits real LinkedIn; live checks use API credits.

`npm run smoke:clipboard` verifies actual browser copy/cut/paste, clipboard reading, copied-name predictions, protected fields, injected native clipboard metadata, context preview, pause and responsive layout. `npm run smoke:clipboard:subq` uses live SubQ predictions. The test uses isolated local pages and a temporary headless browser; on macOS it preserves native clipboard formats in process memory and restores them only when the test still owns the last write. Native shortcut emission depends on macOS Accessibility and is not simulated as a real OS keyboard action by this check.

## Next build

Next, measure predictions against subsequent user actions before adding speculative execution. The collector, predictor, dashboard, and Stagehand control adapter are separate modules so a future Chrome extension can reuse the prediction service with a different browser adapter. This Node-based app is not itself an installable extension.

Stagehand references: [quickstart](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/first-steps/quickstart.mdx), [browser configuration](https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/configuration/browser.mdx).
