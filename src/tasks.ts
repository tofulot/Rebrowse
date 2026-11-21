import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Activity, PageContext } from "./observer.js";
import { workflowSuggestionSchema, buildWorkflowDraft, workflowDraftReport, type WorkflowDraft } from "./workflow-draft.js";
import { queueProposalSchema, buildWorkQueue, workQueueReport, type WorkQueue } from "./work-queue.js";
import { patternSchema, acceptPattern, patternQueue, resourceUrl, sameResourceSite, type TaskPattern } from "./workflow-pattern.js";

export const taskHypothesisSchema = z.object({
  taskId: z.string().nullable(),
  title: z.string().min(1).max(160),
  confidence: z.number().min(0).max(1),
  steps: z.array(z.string().min(1).max(160)).min(1).max(8),
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
  workQueue: queueProposalSchema.nullable().catch(null),
  pattern: patternSchema.nullable().catch(null),
});
export type TaskHypothesis = z.infer<typeof taskHypothesisSchema>;
export type Observation = { id: number; time: number; pageId: string; context: PageContext; events: Activity[]; actor?: "user" | "workflow" };
export type TaskRecord = {
  id: string; sessionId: string; detectedAt: number; updatedAt: number;
  title: string; confidence: number; steps: string[]; reason: string;
  cycles: Array<TaskHypothesis["cycles"][number] & { actor?: "workflow" }>; completedItems: string[]; totalItems: number | null;
  remainingItems: string[]; remainingCount: number | null; currentItem: string | null;
  nextStep: string; status: "suspected" | "repeating" | "uncertain" | "complete";
  evidence: Array<{ id: number; time: number; title: string; url: string; signals: string }>;
  workflowDraft: WorkflowDraft;
  workQueue: WorkQueue;
  pattern?: TaskPattern | null;
};
export type WorkflowContext = { observations: Observation[]; knownTasks: TaskRecord[]; recentActivity: Activity[] };
const key = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function hasConfirmedOutcome(context: PageContext, item: string) {
  const includesName = (text: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${key(item).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u").test(key(text));
  const namedHeading = includesName([context.title, ...context.headings].join(" "));
  const sentences = context.excerpt.split(/[.!?\n]/);
  const negative = /\b(no|not|never|failed|unable)\b/i;
  const outcome = /\b(invitation|request|message|email|form|record|changes|item|task)\s+(successfully\s+)?(sent|submitted|saved|completed|processed)\b/i;
  const contradicted = sentences.some((text) => negative.test(text) && /\b(invitation|request|message|email|form|record|item|task)\b/i.test(text)
    && /\b(sent|submitted|saved|completed|processed)\b/i.test(text));
  if (contradicted) return false;
  const positiveAction = namedHeading && context.actions.some((action) => /^(pending|connected|sent|saved|completed|done|processed|submitted|success)[.!✓✔]?$/i.test(action.trim()));
  const positiveText = sentences.some((text) => !negative.test(text) && outcome.test(text) && (namedHeading || includesName(text)));
  return positiveAction || positiveText;
}

export class TaskMemory {
  readonly sessionId = randomUUID();
  readonly observations: Observation[] = [];
  readonly tasks: TaskRecord[] = [];
  readonly log: TaskRecord[] = [];
  private sequence = 0;
  private fingerprints = new Map<string, string>();

  observe(context: PageContext, pageId: string, events: Activity[], time = Date.now(), actor: "user" | "workflow" = "user") {
    context = { ...context, headings: context.headings.slice(0, 10), actions: context.actions.slice(0, 30), excerpt: context.excerpt.slice(0, 1600),
      links: context.links?.slice(0, 30).map((link) => ({ title: link.title.slice(0, 180), url: link.url.slice(0, 2000) })),
      lists: context.lists?.slice(0, 3).map((list) => ({ ...list, items: list.items.slice(0, 30).map((item) => item.slice(0, 160)), truncated: list.truncated || list.items.length > 30 })) };
    const fingerprint = JSON.stringify({ pageId, context, actor });
    const fingerprintKey = `${actor}:${pageId}`;
    if (fingerprint === this.fingerprints.get(fingerprintKey)) return false;
    this.fingerprints.delete(fingerprintKey);
    this.fingerprints.set(fingerprintKey, fingerprint);
    if (this.fingerprints.size > 160) this.fingerprints.delete(this.fingerprints.keys().next().value!);
    this.observations.push({ id: ++this.sequence, time, pageId, context, actor,
      events: events.filter((event) => event.pageId === pageId && time - event.time < 15000).slice(-8).map(({ addressText, clipboard, ...event }) => ({ ...event,
        ...(clipboard ? { clipboard: { format: clipboard.format, source: clipboard.source, target: clipboard.target, truncated: clipboard.truncated, redacted: clipboard.redacted } } : {}),
        ...(addressText === undefined ? {} : { addressText: addressText.slice(0, 200) }) })) });
    if (this.observations.length > 80) {
      // Prefer removing redundant live-page updates over a distinct guide
      // the user opened earlier in this collection.
      const redundant = this.observations.findIndex((frame, index, all) => all.slice(index + 1).some((newer) =>
        newer.actor === frame.actor && newer.context.title === frame.context.title
        && (newer.context.publicUrl || newer.context.url) === (frame.context.publicUrl || frame.context.url)));
      this.observations.splice(Math.max(0, redundant), 1);
    }
    return true;
  }

  context(events: Activity[]): WorkflowContext {
    const recent = this.observations.slice(-35);
    const sourceLists = this.observations.filter((frame) => frame.context.lists?.length).slice(-5);
    const resources = this.observations.filter((frame, index, all) => frame.actor !== "workflow" && frame.context.title
      && !all.slice(index + 1).some((newer) => newer.actor !== "workflow" && newer.context.title === frame.context.title
        && (newer.context.publicUrl || newer.context.url) === (frame.context.publicUrl || frame.context.url))).slice(-24);
    const selected = new Map([...sourceLists, ...resources].map((frame) => [frame.id, frame]));
    for (const frame of [...recent].reverse()) if (selected.size < 40) selected.set(frame.id, frame);
    const observations = [...selected.values()].sort((a, b) => a.id - b.id);
    return { observations, knownTasks: this.tasks, recentActivity: events.slice(-60) };
  }

  accept(input: TaskHypothesis | null, time = Date.now()): TaskRecord | null {
    if (!input || input.confidence < 0.55) return null;
    const candidate = taskHypothesisSchema.parse(input);
    const pattern = acceptPattern(candidate.pattern, this.observations);
    if (!pattern && candidate.confidence < .7) return null;
    const frames = new Map(this.observations.map((frame) => [frame.id, frame]));
    // The provider sometimes proposes its own descriptive ID for a new task.
    // IDs link existing records; they are not evidence and must not silently
    // discard a supported finding. New records always get an app-owned UUID.
    const previous = (candidate.taskId ? this.tasks.find((task) => task.id === candidate.taskId) : undefined)
      || this.tasks.find((task) => key(task.title) === key(candidate.title));
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
      const confirmed = cycle.outcome === "confirmed" && outcomeFrame && cycle.outcomeEvidenceId !== null && evidenceIds.includes(cycle.outcomeEvidenceId)
        && (hasConfirmedOutcome(outcomeFrame.context, cycle.item) || pattern?.operation === "open_tabs"
          && key([outcomeFrame.context.title, ...outcomeFrame.context.headings].join(" ")).includes(key(cycle.item))
          && !!resourceUrl(outcomeFrame.context.publicUrl || outcomeFrame.context.url));
      if (cycle.outcome === "confirmed" && !confirmed) unverifiedOutcomes++;
      const normalized = { ...cycle, evidenceIds, outcome: confirmed ? "confirmed" as const : "attempted" as const,
        outcomeEvidenceId: confirmed ? cycle.outcomeEvidenceId : null };
      if (cycles.get(key(cycle.item))?.outcome !== "confirmed") cycles.set(key(cycle.item), normalized);
    }
    if (cycles.size < 1 && pattern?.operation !== "open_tabs") return null;
    const distinctEvidence = new Set([...cycles.values()].flatMap((cycle) => cycle.evidenceIds));
    if (distinctEvidence.size < 2 && !pattern) return null;
    const workQueue = pattern?.operation === "open_tabs" ? patternQueue(pattern, previous?.workQueue, this.observations) : buildWorkQueue(candidate, [...cycles.values()], frames, previous?.workQueue);
    const completedItems = workQueue.items.filter((item) => item.state === "confirmed").map((item) => item.item);
    const remainingItems = workQueue.items.filter((item) => item.state !== "confirmed").map((item) => item.item);
    const totalItems = workQueue.counts.total;
    const remainingCount = workQueue.counts.remaining;
    // One confirmed item plus an observed unfinished list supports a candidate,
    // but is not labeled an already repeated pattern.
    if (!pattern && cycles.size === 1 && (completedItems.length !== 1 || (remainingCount === null ? remainingItems.length === 0 : remainingCount <= 0))) return null;
    const status = pattern?.operation === "open_tabs" && !workQueue.items.length
      ? new Set(pattern.evidenceIds.map((id) => frames.get(id)?.context.publicUrl || frames.get(id)?.context.url)).size >= 2 ? "repeating" : "suspected"
      : cycles.size === 1 ? "suspected" : workQueue.decision === "complete" ? "complete" : workQueue.decision === "continue" ? "repeating" : "uncertain";
    const cited = new Set([...candidate.cycles.flatMap((cycle) => cycle.evidenceIds), ...candidate.cycles.flatMap((cycle) => cycle.outcomeEvidenceId === null ? [] : [cycle.outcomeEvidenceId]),
      ...(candidate.totalEvidenceId === null ? [] : [candidate.totalEvidenceId]), ...(candidate.remainingEvidenceId === null ? [] : [candidate.remainingEvidenceId]),
      ...workQueue.items.flatMap((item) => item.evidenceIds), ...(pattern?.evidenceIds || [])]);
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
      currentItem: workQueue.items.find((item) => item.state === "in_progress")?.item || null,
      nextStep: workQueue.decision === "continue" ? `Likely next item: ${workQueue.nextItem}. ${workQueue.reason}` : workQueue.reason,
      workQueue,
      pattern,
      status, evidence: [...(previous?.evidence || []), ...evidence].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index).slice(-40),
    };
    const unchangedPattern = previous && JSON.stringify(previous.steps) === JSON.stringify(assessment.steps) && previous.status === assessment.status
      && JSON.stringify(previous.pattern?.targets) === JSON.stringify(pattern?.targets)
      && (previous.totalItems === null) === (assessment.totalItems === null)
      && previous.cycles.some((cycle) => cycle.outcome !== "confirmed") === assessment.cycles.some((cycle) => cycle.outcome !== "confirmed");
    const workflowDraft = unchangedPattern ? previous.workflowDraft : buildWorkflowDraft(assessment, candidate.suggestedWorkflow, previous?.workflowDraft);
    const record: TaskRecord = { ...assessment, workflowDraft };
    // Do not append the same assessment on every prediction refresh.
    const signature = (task: TaskRecord) => JSON.stringify({ title: task.title, steps: task.steps, cycles: task.cycles.map(({ item, outcome }) => ({ item, outcome })), total: task.totalItems, remaining: task.remainingItems, current: task.currentItem, status: task.status,
      pattern: task.pattern,
      queue: { scope: task.workQueue.scope, decision: task.workQueue.decision, scopeReason: task.workQueue.scopeReason,
        items: task.workQueue.items.map(({ item, state, reason }) => ({ item, state, reason })) } });
    if (previous && signature(previous) === signature(record)) {
      Object.assign(previous, { confidence: record.confidence, reason: record.reason, nextStep: record.nextStep, evidence: record.evidence, workQueue: record.workQueue, pattern: record.pattern });
      return null;
    }
    if (previous) this.tasks.splice(this.tasks.indexOf(previous), 1);
    this.tasks.unshift(record);
    this.tasks.splice(12);
    this.log.push(structuredClone(record));
    if (this.log.length > 60) this.log.shift();
    return record;
  }

  recordExecution(taskId: string, itemName: string, state: "unstarted" | "in_progress" | "blocked" | "confirmed", reason: string, context?: PageContext, pageId = "workflow", openedUrl?: string) {
    const task = this.tasks.find((task) => task.id === taskId);
    if (!task) throw new Error("The current task is no longer available.");
    const queue = structuredClone(task.workQueue);
    const item = queue.items.find((item) => key(item.item) === key(itemName));
    if (!item) throw new Error("This item is outside the current queue.");
    if (item.state === "confirmed") return task;
    const resourceOpened = task.pattern?.operation === "open_tabs" && openedUrl && context && resourceUrl(context.publicUrl || context.url) === resourceUrl(openedUrl)
      && sameResourceSite(openedUrl, task.pattern.sourceUrl) && context.title && !/not found|access denied|error|captcha/i.test(context.title);
    if (state === "confirmed" && (!context || !hasConfirmedOutcome(context, itemName) && !resourceOpened)) throw new Error("No visible completion signal was found. This item was not retried.");
    let observationId: number | undefined;
    if (context) {
      this.observe(context, pageId, [], Date.now(), "workflow");
      observationId = this.observations.at(-1)!.id;
      item.evidenceIds = [...new Set([...item.evidenceIds, observationId])].slice(-12);
    }
    item.state = state; item.reason = reason; item.stateEvidenceId = observationId ?? item.stateEvidenceId;
    if (state === "confirmed") {
      const cycle = { item: itemName, evidenceIds: [observationId!], outcome: "confirmed" as const, outcomeEvidenceId: observationId!, actor: "workflow" as const };
      task.cycles = [...task.cycles.filter((cycle) => key(cycle.item) !== key(itemName)), cycle].slice(-40);
    }
    // Reuse the same queue accounting as prediction. Runtime states are kept
    // separately from human events, and only validated outcomes close items.
    const candidate: TaskHypothesis = { taskId: task.id, title: task.title, confidence: task.confidence, steps: task.steps, reason: task.reason,
      cycles: task.cycles, totalItems: null, totalEvidenceId: null, remainingItems: [], remainingEvidenceId: null,
      currentItem: null, nextStep: "", continuation: "uncertain", suggestedWorkflow: null, workQueue: null, pattern: null };
    task.workQueue = task.pattern?.operation === "open_tabs" ? patternQueue(task.pattern, queue) : buildWorkQueue(candidate, task.cycles, new Map(this.observations.map((frame) => [frame.id, frame])), queue);
    task.completedItems = task.workQueue.items.filter((item) => item.state === "confirmed").map((item) => item.item);
    task.remainingItems = task.workQueue.items.filter((item) => item.state !== "confirmed").map((item) => item.item);
    task.totalItems = task.workQueue.counts.total; task.remainingCount = task.workQueue.counts.remaining;
    task.currentItem = task.workQueue.items.find((item) => item.state === "in_progress")?.item || null;
    task.status = task.workQueue.decision === "complete" ? "complete" : task.workQueue.decision === "continue" ? "repeating" : "uncertain";
    task.nextStep = task.workQueue.reason;
    task.updatedAt = Date.now();
    if (context && observationId) task.evidence = [...task.evidence.filter((entry) => entry.id !== observationId),
      { id: observationId, time: task.updatedAt, title: context.title, url: context.url, signals: ["Automatic workflow observation", ...context.headings, ...context.actions, context.excerpt].join(" · ").slice(0, 1400) }].slice(-40);
    this.log.push(structuredClone(task));
    if (this.log.length > 60) this.log.shift();
    return task;
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
  return ["# Repeatable task detection journal", "", "AI assessments of observed activity and inferred goals. Workflows can run automatically in bounded batches; their outcomes are labeled below. Confidence is an estimate. Unknown progress remains unknown.", "",
    ...log.flatMap((task) => [
      `## ${safe(task.title)}`, `Recorded: ${new Date(task.updatedAt).toISOString()}`, `Status: ${task.status} · Confidence: ${Math.round(task.confidence * 100)}%`, "",
      safe(task.reason), "", "Steps:", ...task.steps.map((step, index) => `${index + 1}. ${safe(step)}`), "",
      `Observed item cycles: ${task.cycles.length}; confirmed outcomes: ${task.completedItems.length}; total: ${task.totalItems ?? "unknown"}; remaining: ${task.remainingCount ?? "unknown"}.`,
      `Confirmed items: ${task.completedItems.map(safe).join(", ") || "none"}`, `Known remaining items: ${task.remainingItems.map(safe).join(", ") || "unknown or none observed"}`,
      `Outcomes confirmed by automatic workflow runs: ${task.cycles.filter((cycle) => cycle.actor === "workflow").map((cycle) => safe(cycle.item)).join(", ") || "none"}`,
      `Likely next step: ${safe(task.nextStep)}`, "", "Supporting observations:",
      ...task.evidence.map((entry) => `- #${entry.id} · ${new Date(entry.time).toISOString()} · ${safe(entry.title)} · ${safe(entry.url)}\n  ${safe(entry.signals)}`), "",
      workQueueReport(task.workQueue), "", workflowDraftReport(task.workflowDraft, "###"), "",
    ]),
  ].join("\n");
}
