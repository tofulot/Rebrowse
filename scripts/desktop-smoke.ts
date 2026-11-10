import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { DesktopObserver } from "../src/desktop-context.js";
import { BrowserObserver } from "../src/observer.js";
import { PredictionDashboard, startDashboard } from "../src/dashboard.js";

if (process.platform !== "darwin") throw new Error("This check requires macOS.");
if (!process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY first.");
const fixture = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<title>Rebrowse browser-controls test</title><h1>Product collection</h1><p>Compare products, read specifications, or view details.</p><button>View details</button>');
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "rebrowse-desktop-"));
const browser = await localBrowser.launch({ headless: false, userDataDir: profile });
const controller = new PredictionDashboard();
const dashboard = await startDashboard(controller);
let observer: BrowserObserver | undefined;
let desktop: DesktopObserver | undefined;
let detected = false;
try {
  await connectAgent(browser);
  const address = fixture.address();
  assert(address && typeof address !== "string");
  const page = await browser.context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  observer = new BrowserObserver(browser.context, dashboard.origin,
    (event, source) => controller.activity(event, source), (message) => controller.reportError(message));
  controller.observer = observer;
  await observer.start();
  const tab = await browser.context.newPage();
  await tab.goto(dashboard.url);
  await browser.context.setActivePage(page);
  desktop = new DesktopObserver(profile, (state) => controller.desktop(state), (kind, label) => {
    console.log(`Browser signal: ${kind}`);
    if (kind === "address-select") detected = true;
    void observer?.external(kind, label);
  });
  controller.desktopObserver = desktop;
  await desktop.start();
  console.log("Ready: select the address bar in the Rebrowse browser-controls test window (Cmd+L). No text entry is needed.");
  const deadline = Date.now() + 90000;
  while ((!detected || controller.state.prediction?.intent === undefined || !controller.state.activity.some((event) => event.kind === "address-select") || controller.state.stale) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(detected, "Native address-bar selection should be detected");
  assert.ok(controller.state.activity.some((event) => event.kind === "address-select"));
  assert.ok(controller.state.desktop?.sample?.accessibility);
  assert.equal(controller.state.error, null);
  const result = controller.state.prediction;
  assert.ok(result);
  assert.match(result.predictions[0]!.action, /search|url|address|navigat/i);
  console.log(JSON.stringify({ passed: true, nextAction: result.predictions[0]!.action, confidence: result.predictions[0]!.confidence }));
} finally {
  controller.stop();
  await desktop?.stop();
  await observer?.stop();
  await browser.close();
  await dashboard.close();
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(profile, { recursive: true, force: true });
}
