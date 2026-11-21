import { z } from "zod";
import type { TaskRecord } from "./tasks.js";

export const workflowSuggestionSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(400),
  inputs: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), description: z.string().max(240) })).min(1).max(6),
  steps: z.array(z.object({ sourceStep: z.number().int().min(1).max(8), instruction: z.string().min(1).max(400), check: z.string().min(1).max(300) })).min(1).max(8),
  stopWhen: z.string().min(1).max(300),
  notes: z.array(z.string().max(240)).max(6),
});
export type WorkflowSuggestion = z.infer<typeof workflowSuggestionSchema>;
export type WorkflowDraft = WorkflowSuggestion & {
  id: string; sourceTaskId: string; version: number; updatedAt: number;
  status: "ready"; execution: "automatic"; loop: string; skipCompleted: string;
  basedOnObservationIds: number[];
};

export function buildWorkflowDraft(task: Omit<TaskRecord, "workflowDraft">, proposed: WorkflowSuggestion | null, previous?: WorkflowDraft): WorkflowDraft {
  const names = [...new Set([...task.cycles.map((cycle) => cycle.item), ...task.remainingItems, ...(task.currentItem ? [task.currentItem] : [])])].sort((a, b) => b.length - a.length);
  const generalize = (text: string) => {
    for (const name of names) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "giu"), "{{item}}");
    text = text.replace(/<(?:name|person|item)>/gi, "{{item}}");
    text = text.replace(/\{\{\s*(?:name|person|current_item)\s*\}\}/gi, "{{item}}");
    for (const entry of task.evidence) {
      if (!entry.url) continue;
      text = text.split(entry.url).join(/list|prospect|queue|items/i.test(entry.title) ? "{{source_url}}" : "the matching result for {{item}}");
    }
    return text;
  };
  const observedOutcome = task.evidence.some((entry) => /\bpending\b|invitation sent/i.test(entry.signals))
    ? "Confirm Pending or Invitation sent for {{item}}. This verifies submission, not that the recipient accepted."
    : "Confirm a visible successful outcome for {{item}}. A click alone is not confirmation.";
  const fallback: WorkflowSuggestion = {
    title: generalize(task.title), summary: "A workflow inferred from the current goal and likely repeated actions.",
    inputs: [{ name: "items", description: "The list of names or items to process in this run." }],
    steps: task.steps.map((step, index) => ({ sourceStep: index + 1, instruction: generalize(step),
      check: index === task.steps.length - 1 ? observedOutcome : "Verify this step refers to the intended {{item}} before continuing." })),
    stopWhen: "Stop when every supplied item has a confirmed outcome. Pause if an item, match, or outcome is unclear; do not assume the list is complete.",
    notes: ["Run a bounded batch and stop when the goal is reached or useful targets run out."],
  };
  const validProposal = proposed && proposed.steps.length === task.steps.length
    && proposed.steps.every((step, index) => step.sourceStep === index + 1);
  let suggestion = validProposal ? proposed : fallback;
  const normalize = (input: WorkflowSuggestion): WorkflowSuggestion => ({
    title: generalize(input.title), summary: generalize(input.summary),
    inputs: [...new Map([{ name: "items", description: "The list of names or items to process in this run." }, ...input.inputs.filter((field) => field.name !== "item" && field.name !== "items")]
      .map((field) => [field.name, { ...field, description: generalize(field.description) }])).values()],
    steps: input.steps.map((step) => ({ ...step, instruction: generalize(task.steps[step.sourceStep - 1]!), check: generalize(step.check) })),
    stopWhen: generalize(input.stopWhen), notes: input.notes.map(generalize),
  });
  suggestion = normalize(suggestion);
  const draftText = (input: WorkflowSuggestion) => [input.title, input.summary, ...input.steps.flatMap((step) => [step.instruction, step.check]), input.stopWhen, ...input.notes].join(" ");
  const knownParameters = new Set(["item", ...suggestion.inputs.map((input) => input.name)]);
  // Do not export a template with undefined variables from a malformed proposal.
  const placeholders = [...draftText(suggestion).matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((match) => match[1]!);
  if (placeholders.some((name) => name !== "source_url" && !knownParameters.has(name))) suggestion = normalize(fallback);
  if (draftText(suggestion).includes("{{source_url}}") && !suggestion.inputs.some((input) => input.name === "source_url")) {
    suggestion.inputs.push({ name: "source_url", description: "The source list or queue location for this run." });
  }
  const notes = [...suggestion.notes];
  if (task.status === "suspected") notes.push("Early pattern inferred from limited activity; repetition is a probability estimate.");
  if (task.totalItems === null) notes.push("The full scope is unknown; the runner uses a bounded batch.");
  if (task.cycles.some((cycle) => cycle.outcome !== "confirmed")) notes.push("Some outcomes are unconfirmed; avoid repeating uncertain submissions.");
  return {
    ...suggestion, notes: [...new Set(notes)],
    id: previous?.id || `workflow-${task.id}`, sourceTaskId: task.id, version: (previous?.version || 0) + 1, updatedAt: task.updatedAt,
    status: "ready", execution: "automatic", loop: "For each {{item}} in {{items}}, follow the proposed steps below.",
    skipCompleted: "Skip duplicate items and items already confirmed complete in the current run. Do not carry completion from an earlier input list into a new run.",
    basedOnObservationIds: task.evidence.map((entry) => entry.id),
  };
}

export function workflowDraftReport(draft: WorkflowDraft, heading = "#") {
  const safe = (text: string) => text.replace(/[\r\n]/g, " ");
  return [
    `${heading} ${safe(draft.title)}`, "", "AUTOMATIC WORKFLOW. Inferred from activity and predictions; runs in bounded batches with a visible stop control.",
    `Version: ${draft.version} · Suggested: ${new Date(draft.updatedAt).toISOString()}`, "", safe(draft.summary), "",
    `${heading}# Inputs`, ...draft.inputs.map((input) => `- \`{{${input.name}}}\`: ${safe(input.description)}`), "",
    `${heading}# Repeated sequence`, safe(draft.loop), "", ...draft.steps.flatMap((step, index) => [
      `${index + 1}. ${safe(step.instruction)}`, `   Check: ${safe(step.check)} (workflow step ${step.sourceStep})`,
    ]), "", `${heading}# Skip and stop rules`, safe(draft.skipCompleted), "", safe(draft.stopWhen), "",
    `${heading}# Notes`, ...draft.notes.map((note) => `- ${safe(note)}`), "",
    `Based on task ${draft.sourceTaskId}; observations: ${draft.basedOnObservationIds.map((id) => `#${id}`).join(", ")}.`, "",
  ].join("\n");
}
