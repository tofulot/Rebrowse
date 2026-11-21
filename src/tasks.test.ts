import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskMemory, TaskJournal, taskReport, type TaskHypothesis } from "./tasks.js";

function setup() {
  const memory = new TaskMemory();
  memory.observe({ url: "https://example.com/list", title: "Prospects", headings: ["3 names total"], actions: [], excerpt: "Full list: Alex Morgan, Sam Rivera, Jamie Chen", lists: [{ label: "Prospects", items: ["Alex Morgan", "Sam Rivera", "Jamie Chen"], truncated: false }] }, "list", []);
  memory.observe({ url: "https://example.com/alex", title: "Alex Morgan", headings: ["Alex Morgan"], actions: ["Pending"], excerpt: "Invitation sent" }, "profile", []);
  memory.observe({ url: "https://example.com/sam", title: "Sam Rivera", headings: ["Sam Rivera"], actions: ["Pending"], excerpt: "Invitation sent" }, "profile", []);
  return memory;
}
const task = (overrides: Partial<TaskHypothesis> = {}): TaskHypothesis => ({
  taskId: null, title: "Connect with people from the prospect list", confidence: 0.9,
  steps: ["Choose an unprocessed name", "Search LinkedIn", "Open their profile", "Send a connection request"],
  reason: "Two distinct people followed the same flow and both profiles show Pending. Jamie remains in the observed three-name list.",
  cycles: [
    { item: "Alex Morgan", evidenceIds: [1, 2], outcome: "confirmed", outcomeEvidenceId: 2 },
    { item: "Sam Rivera", evidenceIds: [1, 3], outcome: "confirmed", outcomeEvidenceId: 3 },
  ], totalItems: 3, totalEvidenceId: 1, remainingItems: ["Jamie Chen"], remainingEvidenceId: 1,
  currentItem: null, nextStep: "Return to the list and search LinkedIn for Jamie Chen", continuation: "likely", suggestedWorkflow: null, pattern: null, workQueue: null, ...overrides,
});

test("two distinct cycles produce an evidence-backed detection with one known remaining item", () => {
  const memory = setup();
  const record = memory.accept(task());
  assert.ok(record);
  assert.equal(record.status, "repeating");
  assert.equal(record.completedItems.length, 2);
  assert.equal(record.remainingCount, 1);
  assert.deepEqual(record.remainingItems, ["Jamie Chen"]);
  assert.equal(record.evidence.length, 3);
  assert.equal(memory.accept(task()), null, "Repeated model refresh must not duplicate journal entries");
  assert.equal(memory.log.length, 1);
  assert.equal(record.workflowDraft.execution, "automatic");
  assert.equal(record.workflowDraft.version, 1);
  assert.equal(memory.tasks[0]!.workflowDraft.id, record.workflowDraft.id);
});

test("one item, duplicate-item cycles, low confidence and invented observation IDs do not create detections", () => {
  for (const candidate of [
    task({ cycles: task().cycles.slice(0, 1), totalItems: null, totalEvidenceId: null, remainingItems: [], remainingEvidenceId: null }),
    task({ cycles: [task().cycles[0]!, { ...task().cycles[0]!, item: "alex morgan" }], totalItems: null, totalEvidenceId: null, remainingItems: [], remainingEvidenceId: null }),
    task({ confidence: 0.5 }),
    task({ cycles: task().cycles.map((cycle) => ({ ...cycle, evidenceIds: [900], outcomeEvidenceId: 900 })) }),
  ]) assert.equal(setup().accept(candidate), null);
});

test("one confirmed cycle and a visibly unfinished list is documented as suspected, not repeated", () => {
  const record = setup().accept(task({ cycles: task().cycles.slice(0, 1), remainingItems: ["Sam Rivera", "Jamie Chen"] }));
  assert.equal(record?.status, "suspected");
  assert.equal(record?.remainingCount, 2);
  assert.equal(record?.cycles.length, 1);
});

test("clicks alone remain attempts and a missing list does not invent a remaining count", () => {
  const record = setup().accept(task({
    cycles: task().cycles.map((cycle) => ({ ...cycle, outcomeEvidenceId: null })),
    totalItems: null, totalEvidenceId: null, remainingItems: ["Invented Person"], remainingEvidenceId: null,
    continuation: "uncertain",
  }));
  assert.ok(record);
  assert.equal(record.completedItems.length, 0);
  assert.ok(record.cycles.every((cycle) => cycle.outcome === "attempted"));
  assert.equal(record.totalItems, null);
  assert.equal(record.remainingCount, null);
  assert.deepEqual(record.remainingItems, ["Alex Morgan", "Sam Rivera"]);
  assert.equal(record.workQueue.counts.blocked, 2);
  assert.equal(record.workQueue.decision, "stop");
  assert.equal(record.status, "uncertain");
});

test("an existing observation ID without a visible named outcome cannot confirm completion", () => {
  const memory = setup();
  for (const frame of memory.observations.slice(1)) { frame.context.actions = ["Connect"]; frame.context.excerpt = "No invitation has been sent"; }
  const record = memory.accept(task());
  assert.equal(record?.completedItems.length, 0);
  assert.match(record?.reason || "", /retained as attempts/);
});

test("a valid separately cited outcome is linked into the cycle evidence", () => {
  const memory = setup();
  const record = memory.accept(task({ cycles: task().cycles.map((cycle) => ({ ...cycle, evidenceIds: [1] })) }));
  assert.equal(record?.completedItems.length, 2);
  assert.ok(record?.cycles[0]!.evidenceIds.includes(2));
  assert.ok(record?.cycles[1]!.evidenceIds.includes(3));
});

test("partial lists and invented remaining names do not establish full progress", () => {
  const memory = setup();
  memory.observations[0]!.context.lists![0]!.truncated = true;
  const record = memory.accept(task({ remainingItems: ["Invented Name"] }));
  assert.equal(record?.totalItems, null);
  assert.equal(record?.remainingCount, null);
  assert.deepEqual(record?.remainingItems, []);
});

test("unsupported citations and name typos are discarded while valid named evidence is retained", () => {
  const record = setup().accept(task({
    cycles: task().cycles.map((cycle) => ({ ...cycle, evidenceIds: [...cycle.evidenceIds, 900] })),
    remainingItems: ["Jamie Rivera"], currentItem: "Jamie Chen",
  }));
  assert.ok(record);
  assert.ok(record.cycles.every((cycle) => !cycle.evidenceIds.includes(900)));
  assert.deepEqual(record.remainingItems, ["Jamie Chen"]);
});

test("a task is complete only when all established items have confirmed outcomes", () => {
  const memory = setup();
  const first = memory.accept(task())!;
  memory.accept(task({ taskId: first.id, continuation: "finished", remainingItems: [] }));
  assert.equal(memory.tasks[0]!.status, "repeating");
  assert.equal(memory.tasks[0]!.workQueue.decision, "continue", "A model finish label cannot override remaining queue items");
  memory.observe({ url: "https://example.com/jamie", title: "Jamie Chen", headings: ["Jamie Chen"], actions: ["Pending"], excerpt: "Invitation sent" }, "profile", []);
  const done = memory.accept(task({ taskId: first.id, cycles: [...task().cycles, { item: "Jamie Chen", evidenceIds: [1, 4], outcome: "confirmed", outcomeEvidenceId: 4 }], remainingItems: [], continuation: "finished" }));
  assert.equal(done?.status, "complete");
  assert.equal(done?.remainingCount, 0);
  assert.equal(done?.completedItems.length, 3);
});

test("changed outcomes update one task; observations are deduplicated and bounded", () => {
  const memory = setup();
  const first = memory.accept(task())!;
  const context = { url: "https://example.com/jamie", title: "Jamie Chen", headings: [], actions: [], excerpt: "No result yet" };
  assert.equal(memory.observe(context, "profile", []), true);
  assert.equal(memory.observe(context, "profile", []), false);
  for (let index = 0; index < 90; index++) memory.observe({ ...context, title: String(index) }, "profile", []);
  assert.equal(memory.observations.length, 80);
  assert.equal(memory.tasks[0]!.id, first.id);
  assert.ok(memory.context([]).observations.length <= 40);
});

test("journal persists assessments and export documents evidence and unknown progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-task-test-"));
  try {
    const record = setup().accept(task())!;
    const journal = new TaskJournal(join(directory, "nested/tasks.jsonl"));
    await journal.append(record);
    await journal.flush();
    const stored = JSON.parse((await readFile(journal.path, "utf8")).trim());
    assert.equal(stored.id, record.id);
    assert.equal(stored.remainingItems[0], "Jamie Chen");
    assert.equal(stored.workflowDraft.execution, "automatic");
    const report = taskReport([record]);
    assert.match(report, /Workflows can run automatically/);
    assert.match(report, /Jamie Chen/);
    assert.match(report, /Supporting observations/);
    assert.match(report, /remaining: 1/);
    assert.match(report, /AUTOMATIC WORKFLOW/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
