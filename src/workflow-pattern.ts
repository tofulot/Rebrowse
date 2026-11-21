import { z } from "zod";
import type { Observation } from "./tasks.js";
import type { WorkQueue } from "./work-queue.js";

export const MAX_AUTOMATIC_TABS = 12;
export const patternSchema = z.object({
  action: z.string().min(1).max(200),
  repeatLikelihood: z.number().min(0).max(1),
  reason: z.string().max(500),
  evidenceIds: z.array(z.number().int().positive()).min(1).max(8),
  operation: z.enum(["open_tabs", "repeat_steps"]),
  goal: z.enum(["searches", "resources"]),
  endCondition: z.string().min(1).max(300),
  endKnown: z.boolean(),
  maxItems: z.number().int().min(1).max(MAX_AUTOMATIC_TABS),
  targets: z.array(z.object({ item: z.string().min(1).max(160), url: z.string().max(2000), basis: z.enum(["observed", "inferred"]) })).max(40),
});
export type TaskPattern = z.infer<typeof patternSchema> & { sourceUrl: string };
export function resourceUrl(raw: string): string | null {
  try {
    if (raw.length > 2000) return null;
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (/\b(delete|remove|unsubscribe|logout|signout|checkout|purchase|send|invite|connect|pay)\b/i.test(url.pathname)) return null;
    url.hash = "";
    const allowed = /(^|\.)youtube\.com$|^youtu\.be$/.test(url.hostname) ? new Set(["v", "list", "search_query", "index"])
      : /(^|\.)(google|bing)\.com$/.test(url.hostname) ? new Set(["q"]) : new Set<string>();
    for (const key of [...url.searchParams.keys()]) if (!allowed.has(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}
const site = (raw: string) => {
  const url = new URL(raw);
  return /(^|\.)youtube\.com$|^youtu\.be$/.test(url.hostname) ? "youtube" : url.host.replace(/^www\./, "");
};
export function sameResourceSite(a: string, b: string) { try { return site(a) === site(b); } catch { return false; } }
export function acceptPattern(input: z.infer<typeof patternSchema> | null, observations: Observation[]): TaskPattern | null {
  if (!input || input.repeatLikelihood < .6) return null;
  const evidence = observations.filter((frame) => input.evidenceIds.includes(frame.id) && frame.actor !== "workflow");
  if (!evidence.length) return null;
  // One meaningful action can be enough in a clear collection/series context.
  // Agent-opened tabs and pointer movement cannot manufacture human intent.
  const acted = evidence.some((frame) => frame.events.some((event) => ["click", "navigate", "edit", "address-edit", "paste"].includes(event.kind)));
  const distinctPages = new Set(evidence.map((frame) => frame.context.publicUrl || `${frame.context.url}:${frame.context.title}`));
  if (!acted && distinctPages.size < 2) return null;
  const source = evidence.at(-1)!.context.publicUrl || evidence.at(-1)!.context.url;
  if (!resourceUrl(source)) return null;
  const known = new Set(observations.flatMap((frame) => [frame.context.publicUrl || frame.context.url, ...(frame.context.links || []).map((link) => link.url)]).map(resourceUrl).filter(Boolean));
  const seen = new Set<string>();
  const names = new Set<string>();
  const targets = input.targets.flatMap((target) => {
    const url = resourceUrl(target.url);
    if (!url || !sameResourceSite(url, source) || seen.has(url) || names.has(target.item.toLowerCase().trim())) return [];
    const observed = known.has(url);
    if (!observed) {
      const parsed = new URL(url);
      const search = parsed.pathname === "/results" && parsed.searchParams.has("search_query") || parsed.pathname === "/search" && parsed.searchParams.has("q");
      // Invented video IDs are not resource discovery. Generated search URLs
      // and numeric variations of observed series paths are useful predictions.
      const shape = parsed.pathname.replace(/\d+/g, "{n}");
      const examples = [...known].filter((value): value is string => !!value && sameResourceSite(value, url) && new URL(value).pathname.replace(/\d+/g, "{n}") === shape);
      if (!search && (!/\d/.test(parsed.pathname) || examples.length < 2)) return [];
    }
    seen.add(url); names.add(target.item.toLowerCase().trim());
    return [{ ...target, url, basis: observed ? "observed" as const : "inferred" as const }];
  }).slice(0, Math.min(input.maxItems, MAX_AUTOMATIC_TABS));
  // Detecting repetition and finding an executable next target are separate.
  // Invalid/unknown target URLs must not erase a supported pattern finding.
  return { ...input, evidenceIds: evidence.map((frame) => frame.id), targets, sourceUrl: resourceUrl(source)! };
}

export function patternQueue(pattern: TaskPattern, previous?: WorkQueue, observations: Observation[] = []): WorkQueue {
  const items = pattern.targets.map((target) => {
    const old = previous?.items.find((item) => item.targetUrl === target.url);
    const visited = observations.find((frame) => resourceUrl(frame.context.publicUrl || frame.context.url) === target.url && frame.context.title
      && !/not found|access denied|captcha/i.test(frame.context.title) && (pattern.goal === "searches" || !/\/(results|search)(?:\?|$)/.test(target.url)));
    return old ? { ...old } : visited ? { item: target.item, targetUrl: target.url, basis: target.basis, state: "confirmed" as const,
      reason: "This resource page was already opened.", evidenceIds: [visited.id], stateEvidenceId: visited.id } : { item: target.item, targetUrl: target.url, basis: target.basis, state: "unstarted" as const,
      reason: target.basis === "inferred" ? "Predicted next resource in the inferred goal." : "Resource link observed on a page.", evidenceIds: pattern.evidenceIds, stateEvidenceId: null };
  });
  const counts = { known: items.length, confirmed: items.filter((item) => item.state === "confirmed").length,
    ready: items.filter((item) => item.state === "unstarted").length, inProgress: items.filter((item) => item.state === "in_progress").length,
    blocked: items.filter((item) => item.state === "blocked").length, knownRemaining: items.filter((item) => item.state !== "confirmed").length, remaining: null, total: null };
  return { source: null, scope: "inferred", scopeReason: pattern.endKnown ? `Predicted batch: ${pattern.endCondition}` : "The endpoint is unknown; this is a bounded look-ahead batch, not a complete list.",
    items, counts, decision: !items.length ? "stop" : counts.ready || counts.inProgress ? "continue" : counts.blocked ? "inspect" : "complete",
    reason: !items.length ? "A repeatable pattern was detected; no useful remaining targets are established yet." : counts.ready ? "Continue opening related resources for the inferred goal." : counts.blocked ? "The available batch is finished; some resources could not be opened." : "The planned resource batch is finished.",
    nextItem: items.find((item) => item.state === "unstarted" || item.state === "in_progress")?.item || null,
    completionRule: `${pattern.endCondition} Stop after ${items.length} planned targets at most; do not invent further batches from the agent's own actions.` };
}
