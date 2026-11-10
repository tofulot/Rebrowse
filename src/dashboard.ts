import { createServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@browserbasehq/stagehand";
import type { Activity, BrowserObserver, PageContext } from "./observer.js";
import { readContext } from "./observer.js";
import { predictNext, type Prediction } from "./predictor.js";
import type { DesktopObserver, DesktopState } from "./desktop-context.js";
import { TaskMemory, TaskJournal, taskReport, type TaskRecord } from "./tasks.js";
import { workflowDraftReport } from "./workflow-draft.js";
import { z } from "zod";
import { WorkflowRunner, workflowOffer, RunRequestError, type WorkflowDriver, type StepPlanner, type WorkflowRun, type RunOffer, type WorkflowRunJournal } from "./workflow-runner.js";
import { clipboardEnabled, clipboardStatus, freshClipboard, sanitizeClipboard, CLIPBOARD_TTL_MS, type ClipboardContext, type ClipboardState } from "./clipboard-context.js";

export type DashboardState = {
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
  execution: { available: boolean; busy: boolean; run: WorkflowRun | null; offers: Record<string, RunOffer> };
  clipboard: ClipboardState;
};

export class PredictionDashboard {
  readonly state: DashboardState = {
    paused: false, status: "watching", page: null, activity: [], prediction: null,
    stale: false, requests: 0, error: null, desktop: null,
    tasks: [], taskLog: [], activeTaskId: null, observationCount: 0, journalStatus: "Session only",
    execution: { available: false, busy: false, run: null, offers: {} },
    clipboard: { status: clipboardEnabled() ? "waiting" : "disabled", context: null, lastUsedAt: null },
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

  constructor(private options: {
    predict?: typeof predictNext;
    isConfigured?: () => boolean;
    debounceMs?: number;
    intervalMs?: number;
    journal?: TaskJournal;
  } = {}) {
    if (options.journal) this.state.journalStatus = "Detections save locally";
  }

  subscribe(listener: (state: DashboardState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish() {
    this.state.execution = { available: !!this.runner, busy: this.runner?.busy || false, run: this.runner?.state || null,
      offers: Object.fromEntries(this.state.tasks.map((task) => [task.id, workflowOffer(task)])) };
    this.listeners.forEach((listener) => listener(this.state));
  }

  attachRunner(options: { driver: () => Promise<WorkflowDriver>; plan?: StepPlanner; journal?: WorkflowRunJournal; settleMs?: number }) {
    if (this.runner) throw new Error("The workflow runner is already connected.");
    this.runner = new WorkflowRunner({ ...options, getTask: (id) => this.taskMemory.tasks.find((task) => task.id === id),
      item: async (id, item, status, reason, snapshot) => {
        const record = this.taskMemory.recordExecution(id, item, status, reason, snapshot?.context, snapshot?.pageId);
        this.state.tasks = this.taskMemory.tasks; this.state.taskLog = this.taskMemory.log;
        this.state.observationCount = this.taskMemory.observations.length; this.state.activeTaskId = id;
        if (this.options.journal) {
          try { await this.options.journal.append(record); this.state.journalStatus = "Saved locally"; }
          catch { this.state.journalStatus = "Local save failed"; throw new Error("The queue update could not be saved. Review before continuing."); }
        }
        this.publish();
      },
      change: () => this.publish(),
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
  approveWorkflow(taskId: string, token: string, inputs: Record<string, string>) {
    if (this.stopped || this.state.paused) throw new RunRequestError("Resume watching before approving a workflow.");
    if (!this.runner) throw new RunRequestError("The workflow runner is not connected.", 503);
    if (!(this.options.isConfigured?.() ?? !!process.env.SUBQ_API_KEY?.trim())) throw new RunRequestError("Add SUBQ_API_KEY and restart before running workflows.", 400);
    return this.runner.start(taskId, token, inputs);
  }
  pauseWorkflow() { this.runner?.pause(); }
  finishExecution() { return this.runner?.settled() ?? Promise.resolve(); }

  observe(context: PageContext, page: Page) {
    if (this.stopped || this.state.paused || this.executionBusy) return;
    if (!this.taskMemory.observe(context, page.pageId, this.state.activity)) return;
    this.state.observationCount = this.taskMemory.observations.length;
    this.target = page;
    this.state.stale = this.state.prediction !== null;
    this.publish();
    // DOM updates are useful memory, but must not repeatedly cancel inference
    // or keep resetting its debounce on animated/live pages. User activity
    // still invalidates stale results through the separate revision counter.
    if (this.busy) this.pending = true;
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
    this.target = page;
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
    if (["address-select", "address-focus", "address-edit", "copy", "cut", "paste", "clipboard-change", "clipboard-available"].includes(event.kind)) {
      this.urgent = true;
      this.abort?.abort();
      this.schedule(100);
    } else this.schedule();
  }

  reportError(message: string) {
    if (this.stopped || this.state.paused) return;
    this.state.error = message.slice(0, 250);
    this.state.status = "error";
    this.publish();
  }

  setPaused(paused: boolean) {
    if (paused) { this.abort?.abort(); this.runner?.pause("Watching was paused. Execution is stopping after its current browser action."); }
    this.state.paused = paused;
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

  private schedule(delay = this.options.debounceMs ?? 1400) {
    if (this.stopped || this.state.paused || this.executionBusy || !this.target) return;
    this.pending = true;
    clearTimeout(this.timer);
    if (!this.busy) {
      const wait = this.urgent ? delay : Math.max(delay, this.lastRequest + (this.options.intervalMs ?? 5000) - Date.now());
      this.timer = setTimeout(() => void this.run(), wait);
    }
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
    try {
      context = await readContext(page);
      this.taskMemory.observe(context, page.pageId, this.state.activity);
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
      const prediction = await (this.options.predict ?? predictNext)(context, events, this.abort.signal, desktop, this.taskMemory.context(this.state.activity), clipboard);
      if (revision !== this.revision || this.stopped) return;
      // Detect navigations that happened between observation scans.
      if ((await readContext(page)).url !== context.url) { this.schedule(); return; }
      if (revision !== this.revision || this.stopped) return;
      this.state.prediction = { ...prediction, time: Date.now(), durationMs: Date.now() - start, url: context.url };
      this.state.stale = this.taskMemory.observations.at(-1)?.id !== observationVersion;
      this.state.status = "ready";
      const record = this.taskMemory.accept(prediction.repeatableTask);
      this.state.tasks = this.taskMemory.tasks;
      this.state.taskLog = this.taskMemory.log;
      const hypothesis = prediction.repeatableTask;
      this.state.activeTaskId = hypothesis && hypothesis.confidence >= 0.7
        ? this.state.tasks.find((task) => task.id === hypothesis.taskId || task.title.toLowerCase() === hypothesis.title.toLowerCase())?.id || null : null;
      if (record && this.options.journal) {
        this.state.journalStatus = "Saving locally…";
        void this.options.journal.append(record).then(() => {
          this.state.journalStatus = "Saved locally"; this.publish();
        }).catch(() => {
          this.state.journalStatus = "Local save failed · report still available"; this.publish();
        });
      }
    } catch (error) {
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
    this.runner?.pause("The browser session is closing. No further actions will be started.");
    this.stopped = true;
    this.abort?.abort();
    this.revision++;
    clearTimeout(this.timer);
    this.listeners.clear();
    this.clearClipboard("paused");
  }
}

export async function startDashboard(controller: PredictionDashboard) {
  const token = randomBytes(24).toString("hex");
  const prefix = `/session/${token}/`;
  const clients = new Set<ServerResponse>();
  const files = new Map([
    ["", ["index.html", "text/html; charset=utf-8"]],
    ["app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["style.css", ["style.css", "text/css; charset=utf-8"]],
  ]);
  let origin = "";
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    if (request.headers.host !== origin.replace("http://", "")) { response.writeHead(403).end(); return; }
    const path = request.url || "";
    if (!path.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const route = path.slice(prefix.length);
    if (request.method === "POST") {
      if (request.headers.origin !== origin) { response.writeHead(403).end(); return; }
      if (route === "workflow-run") {
        try {
          if (!request.headers["content-type"]?.startsWith("application/json")) throw new RunRequestError("Use a JSON approval request.", 415);
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of request) {
            size += chunk.length; if (size > 8192) throw new RunRequestError("The approval request is too large.", 413);
            chunks.push(Buffer.from(chunk));
          }
          let data: unknown;
          try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new RunRequestError("The approval request is invalid.", 400); }
          const parsed = z.object({ taskId: z.string().max(100), token: z.string().regex(/^[a-f0-9]{64}$/),
            inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(500)).default({}) }).safeParse(data);
          if (!parsed.success) throw new RunRequestError("The approval request is invalid.", 400);
          const run = controller.approveWorkflow(parsed.data.taskId, parsed.data.token, parsed.data.inputs);
          response.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ runId: run.id }));
        } catch (error) {
          response.writeHead(error instanceof RunRequestError ? error.status : 500, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: error instanceof RunRequestError ? error.message : "The workflow could not be started." }));
        }
        return;
      }
      if (route === "workflow-pause") controller.pauseWorkflow();
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
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.write(`data: ${JSON.stringify(controller.state)}\n\n`);
      clients.add(response);
      const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
      request.on("close", () => { clearInterval(heartbeat); clients.delete(response); });
      return;
    }
    const file = files.get(route);
    if (!file) { response.writeHead(404).end(); return; }
    try {
      const data = await readFile(new URL(`./dashboard/${file[0]}`, import.meta.url));
      response.writeHead(200, { "Content-Type": file[1]! }).end(data);
    } catch { response.writeHead(500).end("Dashboard could not load."); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start dashboard.");
  origin = `http://127.0.0.1:${address.port}`;
  const unsubscribe = controller.subscribe((state) => {
    for (const client of clients) client.write(`data: ${JSON.stringify(state)}\n\n`);
  });
  return {
    origin, url: origin + prefix,
    async close() {
      unsubscribe();
      clients.forEach((client) => client.end());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
