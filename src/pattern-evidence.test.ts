import test from "node:test";
import assert from "node:assert/strict";
import { TaskMemory } from "./tasks.js";
import { collectionEvidence } from "./pattern-evidence.js";

test("two distinct AP Calculus reviews highlight a series; six reviews survive noisy page updates", () => {
  const memory = new TaskMemory();
  const review = (unit: number) => ({ url: "https://www.youtube.com/watch", publicUrl: `https://www.youtube.com/watch?v=real${unit}`,
    title: `AP Calculus AB Unit ${unit} Review - YouTube`, headings: [], actions: [], excerpt: "" });
  memory.observe(review(1), "one", []); memory.observe(review(2), "two", []);
  assert.equal(collectionEvidence(memory.context([])).seriesCandidates[0]?.observationIds.length, 2);
  for (const unit of [3, 4, 5, 6]) memory.observe(review(unit), `tab${unit}`, []);
  for (let update = 0; update < 100; update++) memory.observe({ ...review(6), excerpt: `Playback update ${update}` }, "tab6", []);
  const evidence = collectionEvidence(memory.context([]));
  assert.equal(evidence.resources.length, 6);
  assert.equal(evidence.seriesCandidates[0]?.observationIds.length, 6);
  for (const unit of [1, 2]) assert.equal(memory.observe(review(unit), unit === 1 ? "one" : "two", []), false, "Alternating unchanged tabs must not manufacture examples");
  memory.observe(review(7), "automatic", [], Date.now(), "workflow");
  assert.equal(collectionEvidence(memory.context([])).resources.length, 6, "The agent's own tabs are not human examples");
});

test("reopening the same resource and unrelated numbered titles do not manufacture a series", () => {
  const memory = new TaskMemory();
  for (const title of ["AP Calculus Unit 1 Review", "AP Calculus Unit 1 Review", "Chemistry Unit 2 Lab"]) {
    memory.observe({ url: "https://example.com/one", title, headings: [], actions: [], excerpt: "" }, title, []);
  }
  assert.equal(collectionEvidence(memory.context([])).resources.length, 1);
  assert.equal(collectionEvidence(memory.context([])).seriesCandidates.length, 0);
});
