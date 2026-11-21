import { performance } from "node:perf_hooks";
import { TaskMemory, type Observation } from "./tasks.js";
import type { Activity } from "./observer.js";
import { predictNext } from "./predictor.js";
import { meaningfulActivity, type RecordingRecord, type ReplayExpectation } from "./recording.js";
import { subqModelName } from "./subq.js";

type ReplayRow = { step: number; actions: number; resources: number; atMs: number; durationMs: number | null;
  proposed: string | null; detected: string | null; confidence: number | null; repeatLikelihood: number | null; matchesExpected: boolean | null; error: string | null };
export type ReplayReport = { format: "rebrowse-replay-v1"; name: string; mode: "recorded" | "live"; model: string | null; baselineCount: number; existingTaskCount: number;
  expected: ReplayExpectation | null; totalSteps: number; evaluatedSteps: number; firstDetectionStep: number | null; firstMatchingStep: number | null;
  firstDetectionRecordedMs: number | null; firstMatchingRecordedMs: number | null; meanInferenceMs: number | null; falsePositiveSteps: number[];
  verdict: "pass" | "fail" | "unscored" | "error" | "incomplete"; rows: ReplayRow[] };

/** Independent prefixes: no later frames, labels, or earlier model outputs enter inference. */
export async function replayRecording(records: RecordingRecord[], options: {
  mode?: "recorded" | "live"; predict?: typeof predictNext; expected?: ReplayExpectation | null; maxSteps?: number;
  signal?: AbortSignal; progress?: (row: ReplayRow) => void;
} = {}): Promise<ReplayReport> {
  const header = records[0];
  if (header?.type !== "session") throw new Error("A recording session header is required.");
  const expected = options.expected === undefined ? header.expected : options.expected;
  const mode = options.mode || "recorded";
  const steps = [...new Set(records.flatMap((record) => record.type === "observation" && record.step > 0 && record.frame.actor !== "workflow" ? [record.step] : []))].sort((a, b) => a - b);
  const rows: ReplayRow[] = [];
  for (const step of steps.slice(0, options.maxSteps)) {
    options.signal?.throwIfAborted();
    // A next-step activity can precede its page snapshot. Cut at that activity,
    // so even its click label cannot leak backwards into an earlier prediction.
    const end = records.findIndex((record) => "step" in record && record.type !== "prediction" && record.type !== "end" && record.step > step);
    const prefix = records.slice(0, end < 0 ? records.length : end);
    const observed = prefix.filter((record) => record.type === "observation");
    const checkpoint = observed.findLast((record) => record.step === step && record.frame.actor !== "workflow");
    if (!checkpoint) continue;
    const frames = new Map<number, Observation>();
    for (const record of prefix) {
      if (record.type === "baseline") for (const frame of record.frames) frames.set(frame.id, structuredClone(frame));
      // Re-assess the human evidence before its automation acted. Later agent
      // outcomes must not leak the inferred continuation back into this prefix.
      if (record.type === "observation" && record.frame.actor !== "workflow") frames.set(record.frame.id, structuredClone(record.frame));
    }
    const target = [...frames.values()].findLast((frame) => frame.pageId === checkpoint.targetPageId) || checkpoint.frame;
    const shift = Date.now() - (header.startedAt + checkpoint.atMs);
    const rebaseEvent = (event: Activity): Activity => ({ ...event, time: event.time + shift });
    const memory = new TaskMemory();
    memory.observations.push(...[...frames.values()].slice(-80).map((frame) => ({ ...frame, time: frame.time + shift, events: frame.events.map(rebaseEvent) })));
    const eventMap = new Map<string, Activity>();
    for (const frame of memory.observations) for (const event of frame.events) eventMap.set(`${event.pageId}:${event.id}`, event);
    for (const record of prefix) if (record.type === "activity" && record.atMs <= checkpoint.atMs) eventMap.set(`${record.event.pageId}:${record.event.id}`, rebaseEvent(record.event));
    const events = [...eventMap.values()].sort((a, b) => a.time - b.time).slice(-60);
    const desktopRecord = prefix.findLast((record) => record.type === "desktop" && record.atMs <= checkpoint.atMs && record.pageId === target.pageId);
    const row: ReplayRow = { step, actions: prefix.filter((record) => record.type === "activity" && record.atMs <= checkpoint.atMs && meaningfulActivity(record.event.kind)).length,
      resources: new Set([...frames.values()].filter((frame) => frame.actor !== "workflow").map((frame) => frame.context.publicUrl || frame.context.url)).size,
      atMs: checkpoint.atMs, durationMs: null, proposed: null, detected: null, confidence: null, repeatLikelihood: null, matchesExpected: null, error: null };
    try {
      let prediction;
      let recordedAccepted = true;
      if (mode === "live") {
        const start = performance.now();
        prediction = await (options.predict || predictNext)(target.context, events.filter((event) => event.pageId === target.pageId), options.signal,
          desktopRecord?.type === "desktop" ? { status: "ready", message: "Recorded browser signals; typed text excluded.", pageId: desktopRecord.pageId,
            sample: { ...desktopRecord.sample, time: desktopRecord.sample.time + shift }, path: [] } : null, memory.context(events), null);
        row.durationMs = Math.round(performance.now() - start);
      } else {
        const results = records.filter((record): record is Extract<RecordingRecord, { type: "prediction" }> => record.type === "prediction" && record.step === step);
        const result = results.find((record) => record.accepted) || results.at(-1);
        if (!result) {
          const failed = records.findLast((record) => record.type === "inference" && record.step === step && record.phase !== "started");
          if (failed?.type === "inference") { row.durationMs = failed.durationMs; row.error = failed.phase === "cancelled" ? "Recorded prediction was cancelled before a result." : "Recorded prediction failed."; }
          rows.push(row); options.progress?.(row); continue;
        }
        prediction = result.prediction; row.durationMs = result.durationMs; recordedAccepted = result.accepted;
      }
      row.proposed = prediction.repeatableTask?.title || null;
      const accepted = recordedAccepted ? memory.accept(prediction.repeatableTask) : null;
      if (accepted) {
        row.detected = accepted.title; row.confidence = accepted.confidence; row.repeatLikelihood = accepted.pattern?.repeatLikelihood ?? null;
        const description = [accepted.title, accepted.reason, accepted.pattern?.action || ""].join(" ").toLowerCase();
        row.matchesExpected = expected ? expected.expectPattern && expected.terms.every((term) => description.includes(term.toLowerCase())) : null;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      // Provider errors can echo content; the adapter's user-facing errors are
      // already sanitized, but replay reports keep a bounded generic message.
      row.error = error instanceof Error && /SubQ|structured|confidence/.test(error.message) ? error.message.slice(0, 250) : "This prediction could not be evaluated.";
    }
    rows.push(row); options.progress?.(row);
  }
  const first = rows.find((row) => row.detected);
  const matching = rows.find((row) => row.matchesExpected);
  const falsePositiveSteps = expected ? rows.filter((row) => row.detected && !row.matchesExpected).map((row) => row.step) : [];
  const latencies = rows.flatMap((row) => row.durationMs === null ? [] : [row.durationMs]);
  const verdict = rows.some((row) => row.error) ? "error" : !rows.length || rows.some((row) => row.durationMs === null) ? "incomplete" : !expected ? "unscored"
    : expected.expectPattern ? matching && matching.step <= expected.byStep && !falsePositiveSteps.length ? "pass" : rows.at(-1)!.step < expected.byStep && !matching ? "incomplete" : "fail"
      : falsePositiveSteps.length ? "fail" : rows.length < steps.length ? "incomplete" : "pass";
  return { format: "rebrowse-replay-v1", name: header.name, mode, model: mode === "live" ? subqModelName() : null,
    baselineCount: header.baselineCount, existingTaskCount: header.existingTaskCount, expected, totalSteps: steps.length, evaluatedSteps: rows.length,
    firstDetectionStep: first?.step ?? null, firstMatchingStep: matching?.step ?? null, firstDetectionRecordedMs: first?.atMs ?? null,
    firstMatchingRecordedMs: matching?.atMs ?? null, meanInferenceMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
    falsePositiveSteps, verdict, rows };
}

export function replayReportMarkdown(report: ReplayReport) {
  const safe = (value: unknown) => String(value ?? "—").replace(/[|\r\n]/g, " ");
  return [`# Pattern detection replay: ${safe(report.name)}`, "", `Mode: ${report.mode === "live" ? `fresh ${report.model} predictions` : "recorded findings; no new inference"}. ${report.expected ? `Verdict: **${report.verdict}**.` : `Discovery from observed activity. ${["error", "incomplete"].includes(report.verdict) ? "Some predictions could not be evaluated." : ""}`}`,
    `First accepted detection: step ${report.firstDetectionStep ?? "none"}. ${report.expected ? `First expected match: step ${report.firstMatchingStep ?? "none"}. ` : ""}Mean inference: ${report.meanInferenceMs ?? "unknown"} ms.`,
    `Evaluated ${report.evaluatedSteps}/${report.totalSteps} steps; ${report.baselineCount} observations and ${report.existingTaskCount} existing tasks were present at recording start.`, "",
    "Steps are counted automatically from observed states/actions, not entered by the user. Recorded elapsed time and model response latency are separate. Each fresh prediction receives an independent history prefix with no earlier model answers.",
    report.expected ? "Developer scoring labels are evaluated after prediction and never sent to the predictor." : "The predictor infers the task from browsing history without an expected task name, pattern label or planned step count.", "",
    `| Step | Recorded time (ms) | Resources | Model time (ms) | Discovered pattern | Confidence |${report.expected ? " Expected match |" : ""}`, `| --- | --- | --- | --- | --- | --- |${report.expected ? " --- |" : ""}`,
    ...report.rows.map((row) => `| ${row.step} | ${row.atMs} | ${row.resources} | ${row.durationMs ?? "—"} | ${safe(row.error || row.detected || (row.proposed ? "Proposed, rejected by validation" : "None"))} | ${row.confidence === null ? "—" : Math.round(row.confidence * 100) + "%"} |${report.expected ? ` ${row.matchesExpected === null ? "—" : row.matchesExpected ? "yes" : "no"} |` : ""}`), "",
    "Replay performs inference only; it does not execute browser actions. Raw clipboard contents, raw address-bar text and ordinary input values are excluded. Public search URLs and visible page text remain in recorded context.", ""].join("\n");
}
