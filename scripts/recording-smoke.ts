import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { PredictionDashboard, startDashboard } from "../src/dashboard.js";
import { BrowserObserver } from "../src/observer.js";
import { collectionEvidence } from "../src/pattern-evidence.js";
import { SessionRecorder, parseRecording } from "../src/recording.js";

const live = process.argv.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY before running the live observation check.");
const directory = await mkdtemp(join(tmpdir(), "rebrowse-recording-smoke-"));
const fixture = createServer((request, response) => {
  const unit = Number((request.url || "").split("/").at(-1));
  const title = unit ? `AP Calculus Unit ${unit} Review` : "Review library";
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><title>${title}</title><main><h1>${title}</h1><p>Review guide and practice problems.</p>
    <input type="password" value="PRIVATE_PASSWORD_FIXTURE"><input value="PRIVATE_INPUT_FIXTURE"><p data-private>PRIVATE_SECTION_FIXTURE</p>
    <a data-sensitive aria-label="PRIVATE_LINK_FIXTURE" href="/private">PRIVATE_LINK_FIXTURE</a></main>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address(); assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const controller = new PredictionDashboard({ recorder: new SessionRecorder(join(directory, "recordings")), isConfigured: () => true, debounceMs: 30, intervalMs: 30, autoDelayMs: 0,
  predict: live ? undefined : async (_context, _events, _signal, _desktop, workflow) => {
    const series = collectionEvidence(workflow).seriesCandidates[0];
    return { intent: "Collect unit reviews", summary: "Related course reviews", predictions: [{ action: "Open the next review", confidence: .7, evidence: "Review pages" }],
      repeatableTask: series ? { taskId: workflow?.knownTasks[0]?.id || null, title: "Collect AP Calculus unit reviews", confidence: .85, steps: ["Open the review for {{item}}"],
        reason: "Two related unit reviews suggest a collection.", cycles: [], totalItems: null, totalEvidenceId: null, remainingItems: [], remainingEvidenceId: null, currentItem: null,
        nextStep: "Open the next unit reviews", continuation: "likely", suggestedWorkflow: null, workQueue: null,
        pattern: { action: "Collect calculus unit reviews", repeatLikelihood: .9, reason: "Distinct reviews in one course", evidenceIds: series.observationIds, operation: "open_tabs", goal: "resources",
          endCondition: "Stop after a useful next batch", endKnown: false, maxItems: 2, targets: [3, 4].map((unit) => ({ item: `Unit ${unit}`, url: `${base}/unit/${unit}`, basis: "inferred" })) } } : null };
  } });
const dashboard = await startDashboard(controller);
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
let observer: BrowserObserver | undefined;
async function until(check: () => boolean) {
  const deadline = Date.now() + (live ? 120000 : 10000);
  while (!check() && !controller.state.error && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(controller.state.error, null);
  assert.ok(check(), `Recording=${JSON.stringify(controller.state.recording)}, replay=${controller.state.replay.status}, error=${controller.state.error}`);
}
try {
  browser = await localBrowser.launch({ headless: true, userDataDir: join(directory, "profile") }); await connectAgent(browser);
  const source = await browser.context.newPage(`${base}/library`);
  const tab = await browser.context.newPage(dashboard.url);
  await browser.context.setActivePage(source);
  observer = new BrowserObserver(browser.context, dashboard.origin, (event, page) => controller.activity(event, page), (message) => controller.reportError(message), (context, page, options) => controller.observe(context, page, options));
  controller.observer = observer; await observer.start();
  await until(() => controller.state.status === "ready");
  await browser.context.setActivePage(tab);
  assert.equal(await tab.locator(".recording-panel input").count(), 0, "The user must not enter a task, topic, goal, or step target");
  await tab.locator("#recording-start").click(); await until(() => controller.state.recording?.status === "recording");
  await browser.context.setActivePage(source);
  for (const unit of [1, 2]) {
    await source.goto(`${base}/unit/${unit}`);
    await until(() => controller.recorder.state.steps === unit && controller.state.status === "ready" && controller.state.page?.title === `AP Calculus Unit ${unit} Review`);
  }
  assert.ok(controller.recorder.state.firstDetection && controller.recorder.state.firstDetection.step <= 2);
  assert.match(controller.state.tasks[0]?.title || "", /calculus/i, "The goal must be inferred from visited page context");
  assert.equal(controller.runner, undefined, "This discovery-only check does not attach an execution driver");
  await browser.context.setActivePage(tab);
  await tab.locator("#recording-stop").click(); await until(() => controller.state.recording?.status === "saved");
  const response = await fetch(dashboard.url + "recording.jsonl"); assert.equal(response.status, 200);
  const contents = await response.text();
  assert.doesNotMatch(contents, /PRIVATE_PASSWORD_FIXTURE|PRIVATE_INPUT_FIXTURE|PRIVATE_SECTION_FIXTURE|PRIVATE_LINK_FIXTURE/);
  const records = parseRecording(contents);
  const header = records[0]; assert.equal(header.type, "session");
  if (header.type === "session") {
    assert.equal(header.expected, null); assert.match(header.name, /^Browsing session /);
    assert.doesNotMatch(header.name, /calculus|review/i, "The session name cannot supply a task hint");
  }
  assert.ok(records.some((record) => record.type === "prediction" && record.accepted));
  await tab.locator("#recording-replay").click(); await until(() => controller.state.replay.status === "done");
  assert.ok(controller.state.replay.report?.firstDetectionStep && controller.state.replay.report.firstDetectionStep <= 2);
  assert.equal(controller.state.replay.report?.expected, null); assert.equal(controller.state.replay.report?.verdict, "unscored");
  assert.equal(controller.runner, undefined, "This discovery-only check does not attach an execution driver");
  const report = await fetch(dashboard.url + "replay.md"); assert.equal(report.status, 200);
  const markdown = await report.text(); assert.match(markdown, /First accepted detection: step [12]/); assert.doesNotMatch(markdown, /Expected match|First expected match|Verdict:/);
  await tab.waitForFunction(() => document.querySelectorAll("#replay-rows tr").length === 2);
  await tab.evaluate(() => document.querySelector(".recording-panel")?.scrollIntoView());
  await writeFile("/tmp/rebrowse-recording-desktop.png", await tab.screenshot());
  await tab.setViewportSize(390, 844);
  assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(await tab.evaluate(() => Array.from(document.querySelectorAll('main,.recording-panel,.replay-table-wrap,table')).map((element) => ({ tag: element.tagName, className: element.className, width: element.getBoundingClientRect().width, scroll: element.scrollWidth })))));
  await tab.evaluate(() => document.querySelector(".recording-panel")?.scrollIntoView());
  await writeFile("/tmp/rebrowse-recording-mobile.png", await tab.screenshot());
  console.log(`Passed: ${live ? "live SubQ" : "simulated model"} infers calculus reviews from browsing alone, with no topic, name or step-count inputs; automatic observation counting, private-text exclusion, discovery replay isolation, and responsive dashboard.`);
} finally {
  controller.stop(); await controller.finishExecution(); await controller.finishRecording(); await observer?.stop(); await browser?.close(); await dashboard.close();
  fixture.closeAllConnections(); await new Promise<void>((resolve) => fixture.close(() => resolve())); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
