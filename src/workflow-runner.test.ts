import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Action } from "@browserbasehq/stagehand";
import { TaskMemory, type TaskHypothesis } from "./tasks.js";
import type { PageContext } from "./observer.js";
import { WorkflowRunner, WorkflowRunJournal, workflowReadiness, type WorkflowDriver, type StepPlanner } from "./workflow-runner.js";
import { PredictionDashboard, startDashboard } from "./dashboard.js";

function fixture(remaining = ["Jamie Chen"]) {
  const memory = new TaskMemory(); const names = ["Alex Morgan", "Sam Rivera", ...remaining];
  const source: PageContext = { url: "https://example.com/list", title: "Prospects", headings: [], actions: [], excerpt: "Complete list",
    lists: [{ label: "Prospects", items: names, truncated: false }] };
  memory.observe(source, "list", []);
  for (const name of names.slice(0, 2)) memory.observe({ url: "https://example.com/profile", title: name, headings: [name], actions: ["Pending"], excerpt: "Invitation sent" }, "profile", []);
  const candidate: TaskHypothesis = { taskId: null, title: "Invite prospects", confidence: .9, steps: ["Find the matching profile for {{item}}", "Send an invitation to {{item}}"], reason: "Observed twice",
    cycles: names.slice(0, 2).map((item, i) => ({ item, evidenceIds: [1, i + 2], outcome: "confirmed", outcomeEvidenceId: i + 2 })),
    totalItems: names.length, totalEvidenceId: 1, remainingItems: remaining, remainingEvidenceId: 1, currentItem: null, nextStep: "Continue", continuation: "likely", workQueue: null, suggestedWorkflow: null, pattern: null };
  const task = memory.accept(candidate)!;
  let stage = "list"; let currentItem = remaining[0]!; let actions = 0; let opens = 0;
  const context = (): PageContext => stage === "list" ? source : { url: "https://example.com/profile", title: currentItem, headings: [currentItem],
    actions: [stage === "done" ? "Pending" : "Connect"], excerpt: stage === "done" ? "Invitation sent" : "No invitation has been sent" };
  const driver: WorkflowDriver = {
    async open() { opens++; stage = "list"; }, async capture() { return { pageId: "runner", context: context() }; },
    async locate() { return [{ selector: stage === "list" ? "#profile" : "#send", method: "click", description: "The matching target" }]; },
    async validate() {}, async perform() { actions++; stage = stage === "list" ? "profile" : "done"; return true; },
  };
  const plan: StepPlanner = async ({ item, step, snapshot }) => {
    currentItem = item;
    return stage === "done" ? { status: "item_complete", instruction: "", evidence: ["Invitation sent"], reason: "Visible outcome" }
      : stage === "profile" && step === 1 ? { status: "step_complete", instruction: "", evidence: [item], reason: "Named matching profile" }
      : { status: "act", instruction: stage === "list" ? `Open the profile for ${item}` : "Click Connect once", evidence: [snapshot.context.title], reason: "Observed step" };
  };
  const runner = new WorkflowRunner({ getTask: (id) => memory.tasks.find((task) => task.id === id), driver: async () => driver, plan, settleMs: 0,
    item: async (id, item, state, reason, snapshot) => { memory.recordExecution(id, item, state, reason, snapshot?.context, snapshot?.pageId); }, change() {}, lock() {} });
  return { runner, memory, task, candidate, driver, plan, source, actions: () => actions, opens: () => opens,
    setStage: (next: string) => { stage = next; }, start: () => runner.start(task.id),
    options: { getTask: (id: string) => memory.tasks.find((task) => task.id === id), driver: async () => driver, plan, settleMs: 0,
      item: async (id: string, item: string, state: "unstarted" | "in_progress" | "blocked" | "confirmed", reason: string, snapshot?: { context: PageContext; pageId: string }) => { memory.recordExecution(id, item, state, reason, snapshot?.context, snapshot?.pageId); }, change() {}, lock() {} } };
}
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(check()); }

test("starting a queued workflow skips completed items and verifies named outcomes", async () => {
  const f = fixture(["Jamie Chen", "Taylor Reed"]);
  assert.equal(f.actions(), 0); assert.equal(f.opens(), 0);
  f.start(); await f.runner.settled();
  assert.equal(f.runner.state?.status, "complete");
  assert.deepEqual(f.runner.state?.completedItems, ["Jamie Chen", "Taylor Reed"]);
  assert.equal(f.actions(), 4); assert.equal(f.opens(), 2);
  assert.equal(f.task.remainingCount, 0); assert.equal(f.task.workQueue.decision, "complete");
  assert.equal(f.task.cycles.filter((cycle) => cycle.actor === "workflow").length, 2);
  assert.ok(f.memory.observations.some((frame) => frame.actor === "workflow"));
  assert.equal(workflowReadiness(f.task).canRun, false);
});

test("automatic runs need a known source or resource targets, without an approval token", () => {
  const f = fixture();
  f.task.workQueue.source = null;
  assert.throws(f.start, /source page/);
  assert.equal(f.opens(), 0); assert.equal(f.actions(), 0);
});

test("the runner rechecks an in-progress item from the source and verifies its outcome", async () => {
  const f = fixture();
  f.memory.recordExecution(f.task.id, "Jamie Chen", "in_progress", "The named profile is open.");
  assert.equal(workflowReadiness(f.task).canRun, true);
  f.start(); await f.runner.settled();
  assert.equal(f.runner.state?.status, "complete"); assert.equal(f.actions(), 2);
  assert.equal(f.task.workQueue.counts.confirmed, 3);
});

test("missing confirmation blocks each attempted item without retrying its action", async () => {
  const f = fixture(["Jamie Chen", "Taylor Reed"]);
  let submissions = 0;
  f.driver.perform = async (action) => { if (action.selector === "#profile") f.setStage("profile"); else submissions++; return true; };
  f.start(); await f.runner.settled();
  assert.equal(submissions, 2); assert.equal(f.runner.state?.status, "complete");
  assert.ok(f.runner.state?.log.some((entry) => /final action was attempted|already attempted/.test(entry.message)));
  assert.equal(f.task.workQueue.counts.blocked, 2);
  assert.equal(f.task.workQueue.items.find((item) => item.item === "Taylor Reed")?.state, "blocked");
});

test("pause during preparation revokes a late action and holds the lock until preparation settles", async () => {
  const f = fixture(); let resolve: ((actions: Action[]) => void) | undefined;
  f.driver.locate = async () => new Promise((done) => { resolve = done; });
  f.start(); await until(() => !!resolve); f.runner.pause();
  assert.equal(f.runner.state?.status, "pausing"); assert.equal(f.runner.busy, true);
  assert.throws(f.start, /already running/);
  resolve!([{ selector: "#profile", method: "click", description: "Late target" }]);
  await f.runner.settled(); assert.equal(f.actions(), 0); assert.equal(f.runner.busy, false);
  assert.equal(f.runner.state?.status, "paused"); assert.equal(f.task.workQueue.counts.ready, 1);
});

test("pausing an in-flight submission records its visible outcome but cannot dispatch another action", async () => {
  const f = fixture(["Jamie Chen", "Taylor Reed"]); const perform = f.driver.perform;
  let release: (() => void) | undefined;
  f.driver.perform = async (action) => {
    if (action.selector === "#send") await new Promise<void>((resolve) => { release = resolve; });
    return perform(action);
  };
  f.start(); await until(() => !!release); f.runner.pause();
  assert.equal(f.runner.busy, true); release!(); await f.runner.settled();
  assert.equal(f.actions(), 2); assert.equal(f.runner.state?.status, "paused");
  assert.equal(f.task.workQueue.items.find((item) => item.item === "Jamie Chen")?.state, "confirmed");
  assert.equal(f.task.workQueue.items.find((item) => item.item === "Taylor Reed")?.state, "unstarted");
});

test("ambiguous or unsupported actions and fabricated outcome evidence pause before extra mutations", async () => {
  for (const kind of ["multiple", "evaluate", "invented outcome"] as const) {
    const f = fixture();
    if (kind === "multiple") f.driver.locate = async () => [{ selector: "#a", method: "click", description: "A" }, { selector: "#b", method: "click", description: "B" }];
    if (kind === "evaluate") f.driver.locate = async () => [{ selector: "body", method: "evaluate", arguments: ["bad code"], description: "Unsupported method" }];
    const runner = kind === "invented outcome" ? new WorkflowRunner({ ...f.options,
      plan: async () => ({ status: "item_complete", instruction: "", reason: "Claim", evidence: ["Invented successful outcome"] }) }) : f.runner;
    runner.start(f.task.id); await runner.settled();
    assert.equal(runner.state?.status, "complete"); assert.equal(f.actions(), 0); assert.equal(f.task.workQueue.counts.blocked, 1); assert.equal(f.task.workQueue.counts.confirmed, 2);
  }
});

test("a success label on another person's page or a contradictory outcome cannot complete the item", async () => {
  for (const wrongPerson of [false, true]) {
    const f = fixture(); const capture = f.driver.capture;
    f.driver.capture = async () => {
      const snapshot = await capture();
      if (snapshot.context.title === "Prospects") return snapshot;
      snapshot.context = { ...snapshot.context, title: wrongPerson ? "Jamie Chenoweth" : "Jamie Chen", headings: [], actions: ["Pending"],
        excerpt: wrongPerson ? "Invitation sent to Jamie Chenoweth" : "No invitation has been sent" };
      return snapshot;
    };
    const runner = new WorkflowRunner({ ...f.options, plan: async (request, signal) => request.snapshot.context.title === "Prospects" ? f.plan(request, signal)
      : { status: "item_complete", instruction: "", reason: "Claimed done", evidence: ["Pending"] } });
    runner.start(f.task.id); await runner.settled();
    assert.equal(runner.state?.status, "complete"); assert.equal(f.task.workQueue.counts.blocked, 1); assert.equal(f.task.workQueue.counts.confirmed, 2);
  }
});

test("a run-journal failure stops dispatch before the first action", async () => {
  const f = fixture();
  const journal = new WorkflowRunJournal("/dev/null/workflow.jsonl");
  const runner = new WorkflowRunner({ ...f.options, journal });
  runner.start(f.task.id); await runner.settled();
  assert.equal(runner.state?.status, "paused"); assert.equal(f.actions(), 0); assert.equal(f.opens(), 0);
});

test("live source changes and queue membership changes invalidate execution", async () => {
  const changedSource = fixture(); changedSource.source.lists![0]!.items.push("New Person");
  changedSource.start(); await changedSource.runner.settled();
  assert.equal(changedSource.actions(), 2); assert.equal(changedSource.task.completedItems.length, 3, "Additional source rows are outside this bounded batch");
  const f = fixture(); const runner = new WorkflowRunner({ ...f.options, plan: async (request, signal) => {
    f.task.workflowDraft.version++; return f.plan(request, signal);
  } });
  runner.start(f.task.id); await runner.settled();
  assert.equal(f.actions(), 0); assert.match(runner.state?.message || "", /membership changed/);
});

test("required inputs gate execution and the journal records the start, actions, and final state", async () => {
  const f = fixture(); f.task.workflowDraft.inputs.push({ name: "team", description: "The intended team" });
  assert.throws(f.start, /Supply the team input/); assert.equal(f.opens(), 0);
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-run-"));
  try {
    const journal = new WorkflowRunJournal(join(directory, "run.jsonl"));
    const runner = new WorkflowRunner({ ...f.options, journal });
    runner.start(f.task.id, { team: "Research" }); await runner.settled();
    const lines = (await readFile(journal.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].log[0].kind, "automatic"); assert.equal(lines.at(-1).status, "complete");
    assert.ok(lines.some((line) => line.log.some((entry: { kind: string }) => entry.kind === "dispatching")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workflows start from predictions without an approval endpoint and can be stopped", async () => {
  const f = fixture(); let release: ((actions: Action[]) => void) | undefined;
  f.driver.locate = async () => new Promise((resolve) => { release = resolve; });
  const dashboard = new PredictionDashboard({ isConfigured: () => true, debounceMs: 0, intervalMs: 0, autoDelayMs: 0,
    predict: async () => ({ intent: "Invite prospects", summary: "Known repeating task", predictions: [{ action: "Continue the next name", confidence: .8, evidence: "Observed list" }], repeatableTask: { ...f.candidate, taskId: f.task.id } }) });
  dashboard.taskMemory.tasks.push(f.task); dashboard.taskMemory.observations.push(...f.memory.observations); dashboard.state.tasks = dashboard.taskMemory.tasks;
  dashboard.attachRunner({ driver: async () => f.driver, plan: f.plan, settleMs: 0 });
  const server = await startDashboard(dashboard);
  const page = { pageId: "source", url: async () => f.source.url, evaluate: async () => f.source } as unknown as import("@browserbasehq/stagehand").Page;
  try {
    assert.equal((await fetch(server.url + "workflow-run", { method: "POST", headers: { Origin: server.origin } })).status, 404);
    dashboard.activity({ id: 1, pageId: page.pageId, time: Date.now(), kind: "navigate", label: "Opened the list", url: f.source.url }, page);
    await until(() => !!release);
    assert.equal(dashboard.runner?.state?.status, "running");
    assert.equal((await fetch(server.url + "workflow-pause", { method: "POST", headers: { Origin: "https://untrusted.example" } })).status, 403);
    await fetch(server.url + "workflow-pause", { method: "POST", headers: { Origin: server.origin } });
    release!([]); await dashboard.finishExecution();
    assert.equal(dashboard.runner?.state?.status, "paused"); assert.equal(f.actions(), 0);
  } finally { dashboard.stop(); await dashboard.finishExecution(); await server.close(); }
});
