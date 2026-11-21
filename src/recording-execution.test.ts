import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@browserbasehq/stagehand";
import { PredictionDashboard } from "./dashboard.js";
import { SessionRecorder, parseRecording } from "./recording.js";
import type { PageContext } from "./observer.js";
import type { TaskHypothesis } from "./tasks.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check());
}
const context = (unit: number): PageContext => ({ url: `https://example.com/unit/${unit}`, title: `Calculus Unit ${unit} Review`, headings: [], actions: [], excerpt: "" });
async function setup(delay = 0, gate?: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-record-execution-"));
  const recorder = new SessionRecorder(directory); const opened: string[] = [];
  const dashboard = new PredictionDashboard({ recorder, isConfigured: () => true, debounceMs: 0, intervalMs: 0, autoDelayMs: delay,
    predict: async (_context, _events, _signal, _desktop, workflow) => {
      const task: TaskHypothesis = { taskId: workflow?.knownTasks[0]?.id || null, title: "Collect calculus unit reviews", confidence: .8,
        steps: ["Open the review for {{item}}"], reason: "Two related unit reviews", cycles: [], totalItems: null, totalEvidenceId: null,
        remainingItems: [], remainingEvidenceId: null, currentItem: null, nextStep: "Open the next unit reviews", continuation: "likely", suggestedWorkflow: null, workQueue: null,
        pattern: { action: "Collect calculus unit reviews", repeatLikelihood: .9, reason: "Two reviews in a course", evidenceIds: [1, 2], operation: "open_tabs", goal: "resources",
          endCondition: "Stop after Unit 4 in this batch", endKnown: false, maxItems: 2,
          targets: [3, 4].map((unit) => ({ item: `Unit ${unit}`, url: context(unit).url, basis: "inferred" })) } };
      return { intent: task.title, summary: task.reason, predictions: [{ action: task.nextStep, confidence: .8, evidence: "Two unit reviews" }], repeatableTask: task };
    } });
  dashboard.attachRunner({ driver: async () => ({ open: async () => {}, capture: async () => { throw new Error("Unused"); }, locate: async () => [], validate: async () => {}, perform: async () => false,
    openResource: async (url) => { opened.push(url); await gate?.(); return { pageId: "agent-" + url.split("/").at(-1), context: { ...context(Number(url.split("/").at(-1))) } }; } }),
    resourcePlan: async () => ({ status: "done", url: null, reason: "The review guide is open" }) });
  for (const unit of [1, 2]) dashboard.taskMemory.observe(context(unit), "human", []);
  const page = { pageId: "human", url: async () => context(2).url, evaluate: async () => context(2) } as unknown as Page;
  const detect = () => { dashboard.activity({ id: 1, time: Date.now(), pageId: page.pageId, kind: "navigate", label: "Opened a review", url: context(2).url }, page); dashboard.requestPrediction(); };
  const cleanup = async () => { dashboard.stop(); await dashboard.finishExecution(); await dashboard.finishRecording(); await rm(directory, { recursive: true, force: true }); };
  return { dashboard, recorder, opened, detect, cleanup };
}

test("a detected workflow runs during recording, logs agent outcomes, and cannot re-run from replay", async () => {
  const f = await setup();
  try {
    await f.dashboard.startRecording(); f.detect();
    await until(() => f.dashboard.runner?.state?.status === "complete");
    assert.deepEqual(f.opened, [context(3).url, context(4).url]);
    assert.equal(f.recorder.capturing, true);
    const runId = f.dashboard.runner!.state!.id;
    await f.dashboard.stopRecording();
    const records = parseRecording(await f.recorder.download());
    assert.ok(records.some((record) => record.type === "workflow" && record.status === "complete"));
    assert.equal(records.filter((record) => record.type === "observation" && record.frame.actor === "workflow").length, 2);
    assert.equal(f.recorder.state.steps, 1, "Automation does not add human demonstration steps");
    await f.dashboard.replayLatest(); await until(() => f.dashboard.state.replay.status === "done");
    assert.equal(f.opened.length, 2); assert.equal(f.dashboard.runner!.state!.id, runId);
  } finally { await f.cleanup(); }
});

test("stopping a recording cannot cancel an already queued automatic workflow", async () => {
  const f = await setup(100);
  try {
    await f.dashboard.startRecording(); f.detect();
    await until(() => f.dashboard.state.execution.reason.startsWith("Starting 2"));
    await f.dashboard.stopRecording();
    await until(() => f.dashboard.runner?.state?.status === "complete");
    assert.equal(f.opened.length, 2); assert.equal(f.recorder.state.status, "saved");
  } finally { await f.cleanup(); }
});

test("starting a recording during a run neither pauses the run nor waits for it to finish", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await setup(0, () => gate);
  try {
    f.detect(); await until(() => f.opened.length === 1);
    await Promise.race([f.dashboard.startRecording(), new Promise((_, reject) => setTimeout(() => reject(new Error("Recording incorrectly waited for the workflow")), 500))]);
    assert.equal(f.dashboard.runner!.state!.status, "running"); assert.equal(f.recorder.capturing, true);
    release(); await f.dashboard.finishExecution(); assert.equal(f.opened.length, 2);
  } finally { release(); await f.cleanup(); }
});
