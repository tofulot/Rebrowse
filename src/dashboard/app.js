const $ = (id) => document.getElementById(id);
const hosted = document.body.classList.contains('hosted');
const connectedLabel = hosted ? 'Live session' : 'Connected locally';
if (hosted) $('connection').textContent = 'Connecting…';
let state;
let lastPredictionTime;
let lastWorkflowRender;
const statusNames = { watching: 'Watching', collecting: 'Reading context', predicting: 'Predicting', ready: 'Watching', paused: 'Paused', error: 'Needs attention', 'needs-key': 'Key needed' };
const stages = { watching: 'Listening for activity', collecting: 'Reading the current page', predicting: 'Estimating the next move', ready: 'Prediction updated', paused: 'Observation paused', error: 'Prediction unavailable', 'needs-key': 'Waiting for API key' };
const icons = { click: '↗', hover: '⌁', edit: '⌨', focus: '⊡', scroll: '↕', navigate: '→', tab: '▣', copy: '▤', cut: '✂', paste: '↧', 'clipboard-available': '⎘', 'clipboard-change': '⎘', 'address-select': '⌘', 'address-focus': '⌕', 'address-edit': '⌨', 'pointer-dwell': '⌁', 'browser-focus': '▣' };
const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
function render(next) {
  state = next;
  $('status').textContent = statusNames[state.status] || 'Watching';
  document.body.classList.toggle('is-busy', ['collecting', 'predicting'].includes(state.status));
  document.body.classList.toggle('is-paused', state.paused);
  document.body.classList.toggle('is-stale', state.stale);
  $('page-title').textContent = state.page?.title || 'Waiting for your first page';
  $('page-url').textContent = state.page?.url || 'Browse in the other tab to begin.';
  $('page-url').title = state.page?.url || '';
  $('pause').textContent = state.paused ? 'Resume watching  ▶' : 'Pause watching  Ⅱ';
  $('predict').disabled = state.paused || state.execution?.busy || !state.page || ['collecting', 'predicting', 'needs-key'].includes(state.status);
  $('browser-mode').textContent = state.execution?.busy ? 'Automatic workflow running' : state.recording && ['starting', 'recording', 'saving'].includes(state.recording.status) ? 'Observing & recording' : 'Observe & automate';
  $('thinking-state').textContent = stages[state.status];
  $('event-count').textContent = String(state.activity.length);
  $('requests').textContent = `${state.requests} predictions requested`;
  renderWorkflow(state);
  renderExecution(state);
  renderClipboard(state.clipboard);
  renderRecording(state);
  $('error').hidden = !state.error;
  $('error').textContent = state.error || '';
  const desktop = state.desktop;
  const sample = desktop?.sample;
  const pointer = sample?.pointer;
  $('desktop-focus').textContent = state.paused ? 'Browser observation paused' : sample?.active && sample.focus === 'address-bar'
    ? sample.addressSelected ? 'Address bar selected' : 'Address bar focused'
    : desktop?.status === 'permission-needed' ? 'Address-bar signals need access'
    : desktop?.status === 'focus-unavailable' ? 'Browser focus data unavailable'
    : desktop?.status === 'ready' ? 'Browser context connected'
    : desktop?.status === 'inactive' ? 'Browser in background'
    : desktop?.status === 'starting' ? 'Connecting browser context…' : 'Page signals available';
  $('desktop-message').textContent = state.paused ? 'Pointer and browser-control observation are paused.' : desktop?.message || 'Browser-level observer is not attached to this session.';
  $('desktop-enable').hidden = !['permission-needed', 'focus-unavailable', 'error'].includes(desktop?.status);
  $('desktop-enable').textContent = desktop?.status === 'permission-needed' ? 'Enable address-bar signals ↗' : 'Reconnect browser context ↗';
  const address = state.paused ? null : desktop?.addressInput;
  $('address-input-panel').hidden = !address;
  $('address-input').textContent = address ? address.text || '(empty)' : '';
  $('address-input-state').textContent = sample?.active && sample.focus === 'address-bar' ? 'LIVE' : 'LAST OBSERVED';
  $('pointer-position').textContent = pointer && !state.paused ? `${Math.round(pointer.x)}, ${Math.round(pointer.y)}` : '—';
  $('pointer-region').textContent = pointer && !state.paused ? `${pointer.region.replaceAll('-', ' ')} · ${pointer.space === 'browser-window' ? 'window coordinates' : 'screen coordinates'}` : 'Waiting for browser focus';
  const mapped = pointer?.space === 'browser-window' && pointer.width > 0 && pointer.height > 0 && !state.paused;
  $('pointer-dot').hidden = !mapped;
  if (mapped) {
    $('pointer-dot').style.left = `${Math.max(0, Math.min(100, pointer.x / pointer.width * 100))}%`;
    $('pointer-dot').style.top = `${Math.max(0, Math.min(100, pointer.y / pointer.height * 100))}%`;
  }
  $('freshness').textContent = state.paused ? 'PAUSED' : state.stale ? 'NEW SIGNALS · UPDATING' : state.prediction ? 'LATEST ESTIMATE' : 'WAITING FOR SIGNALS';
  if (state.prediction && state.prediction.time !== lastPredictionTime) {
    lastPredictionTime = state.prediction.time;
    $('prediction-list').replaceChildren(...state.prediction.predictions.map((prediction, index) => {
      const card = element('article', 'prediction-card');
      const top = element('div', 'card-top');
      top.append(element('span', 'rank', index === 0 ? '01 / MOST LIKELY' : `0${index + 1} / ALTERNATIVE`));
      const confidence = element('span', 'confidence', String(Math.round(prediction.confidence * 100)));
      confidence.append(element('small', '', '%')); top.append(confidence);
      const meter = element('div', 'meter');
      const fill = element('div', 'meter-fill'); fill.style.width = `${prediction.confidence * 100}%`; meter.append(fill);
      meter.setAttribute('role', 'meter'); meter.setAttribute('aria-label', 'Estimated confidence'); meter.setAttribute('aria-valuenow', String(Math.round(prediction.confidence * 100))); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100');
      card.append(top, element('h3', '', prediction.action), element('p', '', prediction.evidence), meter);
      return card;
    }));
    $('intent').textContent = state.prediction.intent;
    $('summary').textContent = state.prediction.summary;
    $('latency').textContent = `${(state.prediction.durationMs / 1000).toFixed(1)}s · ${new Date(state.prediction.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (state.activity.length) {
    $('activity-list').replaceChildren(...state.activity.slice(-20).reverse().map((event) => {
      const row = element('li', 'activity-item');
      const body = element('div', '');
      body.append(element('div', 'activity-kind', event.kind), element('div', 'activity-label', event.label));
      row.append(element('span', 'activity-icon', icons[event.kind] || '·'), body, element('time', 'activity-time', new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
      return row;
    }));
  }
}
function renderClipboard(clipboard) {
  const context = clipboard?.context;
  const labels = { waiting: 'WAITING', ready: 'RECENT TEXT', redacted: 'TEXT EXCLUDED', empty: 'NO TEXT', unavailable: 'TEXT UNAVAILABLE', inactive: 'BROWSER IN BACKGROUND', paused: 'PAUSED', disabled: 'DISABLED' };
  $('clipboard-status').textContent = labels[clipboard?.status] || 'WAITING';
  const operations = { copy: 'Copied', cut: 'Cut', paste: 'Pasted', 'clipboard-available': 'Available clipboard text', 'clipboard-change': 'Clipboard changed' };
  $('clipboard-message').textContent = context ? `${operations[context.operation]}${context.redacted ? ' · content excluded' : context.format === 'non-text' ? ' · images/files are not read' : clipboard?.status === 'empty' ? ' · no plain text available' : context.truncated ? ' · showing the first 2048 characters' : ''}`
    : clipboard?.status === 'paused' ? 'Clipboard observation is paused and its text has been cleared.'
    : clipboard?.status === 'inactive' ? 'Other apps are not observed. Clipboard text is read when the Rebrowse browser is in front.'
    : clipboard?.status === 'disabled' ? 'Clipboard context is disabled in settings.'
    : clipboard?.status === 'redacted' ? 'The focused field or selection is protected. Clipboard text was not read.'
    : clipboard?.status === 'unavailable' ? 'Clipboard text could not be read. Page copy and paste events remain available.'
    : 'Copy or paste in your browsing tab to add context.';
  $('clipboard-preview').hidden = clipboard?.status !== 'ready' || !context?.text;
  $('clipboard-text').textContent = clipboard?.status === 'ready' ? context?.text || '' : '';
  $('clipboard-origin').textContent = context ? `${context.source === 'system' ? 'System clipboard' : 'Page transfer'} · ${context.target.replaceAll('-', ' ')} · ${new Date(context.time).toLocaleTimeString()}${context.operation.startsWith('clipboard-') ? ' · source not observed' : ''}` : '';
  $('clipboard-used').textContent = clipboard?.lastUsedAt ? 'Included in the latest prediction request' : context && clipboard?.status === 'ready' ? 'Waiting for the next prediction' : '';
}
function renderWorkflow(state) {
  $('workflow-observations').textContent = `${state.observationCount || 0} page observations remembered`;
  $('workflow-save').textContent = state.journalStatus || 'Session only';
  const signature = JSON.stringify([state.tasks, state.taskLog, state.activeTaskId]);
  if (signature === lastWorkflowRender) return;
  lastWorkflowRender = signature;
  const tasks = state.tasks || [];
  const task = tasks.find((item) => item.id === state.activeTaskId) || tasks[0];
  $('workflow-empty').hidden = !!task;
  $('workflow-current').hidden = !task;
  if (task) {
    $('workflow-title').textContent = task.title;
    $('workflow-confidence').textContent = `${Math.round(task.confidence * 100)}% ESTIMATED CONFIDENCE`;
    const labels = { suspected: 'Early pattern · inferred from limited activity', repeating: 'Likely to repeat', uncertain: 'Bounded continuation', complete: 'Observed list finished' };
    $('workflow-status').textContent = `${task.pattern && task.status === 'complete' ? 'Planned resource batch finished' : labels[task.status]}${state.activeTaskId === task.id ? '' : ' · detected earlier'} · ${new Date(task.updatedAt).toLocaleTimeString()}`;
    $('workflow-reason').textContent = task.pattern ? `${task.pattern.action} · ${Math.round(task.pattern.repeatLikelihood * 100)}% estimated repeat likelihood. ${task.pattern.reason}` : task.reason;
    $('workflow-steps').replaceChildren(...task.steps.map((step) => element('li', '', step)));
    const statistics = [
      ['Item cycles observed', task.cycles.length], [task.pattern ? 'Planned targets finished' : 'Confirmed outcomes', task.completedItems.length],
      [task.pattern ? 'Planned items' : 'Total items', task.pattern ? task.workQueue.items.length : task.totalItems ?? 'Unknown'], ['Remaining in plan', task.workQueue.counts.knownRemaining],
    ];
    $('workflow-progress').replaceChildren(...statistics.map(([label, value]) => {
      const box = element('div', 'workflow-stat'); box.append(element('strong', '', String(value)), element('span', '', label)); return box;
    }));
    $('workflow-next').textContent = task.nextStep;
    $('workflow-remaining').textContent = task.remainingItems.length ? `${task.pattern ? 'Planned targets' : 'Known unprocessed items'}: ${task.remainingItems.join(', ')}`
      : task.pattern ? task.workQueue.items.length ? 'This planned batch is finished; its broader scope was inferred from context.' : 'Pattern detected. Remaining resources and the endpoint are not established yet.' : task.remainingCount === null ? 'The complete list is not established; remaining work is unknown.' : task.remainingCount ? 'Unprocessed item names have not been established.' : 'Every item in the observed list has a confirmed outcome.';
    const queue = task.workQueue;
    const decisions = { continue: 'NEXT TARGETS', stop: 'STOPPED', inspect: 'NO FURTHER TARGETS', complete: 'BATCH FINISHED' };
    $('queue-decision').textContent = decisions[queue.decision];
    $('queue-decision').dataset.decision = queue.decision;
    $('queue-reason').textContent = queue.reason;
    $('queue-counts').replaceChildren(...[
      ['Confirmed', queue.counts.confirmed], ['Ready', queue.counts.ready], ['In progress', queue.counts.inProgress], ['Unavailable', queue.counts.blocked],
    ].map(([label, value]) => { const cell = element('div', 'queue-stat'); cell.append(element('strong', '', String(value)), element('span', '', label)); return cell; }));
    $('queue-scope').textContent = queue.scope === 'inferred' ? `${queue.counts.known} planned targets · ${queue.counts.ready} ready · full endpoint ${task.pattern?.endKnown ? 'inferred' : 'unknown'}` : queue.scope === 'verified' ? `${queue.counts.total} unique items · ${queue.counts.remaining} remaining`
      : `At least ${queue.counts.knownRemaining} remaining · Total unknown`;
    $('queue-scope-reason').textContent = queue.scopeReason;
    $('queue-next').textContent = queue.nextItem ? `Suggested next item: ${queue.nextItem}` : queue.decision === 'complete' ? 'No further repetition suggested.' : 'No additional useful target is currently planned.';
    const itemStates = { unstarted: 'Ready', in_progress: 'In progress', confirmed: 'Confirmed', blocked: 'Unavailable' };
    $('queue-items').replaceChildren(...queue.items.map((item) => {
      const row = element('li', 'queue-item'); row.dataset.state = item.state;
      const body = element('div', ''); body.append(element('strong', '', item.item), element('p', '', item.reason),
        element('span', 'queue-citations', `Observations: ${item.evidenceIds.map((id) => `#${id}`).join(', ')}`));
      row.append(body, element('span', 'queue-state', itemStates[item.state])); return row;
    }));
    $('queue-completion-rule').textContent = queue.completionRule;
    $('workflow-evidence').replaceChildren(...task.evidence.map((entry) => {
      const row = element('li', ''); row.append(element('strong', '', `#${entry.id} · ${entry.title}`), element('span', '', entry.url), element('p', '', entry.signals)); return row;
    }));
    const draft = task.workflowDraft;
    $('workflow-draft').hidden = !draft;
    if (draft) {
      $('draft-title').textContent = draft.title;
      $('draft-summary').textContent = draft.summary;
      $('draft-inputs').replaceChildren(...draft.inputs.map((input) => {
        const row = element('div', 'draft-input'); row.append(element('code', '', `{{${input.name}}}`), element('span', '', input.description)); return row;
      }));
      $('draft-loop').textContent = draft.loop;
      $('draft-steps').replaceChildren(...draft.steps.map((step) => {
        const row = element('li', ''); row.append(element('strong', '', step.instruction), element('p', '', `Check: ${step.check}`), element('span', '', `Workflow step ${step.sourceStep}`)); return row;
      }));
      $('draft-skip').textContent = draft.skipCompleted;
      $('draft-stop').textContent = draft.stopWhen;
      $('draft-notes').replaceChildren(...draft.notes.map((note) => element('li', '', note)));
      $('draft-version').textContent = `Workflow v${draft.version} · Automatic`;
      $('draft-download').href = `./workflow/${encodeURIComponent(task.id)}.md`;

    }
  }
  const log = state.taskLog || [];
  $('workflow-count').textContent = `${log.length} ${log.length === 1 ? 'record' : 'records'}`;
  $('workflow-log').replaceChildren(...log.slice(-15).reverse().map((entry) => {
    const row = element('li', '');
    row.append(element('time', '', new Date(entry.updatedAt).toLocaleTimeString()), element('strong', '', `${entry.title} · ${Math.round(entry.confidence * 100)}%`),
      element('span', '', `${entry.status} · ${entry.cycles.length} item cycles · ${entry.completedItems.length} confirmed · ${entry.remainingCount ?? 'unknown'} remaining`));
    return row;
  }));
}
function renderExecution(state) {
  const run = state.execution?.run;
  $('automation-status').textContent = state.execution?.reason || 'Watching for a repeatable task with useful next targets.';
  $('workflow-run').hidden = !run;
  if (!run) return;
  const labels = { running: 'RUNNING AUTOMATICALLY', pausing: 'STOPPING', paused: 'STOPPED', complete: 'BATCH FINISHED' };
  $('run-title').textContent = `Workflow v${run.version}`;
  $('run-status').textContent = labels[run.status]; $('run-status').dataset.status = run.status;
  $('run-message').textContent = run.message;
  $('run-progress').textContent = `${run.completedItems.length} of ${run.plannedItems.length} planned items finished · ${run.actionCount} browser actions${run.item ? ` · ${run.item}` : ''}`;
  $('workflow-run-pause').hidden = !state.execution.busy;
  $('workflow-run-pause').disabled = run.status === 'pausing';
  $('run-stop-note').hidden = run.status !== 'paused';
  $('run-log').replaceChildren(...run.log.slice(-20).reverse().map((entry) => {
    const row = element('li', ''); row.append(element('time', '', new Date(entry.time).toLocaleTimeString()), element('span', '', entry.message)); return row;
  }));
}
const stream = new EventSource('./events');
stream.onmessage = (event) => { render(JSON.parse(event.data)); };
stream.onopen = () => { $('connection').textContent = connectedLabel; $('connection').parentElement.classList.remove('offline'); };
stream.onerror = () => { $('connection').textContent = 'Reconnecting…'; $('connection').parentElement.classList.add('offline'); };
async function command(name) {
  try {
    const response = await fetch(`./${name}`, { method: 'POST' });
    if (!response.ok) throw new Error('Command failed. Check that your Rebrowse session is connected.');
  } catch (error) { $('error').hidden = false; $('error').textContent = error.message; }
}
$('pause').onclick = () => command(state?.paused ? 'resume' : 'pause');
$('predict').onclick = () => command('predict');
$('desktop-enable').onclick = () => command('desktop-enable');
$('workflow-run-pause').onclick = () => command('workflow-pause');

function renderRecording(state) {
  const recording = state.recording;
  const active = recording && ['starting', 'recording', 'saving'].includes(recording.status);
  const labels = { idle: 'NOT RECORDING', starting: 'STARTING', recording: 'RECORDING', saving: 'SAVING', saved: 'SAVED LOCALLY', error: 'SAVE FAILED' };
  $('recording-status').textContent = labels[recording?.status] || 'NOT RECORDING';
  $('recording-start').hidden = !!active;
  $('recording-start').disabled = !!state.paused;
  $('recording-stop').hidden = !active;
  $('recording-stop').disabled = recording?.status !== 'recording';
  $('recording-download').hidden = recording?.status !== 'saved';
  $('recording-replay').hidden = recording?.status !== 'saved';
  $('recording-replay').disabled = state.replay?.status === 'running' || !recording?.steps;
  $('recording-progress').textContent = recording?.error || (recording?.id ? `${recording.name} · ${recording.steps} observed steps · ${recording.actions} meaningful action signals · ${recording.frames} page states` : 'Page states and browser signals are saved locally when recording is on.');
  const first = recording?.firstDetection;
  $('recording-detection').textContent = first ? `First new or updated finding used step ${first.step}: ${first.title} · ${Math.round(first.confidence * 100)}% confidence · ${(first.durationMs / 1000).toFixed(1)}s response · appeared ${(first.elapsedMs / 1000).toFixed(1)}s into the recording.` : active ? 'Waiting for the first accepted pattern finding…' : '';
  const replay = state.replay;
  $('replay-result').hidden = !replay || replay.status === 'idle';
  $('replay-download').hidden = !replay?.report;
  const report = replay?.report;
  $('replay-summary').textContent = replay?.error || (replay?.status === 'running' ? `Inferring patterns from saved activity… ${replay.progress} steps checked. Replay does not execute actions.` : report ? `${report.verdict === 'error' ? 'Some predictions could not finish' : report.verdict === 'incomplete' ? 'Replay incomplete' : 'Replay complete'} · First pattern discovered: ${report.firstDetectionStep === null ? 'none yet' : 'step ' + report.firstDetectionStep} · Mean response: ${report.meanInferenceMs === null ? '—' : (report.meanInferenceMs / 1000).toFixed(1) + 's'}` : '');
  $('replay-baseline').textContent = report ? `${report.evaluatedSteps} of ${report.totalSteps} steps checked. ${report.baselineCount} observations were already present when recording started. Steps are state/action checkpoints, not keystrokes.` : '';
  $('replay-rows').replaceChildren(...(report?.rows || []).map((row) => {
    const tr = document.createElement('tr');
    for (const value of [row.step, row.resources, row.error || row.detected || (row.proposed ? 'Proposed; not accepted' : 'None yet'), row.confidence === null ? '—' : Math.round(row.confidence * 100) + '%', row.durationMs === null ? '—' : (row.durationMs / 1000).toFixed(1) + 's']) tr.append(element('td', '', String(value)));
    return tr;
  }));
}
async function recordingCommand(name) {
  try {
    const response = await fetch('./recording-' + name, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || 'Recording command failed.');
  } catch (error) { $('error').hidden = false; $('error').textContent = error.message; }
}
$('recording-start').onclick = () => recordingCommand('start');
$('recording-stop').onclick = () => recordingCommand('stop');
$('recording-replay').onclick = () => recordingCommand('replay');
