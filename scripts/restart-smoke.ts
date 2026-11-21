import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAgent, launchBrowser } from "../src/browser.js";
import { acquireBrowserSession } from "../src/browser-session.js";

const directory = await mkdtemp(join(tmpdir(), "rebrowse restart "));
const fixture = createServer((_request, response) => response.end("<!doctype html><title>Restart fixture</title><h1>Keep this review tab</h1>"));
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address(); assert(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/unit/2`;
const profile = join(directory, "browser profile");
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
let release: Awaited<ReturnType<typeof acquireBrowserSession>> | undefined;
try {
  release = await acquireBrowserSession(profile);
  browser = await launchBrowser({ profile, headless: true });
  await connectAgent(browser);
  assert.equal(browser.origin, "launched");
  const page = await browser.context.newPage(url);
  await page.waitForFunction(() => document.title === "Restart fixture");
  const pageId = page.pageId;
  const initialTabs = (await browser.context.pages()).length;
  await writeFile(join(profile, "saved-profile-fixture"), "Persistent profile preserved");
  await assert.rejects(acquireBrowserSession(profile), /already running/);
  await browser.disconnect(); // Simulate an agent stopping while Chrome survives.
  await release(); release = await acquireBrowserSession(profile);
  browser = await launchBrowser({ profile, headless: true });
  await connectAgent(browser);
  assert.equal(browser.origin, "connected", "Restart should reuse the process, not launch a second Chrome into its profile");
  const restoredTabs = await browser.context.pages();
  assert.equal(restoredTabs.length, initialTabs, "Reconnection must not create a window when browsing tabs already exist");
  const retained = restoredTabs.find((tab) => tab.pageId === pageId);
  assert.ok(retained); assert.equal(await retained.url(), url);
  assert.equal(await retained.evaluate(() => document.querySelector("h1")?.textContent), "Keep this review tab");
  assert.equal(await readFile(join(profile, "saved-profile-fixture"), "utf8"), "Persistent profile preserved");
  await browser.close(); browser = undefined;
  // Connected handles send Browser.close but do not own/wait on the OS child.
  const deadline = Date.now() + 5000;
  while (await readlink(join(profile, "SingletonLock")).catch(() => null)) {
    assert.ok(Date.now() < deadline, "Chrome should release its profile after closing");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await launchBrowser({ profile, headless: true });
  assert.equal(browser.origin, "launched", "After Chrome closes, the next start should launch normally");
  await connectAgent(browser);
  for (const tab of await browser.context.pages()) await tab.close();
  assert.equal((await browser.context.pages()).length, 0);
  await browser.disconnect(); browser = undefined;
  browser = await launchBrowser({ profile, headless: true });
  await connectAgent(browser);
  assert.equal((await browser.context.pages()).length, 1, "Chrome surviving without any windows should get one blank page before Stagehand reconnects");
  console.log("Passed: duplicate-agent protection, reconnect to surviving Chrome, retained review tab/profile, fresh launch after close, and reopening an empty browser; no model calls.");
} finally {
  await browser?.close(); await release?.(); fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve())); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
