import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localBrowser, type Action, type Page } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { PredictionDashboard, startDashboard } from "../src/dashboard.js";
import { TaskJournal, type TaskHypothesis } from "../src/tasks.js";
import { readContext } from "../src/observer.js";
import { browserWorkflowDriver } from "../src/workflow-browser.js";
import { WorkflowRunJournal, planWorkflowStep, type StepPlanner } from "../src/workflow-runner.js";

const live = process.argv.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY first.");
const directory = await mkdtemp(join(tmpdir(), "rebrowse-runner-smoke-"));
const names = live ? ["Alex Morgan", "Sam Rivera", "Jamie Chen"] : ["Alex Morgan", "Sam Rivera", "Jamie Chen", "Taylor Reed"];
const sent = new Set<string>(); let missing = false;
const fixture = createServer((request, response) => {
  const parts = (request.url || "").split("/"); const mode = parts[1] || "success"; const kind = parts[2]; const index = Number(parts[3]);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.method === "POST" && kind === "sent") { sent.add(`${mode}:${index}`); response.end("OK"); return; }
  if (kind === "search") {
    response.end(`<!doctype html><title>LinkedIn search results for ${names[index]}</title><main><h1>Search results for ${names[index]}</h1>${missing ? `<p>No matching profile found for ${names[index]}.</p>` : `<p>Exactly one matching person</p><a id="profile" href="/${mode}/profile/${index}">${names[index]}</a>`}</main>`);
  } else if (kind === "profile") {
    response.end(`<!doctype html><title>${names[index]} | LinkedIn</title><main><h1>${names[index]}</h1><p>Matching LinkedIn profile</p><button id="connect" onclick="fetch('/${mode}/sent/${index}',{method:'POST'}).then(()=>{this.textContent='Pending';document.querySelector('#outcome').textContent='Invitation sent to ${names[index]}';})">${sent.has(`${mode}:${index}`) ? "Pending" : "Connect"}</button><p id="outcome">${sent.has(`${mode}:${index}`) ? `Invitation sent to ${names[index]}` : "No invitation has been sent"}</p></main>`);
  } else {
    response.end(`<!doctype html><title>Prospect list</title><main><h1>Prospect outreach</h1><p>${names.length} names total in this complete list.</p><ul aria-label="Prospects">${names.map((name, index) => `<li>${name} — ${sent.has(`${mode}:${index}`) ? "Invitation sent" : "Not processed"} <a id="person-${index}" href="/${mode}/search/${index}">Search ${name} on LinkedIn</a></li>`).join("")}</ul></main>`);
  }
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address(); assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const controller = new PredictionDashboard({ isConfigured: () => true, journal: new TaskJournal(join(directory, "tasks.jsonl")) });
const server = await startDashboard(controller);
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
const plan: StepPlanner = async ({ step, item, snapshot }) => {
  const page = snapshot.context;
  if (page.excerpt.includes("No matching profile")) return { status: "review", instruction: "", reason: `No matching profile for ${item}.`, evidence: ["No matching profile"] };
  if (page.actions.includes("Pending")) return { status: "item_complete", instruction: "", reason: "Invitation visibly sent", evidence: ["Invitation sent"] };
  if (step === 1) return { status: "step_complete", instruction: "", reason: "Source list open", evidence: ["Prospect outreach"] };
  if (step === 2 && page.url.includes("/search/") || step === 3 && page.url.includes("/profile/")) return { status: "step_complete", instruction: "", reason: "Matching named page open", evidence: [item] };
  return { status: "act", instruction: step === 2 ? `Click Search ${item} on LinkedIn` : step === 3 ? `Open ${item}'s profile` : "Click Connect once", reason: "Approved observed step", evidence: [page.title] };
};
async function until(check: () => boolean, timeout = live ? 240000 : 30000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(check(), JSON.stringify(controller.runner?.state));
}
async function seed(page: Page, mode: string) {
  await browser!.context.setActivePage(page);
  let sourceId = 0; const cycles: TaskHypothesis["cycles"] = [];
  await page.goto(`${base}/${mode}/list`);
  controller.taskMemory.observe(await readContext(page), page.pageId, []); sourceId = controller.taskMemory.observations.at(-1)!.id;
  for (const index of [0, 1]) {
    await page.goto(`${base}/${mode}/profile/${index}`); await page.locator("#connect").click();
    await page.waitForFunction(() => document.querySelector("#connect")?.textContent === "Pending");
    controller.taskMemory.observe(await readContext(page), page.pageId, []);
    const id = controller.taskMemory.observations.at(-1)!.id;
    cycles.push({ item: names[index]!, evidenceIds: [sourceId, id], outcome: "confirmed", outcomeEvidenceId: id });
  }
  const candidate: TaskHypothesis = { taskId: null, title: `Send LinkedIn invitations (${mode})`, confidence: .9,
    steps: ["Open the prospect list", "Click Search {{item}} on LinkedIn", "Open the matching profile for {{item}}", "Click Connect and confirm Invitation sent for {{item}}"],
    reason: "Observed two distinct named outcomes", cycles, totalItems: names.length, totalEvidenceId: sourceId, remainingItems: names.slice(2), remainingEvidenceId: sourceId,
    currentItem: null, nextStep: "Continue with the next name", continuation: "likely", suggestedWorkflow: null, workQueue: null };
  const task = controller.taskMemory.accept(candidate)!; assert(task);
  controller.state.tasks = controller.taskMemory.tasks; controller.state.taskLog = controller.taskMemory.log; controller.state.activeTaskId = task.id;
  controller.setPaused(false);
  return task;
}
try {
  browser = await localBrowser.launch({ headless: true, userDataDir: join(directory, "profile") });
  const agent = await connectAgent(browser);
  controller.attachRunner({ journal: new WorkflowRunJournal(join(directory, "runs.jsonl")), plan: live ? planWorkflowStep : plan, ...(live ? {} : { settleMs: 50 }),
    driver: async () => {
      const driver = browserWorkflowDriver(browser!.context, agent);
      if (!live) driver.locate = async (instruction) => {
        const snapshot = await driver.capture(); const name = names.find((name) => instruction.includes(name))!;
        const selector = snapshot.context.url.endsWith("/list") ? `#person-${names.indexOf(name)}` : snapshot.context.url.includes("/search/") ? "#profile" : "#connect";
        return [{ selector, method: "click", description: `Click ${selector}` } satisfies Action];
      };
      return driver;
    } });
  const content = await browser.context.newPage(); const dashboard = await browser.context.newPage();
  const task = await seed(content, "success");
  await dashboard.goto(server.url);
  await browser.context.setActivePage(dashboard);
  await dashboard.waitForFunction(() => !(document.querySelector("#workflow-approve") as HTMLButtonElement)?.disabled);
  assert.equal(sent.size, 2, "A suggestion cannot execute without approval");
  await dashboard.locator("#workflow-approve").click();
  await until(() => !controller.executionBusy && !!controller.runner?.state);
  assert.equal(controller.runner!.state!.status, "complete", JSON.stringify(controller.runner!.state));
  assert.equal(task.workQueue.counts.remaining, 0); assert.equal(sent.size, names.length);
  await browser.context.setActivePage(dashboard);
  await dashboard.waitForFunction(() => document.querySelector("#run-status")?.textContent === "COMPLETE · STOPPED");
  await until(() => !controller.executionBusy);
  assert.equal(await dashboard.locator("#workflow-run-pause").isVisible(), false);
  assert.equal(controller.state.activity.length, 0);
  const stored = (await readFile(join(directory, "runs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(stored.at(-1).status, "complete");
  assert.match(await (await fetch(server.url + "tasks.md")).text(), /Outcomes confirmed by approved workflow runs: Jamie Chen/);
  await dashboard.evaluate(() => document.querySelector("#workflow-run")?.scrollIntoView());
  await writeFile("/tmp/rebrowse-run-complete.png", await dashboard.screenshot());
  if (!live) {
    missing = true;
    const blocked = await seed(content, "blocked");
    await dashboard.reload();
    await browser.context.setActivePage(dashboard);
    await dashboard.waitForFunction(() => !(document.querySelector("#workflow-approve") as HTMLButtonElement)?.disabled);
    await dashboard.locator("#workflow-approve").click();
    await until(() => !controller.executionBusy && controller.runner?.state?.taskId === blocked.id);
    assert.equal(controller.runner!.state!.status, "paused");
    assert.equal(blocked.workQueue.counts.blocked, 1); assert.equal(sent.size, names.length + 2);
    assert.equal(blocked.workQueue.items.find((item) => item.item === "Taylor Reed")?.state, "unstarted");
    await browser.context.setActivePage(dashboard);
    await dashboard.waitForFunction(() => document.querySelector("#run-status")?.textContent === "PAUSED · REVIEW NEEDED");
    assert.equal(await dashboard.evaluate(() => (document.querySelector("#workflow-approve") as HTMLButtonElement).disabled), true);
    await dashboard.evaluate(() => document.querySelector("#workflow-run")?.scrollIntoView());
    await writeFile("/tmp/rebrowse-run-review.png", await dashboard.screenshot());
    await dashboard.setViewportSize(390, 844);
    assert.ok(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await dashboard.evaluate(() => document.querySelector("#workflow-run")?.scrollIntoView());
    await writeFile("/tmp/rebrowse-run-mobile.png", await dashboard.screenshot());
  }
  console.log(`Passed: ${live ? "live SubQ" : "simulated planning with real Stagehand actions"}, dashboard approval, skipped completed items, verified queue completion${live ? "" : ", missing-match pause"}, run journal, and no execution before approval.`);
} finally {
  controller.stop(); await controller.finishExecution(); await controller.flushTasks();
  await browser?.close(); await server.close(); fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve())); await rm(directory, { recursive: true, force: true });
}
