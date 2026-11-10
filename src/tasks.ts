import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Activity, PageContext } from "./observer.js";
import { workflowSuggestionSchema, buildWorkflowDraft, workflowDraftReport, type WorkflowDraft } from "./workflow-draft.js";

export const taskHypothesisSchema = z.object({
  taskId: z.string().nullable(),
  title: z.string().min(1).max(160),
  confidence: z.number().min(0).max(1),
  steps: z.array(z.string().min(1).max(160)).min(2).max(8),
  reason: z.string().max(700),
  cycles: z.array(z.object({
    item: z.string().min(1).max(160),
    evidenceIds: z.array(z.number().int().positive()).min(1).max(8),
    outcome: z.enum(["confirmed", "attempted"]),
    outcomeEvidenceId: z.number().int().positive().nullable(),
  })).max(40),
  totalItems: z.number().int().min(0).nullable(),
  totalEvidenceId: z.number().int().positive().nullable(),
  remainingItems: z.array(z.string().max(160)).max(40),
  remainingEvidenceId: z.number().int().positive().nullable(),
  currentItem: z.string().max(160).nullable(),
  nextStep: z.string().max(300),
  continuation: z.enum(["likely", "uncertain", "finished"]),
  suggestedWorkflow: workflowSuggestionSchema.nullable().catch(null),
});
export type TaskHypothesis = z.infer<typeof taskHypothesisSchema>;
export type Observation = { id: number; time: number; pageId: string; context: PageContext; events: Activity[] };
export type TaskRecord = {
  id: string; sessionId: string; detectedAt: number; updatedAt: number;
  title: string; confidence: number; steps: string[]; reason: string;
  cycles: TaskHypothesis["cycles"]; completedItems: string[]; totalItems: number | null;
  remainingItems: string[]; remainingCount: number | null; currentItem: string | null;
  nextStep: string; status: "suspected" | "repeating" | "uncertain" | "complete";
  evidence: Array<{ id: number; time: number; title: string; url: string; signals: string }>;
  workflowDraft: WorkflowDraft;
};
export type WorkflowContext = { observations: Observation[]; knownTasks: TaskRecord[]; recentActivity: Activity[] };
const key = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export class TaskMemory {
  readonly sessionId = randomUUID();
  readonly observations: Observation[] = [];
  readonly tasks: TaskRecord[] = [];
  readonly log: TaskRecord[] = [];
  private sequence = 0;
  private lastFingerprint = "";

  observe(context: PageContext, pageId: string, events: Activity[], time = Date.now()) {
    context = { ...context, headings: context.headings.slice(0, 10), actions: context.actions.slice(0, 30), excerpt: context.excerpt.slice(0, 1600),
      lists: context.lists?.slice(0, 3).map((list) => ({ ...list, items: list.items.slice(0, 30).map((item) => item.slice(0, 160)), truncated: list.truncated || list.items.length > 30 })) };
    const fingerprint = JSON.stringify({ pageId, context });
    if (fingerprint === this.lastFingerprint) return false;
    this.lastFingerprint = fingerprint;
    this.observations.push({ id: ++this.sequence, time, pageId, context,
      events: events.filter((event) => event.pageId === pageId && time - event.time < 15000).slice(-8).map(({ addressText, ...event }) => ({ ...event, ...(addressText === undefined ? {} : { addressText: addressText.slice(0, 200) }) })) });
    if (this.observations.length > 80) this.observations.shift();
    return true;
  }

  context(events: Activity[]): WorkflowContext {
    const recent = this.observations.slice(-35);
    const sourceLists = this.observations.filter((frame) => frame.context.lists?.length).slice(-5);
    const observations = [...sourceLists, ...recent].filter((frame, index, all) => all.findIndex((other) => other.id === frame.id) === index).sort((a, b) => a.id - b.id);
    return { observations, knownTasks: this.tasks, recentActivity: events.slice(-60) };
  }

  accept(input: TaskHypothesis | null, time = Date.now()): TaskRecord | null {
    if (!input || input.confidence < 0.7) return null;
    const candidate = taskHypothesisSchema.parse(input);
    const frames = new Map(this.observations.map((frame) => [frame.id, frame]));
    const previous = candidate.taskId ? this.tasks.find((task) => task.id === candidate.taskId) : this.tasks.find((task) => key(task.title) === key(candidate.title));
    if (candidate.taskId && !previous) return null;
    const cycles = new Map((previous?.cycles || []).map((cycle) => [key(cycle.item), cycle]));
    let unverifiedOutcomes = 0;
    for (const cycle of candidate.cycles) {
      // Unknown evidence must never manufacture a repetition or completion.
      const evidenceIds = [...new Set([...cycle.evidenceIds, ...(cycle.outcomeEvidenceId === null ? [] : [cycle.outcomeEvidenceId])])].filter((id) => {
        const frame = frames.get(id);
        return frame && key([frame.context.title, ...frame.context.headings, ...frame.context.actions, frame.context.excerpt,
          ...(frame.context.lists || []).flatMap((list) => list.items)].join(" ")).includes(key(cycle.item));
      });
      if (!evidenceIds.length) continue;
      const outcomeFrame = cycle.outcomeEvidenceId === null ? undefined : frames.get(cycle.outcomeEvidenceId);
      const outcomeText = outcomeFrame ? [outcomeFrame.context.title, ...outcomeFrame.context.headings, outcomeFrame.context.excerpt].join(" ") : "";
      const outcomeVisible = outcomeFrame && (outcomeFrame.context.actions.some((action) => /^(pending|connected|sent|saved|completed|done|processed|submitted|success)\b/i.test(action))
        || /\b(invitation|request|message|email|form|record|changes|item|task)\s+(successfully\s+)?(sent|submitted|saved|completed|processed)\b/i.test(outcomeText));
      const confirmed = cycle.outcome === "confirmed" && outcomeFrame && cycle.outcomeEvidenceId !== null && evidenceIds.includes(cycle.outcomeEvidenceId)
        && key(outcomeText).includes(key(cycle.item)) && !!outcomeVisible;
      if (cycle.outcome === "confirmed" && !confirmed) unverifiedOutcomes++;
      const normalized = { ...cycle, evidenceIds, outcome: confirmed ? "confirmed" as const : "attempted" as const,
        outcomeEvidenceId: confirmed ? cycle.outcomeEvidenceId : null };
      if (cycles.get(key(cycle.item))?.outcome !== "confirmed") cycles.set(key(cycle.item), normalized);
    }
    if (cycles.size < 1) return null;
    const distinctEvidence = new Set([...cycles.values()].flatMap((cycle) => cycle.evidenceIds));
    if (distinctEvidence.size < 2) return null;
    const completedItems = [...cycles.values()].filter((cycle) => cycle.outcome === "confirmed").map((cycle) => cycle.item);
    const totalSource = candidate.totalEvidenceId === null ? undefined : frames.get(candidate.totalEvidenceId);
    const completeSourceList = totalSource?.context.lists?.some((list) => !list.truncated && list.items.length === candidate.totalItems);
    let totalItems = candidate.totalItems !== null && completeSourceList
      && candidate.totalItems >= cycles.size && candidate.totalItems >= (previous?.totalItems ?? 0) ? candidate.totalItems : previous?.totalItems ?? null;
    const remainingSource = candidate.remainingEvidenceId === null ? undefined : frames.get(candidate.remainingEvidenceId);
    const sourceText = remainingSource ? [...(remainingSource.context.lists || []).flatMap((list) => list.items), remainingSource.context.excerpt].join(" ").toLowerCase() : "";
    const remainingItems = remainingSource
      ? [...new Set([...candidate.remainingItems, ...(candidate.currentItem ? [candidate.currentItem] : [])])].filter((item) => sourceText.includes(key(item)) && !completedItems.some((done) => key(done) === key(item)))
      : (previous?.remainingItems || []).filter((item) => !completedItems.some((done) => key(done) === key(item)));
    if (totalItems !== null && totalItems < completedItems.length + remainingItems.length) totalItems = null;
    const remainingCount = totalItems === null ? null : Math.max(0, totalItems - completedItems.length);
    // One confirmed item plus an observed unfinished list supports a candidate,
    // but is not labeled an already repeated pattern.
    if (cycles.size === 1 && (completedItems.length !== 1 || (remainingCount === null ? remainingItems.length === 0 : remainingCount <= 0))) return null;
    const status = cycles.size === 1 ? "suspected" : totalItems !== null && remainingCount === 0 ? "complete" : candidate.continuation === "likely" ? "repeating" : "uncertain";
    const cited = new Set([...candidate.cycles.flatMap((cycle) => cycle.evidenceIds), ...candidate.cycles.flatMap((cycle) => cycle.outcomeEvidenceId === null ? [] : [cycle.outcomeEvidenceId]),
      ...(candidate.totalEvidenceId === null ? [] : [candidate.totalEvidenceId]), ...(candidate.remainingEvidenceId === null ? [] : [candidate.remainingEvidenceId])]);
    const evidence = [...cited].flatMap((id) => {
      const frame = frames.get(id);
      return frame ? [{ id, time: frame.time, title: frame.context.title, url: frame.context.url,
        signals: [...frame.context.headings, ...frame.context.actions, frame.context.excerpt].join(" · ").slice(0, 1400) }] : [];
    });
    const assessment: Omit<TaskRecord, "workflowDraft"> = {
      id: previous?.id || randomUUID(), sessionId: this.sessionId, detectedAt: previous?.detectedAt || time, updatedAt: time,
      title: candidate.title, confidence: candidate.confidence, steps: candidate.steps,
      reason: candidate.reason + (unverifiedOutcomes ? " Outcomes without a named, visible completion signal are retained as attempts." : ""),
      cycles: [...cycles.values()].slice(-40), completedItems, totalItems, remainingItems, remainingCount,
      currentItem: candidate.currentItem, nextStep: status === "complete" ? "All observed items have a confirmed outcome." : candidate.nextStep,
      status, evidence: [...(previous?.evidence || []), ...evidence].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index).slice(-40),
    };
    const unchangedPattern = previous && JSON.stringify(previous.steps) === JSON.stringify(assessment.steps) && previous.status === assessment.status
      && (previous.totalItems === null) === (assessment.totalItems === null)
      && previous.cycles.some((cycle) => cycle.outcome !== "confirmed") === assessment.cycles.some((cycle) => cycle.outcome !== "confirmed");
    const workflowDraft = unchangedPattern ? previous.workflowDraft : buildWorkflowDraft(assessment, candidate.suggestedWorkflow, previous?.workflowDraft);
    const record: TaskRecord = { ...assessment, workflowDraft };
    // Do not append the same assessment on every prediction refresh.
    const signature = (task: TaskRecord) => JSON.stringify({ title: task.title, steps: task.steps, cycles: task.cycles.map(({ item, outcome }) => ({ item, outcome })), total: task.totalItems, remaining: task.remainingItems, current: task.currentItem, status: task.status });
    if (previous && signature(previous) === signature(record)) {
      Object.assign(previous, { confidence: record.confidence, reason: record.reason, nextStep: record.nextStep, evidence: record.evidence });
      return null;
    }
    if (previous) this.tasks.splice(this.tasks.indexOf(previous), 1);
    this.tasks.unshift(record);
    this.tasks.splice(12);
    this.log.push(structuredClone(record));
    if (this.log.length > 60) this.log.shift();
    return record;
  }
}

export class TaskJournal {
  private pending = Promise.resolve();
  constructor(readonly path: string) {}
  append(record: TaskRecord) {
    const line = JSON.stringify(record) + "\n";
    const write = this.pending.then(async () => { await mkdir(dirname(this.path), { recursive: true }); await appendFile(this.path, line, { mode: 0o600 }); });
    this.pending = write.catch(() => {});
    return write;
  }
  flush() { return this.pending; }
}

export function taskReport(log: TaskRecord[]) {
  const safe = (text: string) => text.replace(/[\r\n]/g, " ");
  return ["# Repeatable task detection journal", "", "AI assessments of observed activity. Prediction only; no actions were executed. Confidence is an estimate. Unknown progress remains unknown.", "",
    ...log.flatMap((task) => [
      `## ${safe(task.title)}`, `Recorded: ${new Date(task.updatedAt).toISOString()}`, `Status: ${task.status} · Confidence: ${Math.round(task.confidence * 100)}%`, "",
      safe(task.reason), "", "Steps:", ...task.steps.map((step, index) => `${index + 1}. ${safe(step)}`), "",
      `Observed item cycles: ${task.cycles.length}; confirmed outcomes: ${task.completedItems.length}; total: ${task.totalItems ?? "unknown"}; remaining: ${task.remainingCount ?? "unknown"}.`,
      `Confirmed items: ${task.completedItems.map(safe).join(", ") || "none"}`, `Known remaining items: ${task.remainingItems.map(safe).join(", ") || "unknown or none observed"}`,
      `Likely next step: ${safe(task.nextStep)}`, "", "Supporting observations:",
      ...task.evidence.map((entry) => `- #${entry.id} · ${new Date(entry.time).toISOString()} · ${safe(entry.title)} · ${safe(entry.url)}\n  ${safe(entry.signals)}`), "",
      workflowDraftReport(task.workflowDraft, "###"), "",
    ]),
  ].join("\n");
}
