import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@browserbasehq/stagehand";
import { TaskMemory, type TaskHypothesis } from "./tasks.js";
import { acceptPattern, patternSchema, resourceUrl, MAX_AUTOMATIC_TABS } from "./workflow-pattern.js";
import { WorkflowRunner, type WorkflowDriver } from "./workflow-runner.js";
import { PredictionDashboard } from "./dashboard.js";

function setup() {
  const memory = new TaskMemory();
  for (const unit of [1, 2]) memory.observe({ url: `https://example.com/unit/${unit}`, title: `Biology Unit ${unit} review guide`, headings: [`Biology Unit ${unit}`], actions: [], excerpt: "Biology course review guides" }, `unit-${unit}`,
    [{ id: unit, kind: "navigate", label: "Opened a review guide", time: Date.now(), pageId: `unit-${unit}`, url: `https://example.com/unit/${unit}` }]);
  return memory;
}
function hypothesis(overrides: Partial<TaskHypothesis> = {}): TaskHypothesis {
  return { taskId: null, title: "Gather biology review guides", confidence: .68, steps: ["Open the relevant review guide for {{item}}"], reason: "Two unit reviews suggest collecting the related unit guides.",
    cycles: [], totalItems: null, totalEvidenceId: null, remainingItems: [], remainingEvidenceId: null, currentItem: null, nextStep: "Open the next unit guides", continuation: "likely", suggestedWorkflow: null, workQueue: null,
    pattern: { action: "Collect review guides across biology units", repeatLikelihood: .86, reason: "The same goal applies across units, even with only two examples.", evidenceIds: [1, 2], operation: "open_tabs", goal: "resources", endCondition: "Stop at the end of this useful next-unit batch.", endKnown: false, maxItems: 3,
      targets: [3, 4, 5].map((unit) => ({ item: `Unit ${unit}`, url: `https://example.com/unit/${unit}`, basis: "inferred" })) }, ...overrides };
}
test("two simple actions create a one-step workflow and inferred queue without a full list or completed cycles", () => {
  const task = setup().accept(hypothesis())!;
  assert.ok(task); assert.equal(task.pattern?.repeatLikelihood, .86); assert.equal(task.steps.length, 1);
  assert.equal(task.workQueue.scope, "inferred"); assert.equal(task.totalItems, null);
  assert.deepEqual(task.remainingItems, ["Unit 3", "Unit 4", "Unit 5"]);
  assert.equal(task.workflowDraft.execution, "automatic"); assert.equal(task.workflowDraft.status, "ready");
});
test("one meaningful action plus a visible series can establish a broad repeated goal", () => {
  const memory = new TaskMemory();
  memory.observe({ url: "https://example.com/unit/1", title: "Biology review guides", headings: ["Review every unit"], actions: [], excerpt: "Five biology units",
    links: [2, 3].map((unit) => ({ title: `Unit ${unit} review`, url: `https://example.com/unit/${unit}` })) }, "source", [{ id: 1, pageId: "source", time: Date.now(), kind: "click", label: "Unit 1 review", url: "https://example.com/unit/1" }]);
  const input = hypothesis(); input.pattern!.evidenceIds = [1]; input.pattern!.targets = input.pattern!.targets.slice(0, 1);
  const task = memory.accept(input)!; assert.ok(task); assert.equal(task.pattern?.targets[0]?.basis, "observed");
});
test("a supported pattern is documented even before any useful remaining target is known", () => {
  const candidate = hypothesis(); candidate.pattern!.targets = [];
  const task = setup().accept(candidate)!;
  assert.ok(task); assert.equal(task.status, "repeating");
  assert.equal(task.workQueue.decision, "stop"); assert.equal(task.workQueue.items.length, 0);
  assert.match(task.workQueue.reason, /pattern was detected/);
  assert.equal(task.totalItems, null);
});
test("a model-proposed new task ID cannot silently discard a supported collection pattern", () => {
  const memory = setup();
  const input = hypothesis({ taskId: "ap-calc-unit-reviews" });
  const task = memory.accept(input)!;
  assert.ok(task); assert.notEqual(task.id, input.taskId);
  assert.match(task.id, /^[\da-f-]{36}$/);
  assert.equal(memory.accept(input), null, "The same title reuses the internal record even if the model repeats its descriptive ID");
  assert.equal(memory.tasks.length, 1);
});
test("hovering and automation output alone cannot trigger an inferred workflow", () => {
  const memory = setup();
  for (const frame of memory.observations) frame.actor = "workflow";
  assert.equal(acceptPattern(hypothesis().pattern, memory.observations), null);
  const frame = { ...setup().observations[0]!, events: [{ ...setup().observations[0]!.events[0]!, kind: "hover" }] };
  assert.equal(acceptPattern({ ...hypothesis().pattern!, evidenceIds: [1] }, [frame]), null);
});
test("YouTube IDs remain usable, searches may be inferred, and invented video IDs or unrelated hosts are rejected", () => {
  const memory = new TaskMemory();
  for (const unit of [1, 2]) memory.observe({ url: "https://www.youtube.com/watch", publicUrl: `https://www.youtube.com/watch?v=observed${unit}`, title: `Biology Unit ${unit} Review`, headings: [], actions: [], excerpt: "" }, `unit-${unit}`,
    [{ id: unit, pageId: `unit-${unit}`, time: Date.now(), kind: "navigate", label: "Opened review video", url: "https://www.youtube.com/watch" }]);
  const pattern = hypothesis().pattern!;
  pattern.targets = [
    { item: "Unit 3", url: "https://www.youtube.com/results?search_query=biology+unit+3+review", basis: "inferred" },
    { item: "Invented", url: "https://www.youtube.com/watch?v=invented", basis: "inferred" },
    { item: "Other host", url: "https://unrelated.example/unit/4", basis: "inferred" },
  ];
  const accepted = acceptPattern(pattern, memory.observations)!;
  assert.equal(accepted.targets.length, 1); assert.match(accepted.targets[0]!.url, /search_query/);
  assert.equal(resourceUrl("https://www.youtube.com/watch?v=real&auth=private#fragment"), "https://www.youtube.com/watch?v=real");
  assert.equal(resourceUrl("https://example.com/delete/record"), null);
});
test("large inferred series are bounded and unknown endpoints never become verified totals", () => {
  const input = hypothesis(); input.pattern!.maxItems = MAX_AUTOMATIC_TABS;
  input.pattern!.targets = Array.from({ length: 30 }, (_, index) => ({ item: `Unit ${index + 3}`, url: `https://example.com/unit/${index + 3}`, basis: "inferred" }));
  const task = setup().accept(input)!; assert.equal(task.workQueue.items.length, MAX_AUTOMATIC_TABS);
  assert.equal(task.totalItems, null); assert.match(task.workQueue.scopeReason, /endpoint is unknown/);
  assert.equal(patternSchema.safeParse({ ...input.pattern, maxItems: 100 }).success, false);
});

function runnerFixture() {
  const memory = setup(); const task = memory.accept(hypothesis())!; const opened: string[] = [];
  const driver: WorkflowDriver = {
    async open() { throw new Error("List runner must not be used for inferred resource tasks"); },
    async capture() { throw new Error("Unused"); }, async locate() { throw new Error("Unused"); }, async validate() {}, async perform() { throw new Error("No mutations expected"); },
    async openResource(url) { opened.push(url); return { pageId: `resource-${opened.length}`, context: { url, publicUrl: url, title: `Biology Unit ${url.split("/").at(-1)} review`, headings: [], actions: [], excerpt: "" } }; },
  };
  const runner = new WorkflowRunner({ getTask: (id) => memory.tasks.find((task) => task.id === id), driver: async () => driver,
    resourcePlan: async () => ({ status: "done", url: null, reason: "Related review guide opened" }),
    item: async (id, name, state, reason, snapshot) => { memory.recordExecution(id, name, state, reason, snapshot?.context, snapshot?.pageId, snapshot?.openedUrl); },
    change() {}, lock() {} });
  return { runner, task, memory, driver, opened };
}
test("the resource runner opens a batch automatically, records actual navigations, and stops at the bound", async () => {
  const f = runnerFixture();
  f.task.workflowDraft.inputs.push({ name: "course", description: "An optional reusable-template parameter" });
  f.task.workflowDraft.steps[0]!.instruction = "Find {{course}} review guides";
  f.runner.start(f.task.id); await f.runner.settled();
  assert.equal(f.opened.length, 3); assert.equal(f.runner.state?.status, "complete");
  assert.equal(f.task.completedItems.length, 3); assert.equal(f.task.totalItems, null);
  assert.ok(f.task.cycles.every((cycle) => cycle.actor === "workflow"));
});
test("an unavailable resource is skipped without a review gate and other targets still open", async () => {
  const f = runnerFixture(); const open = f.driver.openResource!;
  f.driver.openResource = async (url, follow) => { if (url.endsWith("/4")) throw new Error("No useful guide found"); return open(url, follow); };
  f.runner.start(f.task.id); await f.runner.settled();
  assert.equal(f.runner.state?.status, "complete"); assert.equal(f.task.completedItems.length, 2);
  assert.equal(f.task.workQueue.counts.blocked, 1); assert.ok(f.runner.state?.log.some((entry) => entry.kind === "skipped"));
});
test("a stop during tab navigation prevents subsequent tabs even when the first open resolves late", async () => {
  const f = runnerFixture(); let release: (() => void) | undefined; const open = f.driver.openResource!;
  f.driver.openResource = async (url, follow) => { await new Promise<void>((resolve) => { release = resolve; }); return open(url, follow); };
  f.runner.start(f.task.id);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  f.runner.pause(); release!(); await f.runner.settled();
  assert.equal(f.opened.length, 1); assert.equal(f.runner.state?.status, "paused");
});
test("a captured search result link can be followed, but an invented result URL cannot", async () => {
  const f = runnerFixture(); let calls = 0;
  f.driver.openResource = async (url, follow) => { calls++; return { pageId: "resource", context: { url, publicUrl: url, title: follow ? "Biology Unit review" : "Search results", headings: [], actions: [], excerpt: "",
    links: follow ? [] : [{ title: "Matching guide", url: url + "/video" }] } }; };
  const runner = new WorkflowRunner({ getTask: () => f.task, driver: async () => f.driver,
    resourcePlan: async (_task, _item, snapshot) => snapshot.context.links?.length ? { status: "follow", url: snapshot.context.links[0]!.url, reason: "Matching result" } : { status: "done", url: null, reason: "Guide opened" },
    item: async (id, name, state, reason, snapshot) => { f.memory.recordExecution(id, name, state, reason, snapshot?.context, snapshot?.pageId, snapshot?.openedUrl); }, change() {}, lock() {} });
  runner.start(f.task.id); await runner.settled(); assert.equal(calls, 6); assert.equal(f.task.completedItems.length, 3);
});
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(check()); }
test("the controller automatically starts a goal once per new human intent, not again from its own output", async () => {
  const dashboard = new PredictionDashboard({ isConfigured: () => true, debounceMs: 0, intervalMs: 0, autoDelayMs: 0,
    predict: async (_context, _events, _signal, _desktop, workflow) => ({ intent: "Collect reviews", summary: "Series goal", predictions: [{ action: "Open related unit guides", confidence: .8, evidence: "Two review pages" }], repeatableTask: { ...hypothesis(), taskId: workflow?.knownTasks[0]?.id || null } }) });
  const memory = setup(); dashboard.taskMemory.observations.push(...memory.observations);
  let opened = 0;
  dashboard.attachRunner({ driver: async () => ({ open: async () => {}, capture: async () => { throw new Error("Unused"); }, locate: async () => [], validate: async () => {}, perform: async () => false,
    openResource: async (url) => { opened++; return { pageId: `resource-${opened}`, context: { url, publicUrl: url, title: "Biology review", headings: [], actions: [], excerpt: "" } }; } }),
    resourcePlan: async () => ({ status: "done", url: null, reason: "Resource opened" }) });
  const context = memory.observations[1]!.context;
  const page = { pageId: "unit-2", url: async () => context.url, evaluate: async () => context } as unknown as Page;
  try {
    dashboard.activity({ id: 2, pageId: page.pageId, time: Date.now(), kind: "navigate", label: "Opened Unit 2 review", url: context.url }, page);
    await until(() => dashboard.runner?.state?.status === "complete"); assert.equal(opened, 3);
    dashboard.requestPrediction(); await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opened, 3, "Refreshing the same human evidence must not create another batch");
  } finally { dashboard.stop(); await dashboard.finishExecution(); }
});
