import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@browserbasehq/stagehand";
import type { Activity, BrowserObserver, ObservationOptions, PageContext } from "./observer.js";
import { readContext } from "./observer.js";
import { predictNext, type Prediction } from "./predictor.js";
import type { DesktopObserver, DesktopState } from "./desktop-context.js";
import { TaskMemory, TaskJournal, taskReport, type TaskRecord } from "./tasks.js";
import { workflowDraftReport } from "./workflow-draft.js";
import { WorkflowRunner, workflowReadiness, type WorkflowDriver, type StepPlanner, type ResourcePlanner, type WorkflowRun, type RunReadiness, type WorkflowRunJournal } from "./workflow-runner.js";
import { clipboardEnabled, clipboardStatus, freshClipboard, sanitizeClipboard, CLIPBOARD_TTL_MS, type ClipboardContext, type ClipboardState } from "./clipboard-context.js";
import { SessionRecorder, parseRecording, type RecordingState } from "./recording.js";
import { replayRecording, replayReportMarkdown, type ReplayReport } from "./replay.js";
import { resolve } from "node:path";

type DashboardState = {
  paused: boolean;
  status: "watching" | "collecting" | "predicting" | "ready" | "paused" | "error" | "needs-key";
  page: { title: string; url: string } | null;
  activity: Activity[];
  prediction: (Prediction & { time: number; durationMs: number; url: string }) | null;
  stale: boolean;
  requests: number;
  error: string | null;
  desktop: DesktopState | null;
  tasks: TaskRecord[];
  taskLog: TaskRecord[];
  activeTaskId: string | null;
  observationCount: number;
  journalStatus: string;
  execution: { available: boolean; busy: boolean; run: WorkflowRun | null; offers: Record<string, RunReadiness>; reason: string };
  clipboard: ClipboardState;
  recording: RecordingState | null;
  replay: { status: "idle" | "running" | "done" | "error"; progress: number; report: ReplayReport | null; error: string | null };
};

export class PredictionDashboard {
  readonly state: DashboardState = {
    paused: false, status: "watching", page: null, activity: [], prediction: null,
    stale: false, requests: 0, error: null, desktop: null,
    tasks: [], taskLog: [], activeTaskId: null, observationCount: 0, journalStatus: "Session only",
    execution: { available: false, busy: false, run: null, offers: {}, reason: "Watching for a repeatable task with useful next targets." },
    clipboard: { status: clipboardEnabled() ? "waiting" : "disabled", context: null, lastUsedAt: null },
    recording: null, replay: { status: "idle", progress: 0, report: null, error: null },
  };
  observer?: BrowserObserver;
  desktopObserver?: DesktopObserver;
  private listeners = new Set<(state: DashboardState) => void>();
  private target?: Page;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private stopped = false;
  private revision = 0;
  private lastRequest = 0;
  private pending = false;
  private abort?: AbortController;
  private urgent = false;
  readonly taskMemory = new TaskMemory();
  runner?: WorkflowRunner;
  private clipboardTimer?: ReturnType<typeof setTimeout>;
  private autoTimer?: ReturnType<typeof setTimeout>;
  private humanEpoch = 0;
  private lastAutoEpoch = -1;
  private startedPlans = new Set<string>();
  readonly recorder: SessionRecorder;
  private replayAbort?: AbortController;
  private startingRecording = false;
  private automaticReason = "Watching for a repeatable task with useful next targets.";

  constructor(private options: {
    predict?: typeof predictNext;
    isConfigured?: () => boolean;
    debounceMs?: number;
    intervalMs?: number;
    journal?: TaskJournal;
    autoDelayMs?: number;
    recorder?: SessionRecorder;
  } = {}) {
    if (options.journal) this.state.journalStatus = "Detections save locally";
    this.recorder = options.recorder || new SessionRecorder(resolve("session-data/recordings"));
    this.state.recording = { ...this.recorder.state };
    this.recorder.onChange(() => this.publish());
  }

  subscribe(listener: (state: DashboardState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish() {
    this.state.recording = { ...this.recorder.state };
    this.state.execution = { available: !!this.runner, busy: this.runner?.busy || false, run: this.runner?.state || null,
      offers: Object.fromEntries(this.state.tasks.map((task) => [task.id, workflowReadiness(task)])), reason: this.runner?.busy ? this.runner.state?.message || "Running the detected workflow." : this.automaticReason };
    this.listeners.forEach((listener) => listener(this.state));
  }

  attachRunner(options: { driver: () => Promise<WorkflowDriver>; plan?: StepPlanner; resourcePlan?: ResourcePlanner; journal?: WorkflowRunJournal; settleMs?: number }) {
    if (this.runner) throw new Error("The workflow runner is already connected.");
    this.runner = new WorkflowRunner({ ...options, getTask: (id) => this.taskMemory.tasks.find((task) => task.id === id),
      item: async (id, item, status, reason, snapshot) => {
        const record = this.taskMemory.recordExecution(id, item, status, reason, snapshot?.context, snapshot?.pageId, snapshot?.openedUrl);
        this.state.tasks = this.taskMemory.tasks; this.state.taskLog = this.taskMemory.log;
        this.state.observationCount = this.taskMemory.observations.length; this.state.activeTaskId = id;
        if (snapshot) {
          const frame = this.taskMemory.observations.findLast((frame) => frame.actor === "workflow" && frame.pageId === snapshot.pageId);
          if (frame) this.recorder.observation(frame);
        }
        if (this.options.journal) {
          try { await this.options.journal.append(record); this.state.journalStatus = "Saved locally"; }
          catch { this.state.journalStatus = "Local save failed"; throw new Error("The queue update could not be saved. Execution stopped."); }
        }
        this.publish();
      },
      change: () => {
        if (this.runner?.state) { this.automaticReason = this.runner.state.message; this.recorder.workflow(this.runner.state); }
        this.publish();
      },
      lock: (locked) => {
        this.revision++; this.abort?.abort(); clearTimeout(this.timer); this.timer = undefined; this.pending = false;
        this.observer?.suppress(locked || this.state.paused); this.desktopObserver?.setPaused(locked || this.state.paused);
        this.state.stale = this.state.prediction !== null;
        this.state.status = this.state.paused ? "paused" : "watching";
        this.clearClipboard(locked || this.state.paused ? "paused" : "waiting");
      },
    });
    this.publish();
  }
  get executionBusy() { return this.runner?.busy || false; }
  private scheduleWorkflow(task: TaskRecord) {
    clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
    const readiness = workflowReadiness(task);
    if (!this.runner) { this.automaticReason = "Pattern detected, but the browser runner is not connected."; return; }
    if (this.state.paused || this.stopped || this.executionBusy) return;
    if (!readiness.canRun) { this.automaticReason = readiness.reason; return; }
    if (this.humanEpoch <= this.lastAutoEpoch) { this.automaticReason = "This activity has already been handled or stopped. Waiting for new browsing activity."; return; }
    if (task.pattern && task.pattern.repeatLikelihood < .6 || task.confidence < (task.pattern ? .55 : .7)) { this.automaticReason = "Pattern detected; waiting for stronger evidence before running it."; return; }
    const latest = this.state.activity.at(-1);
    if (latest && ["address-select", "address-focus", "address-edit"].includes(latest.kind)) { this.automaticReason = "Waiting while you edit the address bar, then reassessing the next action."; return; }
    const key = JSON.stringify([task.id, task.workflowDraft.steps, task.pattern?.targets || task.workQueue.items.filter((item) => item.state === "unstarted").map((item) => item.item)]);
    if (this.startedPlans.has(key)) { this.automaticReason = "This planned batch has already run. Waiting for new work."; return; }
    const epoch = this.humanEpoch; const revision = this.revision;
    const prediction = this.state.prediction;
    this.automaticReason = `Starting ${readiness.count} planned ${readiness.count === 1 ? "item" : "items"} automatically.`;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = undefined;
      if (this.stopped || this.state.paused || this.executionBusy || this.busy || prediction !== this.state.prediction || epoch !== this.humanEpoch || revision !== this.revision) {
        this.automaticReason = "Waiting for the latest browsing prediction before running the next batch."; this.publish(); return;
      }
      this.startedPlans.add(key); this.lastAutoEpoch = epoch;
      try { this.runner!.start(task.id); } catch (error) { this.state.error = error instanceof Error ? error.message : "Workflow could not start."; this.automaticReason = this.state.error; this.publish(); }
    }, this.options.autoDelayMs ?? 700);
  }
  pauseWorkflow() { clearTimeout(this.autoTimer); this.autoTimer = undefined; this.lastAutoEpoch = this.humanEpoch; this.automaticReason = "Workflow stopped. New browsing activity can lead to another bounded batch."; this.runner?.pause(); this.publish(); }
  finishExecution() { return this.runner?.settled() ?? Promise.resolve(); }
  async startRecording() {
    if (this.stopped || this.state.paused) throw new Error("Resume watching before recording a demonstration.");
    if (this.startingRecording) throw new Error("A recording is already starting.");
    this.startingRecording = true;
    this.replayAbort?.abort();
    try {
      await this.recorder.start({ name: `Browsing session ${new Date().toISOString()}`, expected: null }, this.taskMemory.context(this.state.activity).observations, this.state.tasks.length);
      if (this.runner?.state) this.recorder.workflow(this.runner.state);
      this.state.replay = { status: "idle", progress: 0, report: null, error: null }; this.publish();
    } finally { this.startingRecording = false; }
  }
  async stopRecording() { await this.recorder.stop(); this.publish(); }
  finishRecording() { return this.recorder.stop("Browser session ended."); }
  async replayLatest() {
    if (this.state.replay.status === "running") throw new Error("A replay is already running.");
    if (this.recorder.active) throw new Error("Stop the recording before replaying it.");
    if (!(this.options.isConfigured?.() ?? !!process.env.SUBQ_API_KEY?.trim())) throw new Error("Add SUBQ_API_KEY and restart to replay with SubQ.");
    const abort = new AbortController(); this.replayAbort = abort;
    this.state.replay = { status: "running", progress: 0, report: null, error: null }; this.publish();
    let records;
    try { records = parseRecording(await this.recorder.download()); }
    catch (error) { this.state.replay = { status: "error", progress: 0, report: null, error: "No saved recording is available." }; this.publish(); throw error; }
    if (abort.signal.aborted) return;
    void replayRecording(records, { mode: "live", expected: null, maxSteps: 12, signal: abort.signal, predict: this.options.predict,
      progress: (row) => { if (!abort.signal.aborted) { this.state.replay.progress = row.step; this.publish(); } },
    }).then((report) => {
      if (abort.signal.aborted) return;
      this.state.replay = { status: "done", progress: report.evaluatedSteps, report, error: null }; this.publish();
    }).catch(() => {
      if (!abort.signal.aborted) { this.state.replay = { status: "error", progress: this.state.replay.progress, report: null, error: "Replay could not finish. Check the recording and SubQ connection." }; this.publish(); }
    });
  }

  private isAutomatedContext(context: PageContext, page: Page) {
    const identity = context.publicUrl || context.url;
    const automated = this.taskMemory.observations.findLast((frame) => frame.actor === "workflow" && frame.pageId === page.pageId
      && (frame.context.publicUrl || frame.context.url) === identity);
    return !!automated && !this.state.activity.some((event) => event.pageId === page.pageId && event.time > automated.time
      && ["click", "edit", "paste", "address-edit"].includes(event.kind));
  }

  observe(context: PageContext, page: Page, options?: ObservationOptions) {
    if (this.stopped || this.state.paused || this.executionBusy || this.isAutomatedContext(context, page)) return;
    const identity = context.publicUrl || context.url;
    const newResource = !!context.title && !this.taskMemory.observations.some((frame) => frame.actor !== "workflow"
      && (frame.context.publicUrl || frame.context.url) === identity && frame.context.title === context.title);
    const changed = this.taskMemory.observe(context, page.pageId, this.state.activity);
    const frame = this.taskMemory.observations.findLast((frame) => frame.pageId === page.pageId);
    if (frame) this.recorder.observation(frame, options?.background ? this.target?.pageId : page.pageId);
    if (!changed) return;
    this.state.observationCount = this.taskMemory.observations.length;
    if (!options?.background || !this.target) this.target = page;
    this.state.stale = this.state.prediction !== null;
    this.publish();
    // DOM updates are useful memory, but must not repeatedly cancel inference
    // or keep resetting its debounce on animated/live pages. User activity
    // still invalidates stale results through the separate revision counter.
    if (newResource && this.taskMemory.observations.filter((frame) => frame.actor !== "workflow").length >= 2) {
      this.urgent = true;
      this.schedule(200);
    } else if (this.busy) this.pending = true;
    else if (!this.timer) this.schedule();
  }

  reportTasks() { return taskReport(this.state.taskLog); }
  reportWorkflow(id: string) {
    const task = this.state.tasks.find((task) => task.id === id);
    return task ? workflowDraftReport(task.workflowDraft) : undefined;
  }
  flushTasks() { return this.options.journal?.flush() ?? Promise.resolve(); }

  desktop(state: DesktopState) {
    if (this.stopped) return;
    if (state.sample && this.state.desktop?.sample && state.sample.time < this.state.desktop.sample.time) return;
    const inputChanged = state.addressInput?.text !== undefined && state.addressInput.text !== this.state.desktop?.addressInput?.text;
    if (!this.state.paused && inputChanged) {
      this.revision++;
      this.abort?.abort();
      this.state.stale = this.state.prediction !== null;
    }
    this.state.desktop = this.state.paused ? { ...state, sample: null, path: [], addressInput: null } : state;
    if (!this.state.paused) this.recorder.desktop(state);
    this.publish();
  }

  async enableDesktopContext() { await this.desktopObserver?.requestPermission(); }

  private clearClipboard(status: ClipboardState["status"]) {
    clearTimeout(this.clipboardTimer); this.clipboardTimer = undefined;
    this.state.clipboard = { status: clipboardEnabled() ? status : "disabled", context: null, lastUsedAt: null };
  }
  clipboardStatus(status: ClipboardState["status"]) {
    if (this.stopped || this.state.paused || this.executionBusy || !clipboardEnabled()) return;
    if (this.state.clipboard.status === status && !this.state.clipboard.context) return;
    if (this.state.clipboard.context) { this.revision++; this.abort?.abort(); this.state.stale = this.state.prediction !== null; }
    this.clearClipboard(status); this.publish();
  }

  activity(event: Activity, page: Page) {
    if (this.stopped || this.state.paused || this.executionBusy) return;
    const automatedPage = this.taskMemory.observations.some((frame) => frame.actor === "workflow" && frame.pageId === page.pageId && frame.context.url === event.url);
    const ownNavigation = event.kind === "navigate" && automatedPage;
    if (!ownNavigation && !(event.kind === "tab" && automatedPage)) this.recorder.activity(event);
    // Incidental movement must not throw away a useful pattern analysis or
    // keep restarting the quiet period while the user browses a collection.
    if (["hover", "scroll", "pointer-dwell"].includes(event.kind)) {
      this.state.activity = [...this.state.activity, event].slice(-60);
      this.publish();
      if (!this.busy && !this.timer) this.schedule();
      return;
    }
    this.target = page;
    clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
    this.automaticReason = "Updating the next actions from your latest browsing activity.";
    if (!ownNavigation && ["click", "navigate", "edit", "paste", "address-edit"].includes(event.kind)) this.humanEpoch++;
    this.revision++;
    if (event.clipboard && ["copy", "cut", "paste", "clipboard-change", "clipboard-available"].includes(event.kind)) {
      if (!clipboardEnabled()) return;
      const data = sanitizeClipboard(event.clipboard);
      this.clearClipboard(clipboardStatus(data));
      this.state.clipboard.context = { ...data, time: event.time, operation: event.kind as ClipboardContext["operation"], pageId: page.pageId, url: event.url };
      this.clipboardTimer = setTimeout(() => {
        this.revision++; this.abort?.abort(); this.clearClipboard("waiting"); this.state.stale = this.state.prediction !== null; this.publish();
      }, CLIPBOARD_TTL_MS);
      this.clipboardTimer.unref();
      // Raw text is transient prediction context, not activity history or
      // workflow journal evidence. Only operation metadata is retained there.
      const { text: _text, ...metadata } = data;
      event = { ...event, clipboard: metadata };
      this.abort?.abort();
    }
    this.state.activity = [...this.state.activity, event].slice(-60);
    this.state.page = { title: this.state.page?.url === event.url ? this.state.page.title : "Browsing", url: event.url };
    this.state.stale = this.state.prediction !== null;
    this.state.error = null;
    if (!this.busy) this.state.status = "watching";
    this.publish();
    if (["navigate", "address-select", "address-focus", "address-edit", "copy", "cut", "paste", "clipboard-change", "clipboard-available"].includes(event.kind)) {
      this.urgent = true;
      if (event.kind !== "navigate") this.abort?.abort();
      this.schedule(event.kind === "navigate" ? 250 : 100);
    } else this.schedule();
  }

  reportError(message: string) {
    if (this.stopped || this.state.paused) return;
    this.state.error = message.slice(0, 250);
    this.state.status = "error";
    this.publish();
  }

  setPaused(paused: boolean) {
    clearTimeout(this.autoTimer);
    if (paused) { this.abort?.abort(); this.runner?.pause("Watching was paused. Execution is stopping after its current browser action."); }
    this.state.paused = paused;
    this.automaticReason = paused ? "Watching is paused. No new workflow actions will start." : "Watching resumed; checking for the next useful workflow.";
    this.revision++;
    this.state.status = paused ? "paused" : "watching";
    this.state.stale = this.state.prediction !== null;
    this.observer?.suppress(paused || this.executionBusy);
    this.desktopObserver?.setPaused(paused || this.executionBusy);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = false;
    this.urgent = false;
    this.clearClipboard(paused ? "paused" : "waiting");
    this.publish();
    if (!paused) this.schedule();
  }

  requestPrediction() { this.schedule(0); }

  private schedule(delay = this.options.debounceMs ?? 700) {
    if (this.stopped || this.state.paused || this.executionBusy || !this.target) return;
    this.pending = true;
    clearTimeout(this.timer);
    if (!this.busy) {
      const wait = this.urgent ? delay : Math.max(delay, this.lastRequest + (this.options.intervalMs ?? 3000) - Date.now());
      this.timer = setTimeout(() => void this.run(), wait);
    }
  }

  private recordPattern(hypothesis: Prediction["repeatableTask"]) {
    const record = this.taskMemory.accept(hypothesis);
    this.state.tasks = this.taskMemory.tasks;
    this.state.taskLog = this.taskMemory.log;
    this.state.activeTaskId = hypothesis && hypothesis.confidence >= 0.55
      ? this.state.tasks.find((task) => task.id === hypothesis.taskId || task.title.toLowerCase() === hypothesis.title.toLowerCase())?.id || null : null;
    if (record && this.options.journal) {
      this.state.journalStatus = "Saving locally…";
      void this.options.journal.append(record).then(() => {
        this.state.journalStatus = "Saved locally"; this.publish();
      }).catch(() => {
        this.state.journalStatus = "Local save failed · report still available"; this.publish();
      });
    }
    return record;
  }

  private async run() {
    this.timer = undefined;
    if (this.stopped || this.state.paused || this.executionBusy || this.busy || !this.target) return;
    this.pending = false;
    this.urgent = false;
    if (!(this.options.isConfigured?.() ?? !!process.env.SUBQ_API_KEY?.trim())) {
      this.state.status = "needs-key";
      this.state.error = "Add SUBQ_API_KEY to .env and restart to enable predictions.";
      this.publish(); return;
    }
    const page = this.target;
    const revision = this.revision;
    const events = this.state.activity.filter((event) => event.pageId === page.pageId);
    const start = Date.now();
    this.busy = true;
    this.lastRequest = start;
    this.state.status = "collecting";
    this.state.error = null;
    this.publish();
    let context: PageContext | undefined;
    let recordingRequest: { sessionId: string | null; step: number; startedAt: number } | undefined;
    try {
      context = await readContext(page);
      if (!this.isAutomatedContext(context, page)) this.taskMemory.observe(context, page.pageId, this.state.activity);
      const frame = this.taskMemory.observations.findLast((frame) => frame.pageId === page.pageId);
      if (frame) this.recorder.observation(frame, page.pageId);
      this.state.observationCount = this.taskMemory.observations.length;
      if (revision !== this.revision || this.stopped) return;
      this.state.page = { title: context.title, url: context.url };
      this.state.status = "predicting";
      this.state.requests++;
      this.publish();
      this.abort = new AbortController();
      const desktop = this.state.desktop?.pageId === page.pageId ? this.state.desktop : null;
      const observationVersion = this.taskMemory.observations.at(-1)?.id;
      const clipboard = freshClipboard(this.state.clipboard) ? structuredClone(this.state.clipboard) : null;
      if (clipboard) { this.state.clipboard.lastUsedAt = Date.now(); this.publish(); }
      const recordingSession = this.recorder.capturing ? this.recorder.state.id : null;
      const recordingStep = this.recorder.state.steps;
      recordingRequest = { sessionId: recordingSession, step: recordingStep, startedAt: Date.now() };
      this.recorder.inference({ ...recordingRequest, phase: "started", durationMs: 0 });
      const prediction = await (this.options.predict ?? predictNext)(context, events, this.abort.signal, desktop, this.taskMemory.context(this.state.activity), clipboard);
      if (this.stopped || this.state.paused || this.executionBusy || this.abort.signal.aborted) {
        this.recorder.inference({ ...recordingRequest, phase: "cancelled", durationMs: Date.now() - recordingRequest.startedAt }); return;
      }
      // A completed pattern describes observed history and can still be
      // useful after another click. Never execute it from an outdated result;
      // the immediate prediction and auto-run still require a fresh revision.
      const detection = this.recordPattern(prediction.repeatableTask);
      this.recorder.prediction(prediction, { ...recordingRequest, durationMs: Date.now() - recordingRequest.startedAt, accepted: !!detection, stale: revision !== this.revision });
      if (revision !== this.revision || this.stopped) return;
      // Detect navigations that happened between observation scans.
      const latest = await readContext(page);
      if ((latest.publicUrl || latest.url) !== (context.publicUrl || context.url)) { this.schedule(); return; }
      if (revision !== this.revision || this.stopped) return;
      this.state.prediction = { ...prediction, time: Date.now(), durationMs: Date.now() - start, url: context.url };
      clearTimeout(this.autoTimer);
      this.state.stale = this.taskMemory.observations.at(-1)?.id !== observationVersion;
      this.state.status = "ready";
      const activeTask = this.state.tasks.find((task) => task.id === this.state.activeTaskId);
      if (activeTask) this.scheduleWorkflow(activeTask);
      else this.automaticReason = "Watching for a repeatable task with useful next targets.";
    } catch (error) {
      if (recordingRequest) this.recorder.inference({ ...recordingRequest, phase: this.abort?.signal.aborted ? "cancelled" : "failed", durationMs: Date.now() - recordingRequest.startedAt });
      if (revision === this.revision && !this.stopped) this.reportError(error instanceof Error ? error.message : "Prediction failed");
    } finally {
      this.busy = false;
      if (!this.stopped && !this.state.paused && revision !== this.revision) {
        this.state.status = "watching";
      }
      this.publish();
      if (this.pending && !this.stopped && !this.state.paused) this.schedule(this.urgent ? 100 : undefined);
    }
  }

  stop() {
    this.replayAbort?.abort();
    void this.finishRecording();
    this.runner?.pause("The browser session is closing. No further actions will be started.");
    this.stopped = true;
    this.abort?.abort();
    this.revision++;
    clearTimeout(this.timer);
    clearTimeout(this.autoTimer);
    this.listeners.clear();
    this.clearClipboard("paused");
  }
}

export async function startDashboard(controller: PredictionDashboard) {
  const token = randomBytes(24).toString("hex");
  const prefix = `/session/${token}/`;
  let origin = "";
  const dashboard = dashboardRoutes(controller);
  const server = createServer(async (request, response) => {
    if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
    const path = request.url || "";
    if (!path.startsWith(prefix)) { response.writeHead(404).end(); return; }
    await dashboard.handle(request, response, path.slice(prefix.length), origin);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start dashboard.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, url: origin + prefix,
    async close() {
      dashboard.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function dashboardRoutes(controller: PredictionDashboard, hosted = false) {
  const clients = new Set<ServerResponse>();
  const files = new Map([
    ["", ["index.html", "text/html; charset=utf-8"]],
    ["app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["style.css", ["style.css", "text/css; charset=utf-8"]],
  ]);
  async function handle(request: IncomingMessage, response: ServerResponse, route: string, origin: string) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors ${hosted ? "'self'" : "'none'"}`);
    if (request.method === "POST") {
      if (request.headers.origin !== origin) { response.writeHead(403).end(); return; }
      if (route.startsWith("recording-")) {
        if (hosted) { response.writeHead(404).end(); return; }
        try {
          if (route === "recording-start") {
            let body = "";
            for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 8192) throw new Error("Recording settings are too large."); }
            if (body && Object.keys(JSON.parse(body)).length) throw new Error("Recording starts without task hints, labels or a step count.");
            await controller.startRecording();
          } else if (route === "recording-stop") await controller.stopRecording();
          else if (route === "recording-replay") await controller.replayLatest();
          else { response.writeHead(404).end(); return; }
        } catch (error) { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 250) : "Recording request failed." })); return; }
      }
      else if (route === "workflow-pause") controller.pauseWorkflow();
      else if (route === "pause") controller.setPaused(true);
      else if (route === "resume") controller.setPaused(false);
      else if (route === "predict") controller.requestPrediction();
      else if (route === "desktop-enable") {
        try { await controller.enableDesktopContext(); }
        catch { response.writeHead(500).end(); return; }
      }
      else { response.writeHead(404).end(); return; }
      response.writeHead(204).end(); return;
    }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (route === "recording.jsonl") {
      try {
        const contents = await controller.recorder.download();
        response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": 'attachment; filename="rebrowse-recording.jsonl"' }).end(contents);
      } catch { response.writeHead(409).end("Stop a recording before downloading it."); }
      return;
    }
    if (route === "replay.md") {
      const report = controller.state.replay.report;
      if (!report) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="rebrowse-replay.md"' }).end(replayReportMarkdown(report)); return;
    }
    if (route === "tasks.md") {
      response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="rebrowse-repeatable-tasks.md"' }).end(controller.reportTasks());
      return;
    }
    const workflowId = /^workflow\/([a-zA-Z0-9-]+)\.md$/.exec(route)?.[1];
    if (workflowId) {
      const report = controller.reportWorkflow(workflowId);
      if (!report) { response.writeHead(404).end("Workflow draft not found."); return; }
      response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="rebrowse-workflow-draft.md"' }).end(report);
      return;
    }
    if (route === "events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      response.write(`data: ${JSON.stringify(controller.state)}\n\n`);
      clients.add(response);
      const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
      response.on("close", () => { clearInterval(heartbeat); clients.delete(response); });
      return;
    }
    const file = files.get(route);
    if (!file) { response.writeHead(404).end(); return; }
    try {
      const data = await readFile(new URL(`./dashboard/${file[0]}`, import.meta.url));
      const body = hosted && route === "" ? data.toString("utf8").replace("<body>", '<body class="hosted">') : data;
      response.writeHead(200, { "Content-Type": file[1]! }).end(body);
    } catch { response.writeHead(500).end("Dashboard could not load."); }
  }
  const unsubscribe = controller.subscribe((state) => {
    for (const client of clients) client.write(`data: ${JSON.stringify(state)}\n\n`);
  });
  return {
    handle,
    close() {
      unsubscribe();
      clients.forEach((client) => client.end());
    },
  };
}
