import { icon, setIcon } from './ui/icons.js';

const get = (id) => document.getElementById(id);
const start = get('start');
const status = get('status');
const browser = get('browser');
const address = get('address');
const viewport = browser.parentElement;
const dashboard = get('dashboard');
const watchToggle = get('watch-toggle');
let watch = { label: 'Connecting…', tone: 'quiet', enabled: false, paused: false };
let watchPending = false;
let selected;
let expiresAt = 0;
let busy = false;
let tabs = [];
let tabSignature;

function message(text = '', error = false) {
  status.hidden = !text;
  status.textContent = text;
  status.toggleAttribute('data-error', error);
}

function renderWatch() {
  get('watch-label').textContent = watch.label;
  get('watch-status').dataset.tone = watch.tone;
  get('watch-action').textContent = watch.paused ? 'Resume watching' : 'Pause watching';
  setIcon(watchToggle.querySelector('use'), watch.paused ? 'play' : 'pause');
  watchToggle.disabled = !watch.enabled || watchPending;
}

window.addEventListener('message', (event) => {
  if (!expiresAt || event.origin !== location.origin || event.source !== dashboard.contentWindow || event.data?.type !== 'rebrowse-watch') return;
  watch = event.data;
  renderWatch();
});

watchToggle.onclick = async () => {
  if (!watch.enabled || watchPending || !expiresAt) return;
  const expiry = expiresAt;
  watchPending = true;
  renderWatch();
  message();
  try {
    await request(watch.paused ? '/dashboard/resume' : '/dashboard/pause', 'POST');
  } catch {
    if (expiresAt === expiry) message('Couldn’t change watching status. Check that the session is still connected.', true);
  } finally {
    if (expiresAt === expiry) {
      watchPending = false;
      renderWatch();
    }
  }
};

async function request(path, method = 'GET', body) {
  const response = await fetch(path, { method, ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (response.status === 204) return;
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

function renderTabs(next, updateAddress = false) {
  tabs = next;
  if (!next.some((tab) => tab.id === selected)) selected = next[0]?.id;
  const current = next.find((tab) => tab.id === selected);
  const signature = JSON.stringify([next.map(({ id, title }) => [id, title]), selected]);
  if (signature !== tabSignature) {
    tabSignature = signature;
    get('tabs').replaceChildren(...next.map((tab) => {
      const item = document.createElement('div');
      item.className = 'tab';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'button tab-select';
      select.title = tab.title;
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title;
      select.append(icon('globe-alt'), title);
      select.setAttribute('aria-pressed', String(tab.id === selected));
      select.onclick = () => changeTab('select', tab.id);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'button icon-button';
      close.append(icon('x-mark'));
      close.setAttribute('aria-label', `Close ${tab.title}`);
      close.disabled = next.length <= 1;
      close.onclick = () => changeTab('close', tab.id);
      item.append(select, close);
      return item;
    }));
  }
  if (updateAddress || document.activeElement !== address) {
    const url = current?.url || '';
    if (!url.startsWith('chrome-error:')) address.value = /^https?:/.test(url) ? url : '';
  }
  const view = current?.view;
  browser.hidden = !view;
  if (view && browser.getAttribute('src') !== view) browser.src = view;
  if (!view) browser.removeAttribute('src');
  const notices = get('browser-message');
  notices.hidden = !!view;
  get('browser-message-text').textContent = current?.url === 'about:blank' ? 'Search or enter a website address.' : 'Connecting to this tab…';
}

function show(result) {
  expiresAt = result.expiresAt;
  dashboard.src = '/dashboard/';
  get('welcome').hidden = true;
  get('workspace').hidden = false;
  get('session-controls').hidden = false;
  renderTabs(result.tabs, true);
  address.focus();
  updateTime();
}

function reset(text) {
  expiresAt = 0;
  selected = undefined;
  tabs = [];
  watchPending = false;
  watch = { label: 'Connecting…', tone: 'quiet', enabled: false, paused: false };
  renderWatch();
  dashboard.removeAttribute('src');
  browser.removeAttribute('src');
  get('workspace').hidden = true;
  get('session-controls').hidden = true;
  get('welcome').hidden = false;
  message(text);
}

async function changeTab(action, tabId = selected, url) {
  if (busy || !expiresAt) return;
  busy = true;
  message();
  get('go').disabled = true;
  try {
    const size = { width: viewport.clientWidth, height: viewport.clientHeight };
    const result = await request('/api/tab', 'POST', { action, tabId, url, viewport: size });
    if (!expiresAt) return;
    selected = result.selected ?? selected;
    renderTabs(result.tabs, true);
    if (action === 'new') address.focus();
  } catch (error) { message(error.message, true); }
  finally { busy = false; get('go').disabled = false; }
}

function updateTime() {
  const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  get('expiration').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} left`;
  if (!remaining) reset('Your browser session ended. You can start a new one.');
}

start.onclick = async () => {
  start.disabled = true;
  message('Starting a cloud browser…');
  try { show(await request('/api/session', 'POST')); message(); }
  catch (error) { message(error.message, true); }
  finally { start.disabled = false; }
};

get('end').onclick = async () => {
  get('end').disabled = true;
  try { await request('/api/session', 'DELETE'); reset('Session ended.'); }
  catch (error) { message(error.message, true); }
  finally { get('end').disabled = false; }
};

get('navigation').onsubmit = (event) => { event.preventDefault(); void changeTab('navigate', selected, address.value); };
for (const action of ['new', 'back', 'forward', 'reload']) get(action).onclick = () => changeTab(action);

setInterval(() => { if (expiresAt) updateTime(); }, 1000);
let polling = false;
setInterval(async () => {
  if (busy || polling || !expiresAt) return;
  polling = true;
  const sessionExpiry = expiresAt;
  const previousTabs = tabs;
  try {
    const result = await request('/api/session');
    if (!busy && expiresAt === sessionExpiry && tabs === previousTabs) renderTabs(result.tabs);
  } catch (error) {
    if (expiresAt !== sessionExpiry) return;
    if (error.status === 404) reset(error.message);
  } finally { polling = false; }
}, 2500);

request('/api/session').then(show).catch((error) => { if (error.status !== 404) message(error.message, true); })
  .finally(() => { start.disabled = false; });
