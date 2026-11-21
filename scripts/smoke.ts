import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";

// --live additionally verifies actual SubQ inference on this local fixture.
const live = process.argv.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY in .env first.");
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end('<title>Rebrowse smoke</title><button onclick="this.textContent=\'Done\'">Try it</button>');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "rebrowse-smoke-"));
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  browser = await localBrowser.launch({ headless: true, userDataDir: profile });
  const agent = await connectAgent(browser);
  const page = await browser.context.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  assert.equal(await page.title(), "Rebrowse smoke");
  await page.locator("button").click();
  await page.waitForFunction(() => document.querySelector("button")?.textContent === "Done");
  assert.equal(await page.evaluate(() => document.querySelector("button")?.textContent), "Done");
  const snapshot = await page.snapshot();
  assert.match(JSON.stringify(snapshot), /Done/);
  console.log("Passed: browser launch, navigation, page interaction, and snapshot.");
  if (live) {
    await page.reload();
    const observed = await agent.observe("Find the Try it button", { page });
    assert.ok(observed.data.length > 0, "SubQ should identify an available action");
    const action = await agent.act("Click the Try it button", { page });
    assert.ok(action.data.success, "Stagehand action should succeed");
    await page.waitForFunction(() => document.querySelector("button")?.textContent === "Done");
    console.log("Passed: live SubQ observe and act, including verified button click.");
  }
} finally {
  try {
    await browser?.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}
