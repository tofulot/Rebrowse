import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { BrowserObserver } from "../src/observer.js";
import { PredictionDashboard, startDashboard } from "../src/dashboard.js";
import { collectionEvidence } from "../src/pattern-evidence.js";

const live = process.argv.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY first.");
const directory = await mkdtemp(join(tmpdir(), "rebrowse-pattern-"));
const fixture = createServer((request, response) => {
  const unit = Number((request.url || "").split("/").at(-1));
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(unit ? `<!doctype html><title>AP Calculus AB Unit ${unit} Review</title><main><h1>AP Calculus AB Unit ${unit} Review</h1><p>Unit ${unit} exam review guide and practice problems.</p></main>`
    : '<!doctype html><title>AP Calculus review library</title><main><h1>AP Calculus reviews</h1><button>Browse reviews</button></main>');
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address(); assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const controller = new PredictionDashboard({ ...(live ? {} : { isConfigured: () => true, debounceMs: 10, intervalMs: 10,
  predict: (async (_context, _events, _signal, _desktop, workflow) => {
    const series = collectionEvidence(workflow).seriesCandidates[0];
    return { intent: "Collect AP Calculus unit reviews", summary: "Related unit reviews are open in background tabs.", predictions: [{ action: "Open another unit review", confidence: .8, evidence: "Two related unit titles" }],
      repeatableTask: series ? { taskId: workflow?.knownTasks[0]?.id || null, title: "Collect AP Calculus unit reviews", confidence: .85,
        steps: ["Open the AP Calculus review for {{item}}"], reason: "Multiple distinct unit reviews share a goal.", cycles: [], totalItems: null, totalEvidenceId: null,
        remainingItems: [], remainingEvidenceId: null, currentItem: null, nextStep: "Continue collecting related unit reviews", continuation: "likely" as const, suggestedWorkflow: null, workQueue: null,
        pattern: { action: "Gather AP Calculus unit reviews", repeatLikelihood: .9, reason: "Distinct unit review titles", evidenceIds: series.observationIds,
          operation: "open_tabs" as const, goal: "resources" as const, endCondition: "Stop after a small useful batch; full course endpoint is unknown.", endKnown: false, maxItems: 2,
          targets: [7, 8].map((unit) => ({ item: `Unit ${unit}`, url: `${base}/unit/${unit}`, basis: "inferred" as const })) } } : null };
  }) satisfies NonNullable<ConstructorParameters<typeof PredictionDashboard>[0]>["predict"] }) });
const dashboard = await startDashboard(controller);
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
let observer: BrowserObserver | undefined;
async function until(check: () => boolean) {
  const deadline = Date.now() + (live ? 120000 : 10000);
  while (!check() && !controller.state.error && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(controller.state.error, null);
  assert.ok(check(), `The related background reviews should produce a documented pattern. ${JSON.stringify({ status: controller.state.status, requests: controller.state.requests, observations: controller.state.observationCount, hypothesis: controller.state.prediction?.repeatableTask })}`);
}
try {
  browser = await localBrowser.launch({ headless: true, userDataDir: join(directory, "profile") });
  await connectAgent(browser);
  const source = await browser.context.newPage(`${base}/library`);
  for (const unit of [1, 2]) await browser.context.newPage(`${base}/unit/${unit}`);
  const tab = await browser.context.newPage(dashboard.url);
  await browser.context.setActivePage(source);
  observer = new BrowserObserver(browser.context, dashboard.origin, (event, page) => controller.activity(event, page),
    (message) => controller.reportError(message), (context, page, options) => controller.observe(context, page, options));
  controller.observer = observer; await observer.start();
  await source.locator("button").click();
  await until(() => controller.state.tasks.length > 0 && !!controller.state.prediction);
  const first = controller.state.tasks[0]!;
  assert.match(first.title + first.pattern?.action, /calculus|calc/i);
  assert.ok(first.pattern?.evidenceIds.length && first.pattern.repeatLikelihood >= .6);
  assert.ok(first.evidence.some((entry) => /Unit 1/.test(entry.title)));
  assert.ok(first.evidence.some((entry) => /Unit 2/.test(entry.title)));
  assert.equal(observer.lastPage?.pageId, source.pageId, "Observing background reviews must not change the active page");
  console.log(`Passed: ${live ? "live SubQ" : "simulated model"} detects and documents AP Calculus review collection after two background tabs.`);
  for (const unit of [3, 4, 5, 6]) await browser.context.newPage(`${base}/unit/${unit}`);
  await browser.context.setActivePage(source);
  await until(() => collectionEvidence(controller.taskMemory.context([])).seriesCandidates.some((series) => series.observationIds.length === 6));
  const before = controller.state.prediction!.time;
  controller.requestPrediction();
  await until(() => !!controller.state.prediction && controller.state.prediction.time > before && controller.state.status === "ready");
  assert.ok(controller.state.prediction?.repeatableTask, "Six related unit reviews must still produce a pattern hypothesis");
  await tab.waitForFunction(() => !!document.querySelector("#workflow-title")?.textContent?.match(/calc/i));
  assert.equal(controller.runner, undefined, "Detection smoke must not execute any suggested workflow");
  console.log("Passed: all six background units reach pattern history and the dashboard; no workflows executed.");
} finally {
  controller.stop(); await observer?.stop(); await browser?.close(); await dashboard.close();
  fixture.closeAllConnections(); await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
