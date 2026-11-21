import test from "node:test";
import assert from "node:assert/strict";
import { TaskMemory, type TaskHypothesis } from "./tasks.js";
import type { QueueProposal } from "./work-queue.js";

const names = ["Alex Morgan", "Sam Rivera", "Jamie Chen"];
function setup(truncated = false, rows = names) {
  const memory = new TaskMemory();
  memory.observe({ url: "https://example.com/list", title: "Prospects", headings: ["Prospect list"], actions: [], excerpt: "Names to process",
    lists: [{ label: "Prospects", items: rows, truncated }] }, "list", []);
  for (const name of names.slice(0, 2)) memory.observe({ url: `https://example.com/${name}`, title: name, headings: [name], actions: ["Pending"], excerpt: "Invitation sent" }, "profile", []);
  return memory;
}
function candidate(overrides: Partial<TaskHypothesis> = {}): TaskHypothesis {
  return { taskId: null, title: "Connect prospects", confidence: .9, steps: ["Find profile", "Send invitation"], reason: "Two named outcomes observed",
    cycles: names.slice(0, 2).map((item, index) => ({ item, evidenceIds: [1, index + 2], outcome: "confirmed", outcomeEvidenceId: index + 2 })),
    totalItems: 3, totalEvidenceId: 1, remainingItems: [names[2]!], remainingEvidenceId: 1, currentItem: null,
    nextStep: "Continue", continuation: "likely", suggestedWorkflow: null, pattern: null,
    workQueue: { sourceObservationId: 1, sourceListIndex: 0,
      items: names.map((item, index) => ({ item, sourceRow: index + 1, state: "unstarted", evidenceId: 1, reason: "Visible source row" })) }, ...overrides };
}
function updateItem(state: "in_progress" | "blocked", evidenceId: number): QueueProposal {
  return { sourceObservationId: 1, sourceListIndex: 0, items: [{ item: names[2]!, sourceRow: 3, state, evidenceId, reason: state === "blocked" ? "No matching profile found" : "Checking Jamie's profile" }] };
}

test("queue derives exact remaining repetitions from verified unique membership, not a model finish label", () => {
  const queue = setup().accept(candidate({ continuation: "finished" }))!.workQueue;
  assert.equal(queue.scope, "verified");
  assert.deepEqual(queue.counts, { known: 3, confirmed: 2, ready: 1, inProgress: 0, blocked: 0, knownRemaining: 1, remaining: 1, total: 3 });
  assert.equal(queue.decision, "continue");
  assert.equal(queue.nextItem, names[2]);
});

test("duplicate names count once while unknown and invented identities cannot close a list", () => {
  const duplicate = setup(false, [...names, names[2]!]);
  const record = duplicate.accept(candidate({ totalItems: 4 }))!;
  assert.equal(record.totalItems, 3);
  assert.equal(record.remainingCount, 1);
  const memory = setup();
  const input = candidate();
  input.workQueue!.items[2] = { item: "Invented Person", sourceRow: 3, state: "unstarted", evidenceId: 1, reason: "Guess" };
  input.remainingItems = [];
  const queue = memory.accept(input)!.workQueue;
  assert.equal(queue.counts.total, null);
  assert.equal(queue.decision, "inspect");
  assert.ok(!queue.items.some((item) => item.item === "Invented Person"));
});

test("count and membership can use different snapshots of the same complete list", () => {
  const memory = setup();
  memory.observe({ url: "https://example.com/list", title: "Prospects", headings: [], actions: [], excerpt: "",
    lists: [{ label: "Prospects", items: names.map((name, i) => `${name} — ${i < 2 ? "Invitation sent" : "Not processed"}`), truncated: false }] }, "list", []);
  const input = candidate();
  input.workQueue!.sourceObservationId = 4;
  const record = memory.accept(input)!;
  assert.equal(record.workQueue.scope, "verified");
  assert.equal(record.workQueue.source?.observationId, 4);
  assert.equal(record.remainingCount, 1);
});

test("partial lists never become finished when every visible name is done", () => {
  const memory = setup(true, names.slice(0, 2));
  const input = candidate({ totalItems: 2, remainingItems: [] });
  input.workQueue!.items = input.workQueue!.items.slice(0, 2);
  const queue = memory.accept(input)!.workQueue;
  assert.equal(queue.scope, "partial");
  assert.equal(queue.counts.remaining, null);
  assert.equal(queue.counts.knownRemaining, 0);
  assert.equal(queue.decision, "inspect");
});

test("named in-progress evidence waits for an outcome; a click or model assertion cannot complete the item", () => {
  const memory = setup();
  memory.observe({ url: "https://example.com/jamie", title: names[2]!, headings: [names[2]!], actions: ["Connect"], excerpt: "No invitation has been sent" }, "profile", []);
  const input = candidate({ currentItem: names[2], workQueue: updateItem("in_progress", 4) });
  input.cycles.push({ item: names[2]!, evidenceIds: [4], outcome: "confirmed", outcomeEvidenceId: 4 });
  const queue = memory.accept(input)!.workQueue;
  assert.equal(queue.counts.inProgress, 1);
  assert.equal(queue.counts.confirmed, 2);
  assert.equal(queue.decision, "continue");
  assert.match(queue.reason, /checking the current item/);
});

test("a visible blocker pauses an exhausted queue, persists across refreshes and clears on confirmed outcome", () => {
  const memory = setup();
  memory.observe({ url: "https://example.com/jamie", title: `Search for ${names[2]}`, headings: [names[2]!], actions: [], excerpt: "No matching profile found" }, "profile", []);
  const record = memory.accept(candidate({ workQueue: updateItem("blocked", 4) }))!;
  assert.equal(record.workQueue.decision, "stop");
  assert.equal(record.workQueue.counts.blocked, 1);
  assert.equal(record.remainingCount, 1);
  assert.equal(record.workQueue.nextItem, null);
  memory.accept(candidate({ taskId: record.id }));
  assert.equal(memory.tasks[0]!.workQueue.counts.blocked, 1);
  memory.observe({ url: "https://example.com/jamie", title: names[2]!, headings: [names[2]!], actions: ["Pending"], excerpt: "Invitation sent" }, "profile", []);
  const next = candidate({ taskId: record.id, continuation: "likely", remainingItems: [] });
  next.cycles.push({ item: names[2]!, evidenceIds: [5], outcome: "confirmed", outcomeEvidenceId: 5 });
  const done = memory.accept(next)!;
  assert.equal(done.workQueue.decision, "complete");
  assert.equal(done.status, "complete");
  assert.equal(done.remainingCount, 0);
  assert.equal(done.workQueue.counts.blocked, 0);
});

test("unconfirmed attempts require review instead of being suggested again", () => {
  const input = candidate();
  input.cycles.push({ item: names[2]!, evidenceIds: [1], outcome: "attempted", outcomeEvidenceId: null });
  const queue = setup().accept(input)!.workQueue;
  assert.equal(queue.items.find((item) => item.item === names[2])!.state, "blocked");
  assert.equal(queue.decision, "stop");
});

test("a negated success message cannot finish the last queue item", () => {
  const memory = setup();
  memory.observe({ url: "https://example.com/jamie", title: names[2]!, headings: [names[2]!], actions: ["Connect"], excerpt: "No request sent. Try again." }, "profile", []);
  const input = candidate({ continuation: "finished", remainingItems: [] });
  input.cycles.push({ item: names[2]!, evidenceIds: [4], outcome: "confirmed", outcomeEvidenceId: 4 });
  const record = memory.accept(input)!;
  assert.equal(record.workQueue.decision, "stop");
  assert.equal(record.workQueue.counts.confirmed, 2);
  assert.equal(record.remainingCount, 1);
});

test("ready items can continue while other items remain blocked", () => {
  const memory = setup(false, [...names, "Taylor Reed"]);
  memory.observe({ url: "https://example.com/jamie", title: names[2]!, headings: [], actions: [], excerpt: "Multiple matches found" }, "profile", []);
  const input = candidate({ totalItems: 4, workQueue: updateItem("blocked", 4), remainingItems: [names[2]!, "Taylor Reed"] });
  const queue = memory.accept(input)!.workQueue;
  assert.equal(queue.decision, "continue");
  assert.equal(queue.nextItem, "Taylor Reed");
  assert.equal(queue.counts.blocked, 1);
  assert.equal(queue.counts.remaining, 2);
});

test("unknown, unrelated, and list-only state citations cannot manufacture blockers or active work", () => {
  for (const evidenceId of [1, 2, 900]) {
    for (const state of ["blocked", "in_progress"] as const) {
      const queue = setup().accept(candidate({ workQueue: updateItem(state, evidenceId) }))!.workQueue;
      assert.equal(queue.counts.blocked, 0);
      assert.equal(queue.counts.inProgress, 0);
      assert.equal(queue.counts.ready, 1);
    }
  }
});

test("a changed or shrinking source cannot silently complete the queue or inherit earlier completions", () => {
  for (const differentUrl of [false, true]) {
    const memory = setup();
    const first = memory.accept(candidate())!;
    memory.observe({ url: `https://example.com/${differentUrl ? "new-list" : "list"}`, title: "Prospects", headings: [], actions: [], excerpt: "",
      lists: [{ label: "Prospects", items: names.slice(0, 2), truncated: false }] }, "list", []);
    const record = memory.accept(candidate({ taskId: first.id, totalItems: 2, totalEvidenceId: 4, remainingEvidenceId: 4, remainingItems: [], continuation: "finished",
      workQueue: { sourceObservationId: 4, sourceListIndex: 0, items: candidate().workQueue!.items.slice(0, 2) } }))!;
    assert.equal(record.workQueue.decision, "stop");
    assert.equal(record.totalItems, null);
    assert.equal(record.workQueue.items.some((item) => item.item === names[2]), true);
  }
});
