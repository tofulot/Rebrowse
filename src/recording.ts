import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { cleanUrl, type Activity } from "./observer.js";
import { resourceUrl } from "./workflow-pattern.js";
import { predictionSchema, type Prediction } from "./predictor.js";
import type { Observation } from "./tasks.js";
import { clipboardMetadata, sanitizeClipboard } from "./clipboard-context.js";
import { desktopSampleSchema, type DesktopState } from "./desktop-context.js";
import type { WorkflowRun } from "./workflow-runner.js";

const text = z.string().max(4000);
const activitySchema = z.object({ id: z.number().int(), pageId: text, time: z.number(), kind: text, label: text, url: text,
  clipboard: z.object({ format: z.enum(["text", "non-text", "unavailable"]), truncated: z.boolean(), source: z.enum(["page", "system"]),
    target: z.enum(["page", "field", "search", "address-bar", "browser-controls"]), redacted: z.boolean().optional() }).optional() });
const contextSchema = z.object({ url: text, publicUrl: text.optional(), title: text, headings: z.array(text).max(15), actions: z.array(text).max(50), excerpt: text,
  links: z.array(z.object({ title: text, url: text })).max(60).optional(),
  lists: z.array(z.object({ label: text, items: z.array(text).max(40), truncated: z.boolean() })).max(4).optional() });
const frameSchema = z.object({ id: z.number().int().positive(), time: z.number(), pageId: text, actor: z.enum(["user", "workflow"]).optional(), context: contextSchema, events: z.array(activitySchema).max(60) });
export const replayExpectationSchema = z.object({ expectPattern: z.boolean(), byStep: z.number().int().min(1).max(1000), terms: z.array(z.string().min(1).max(100)).max(10) });
export type ReplayExpectation = z.infer<typeof replayExpectationSchema>;
const recordingOptionsSchema = z.object({ name: z.string().trim().min(1).max(120).default("Browsing demonstration"), expected: replayExpectationSchema.nullable().default(null) });
const base = { atMs: z.number().nonnegative(), step: z.number().int().nonnegative() };
const recordingRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), format: z.literal("rebrowse-trajectory-v1"), id: z.string(), name: text, startedAt: z.number(),
    expected: replayExpectationSchema.nullable(), baselineCount: z.number().int().nonnegative(), existingTaskCount: z.number().int().nonnegative() }),
  z.object({ type: z.literal("baseline"), ...base, frames: z.array(frameSchema).max(80) }),
  z.object({ type: z.literal("activity"), ...base, event: activitySchema }),
  z.object({ type: z.literal("observation"), ...base, frame: frameSchema, targetPageId: text }),
  z.object({ type: z.literal("desktop"), ...base, pageId: text.nullable(), sample: desktopSampleSchema.omit({ addressText: true, browserPid: true, clipboardVersion: true }) }),
  z.object({ type: z.literal("prediction"), ...base, startedAtMs: z.number().nonnegative(), durationMs: z.number().nonnegative(), accepted: z.boolean(), stale: z.boolean(), prediction: predictionSchema }),
  z.object({ type: z.literal("inference"), ...base, phase: z.enum(["started", "cancelled", "failed"]), durationMs: z.number().nonnegative() }),
  z.object({ type: z.literal("workflow"), ...base, runId: text, taskId: text, status: z.enum(["running", "pausing", "paused", "complete"]),
    phase: text, item: text.nullable(), actionCount: z.number().int().nonnegative(), completedItems: z.number().int().nonnegative(), message: text }),
  z.object({ type: z.literal("end"), ...base, actions: z.number().int().nonnegative(), reason: text }),
]);
export type RecordingRecord = z.infer<typeof recordingRecordSchema>;
export type RecordingState = {
  status: "idle" | "starting" | "recording" | "saving" | "saved" | "error";
  id: string | null; name: string; file: string | null; steps: number; actions: number; frames: number; startedAt: number | null;
  baselineCount: number; firstDetection: { step: number; elapsedMs: number; durationMs: number; confidence: number; title: string } | null; error: string | null;
};
export const meaningfulActivity = (kind: string) => ["click", "navigate", "edit", "paste", "copy", "cut", "address-edit"].includes(kind);
function safeString(value: string) { return sanitizeClipboard({ text: value, format: "text", source: "page", target: "page", truncated: false }).redacted ? "[credential excluded]" : value; }
function recordingActivity(event: Activity): Activity {
  const { addressText: _addressText, clipboard, ...rest } = event;
  return { ...rest, url: cleanUrl(rest.url), label: safeString(rest.label), ...(clipboard ? { clipboard: clipboardMetadata(clipboard) } : {}) };
}
function recordingFrame(frame: Observation): Observation {
  const context = contextSchema.parse(frame.context);
  context.url = cleanUrl(context.url) || context.url;
  context.publicUrl = resourceUrl(context.publicUrl || context.url) || undefined;
  context.links = context.links?.flatMap((link) => { const url = resourceUrl(link.url); return url ? [{ ...link, url }] : []; });
  return { ...frame, context, events: frame.events.map(recordingActivity) };
}

/** Local state/action trajectories, using the observer's filtered page data. */
export class SessionRecorder {
  readonly state: RecordingState = { status: "idle", id: null, name: "", file: null, steps: 0, actions: 0, frames: 0, startedAt: null, baselineCount: 0, firstDetection: null, error: null };
  private pending = Promise.resolve();
  private change = () => {};
  private identities = new Set<string>();
  private fingerprints = new Map<string, string>();
  private checkpointActions = 0;
  private lastDesktop = 0;
  private rows = 0;
  private bytes = 0;
  private lastMeaningfulAt = 0;
  private lastStepKind: "action" | "resource" = "resource";
  private recentResources = new Map<string, { url: string; step: number; time: number }>();
  private lastWorkflow = "";
  constructor(readonly directory: string) {}
  onChange(change: () => void) { this.change = change; }
  get active() { return ["starting", "recording", "saving"].includes(this.state.status); }
  get capturing() { return this.state.status === "recording"; }
  async start(input: z.input<typeof recordingOptionsSchema>, frames: Observation[] = [], existingTaskCount = 0) {
    if (this.active) throw new Error("A recording is already running.");
    const options = recordingOptionsSchema.parse(input);
    await this.pending;
    if (this.active) throw new Error("A recording is already running.");
    const id = randomUUID(); const startedAt = Date.now();
    Object.assign(this.state, { status: "starting", id, name: options.name, file: `${id}.jsonl`, startedAt, steps: 0, actions: 0, frames: 0, baselineCount: frames.length, firstDetection: null, error: null });
    this.identities.clear(); this.fingerprints.clear(); this.checkpointActions = 0; this.lastDesktop = 0; this.rows = 2; this.lastMeaningfulAt = 0; this.lastStepKind = "resource";
    this.recentResources.clear();
    this.lastWorkflow = "";
    this.change();
    const baseline = frames.map(recordingFrame);
    for (const frame of baseline) this.identities.add(`${frame.actor || "user"}:${frame.pageId}:${frame.context.publicUrl || frame.context.url}`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const header: RecordingRecord = { type: "session", format: "rebrowse-trajectory-v1", id, name: options.name, startedAt, expected: options.expected, baselineCount: frames.length, existingTaskCount };
      const initial = this.line(header) + this.line({ type: "baseline", atMs: 0, step: 0, frames: baseline });
      this.bytes = Buffer.byteLength(initial);
      await writeFile(join(this.directory, this.state.file!), initial, { flag: "wx", mode: 0o600 });
      this.state.status = "recording"; this.change();
    } catch { this.fail(); throw new Error("The recording could not be saved locally."); }
  }
  private line(record: RecordingRecord) {
    return JSON.stringify(recordingRecordSchema.parse(record), (_key, value) => typeof value === "string" ? safeString(value) : value) + "\n";
  }
  private at() { return Math.max(0, Date.now() - (this.state.startedAt || Date.now())); }
  private fail() { this.state.status = "error"; this.state.error = "The local recording could not be saved. Start a new recording to try again."; this.change(); }
  private append(record: RecordingRecord) {
    let line: string;
    try { line = this.line(record); } catch { this.fail(); return; }
    const path = join(this.directory, this.state.file!);
    this.rows++; this.bytes += Buffer.byteLength(line);
    this.pending = this.pending.then(() => appendFile(path, line, { mode: 0o600 })).catch(() => this.fail());
    if (this.rows >= 10000 && this.capturing) void this.stop("Recording reached its 10,000-record limit.");
    else if (this.bytes >= 24 * 1024 * 1024 && this.capturing) void this.stop("Recording reached its 24 MB size limit.");
  }
  activity(event: Activity) {
    if (!this.capturing) return;
    const meaningful = meaningfulActivity(event.kind);
    const resource = event.kind === "navigate" ? this.recentResources.get(event.pageId) : undefined;
    const arrivingNavigation = resource && resource.url === cleanUrl(event.url) && Date.now() - resource.time < 3000 ? resource : undefined;
    if (meaningful) { this.state.actions++; this.lastMeaningfulAt = Date.now(); }
    // The page state may arrive before its navigation notification. That
    // late notification belongs to the resource's existing observed step.
    if (arrivingNavigation) this.checkpointActions++;
    this.append({ type: "activity", atMs: this.at(), step: arrivingNavigation?.step ?? this.state.steps + (meaningful ? 1 : 0), event: recordingActivity(event) });
    if (meaningful) this.change();
  }
  observation(frame: Observation, targetPageId = frame.pageId) {
    if (!this.capturing) return;
    frame = recordingFrame(frame);
    const fingerprint = JSON.stringify(frame.context);
    const newAction = this.state.actions !== this.checkpointActions;
    if (this.fingerprints.get(frame.pageId) === fingerprint && !newAction) return;
    this.fingerprints.set(frame.pageId, fingerprint);
    const identity = `${frame.actor || "user"}:${frame.pageId}:${frame.context.publicUrl || frame.context.url}`;
    const newResource = !this.identities.has(identity);
    // A click followed by its loaded/background tab is one observed step,
    // even if the source page was sampled while that new tab was loading.
    const followsAction = newResource && !newAction && this.lastStepKind === "action" && Date.now() - this.lastMeaningfulAt < 3000;
    if (frame.actor !== "workflow" && (newResource || newAction)) {
      if (!followsAction) this.state.steps++;
      this.checkpointActions = this.state.actions;
      this.lastStepKind = newResource ? "resource" : "action";
      if (newResource) this.recentResources.set(frame.pageId, { url: cleanUrl(frame.context.url), step: this.state.steps, time: Date.now() });
    }
    this.identities.add(identity); this.state.frames++;
    this.append({ type: "observation", atMs: this.at(), step: this.state.steps, frame, targetPageId });
    this.change();
  }
  desktop(desktop: DesktopState) {
    if (!this.capturing || !desktop.sample?.active || Date.now() - this.lastDesktop < 500) return;
    this.lastDesktop = Date.now();
    const { addressText: _text, browserPid: _pid, clipboardVersion: _version, ...sample } = desktop.sample;
    this.append({ type: "desktop", atMs: this.at(), step: this.state.steps, pageId: desktop.pageId || null, sample });
  }
  prediction(prediction: Prediction, input: { sessionId: string | null; step: number; startedAt: number; durationMs: number; accepted: boolean; stale: boolean }) {
    if (!this.capturing || input.sessionId !== this.state.id) return;
    this.append({ type: "prediction", atMs: this.at(), step: input.step, startedAtMs: Math.max(0, input.startedAt - this.state.startedAt!), durationMs: input.durationMs, accepted: input.accepted, stale: input.stale, prediction });
    if (input.accepted && prediction.repeatableTask && !this.state.firstDetection) {
      this.state.firstDetection = { step: input.step, elapsedMs: this.at(), durationMs: input.durationMs, confidence: prediction.repeatableTask.confidence, title: prediction.repeatableTask.title };
      this.change();
    }
  }
  inference(input: { sessionId: string | null; step: number; phase: "started" | "cancelled" | "failed"; durationMs: number }) {
    if (!this.capturing || input.sessionId !== this.state.id) return;
    this.append({ type: "inference", atMs: this.at(), step: input.step, phase: input.phase, durationMs: input.durationMs });
  }
  workflow(run: WorkflowRun) {
    if (!this.capturing) return;
    const record = { type: "workflow" as const, step: this.state.steps, runId: run.id, taskId: run.taskId, status: run.status,
      phase: run.phase, item: run.item, actionCount: run.actionCount, completedItems: run.completedItems.length, message: run.message };
    const fingerprint = JSON.stringify(record);
    if (fingerprint === this.lastWorkflow) return;
    this.lastWorkflow = fingerprint;
    this.append({ ...record, atMs: this.at() });
  }
  async stop(reason = "Recording stopped.") {
    if (this.capturing) {
      this.state.status = "saving";
      this.append({ type: "end", atMs: this.at(), step: this.state.steps, actions: this.state.actions, reason });
      this.change();
    }
    await this.pending;
    if (this.state.status === "saving") { this.state.status = "saved"; this.change(); }
  }
  async download() {
    if (this.active) throw new Error("Stop the recording before downloading it.");
    if (!this.state.file) throw new Error("No recording is available yet.");
    await this.pending;
    return readFile(join(this.directory, this.state.file), "utf8");
  }
}

export function parseRecording(contents: string): RecordingRecord[] {
  if (Buffer.byteLength(contents) > 32 * 1024 * 1024) throw new Error("Recording exceeds the 32 MB replay limit.");
  const lines = contents.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length || lines.length > 10001) throw new Error("Recording is empty or exceeds the replay record limit.");
  const records = lines.map((line, index) => {
    try { return recordingRecordSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`Invalid recording at line ${index + 1}.`); }
  });
  if (records[0]?.type !== "session" || records.slice(1).some((record) => record.type === "session")) throw new Error("Recording must start with exactly one session header.");
  return records;
}
