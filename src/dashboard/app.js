const $ = (id) => document.getElementById(id);
let state;
let lastPredictionTime;
let lastWorkflowRender;
const statusNames = { watching: 'Watching', collecting: 'Reading context', predicting: 'Predicting', ready: 'Watching', paused: 'Paused', error: 'Needs attention', 'needs-key': 'Key needed' };
const stages = { watching: 'Listening for activity', collecting: 'Reading the current page', predicting: 'Estimating the next move', ready: 'Prediction updated', paused: 'Observation paused', error: 'Prediction unavailable', 'needs-key': 'Waiting for API key' };
const icons = { click: '↗', hover: '⌁', edit: '⌨', focus: '⊡', scroll: '↕', navigate: '→', tab: '▣', 'address-select': '⌘', 'address-focus': '⌕', 'address-edit': '⌨', 'pointer-dwell': '⌁', 'browser-focus': '▣' };
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
  $('predict').disabled = state.paused || !state.page || ['collecting', 'predicting', 'needs-key'].includes(state.status);
  $('thinking-state').textContent = stages[state.status];
  $('event-count').textContent = String(state.activity.length);
  $('requests').textContent = `${state.requests} predictions requested`;
  renderWorkflow(state);
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
    const labels = { suspected: 'Possible repeatable task · repetition not yet observed', repeating: 'Likely to repeat', uncertain: 'Continuation uncertain', complete: 'Observed list finished' };
    $('workflow-status').textContent = `${labels[task.status]}${state.activeTaskId === task.id ? '' : ' · detected earlier'} · ${new Date(task.updatedAt).toLocaleTimeString()}`;
    $('workflow-reason').textContent = task.reason;
    $('workflow-steps').replaceChildren(...task.steps.map((step) => element('li', '', step)));
    const statistics = [
      ['Item cycles observed', task.cycles.length], ['Confirmed outcomes', task.completedItems.length],
      ['Total items', task.totalItems ?? 'Unknown'], ['Remaining', task.remainingCount ?? 'Unknown'],
    ];
    $('workflow-progress').replaceChildren(...statistics.map(([label, value]) => {
      const box = element('div', 'workflow-stat'); box.append(element('strong', '', String(value)), element('span', '', label)); return box;
    }));
    $('workflow-next').textContent = task.nextStep;
    $('workflow-remaining').textContent = task.remainingItems.length ? `Known unprocessed items: ${task.remainingItems.join(', ')}`
      : task.remainingCount === null ? 'The complete list is not established; remaining work is unknown.' : task.remainingCount ? 'Unprocessed item names have not been established.' : 'Every item in the observed list has a confirmed outcome.';
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
        const row = element('li', ''); row.append(element('strong', '', step.instruction), element('p', '', `Check: ${step.check}`), element('span', '', `Based on observed step ${step.sourceStep}`)); return row;
      }));
      $('draft-skip').textContent = draft.skipCompleted;
      $('draft-stop').textContent = draft.stopWhen;
      $('draft-review').replaceChildren(...draft.reviewNotes.map((note) => element('li', '', note)));
      $('draft-version').textContent = `Suggestion v${draft.version} · Review only · Not executed`;
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
const stream = new EventSource('./events');
stream.onmessage = (event) => { render(JSON.parse(event.data)); $('connection').textContent = 'Connected locally'; $('connection').parentElement.classList.remove('offline'); };
stream.onopen = () => { $('connection').textContent = 'Connected locally'; $('connection').parentElement.classList.remove('offline'); };
stream.onerror = () => { $('connection').textContent = 'Reconnecting…'; $('connection').parentElement.classList.add('offline'); };
async function command(name) {
  try {
    const response = await fetch(`./${name}`, { method: 'POST' });
    if (!response.ok) throw new Error('Command failed. Reconnect to the local session.');
  } catch (error) { $('error').hidden = false; $('error').textContent = error.message; }
}
$('pause').onclick = () => command(state?.paused ? 'resume' : 'pause');
$('predict').onclick = () => command('predict');
$('desktop-enable').onclick = () => command('desktop-enable');
