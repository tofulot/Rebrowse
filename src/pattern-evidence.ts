import type { WorkflowContext } from "./tasks.js";

/** Compact history of distinct human-browsed resources, ahead of noisy DOM data. */
export function collectionEvidence(workflow?: WorkflowContext) {
  const resources = new Map<string, { observationId: number; title: string; url: string; pageId: string }>();
  for (const frame of workflow?.observations || []) {
    if (frame.actor === "workflow" || !frame.context.title) continue;
    const url = frame.context.publicUrl || frame.context.url;
    resources.delete(url);
    resources.set(url, { observationId: frame.id, title: frame.context.title, url, pageId: frame.pageId });
  }
  const trail = [...resources.values()].slice(-24);
  const shapes = new Map<string, typeof trail>();
  for (const resource of trail) {
    const shape = resource.title.toLowerCase().replace(/\b(unit|chapter|lesson|module|part|episode)\s*[#:.\-]?\s*\d+(?:\.\d+)?\b/g, "$1 {number}").replace(/\s+/g, " ").trim();
    if (!shape.includes("{number}")) continue;
    const group = shapes.get(shape) || [];
    group.push(resource); shapes.set(shape, group);
  }
  return { resources: trail, seriesCandidates: [...shapes].filter(([, group]) => group.length >= 2)
    .map(([sharedTitle, group]) => ({ sharedTitle, observationIds: group.map((item) => item.observationId), examples: group.map((item) => item.title) })) };
}
