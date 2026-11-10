import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { BrowserObserver, readContext } from "../src/observer.js";
import { PredictionDashboard, startDashboard } from "../src/dashboard.js";

const live = process.argv.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY first.");
const expected = {
  repeatableTask: null,
  intent: "Explore a product before choosing it",
  summary: "You opened the product details and paused near its main action. Selecting the next step is plausible, though the available history is short.",
  predictions: [
    { action: "Open the product details", confidence: 0.62, evidence: "You clicked Explore products and hovered over the Details button." },
    { action: "Scroll to compare specifications", confidence: 0.23, evidence: "Additional product information is available below." },
    { action: "Continue browsing the collection", confidence: 0.1, evidence: "The collection link offers another path." },
  ],
};
const controller = new PredictionDashboard(live ? {} : {
  isConfigured: () => true, predict: async () => expected, debounceMs: 100, intervalMs: 100,
});
const dashboard = await startDashboard(controller);
const fixture = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Northline — Product collection</title><main>
    <h1>Northline collection</h1><p>Explore products and compare details.</p>
    <button id="explore">Explore products</button><button id="details">View product details</button>
    <a href="/collection">Browse collection</a><input type="password" value="secret-password">
    <input type="search" value="secret-search"><textarea>secret-notes</textarea>
    <p contenteditable="true">secret-editable</p><p style="height:1300px">Product specifications</p>
    </main>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "rebrowse-predictions-"));
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
let observer: BrowserObserver | undefined;
try {
  browser = await localBrowser.launch({ headless: true, userDataDir: profile });
  await connectAgent(browser);
  const address = fixture.address();
  assert(address && typeof address !== "string");
  const page = await browser.context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/products?token=secret-query#secret-fragment`);
  const context = JSON.stringify(await readContext(page));
  assert.doesNotMatch(context, /secret-/);
  const tab = await browser.context.newPage();
  await tab.goto(dashboard.url);
  const errors: string[] = [];
  observer = new BrowserObserver(browser.context, dashboard.origin,
    (event, source) => controller.activity(event, source), (message) => errors.push(message));
  controller.observer = observer;
  await observer.start();
  await browser.context.setActivePage(page);
  await page.locator("#explore").click();
  const deadline = Date.now() + 30000;
  while (!controller.state.prediction && !controller.state.error && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(controller.state.error, null);
  assert.deepEqual(errors, []);
  assert.ok(controller.state.activity.some((event) => event.kind === "click" && event.label === "Explore products"), "Actual trusted clicks should reach the dashboard");
  assert.ok(controller.state.prediction, "A prediction should arrive");
  assert.ok(controller.state.prediction.predictions.every((item) => item.confidence >= 0 && item.confidence <= 1));
  assert.ok(controller.state.activity.every((event) => event.pageId !== tab.pageId), "Dashboard must not watch itself");
  await tab.waitForFunction(() => document.querySelectorAll(".prediction-card").length > 0);
  assert.equal(await tab.evaluate(() => document.querySelector("#page-title")?.textContent), "Northline — Product collection");
  // Exercise the actual UI control and its local POST endpoint.
  await browser.context.setActivePage(tab);
  await tab.locator("#pause").click();
  await tab.waitForFunction(() => document.querySelector("#status")?.textContent === "Paused");
  const count = controller.state.activity.length;
  await browser.context.setActivePage(page);
  await page.locator("#details").click();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(controller.state.activity.length, count, "Paused session must not collect events");
  await browser.context.setActivePage(tab);
  await tab.locator("#pause").click();
  await tab.waitForFunction(() => document.querySelector("#pause")?.textContent?.includes("Pause watching"));
  await browser.context.setActivePage(page);
  await page.goto(`http://127.0.0.1:${address.port}/another-page?token=secret-new`);
  await page.locator("#details").click();
  const navigationDeadline = Date.now() + 5000;
  while (!controller.state.activity.some((event) => event.kind === "click" && event.label === "View product details") && Date.now() < navigationDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(controller.state.activity.some((event) => event.kind === "click" && event.label === "View product details"), "Collector must survive navigation");
  assert.doesNotMatch(JSON.stringify(controller.state.activity), /secret-/);
  await browser.context.setActivePage(tab);
  // A sibling web origin cannot control this session.
  const denied = await fetch(dashboard.url + "pause", { method: "POST", headers: { Origin: "https://unrelated.example" } });
  assert.equal(denied.status, 403);
  assert.equal((await fetch(dashboard.origin + "/session/wrong/")).status, 404);
  if (live) {
    // Inject a native-control sample to verify the address-bar signal path and
    // actual model response independently of GUI automation permissions.
    await browser.context.setActivePage(page);
    controller.desktop({ status: "ready", message: "Browser-control test signal", pageId: page.pageId,
      sample: { time: Date.now(), active: true, accessibility: true, focus: "address-bar", addressSelected: true,
        pointer: { x: 520, y: 60, width: 1280, height: 800, space: "browser-window", region: "address-bar" } }, path: [] });
    const previousTime = controller.state.prediction?.time || 0;
    await observer.external("address-select", "Address bar text selected · may replace URL or start a search");
    assert.ok(controller.state.activity.some((event) => event.kind === "address-select"), "Injected native selection must reach the controller");
    const deadline = Date.now() + 30000;
    while ((!controller.state.prediction || controller.state.prediction.time <= previousTime || controller.state.stale) && !controller.state.error && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(controller.state.error, null);
    assert.ok(controller.state.prediction && controller.state.prediction.time > previousTime);
    assert.match(controller.state.prediction.predictions[0]!.action, /search|url|address|navigat/i);
    console.log("Passed: injected address-bar selection produces a live search/navigation prediction.");
    const previousEditTime = controller.state.prediction.time;
    controller.desktop({ status: "ready", message: "Browser-control text test", pageId: page.pageId,
      sample: { time: Date.now(), active: true, accessibility: true, focus: "address-bar", addressSelected: false, addressText: "wasd" },
      path: [], addressInput: { text: "wasd", time: Date.now() } });
    await observer.external("address-edit", "Address-bar text updated", "wasd");
    const editDeadline = Date.now() + 30000;
    while ((!controller.state.prediction || controller.state.prediction.time <= previousEditTime || controller.state.stale) && !controller.state.error && Date.now() < editDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(controller.state.error, null);
    assert.ok(controller.state.prediction && controller.state.prediction.time > previousEditTime);
    assert.match(controller.state.prediction.predictions[0]!.action, /wasd/i);
    await tab.waitForFunction(() => document.querySelector("#address-input")?.textContent === "wasd");
    console.log("Passed: actual query text reaches the dashboard and live SubQ prediction.");
    await browser.context.setActivePage(tab);
  }
  await writeFile("/tmp/rebrowse-dashboard-desktop.png", await tab.screenshot({ fullPage: true }));
  await tab.setViewportSize(390, 844);
  assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile layout should not overflow");
  await writeFile("/tmp/rebrowse-dashboard-mobile.png", await tab.screenshot({ fullPage: true }));
  console.log(`Passed: ${live ? "live SubQ" : "simulated"} predictions, trusted activity, redaction, separate dashboard tab, pause/resume, access checks, and responsive layout.`);
} finally {
  controller.stop();
  await observer?.stop();
  await browser?.close();
  await dashboard.close();
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(profile, { recursive: true, force: true });
}
