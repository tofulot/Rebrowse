import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { BrowserObserver } from "../src/observer.js";
import { PredictionDashboard, startDashboard } from "../src/dashboard.js";
import { TaskJournal, type TaskHypothesis } from "../src/tasks.js";
import type { predictNext } from "../src/predictor.js";

const live = process.argv.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY first.");
const people = ["Alex Morgan", "Sam Rivera", "Jamie Chen"];
const sent = new Set<number>();
const directory = await mkdtemp(join(tmpdir(), "rebrowse-workflow-"));
const journal = new TaskJournal(join(directory, "task-journal.jsonl"));
const mock: typeof predictNext = async (_context, _events, _signal, _desktop, workflow) => {
  const observations = workflow?.observations || [];
  const source = observations.find((frame) => frame.context.lists?.some((list) => list.items.length === 3));
  const outcomes = people.flatMap((person) => {
    const frame = observations.find((frame) => frame.context.title === `${person} | LinkedIn` && frame.context.actions.includes("Pending"));
    return frame ? [{ item: person, evidenceIds: [source?.id || frame.id, frame.id], outcome: "confirmed" as const, outcomeEvidenceId: frame.id }] : [];
  });
  const currentJamie = observations.filter((frame) => frame.context.title.includes(people[2]!)).at(-1);
  const jamieState = currentJamie?.context.excerpt.includes("No matching profile") ? "blocked"
    : currentJamie?.context.actions.includes("Connect") ? "in_progress" : "unstarted";
  const task: TaskHypothesis | null = source && outcomes.length >= 2 ? {
    taskId: workflow?.knownTasks[0]?.id || null, title: "Connect with names from the prospect list", confidence: 0.92,
    steps: ["Choose an unprocessed name", "Search LinkedIn", "Open the person's profile", "Send a connection request"],
    reason: "The same sequence was observed for different people. Pending on each profile confirms invitations were sent; the list shows unprocessed names.",
    cycles: outcomes, totalItems: 3, totalEvidenceId: source.id,
    remainingItems: people.filter((person) => !outcomes.some((cycle) => cycle.item === person)), remainingEvidenceId: source.id,
    currentItem: jamieState === "in_progress" ? people[2]! : null,
    nextStep: outcomes.length === 3 ? "Finish the observed list" : jamieState === "blocked" ? "Review the missing match for Jamie Chen before another attempt"
      : jamieState === "in_progress" ? "Check the current item outcome for Jamie Chen" : "Return to the list and search LinkedIn for Jamie Chen",
    continuation: outcomes.length === 3 ? "finished" : "likely",
    suggestedWorkflow: null, pattern: null,
    workQueue: { sourceObservationId: source.id, sourceListIndex: 0,
      items: people.map((item, index) => ({ item, sourceRow: index + 1, state: index === 2 ? jamieState : "unstarted",
        evidenceId: index === 2 && jamieState !== "unstarted" ? currentJamie!.id : source.id,
        reason: jamieState === "blocked" ? "No matching profile found" : "Named profile is being checked" })) },
  } : null;
  return { intent: task?.title || "Work through the prospect list", summary: task?.reason || "Collecting examples of the workflow.",
    predictions: [{ action: task?.nextStep || "Continue the current step", confidence: 0.6, evidence: "Observed page context" }], repeatableTask: task };
};
const controller = new PredictionDashboard({ journal, ...(live ? {} : { predict: mock, isConfigured: () => true, debounceMs: 100, intervalMs: 100 }) });
const dashboard = await startDashboard(controller);
const fixture = createServer((request, response) => {
  const path = (request.url || "/").split("?")[0]!;
  if (request.method === "POST" && path.startsWith("/sent/")) {
    sent.add(Number(path.split("/").at(-1))); response.writeHead(200).end(); return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  const index = Number(path.split("/").at(-1));
  if (path.startsWith("/linkedin/no-match/") && people[index]) {
    response.end(`<!doctype html><title>${people[index]} — LinkedIn search</title><main><h1>Search for ${people[index]}</h1><p>No matching profile found for ${people[index]}.</p></main>`);
  } else if (path.startsWith("/linkedin/in/") && people[index]) {
    response.end(`<!doctype html><title>${people[index]} | LinkedIn</title><main><h1>${people[index]}</h1><p>LinkedIn profile</p><button id="connect" onclick="fetch('/sent/${index}',{method:'POST'}).then(()=>{this.textContent='Pending';document.querySelector('#outcome').textContent='Invitation sent to ${people[index]}';})">${sent.has(index) ? "Pending" : "Connect"}</button><p id="outcome">${sent.has(index) ? `Invitation sent to ${people[index]}` : "No invitation has been sent"}</p></main>`);
  } else if (path.startsWith("/linkedin/search/") && people[index]) {
    response.end(`<!doctype html><title>Search results — LinkedIn</title><main><h1>LinkedIn search results for ${people[index]}</h1><p>One matching person</p><a id="profile" href="/linkedin/in/${index}">${people[index]}</a></main>`);
  } else {
    response.end(`<!doctype html><title>Prospect list</title><main><h1>Prospect outreach</h1><p>3 names total in this complete list.</p><ul aria-label="Complete prospect list">${people.map((person, i) => `<li>${person} — ${sent.has(i) ? 'Invitation sent' : 'Not processed'} <a id="person-${i}" href="/linkedin/search/${i}">Search ${person} on LinkedIn</a></li>`).join("")}</ul></main>`);
  }
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
let observer: BrowserObserver | undefined;
async function until(condition: () => boolean, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(condition(), `Expected workflow state; latest error: ${controller.state.error || "none"}; assessment: ${JSON.stringify(controller.state.prediction?.repeatableTask)}; observations: ${JSON.stringify(controller.taskMemory.observations.map((frame) => ({ id: frame.id, title: frame.context.title, actions: frame.context.actions, lists: frame.context.lists?.map((list) => list.items.length) })))}`);
}
try {
  browser = await localBrowser.launch({ headless: true, userDataDir: join(directory, "profile") });
  await connectAgent(browser);
  const address = fixture.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await browser.context.newPage();
  await page.goto(base + "/list");
  const tab = await browser.context.newPage();
  await tab.goto(dashboard.url);
  await browser.context.setActivePage(page);
  observer = new BrowserObserver(browser.context, dashboard.origin, (event, source) => controller.activity(event, source),
    (message) => controller.reportError(message), (context, source, options) => controller.observe(context, source, options));
  controller.observer = observer;
  await observer.start();
  await until(() => controller.taskMemory.observations.some((frame) => frame.context.lists?.length));
  assert.equal(controller.taskMemory.observations[0]!.context.lists![0]!.items.length, 3);
  for (const index of [0, 1]) {
    await page.goto(base + "/list");
    await page.locator(`#person-${index}`).click();
    await until(() => controller.taskMemory.observations.some((frame) => frame.context.headings.some((heading) => heading.includes(`search results for ${people[index]}`))));
    await page.locator("#profile").click();
    await until(() => controller.taskMemory.observations.some((frame) => frame.context.title === `${people[index]} | LinkedIn` && frame.context.actions.includes("Connect")));
    await page.locator("#connect").click();
    await until(() => controller.taskMemory.observations.some((frame) => frame.context.title === `${people[index]} | LinkedIn` && frame.context.actions.includes("Pending")));
  }
  await page.goto(base + "/list");
  await until(() => controller.state.tasks.some((task) => task.completedItems.length === 2 && task.remainingCount === 1 && task.remainingItems.includes("Jamie Chen")), 45000);
  const task = controller.state.tasks[0]!;
  assert.equal(task.status, "repeating");
  assert.equal(task.workQueue.scope, "verified");
  assert.equal(task.workQueue.decision, "continue");
  assert.equal(task.workQueue.counts.ready, 1);
  assert.equal(task.workQueue.nextItem, people[2]);
  assert.equal(task.workflowDraft.status, "ready");
  assert.equal(task.workflowDraft.execution, "automatic");
  assert.ok(task.workflowDraft.inputs.some((input) => input.name === "items"));
  assert.equal(task.workflowDraft.steps.length, task.steps.length);
  assert.ok(task.workflowDraft.steps.every((step, index) => step.sourceStep === index + 1 && step.check.length > 0));
  for (const person of people) assert.ok(!JSON.stringify(task.workflowDraft).includes(person), "Reusable drafts should not bake in observed people");
  assert.equal(sent.size, 2, "Predictions must never send the third invitation");
  await tab.waitForFunction(() => document.querySelector("#workflow-current")?.hasAttribute("hidden") === false);
  assert.match(await tab.evaluate(() => document.querySelector("#workflow-remaining")?.textContent || ""), /Jamie Chen/);
  await tab.waitForFunction(() => document.querySelector("#queue-decision")?.textContent === "NEXT TARGETS");
  assert.equal(await tab.evaluate(() => document.querySelectorAll('#queue-items [data-state="confirmed"]').length), 2);
  assert.match(await tab.evaluate(() => document.querySelector("#queue-scope")?.textContent || ""), /3 unique items.*1 remaining/);
  await tab.waitForFunction(() => document.querySelector("#workflow-draft")?.hasAttribute("hidden") === false);
  assert.match(await tab.evaluate(() => document.querySelector("#draft-version")?.textContent || ""), /Automatic/);
  await browser.context.setActivePage(tab);
  await tab.locator("#draft-details > summary").click();
  await tab.waitForFunction(() => document.querySelector("#draft-details")?.hasAttribute("open") === true);
  assert.equal(await tab.evaluate(() => document.querySelectorAll("#draft-steps > li").length), task.steps.length);
  const report = await (await fetch(dashboard.url + "tasks.md")).text();
  assert.match(report, /Jamie Chen/);
  assert.match(report, /remaining: 1/);
  assert.match(report, /AUTOMATIC WORKFLOW/);
  assert.match(report, /Work queue and stopping assessment/);
  const exportedDraft = await fetch(dashboard.url + `workflow/${task.id}.md`);
  assert.equal(exportedDraft.status, 200);
  const draftText = await exportedDraft.text();
  assert.match(draftText, /AUTOMATIC WORKFLOW/);
  assert.match(draftText, /\{\{items\}\}/);
  assert.match(draftText, /Check:/);
  assert.match(draftText, /Skip and stop rules/);
  assert.equal((await fetch(dashboard.url + "workflow/unknown.md")).status, 404);
  assert.equal(sent.size, 2, "Reviewing or downloading a draft must not execute it");
  // The test driver alone changes local fixture pages. The prediction loop
  // only observes, even when it suggests continuing or finishing the queue.
  await browser.context.setActivePage(page);
  await page.goto(base + "/linkedin/no-match/2");
  await until(() => controller.state.tasks[0]?.workQueue.decision === "stop" && controller.state.tasks[0]?.workQueue.counts.blocked === 1, 45000);
  await tab.waitForFunction(() => document.querySelector("#queue-decision")?.textContent === "STOPPED");
  assert.equal(controller.state.tasks[0]!.remainingCount, 1);
  assert.equal(sent.size, 2, "A blocker must not trigger an automatic retry or skip");
  await browser.context.setActivePage(tab);
  await writeFile("/tmp/rebrowse-queue-review.png", await tab.screenshot({ fullPage: true }));
  await browser.context.setActivePage(page);
  await page.goto(base + "/linkedin/in/2");
  await until(() => controller.state.tasks[0]?.workQueue.counts.inProgress === 1, 45000);
  assert.equal(sent.size, 2, "An in-progress prediction must not submit the invitation");
  await page.locator("#connect").click();
  await until(() => controller.taskMemory.observations.some((frame) => frame.context.title === `${people[2]} | LinkedIn` && frame.context.actions.includes("Pending")));
  await page.goto(base + "/list");
  await until(() => controller.state.tasks[0]?.workQueue.decision === "complete", 45000);
  assert.equal(controller.state.tasks[0]!.remainingCount, 0);
  assert.equal(controller.state.tasks[0]!.workQueue.counts.confirmed, 3);
  await tab.waitForFunction(() => document.querySelector("#queue-decision")?.textContent === "BATCH FINISHED");
  assert.equal(sent.size, 3, "Only the test driver's explicit local fixture click submitted the last item");
  await browser.context.setActivePage(tab);
  await controller.flushTasks();
  assert.ok((await readFile(journal.path, "utf8")).trim().split("\n").every((line) => JSON.parse(line).sessionId === controller.taskMemory.sessionId && JSON.parse(line).workflowDraft.execution === "automatic"));
  await tab.evaluate(() => window.scrollTo(0, 0));
  await writeFile("/tmp/rebrowse-workflow-desktop.png", await tab.screenshot({ fullPage: true }));
  await tab.setViewportSize(390, 844);
  assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await writeFile("/tmp/rebrowse-workflow-mobile.png", await tab.screenshot({ fullPage: true }));
  await tab.evaluate(() => document.querySelector(".queue-panel")?.scrollIntoView());
  await writeFile("/tmp/rebrowse-queue-mobile.png", await tab.screenshot());
  console.log(`Passed: ${live ? "live SubQ" : "simulated"} work queue, continuation/unavailable/in-progress/finish states, reusable workflow, exports, local persistence, responsive layout, and no automatic actions.`);
} finally {
  controller.stop();
  await observer?.stop();
  await controller.flushTasks();
  await browser?.close();
  await dashboard.close();
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
