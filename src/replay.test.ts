import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseRecording, type RecordingRecord } from "./recording.js";
import { replayRecording, replayReportMarkdown } from "./replay.js";
import { collectionEvidence } from "./pattern-evidence.js";
import type { Prediction } from "./predictor.js";
import type { TaskHypothesis, WorkflowContext } from "./tasks.js";

const fixture = async (name = "ap-calculus-units") => parseRecording(await readFile(new URL(`../fixtures/recordings/${name}.jsonl`, import.meta.url), "utf8"));
const none = (): Prediction => ({ intent: "Browse", summary: "Limited history", predictions: [{ action: "Continue browsing", confidence: .5, evidence: "An opened page" }], repeatableTask: null });
function detection(workflow: WorkflowContext): Prediction {
  const series = collectionEvidence(workflow).seriesCandidates[0];
  if (!series) return none();
  const task: TaskHypothesis = { taskId: null, title: "Collect AP Calculus unit review guides", confidence: .85, steps: ["Open the next unit review for {{item}}"], reason: "Distinct unit reviews share a course and format.",
    cycles: [], totalItems: null, totalEvidenceId: null, remainingItems: [], remainingEvidenceId: null, currentItem: null, nextStep: "Open the next unit review", continuation: "likely", suggestedWorkflow: null, workQueue: null,
    pattern: { action: "Collect calculus unit reviews", repeatLikelihood: .9, reason: "Two related reviews", evidenceIds: series.observationIds.slice(-8), operation: "open_tabs", goal: "resources",
      endCondition: "Stop at the batch limit", endKnown: false, maxItems: 2, targets: [] } };
  return { ...none(), repeatableTask: task };
}

test("fresh replay detects at the second prefix with no future frames, goal labels or earlier model answers", async () => {
  const records = await fixture(); let calls = 0;
  if (records[0].type === "session") records[0].expected!.terms.push("SCORING_LABEL_ONLY");
  const report = await replayRecording(records, { mode: "live", predict: async (_context, _events, _signal, _desktop, workflow, clipboard) => {
    calls++; assert.ok(workflow); assert.equal(workflow.knownTasks.length, 0); assert.equal(clipboard, null);
    const body = JSON.stringify(workflow);
    assert.doesNotMatch(body, /SCORING_LABEL_ONLY/);
    assert.ok(workflow.observations.every((frame) => frame.id <= calls));
    assert.equal(collectionEvidence(workflow).resources.length, calls);
    assert.ok(workflow.recentActivity.every((event) => event.id <= calls));
    assert.ok(workflow.recentActivity.every((event) => event.time <= Date.now()));
    return detection(workflow);
  } });
  assert.equal(calls, 6); assert.equal(report.firstDetectionStep, 2); assert.equal(report.firstDetectionRecordedMs, 4100);
  assert.equal(report.firstMatchingStep, null, "A task detection is distinct from passing the held-out expected terms");
  assert.equal(report.verdict, "fail"); assert.deepEqual(report.falsePositiveSteps, [2, 3, 4, 5, 6]);
});

test("positive, negative and fabricated-evidence cases are scored with the production acceptance rules", async () => {
  const predict = (async (_context, _events, _signal, _desktop, workflow) => detection(workflow!)) satisfies NonNullable<Parameters<typeof replayRecording>[1]>["predict"];
  const positive = await replayRecording(await fixture(), { mode: "live", predict });
  assert.equal(positive.verdict, "pass"); assert.equal(positive.firstMatchingStep, 2); assert.equal(positive.rows[0].detected, null);
  const negative = await replayRecording(await fixture("unrelated-browsing"), { mode: "live", predict });
  assert.equal(negative.verdict, "pass"); assert.equal(negative.firstDetectionStep, null);
  const bad = await replayRecording(await fixture(), { mode: "live", predict: async (_context, _events, _signal, _desktop, workflow) => {
    const result = detection(workflow!); if (result.repeatableTask?.pattern) result.repeatableTask.pattern.evidenceIds = [99999]; return result;
  } });
  assert.equal(bad.verdict, "fail"); assert.equal(bad.firstDetectionStep, null); assert.ok(bad.rows[1].proposed);
  assert.match(replayReportMarkdown(positive), /First accepted detection: step 2/);
});

test("recorded-only replay makes no model calls and missing answers or provider failures cannot pass", async () => {
  const records = await fixture();
  const missing = await replayRecording(records, { predict: async () => { throw new Error("Must not call"); } });
  assert.equal(missing.mode, "recorded"); assert.equal(missing.verdict, "incomplete"); assert.equal(missing.meanInferenceMs, null);
  const failed = await replayRecording(records, { mode: "live", maxSteps: 1, predict: async () => { throw new Error("SubQ request failed (HTTP 429)."); } });
  assert.equal(failed.verdict, "error"); assert.equal(failed.firstDetectionStep, null);
  const cancelled = [...records, { type: "inference", step: 1, atMs: 2200, phase: "cancelled", durationMs: 100 } as const];
  const aborted = await replayRecording(cancelled, { maxSteps: 1 });
  assert.equal(aborted.verdict, "error"); assert.match(aborted.rows[0].error || "", /cancelled/);
});

test("a future next-step click is excluded even when it precedes the next observation", async () => {
  const records = await fixture();
  const next = records.find((record): record is Extract<RecordingRecord, { type: "activity" }> => record.type === "activity" && record.step === 2)!;
  next.event.label = "FUTURE_CLICK_LABEL";
  await replayRecording(records, { mode: "live", maxSteps: 1, predict: async (_context, _events, _signal, _desktop, workflow) => {
    assert.doesNotMatch(JSON.stringify(workflow), /FUTURE_CLICK_LABEL/);
    return none();
  } });
});

test("recorded findings replay without inference and keep the original response latencies", async () => {
  const records = await fixture();
  const frames = records.flatMap((record) => record.type === "observation" && record.step <= 2 ? [record.frame] : []);
  const answer = detection({ observations: frames, knownTasks: [], recentActivity: [] });
  records.push({ type: "prediction", step: 1, atMs: 3600, startedAtMs: 2100, durationMs: 1500, accepted: false, stale: false, prediction: none() },
    { type: "prediction", step: 2, atMs: 6600, startedAtMs: 4100, durationMs: 2500, accepted: true, stale: true, prediction: answer });
  const report = await replayRecording(records, { maxSteps: 2, predict: async () => { throw new Error("Recorded-only replay cannot call inference"); } });
  assert.equal(report.mode, "recorded"); assert.equal(report.firstMatchingStep, 2); assert.equal(report.verdict, "pass");
  assert.equal(report.meanInferenceMs, 2000); assert.equal(report.rows[1].durationMs, 2500);
});

test("workflow-created resource frames never become new replay steps or user pattern examples", async () => {
  const records = await fixture();
  for (const record of records) if (record.type === "observation" && record.step >= 2) record.frame.actor = "workflow";
  let calls = 0;
  const report = await replayRecording(records, { mode: "live", predict: async () => { calls++; return none(); } });
  assert.equal(calls, 1); assert.equal(report.firstDetectionStep, null);
});

test("unlabeled recordings discover the goal and count steps without a name, target, or deadline", async () => {
  const records = await fixture();
  if (records[0].type === "session") { records[0].expected = null; records[0].name = "SESSION_METADATA_MUST_NOT_BE_AN_INPUT"; }
  let calls = 0;
  const report = await replayRecording(records, { mode: "live", predict: async (context, events, _signal, desktop, workflow) => {
    calls++;
    assert.doesNotMatch(JSON.stringify({ context, events, desktop, workflow }), /SESSION_METADATA|byStep|expectPattern|deadline/);
    return detection(workflow!);
  } });
  assert.equal(calls, 6); assert.equal(report.totalSteps, 6); assert.equal(report.firstDetectionStep, 2);
  assert.equal(report.expected, null); assert.equal(report.verdict, "unscored");
  const markdown = replayReportMarkdown(report);
  assert.match(markdown, /First accepted detection: step 2/);
  assert.doesNotMatch(markdown, /Expected match|First expected match|Verdict:/);
});

test("automation occurring after a human checkpoint cannot leak its chosen continuation into replay", async () => {
  const records = await fixture();
  const first = records.find((record): record is Extract<RecordingRecord, { type: "observation" }> => record.type === "observation")!;
  const boundary = records.findIndex((record) => record.type === "activity" && record.step === 2);
  records.splice(boundary, 0, { type: "observation", step: 1, atMs: 2200, targetPageId: first.frame.pageId,
    frame: { ...first.frame, id: 99, pageId: "agent-tab", actor: "workflow", context: { ...first.frame.context, title: "AGENT_CHOSEN_FUTURE_RESOURCE", url: "https://example.com/unit/99", publicUrl: "https://example.com/unit/99" } } });
  await replayRecording(records, { mode: "live", maxSteps: 1, predict: async (context, events, _signal, _desktop, workflow) => {
    assert.doesNotMatch(JSON.stringify({ context, events, workflow }), /AGENT_CHOSEN_FUTURE_RESOURCE|unit\/99/);
    return none();
  } });
});
