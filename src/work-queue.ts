import { z } from "zod";
import type { Observation, TaskHypothesis } from "./tasks.js";

export const queueProposalSchema = z.object({
  sourceObservationId: z.number().int().positive().nullable(),
  sourceListIndex: z.number().int().min(0).max(2).nullable(),
  items: z.array(z.object({
    item: z.string().min(1).max(160),
    sourceRow: z.number().int().min(1).max(30).nullable(),
    state: z.enum(["unstarted", "in_progress", "blocked"]),
    evidenceId: z.number().int().positive().nullable(),
    reason: z.string().max(300),
  })).max(40),
});
export type QueueProposal = z.infer<typeof queueProposalSchema>;
export type QueueItem = {
  item: string; state: "unstarted" | "in_progress" | "confirmed" | "blocked";
  reason: string; evidenceIds: number[]; stateEvidenceId: number | null;
};
type Source = { observationId: number; url: string; title: string; listIndex: number; label: string; rows: string[]; truncated: boolean };
export type WorkQueue = {
  source: Source | null;
  scope: "verified" | "partial" | "unknown";
  scopeReason: string;
  items: QueueItem[];
  counts: { known: number; confirmed: number; ready: number; inProgress: number; blocked: number; knownRemaining: number; remaining: number | null; total: number | null };
  decision: "continue" | "review" | "inspect" | "complete";
  reason: string; nextItem: string | null;
  completionRule: string;
};
export const itemKey = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const contains = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${itemKey(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u").test(itemKey(text));
const pageText = (frame: Observation) => [frame.context.title, ...frame.context.headings, ...frame.context.actions, frame.context.excerpt].join(" ");
const mergeEvidence = (...groups: number[][]) => [...new Set(groups.flat())].slice(-12);

// Model output proposes item identities and citations. Counts and stopping
// decisions are derived here from validated membership and confirmed outcomes.
export function buildWorkQueue(candidate: TaskHypothesis, cycles: TaskHypothesis["cycles"], frames: Map<number, Observation>, previous?: WorkQueue): WorkQueue {
  const proposal = candidate.workQueue;
  const proposedSource = proposal?.sourceObservationId ? frames.get(proposal.sourceObservationId) : undefined;
  const totalSource = candidate.totalEvidenceId ? frames.get(candidate.totalEvidenceId) : undefined;
  const remainingSource = candidate.remainingEvidenceId ? frames.get(candidate.remainingEvidenceId) : undefined;
  const frame = proposedSource || totalSource || remainingSource;
  const listIndex = proposedSource && proposal?.sourceListIndex !== null ? proposal?.sourceListIndex ?? 0
    : Math.max(0, frame?.context.lists?.findIndex((list) => !list.truncated && list.items.length === candidate.totalItems) ?? 0);
  const list = frame?.context.lists?.[listIndex];
  const incoming: Source | null = frame && list ? { observationId: frame.id, url: frame.context.url, title: frame.context.title,
    listIndex, label: list.label, rows: list.items, truncated: list.truncated } : null;
  const sourceChanged = !!(incoming && previous?.source && (incoming.url !== previous.source.url || incoming.listIndex !== previous.source.listIndex || incoming.label !== previous.source.label));
  // A different source is a different run. Never carry completions into it.
  // Keep the current queue for review rather than silently merging the lists.
  const source = sourceChanged ? previous!.source : incoming || previous?.source || null;
  const items = new Map((previous?.items || []).map((item) => [itemKey(item.item), { ...item, evidenceIds: [...item.evidenceIds] }]));
  const add = (name: string, evidenceIds: number[]) => {
    const id = itemKey(name);
    if (!id) return;
    const old = items.get(id);
    items.set(id, old ? { ...old, evidenceIds: mergeEvidence(old.evidenceIds, evidenceIds) }
      : { item: name.trim(), state: "unstarted", reason: "Seen in the source list; no confirmed outcome observed.", evidenceIds, stateEvidenceId: null });
  };
  const rowMatches = (name: string, row?: number | null) => !!source && (row ? !!source.rows[row - 1] && contains(source.rows[row - 1]!, name) : source.rows.some((text) => contains(text, name)));
  if (!sourceChanged) {
    for (const entry of proposal?.items || []) {
      if (incoming && source === incoming && rowMatches(entry.item, entry.sourceRow)) add(entry.item, [incoming.observationId]);
    }
    for (const name of [...candidate.remainingItems, ...(candidate.currentItem ? [candidate.currentItem] : []), ...cycles.map((cycle) => cycle.item)]) {
      if (rowMatches(name)) add(name, [source!.observationId]);
    }
    // Cycles remain useful when the source list is not currently available.
    for (const cycle of cycles) {
      if (!source || rowMatches(cycle.item)) add(cycle.item, cycle.evidenceIds);
    }
    for (const entry of proposal?.items || []) {
      const item = items.get(itemKey(entry.item));
      const evidence = entry.evidenceId === null ? undefined : frames.get(entry.evidenceId);
      if (!item || item.state === "confirmed" || !evidence || !contains(pageText(evidence), item.item)) continue;
      const text = pageText(evidence);
      // A list row alone does not establish active work. Require a named page
      // or actual recent activity for an in-progress assessment.
      const active = contains([evidence.context.title, ...evidence.context.headings].join(" "), item.item)
        && !evidence.context.lists?.length;
      const blocked = /\b(no (?:matching|results|match)|not found|multiple (?:matches|matching|results)|ambiguous|failed|error|unavailable|unable|could not|couldn't|try again)\b/i.test(text);
      const newer = entry.evidenceId! >= (item.stateEvidenceId ?? 0);
      if (newer && (entry.state === "blocked" && blocked || entry.state === "in_progress" && active && !blocked)) {
        item.state = entry.state; item.reason = entry.reason || (blocked ? "A visible blocker needs review." : "Working on this item; outcome not yet confirmed.");
        item.stateEvidenceId = entry.evidenceId;
        item.evidenceIds = mergeEvidence(item.evidenceIds, [entry.evidenceId!]);
      }
    }
    for (const cycle of cycles) {
      const item = items.get(itemKey(cycle.item));
      if (!item) continue;
      item.evidenceIds = mergeEvidence(item.evidenceIds, cycle.evidenceIds);
      if (cycle.outcome === "confirmed") {
        item.state = "confirmed"; item.reason = "A named, visible outcome confirms completion.";
        item.stateEvidenceId = cycle.outcomeEvidenceId;
      } else if (item.state === "unstarted") {
        item.state = "blocked"; item.reason = "An attempt was observed without a confirmed outcome. Review before repeating it.";
        item.stateEvidenceId = Math.max(...cycle.evidenceIds);
      }
    }
  }
  const queueItems = [...items.values()];
  // Every row must map to exactly one known identity, and every known identity
  // must belong to this source. Duplicate rows count as one queue item.
  const mapsWholeQueue = (rows: string[]) => rows.length > 0
    && rows.every((row) => queueItems.filter((item) => contains(row, item.item)).length === 1)
    && queueItems.every((item) => rows.some((row) => contains(row, item.item)));
  const allRowsMapped = !!source && mapsWholeQueue(source.rows);
  const membershipUnchanged = previous?.scope === "verified" && previous.items.length === queueItems.length
    && previous.items.every((item) => items.has(itemKey(item.item))) && !!source && mapsWholeQueue(source.rows);
  // The count and current row states may be cited from different snapshots
  // of the same list. Validate matching membership rather than requiring IDs
  // to be identical (e.g. a row changed from Not processed to Invitation sent).
  const countList = totalSource?.context.lists?.[source?.listIndex ?? 0];
  const countSupported = !!source && totalSource?.context.url === source.url && !!countList && countList.label === source.label
    && !countList.truncated && mapsWholeQueue(countList.items)
    && (candidate.totalItems === countList.items.length || candidate.totalItems === queueItems.length);
  const outsideCycles = !!source && cycles.some((cycle) => !rowMatches(cycle.item));
  const missingMembers = !!source && queueItems.some((item) => !rowMatches(item.item));
  const verified = !sourceChanged && !outsideCycles && !!source && !source.truncated && allRowsMapped && (countSupported || membershipUnchanged);
  const scope = verified ? "verified" : source || queueItems.length ? "partial" : "unknown";
  const confirmed = queueItems.filter((item) => item.state === "confirmed").length;
  const ready = queueItems.filter((item) => item.state === "unstarted").length;
  const inProgress = queueItems.filter((item) => item.state === "in_progress").length;
  const blocked = queueItems.filter((item) => item.state === "blocked").length;
  const knownRemaining = queueItems.length - confirmed;
  const complete = verified && queueItems.length > 0 && knownRemaining === 0;
  const decision = sourceChanged || outsideCycles || missingMembers ? "review" : complete ? "complete" : inProgress || ready ? "continue" : blocked ? "review" : "inspect";
  const next = decision === "continue" ? queueItems.find((item) => item.state === "in_progress") || queueItems.find((item) => item.state === "unstarted") : undefined;
  const scopeReason = sourceChanged ? "A different source list was observed. Review the run boundary; earlier completions were not applied to the new list."
    : outsideCycles ? "Some observed cycles are outside the source list. The task scope needs review."
    : missingMembers ? "The source no longer shows some known items. Review the task scope; outstanding work has been retained."
    : verified ? `Full observed list mapped to ${queueItems.length} unique items; duplicate rows are counted once.`
    : source?.truncated ? "Only part of the source list is visible; the total is unknown."
    : source ? "The full list membership or its end has not been established; the total is unknown."
    : "The source list has not been established; the total is unknown.";
  const reason = sourceChanged || outsideCycles || missingMembers ? scopeReason : complete ? "Every unique item in the verified list has a confirmed outcome. No further repetition is suggested."
    : decision === "continue" ? `${inProgress ? "Finish checking the current item" : "Another known item is ready"}${blocked ? `; ${blocked} blocked item${blocked === 1 ? " needs" : "s need"} review` : ""}.${verified ? "" : " More items may exist beyond the observed list."}`
    : blocked ? "Known items have unresolved blockers or outcomes. Review them before suggesting another attempt."
    : "No ready items are known, but the full list is unverified. Inspect the source or its next page before declaring completion.";
  return { source, scope, scopeReason, items: queueItems,
    counts: { known: queueItems.length, confirmed, ready, inProgress, blocked, knownRemaining, remaining: verified ? knownRemaining : null, total: verified ? queueItems.length : null },
    decision, reason, nextItem: next?.item || null,
    completionRule: "Finish only when the complete source list is established and every unique item has a confirmed outcome. Unresolved items require review; an empty visible page does not prove completion. Predictions alone never execute actions." };
}

export function workQueueReport(queue: WorkQueue) {
  const safe = (text: string) => text.replace(/[\r\n]/g, " ");
  return ["### Work queue and stopping assessment", `Scope: ${queue.scope} · ${safe(queue.scopeReason)}`,
    `Queue: ${queue.counts.confirmed} confirmed, ${queue.counts.ready} ready, ${queue.counts.inProgress} in progress, ${queue.counts.blocked} blocked.`,
    `Remaining: ${queue.counts.remaining ?? `at least ${queue.counts.knownRemaining}; total unknown`}`,
    `Suggested decision: ${queue.decision} · ${safe(queue.reason)}`, `Next item: ${safe(queue.nextItem || "none established")}`,
    ...queue.items.map((item) => `- ${safe(item.item)}: ${item.state} · ${safe(item.reason)} (observations ${item.evidenceIds.map((id) => `#${id}`).join(", ")})`),
    "", queue.completionRule, ""].join("\n");
}
