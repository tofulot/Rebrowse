import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowDraft, workflowDraftReport, type WorkflowSuggestion } from "./workflow-draft.js";
import { taskHypothesisSchema, type TaskRecord } from "./tasks.js";

function source(overrides: Partial<Omit<TaskRecord, "workflowDraft">> = {}): Omit<TaskRecord, "workflowDraft"> {
  return {
    id: "task-test", sessionId: "session-test", detectedAt: 1000, updatedAt: 2000,
    title: "Connect people from a list", confidence: 0.9,
    steps: ["Open https://example.com/prospects", "Search LinkedIn for Alex Morgan", "Open Alex Morgan's matching profile", "Send a connection request to Alex Morgan"],
    reason: "The same sequence was observed twice", cycles: [
      { item: "Alex Morgan", evidenceIds: [1, 2], outcome: "confirmed", outcomeEvidenceId: 2 },
      { item: "Sam Rivera", evidenceIds: [1, 3], outcome: "confirmed", outcomeEvidenceId: 3 },
    ], completedItems: ["Alex Morgan", "Sam Rivera"], totalItems: 3, remainingItems: ["Jamie Chen"], remainingCount: 1,
    currentItem: null, nextStep: "Search Jamie Chen", status: "repeating",
    workQueue: { source: null, scope: "unknown", scopeReason: "Source unknown", items: [],
      counts: { known: 0, confirmed: 0, ready: 0, inProgress: 0, blocked: 0, knownRemaining: 0, remaining: null, total: null },
      decision: "inspect", reason: "Inspect the source", nextItem: null, completionRule: "Confirm every item" },
    evidence: [{ id: 1, time: 1000, title: "Prospect list", url: "https://example.com/prospects", signals: "3 names" },
      { id: 2, time: 1200, title: "Alex Morgan", url: "https://example.com/in/alex", signals: "Pending · Invitation sent" }],
    ...overrides,
  };
}
const suggestion = (): WorkflowSuggestion => ({
  title: "Reusable prospect workflow", summary: "Apply the observed pattern to a new list.",
  inputs: [{ name: "items", description: "People to process" }],
  steps: source().steps.map((_step, index) => ({ sourceStep: index + 1, instruction: "Generalized instruction", check: "Verify the expected result for {{item}}" })),
  stopWhen: "Stop when all supplied items have a confirmed outcome; pause if matching or outcome is unclear.",
  reviewNotes: ["Review profile matching before future use."],
});

test("accepted tasks become reusable parameterized drafts with execution disabled", () => {
  const draft = buildWorkflowDraft(source(), null);
  assert.equal(draft.status, "draft");
  assert.equal(draft.execution, "disabled");
  assert.equal(draft.steps.length, 4);
  assert.ok(draft.inputs.some((input) => input.name === "items"));
  assert.ok(draft.inputs.some((input) => input.name === "source_url"));
  assert.match(draft.steps[0]!.instruction, /\{\{source_url\}\}/);
  assert.match(draft.steps[1]!.instruction, /\{\{item\}\}/);
  assert.doesNotMatch(JSON.stringify(draft), /Alex Morgan|Sam Rivera|Jamie Chen|https:\/\/example.com/);
  assert.match(draft.steps[3]!.check, /Pending|Invitation sent/);
  assert.match(draft.skipCompleted, /current run/);
});

test("suggestions provide checks but cannot replace observed steps with new actions", () => {
  const proposed = suggestion();
  proposed.steps[1]!.instruction = "Send an unobserved email";
  const draft = buildWorkflowDraft(source(), proposed);
  assert.equal(draft.title, proposed.title);
  assert.match(draft.steps[1]!.instruction, /Search LinkedIn/);
  assert.doesNotMatch(JSON.stringify(draft), /unobserved email/);
  assert.equal(draft.steps[1]!.check, proposed.steps[1]!.check);
});

test("extra steps, invalid source mappings and undefined template inputs fall back to observed steps", () => {
  for (const proposed of [
    { ...suggestion(), steps: [...suggestion().steps, { sourceStep: 5, instruction: "Email everyone", check: "Email sent" }] },
    { ...suggestion(), steps: suggestion().steps.map((step) => ({ ...step, sourceStep: 1 })) },
    { ...suggestion(), stopWhen: "Run until {{invented_input}}" },
  ]) {
    const draft = buildWorkflowDraft(source(), proposed);
    assert.equal(draft.steps.length, 4);
    assert.equal(draft.title, source().title);
    assert.doesNotMatch(JSON.stringify(draft), /Email everyone|invented_input/);
  }
});

test("uncertain evidence stays visible for review and regex characters in item names are literal", () => {
  const draft = buildWorkflowDraft(source({ status: "suspected", totalItems: null, cycles: [{ item: "Alex (A)", evidenceIds: [1, 2], outcome: "attempted", outcomeEvidenceId: null }], steps: ["Find Alex (A)", "Check Alex (A)"] }), null);
  assert.match(draft.steps[0]!.instruction, /\{\{item\}\}/);
  assert.ok(draft.reviewNotes.some((note) => /Only one/.test(note)));
  assert.ok(draft.reviewNotes.some((note) => /full source list is unknown/.test(note)));
  assert.ok(draft.reviewNotes.some((note) => /unconfirmed/.test(note)));
});

test("workflow exports are review-only and stable IDs get versioned when rebuilt", () => {
  const first = buildWorkflowDraft(source(), null);
  const second = buildWorkflowDraft(source({ updatedAt: 3000 }), suggestion(), first);
  assert.equal(first.id, second.id);
  assert.equal(second.version, 2);
  const report = workflowDraftReport(second);
  assert.match(report, /DRAFT SUGGESTION.*REVIEW ONLY/);
  assert.match(report, /Execution is disabled/);
  assert.match(report, /\{\{items\}\}/);
  assert.match(report, /Check:/);
  assert.match(report, /Skip and stop rules/);
  assert.match(report, /observations: #1, #2/);
});

test("a malformed optional suggestion cannot discard an otherwise valid task assessment", () => {
  const raw = { taskId: null, title: "Task", confidence: 0.9, steps: ["Find", "Check"], reason: "Observed",
    cycles: [], totalItems: null, totalEvidenceId: null, remainingItems: [], remainingEvidenceId: null,
    currentItem: null, nextStep: "Next", continuation: "likely", suggestedWorkflow: { inputs: [] } };
  assert.equal(taskHypothesisSchema.parse(raw).suggestedWorkflow, null);
});
