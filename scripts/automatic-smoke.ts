import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { BrowserObserver, readContext } from "../src/observer.js";
import { PredictionDashboard, startDashboard } from "../src/dashboard.js";
import { TaskJournal, type TaskHypothesis } from "../src/tasks.js";
import { browserWorkflowDriver } from "../src/workflow-browser.js";
import { WorkflowRunJournal } from "../src/workflow-runner.js";
import { SessionRecorder, parseRecording } from "../src/recording.js";

const live = process.argv.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY first.");
const directory = await mkdtemp(join(tmpdir(), "rebrowse-automatic-"));
const fixture = createServer((request, response) => {
  const unit = Number((request.url || "").split("/").at(-1));
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Biology Unit ${unit} review guide</title><main><h1>Biology Unit ${unit}: complete unit review</h1><p>This biology course has exactly 5 units. Collect one review guide for each unit.</p><p>Review guide material for Unit ${unit}.</p>${[1, 2, 3, 4, 5].map((n) => `<a href="/unit/${n}">Biology Unit ${n} review guide</a>`).join(" ")}</main>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address(); assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const controller = new PredictionDashboard({ recorder: new SessionRecorder(join(directory, "recordings")), journal: new TaskJournal(join(directory, "tasks.jsonl")), autoDelayMs: 100, ...(live ? {} : {
  isConfigured: () => true, debounceMs: 100, intervalMs: 100,
  predict: async () => {
    const task: TaskHypothesis = { taskId: controller.state.tasks[0]?.id || null, title: "Collect biology unit review guides", confidence: .75,
      steps: ["Open the matching review guide for {{item}}"], reason: "Opening the first two unit reviews suggests collecting the remaining unit guides.", cycles: [],
      totalItems: null, totalEvidenceId: null, remainingItems: [], remainingEvidenceId: null, currentItem: null, nextStep: "Open guides for the remaining units", continuation: "likely", workQueue: null, suggestedWorkflow: null,
      pattern: { action: "Gather review guides for every biology unit", repeatLikelihood: .9, reason: "The goal applies across related units after only two simple navigations.", evidenceIds: [1, 2], operation: "open_tabs", goal: "resources", endCondition: "Stop after Unit 5; there are five units in this course.", endKnown: true, maxItems: 3,
        targets: [3, 4, 5].map((unit) => ({ item: `Unit ${unit}`, url: `${base}/unit/${unit}`, basis: "observed" })) } };
    return { intent: task.title, summary: task.reason, predictions: [{ action: task.nextStep, confidence: .8, evidence: "Unit 1 and Unit 2 review guides opened" }], repeatableTask: task };
  },
}) });
const server = await startDashboard(controller);
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
let observer: BrowserObserver | undefined;
async function until(check: () => boolean, timeout = live ? 120000 : 20000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(check(), `Prediction: ${JSON.stringify(controller.state.prediction?.repeatableTask)}; run: ${JSON.stringify(controller.runner?.state)}; error: ${controller.state.error}`);
}
try {
  browser = await localBrowser.launch({ headless: true, userDataDir: join(directory, "profile") });
  const agent = await connectAgent(browser);
  controller.attachRunner({ driver: async () => browserWorkflowDriver(browser!.context, agent), journal: new WorkflowRunJournal(join(directory, "runs.jsonl")),
    ...(live ? {} : { resourcePlan: async () => ({ status: "done" as const, url: null, reason: "The matching review guide is open." }) }) });
  const page = await browser.context.newPage();
  for (const unit of [1, 2]) {
    await page.goto(`${base}/unit/${unit}`);
    controller.taskMemory.observe(await readContext(page), page.pageId, [{ id: unit, pageId: page.pageId, time: Date.now(), kind: "navigate", label: `Opened Unit ${unit} review`, url: `${base}/unit/${unit}` }]);
  }
  await browser.context.newPage(`${base}/unit/3`); // Existing resource must be reused.
  const dashboard = await browser.context.newPage(); await dashboard.goto(server.url);
  const initialTabs = (await browser.context.pages()).length;
  await browser.context.setActivePage(page);
  observer = new BrowserObserver(browser.context, server.origin, (event, source) => controller.activity(event, source), (message) => controller.reportError(message), (context, source, options) => controller.observe(context, source, options));
  controller.observer = observer; await controller.startRecording(); await observer.start();
  await until(() => controller.runner?.state?.status === "complete");
  assert.equal(controller.state.error, null);
  const task = controller.state.tasks[0]!;
  assert.equal(task.pattern?.operation, "open_tabs"); assert.ok(task.pattern.repeatLikelihood >= .6);
  assert.equal((await browser.context.pages()).length, initialTabs + 2, "Units 4 and 5 should open; the existing Unit 3 tab should be reused");
  assert.equal(task.workQueue.items.filter((item) => item.state === "confirmed").length, task.workQueue.items.length);
  assert.equal(task.totalItems, null, "A predicted batch must not be presented as a verified complete list");
  assert.match(controller.runner!.state!.message, /Stopped automatically/);
  const runCount = controller.runner!.state!.id;
  controller.requestPrediction(); await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(controller.runner!.state!.id, runCount, "AI output and prediction refresh cannot recursively start another batch");
  assert.equal((await fetch(server.url + "workflow-run", { method: "POST", headers: { Origin: server.origin } })).status, 404);
  await browser.context.setActivePage(dashboard);
  await dashboard.waitForFunction(() => document.querySelector("#run-status")?.textContent === "BATCH FINISHED");
  assert.equal(await dashboard.locator("#workflow-approve").count(), 0);
  assert.match(await dashboard.evaluate(() => document.querySelector("#workflow-reason")?.textContent || ""), /repeat likelihood/);
  await dashboard.evaluate(() => document.querySelector(".workflow-panel")?.scrollIntoView());
  await writeFile("/tmp/rebrowse-automatic-desktop.png", await dashboard.screenshot());
  await dashboard.setViewportSize(390, 844); assert.ok(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await dashboard.evaluate(() => document.querySelector("#workflow-run")?.scrollIntoView());
  await writeFile("/tmp/rebrowse-automatic-mobile.png", await dashboard.screenshot());
  await controller.finishExecution();
  assert.equal(controller.recorder.capturing, true, "Recording must continue while the workflow executes");
  await controller.stopRecording();
  const recording = parseRecording(await controller.recorder.download());
  assert.ok(recording.some((entry) => entry.type === "workflow" && entry.status === "complete"));
  assert.ok(recording.some((entry) => entry.type === "observation" && entry.frame.actor === "workflow"));
  const lines = (await readFile(join(directory, "runs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.at(-1).status, "complete");
  console.log(`Passed: ${live ? "live SubQ" : "simulated"} broad goal detection from two navigations, automatic resource tabs while recording, labeled automation outcomes, duplicate reuse, bounded stopping, no approval UI/API, local journal and responsive dashboard.`);
} finally {
  controller.stop(); await controller.finishExecution(); await controller.finishRecording(); await observer?.stop(); await controller.flushTasks();
  await browser?.close(); await server.close(); fixture.closeAllConnections(); await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
