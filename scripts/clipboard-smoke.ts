import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { BrowserObserver } from "../src/observer.js";
import { PredictionDashboard, startDashboard } from "../src/dashboard.js";
import type { ClipboardState } from "../src/clipboard-context.js";

const live = process.argv.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY first.");
const directory = await mkdtemp(join(tmpdir(), "rebrowse-clipboard-"));
let restoreClipboard: (() => Promise<void>) | undefined;
let rememberClipboardVersion = async () => {};
// A headless browser normally owns a virtual clipboard. Preserve all native
// formats as well, and restore only if the test still owns the last write.
// Clipboard data stays in this process; it is never logged or written to disk.
if (process.platform === "darwin") {
  const helper = join(directory, "clipboard-fixture");
  const source = `import AppKit
import Foundation
let board = NSPasteboard.general
let command = CommandLine.arguments[1]
if command == "save" {
  let items = (board.pasteboardItems ?? []).map { item in Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type.rawValue, $0.base64EncodedString()) } }) }
  let data = try JSONSerialization.data(withJSONObject: ["version": board.changeCount, "items": items])
  FileHandle.standardOutput.write(data)
} else if command == "version" { print(board.changeCount) }
else {
  let input = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
  if board.changeCount == input["expected"] as? Int, board.changeCount != input["version"] as? Int, board.string(forType: .string) == "Jamie Chen" {
    let items = (input["items"] as! [[String: String]]).map { values -> NSPasteboardItem in let item = NSPasteboardItem(); for (type, data) in values { item.setData(Data(base64Encoded: data)!, forType: NSPasteboard.PasteboardType(type)) }; return item }
    board.clearContents(); if !items.isEmpty { board.writeObjects(items) }
  }
}`;
  await writeFile(helper + ".swift", source);
  await promisify(execFile)("swiftc", [helper + ".swift", "-o", helper, "-framework", "AppKit"]);
  const backup = JSON.parse((await promisify(execFile)(helper, ["save"], { maxBuffer: 64 * 1024 * 1024 })).stdout);
  let expected = backup.version;
  rememberClipboardVersion = async () => { expected = Number((await promisify(execFile)(helper, ["version"])).stdout.trim()); };
  restoreClipboard = async () => new Promise<void>((resolve, reject) => {
    const child = spawn(helper, ["restore"], { stdio: ["pipe", "ignore", "pipe"] });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Clipboard fixture cleanup failed.")));
    child.stdin.end(JSON.stringify({ ...backup, expected }));
  });
}
let received: ClipboardState | null | undefined;
const controller = new PredictionDashboard(live ? {} : { isConfigured: () => true, debounceMs: 100, intervalMs: 100,
  predict: async (_page, _events, _signal, _desktop, _workflow, clipboard) => {
    received = clipboard;
    return { intent: "Look up the copied person", summary: "Clipboard transfer provides a name for the next search.", repeatableTask: null,
      predictions: [{ action: `Search LinkedIn for ${clipboard?.context?.text || "a person"}`, confidence: .65, evidence: "Recent clipboard text and the search page" }] };
  } });
const dashboard = await startDashboard(controller);
const fixture = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>${request.url === "/linkedin" ? "LinkedIn people search" : "Prospect list"}</title><main><h1>${request.url === "/linkedin" ? "Search people on LinkedIn" : "Prospects"}</h1><p id="name">Jamie Chen</p><input type="search" id="search" aria-label="Search people"><button>Search people</button><textarea id="notes"></textarea><input id="password" type="password" autocomplete="current-password"><input id="payment" autocomplete="cc-number"></main>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
let observer: BrowserObserver | undefined;
async function until(check: () => boolean, timeout = live ? 45000 : 10000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), `Clipboard state: ${controller.state.clipboard.status}; events: ${controller.state.activity.map((event) => event.kind).join(",")}; error: ${controller.state.error || "none"}`);
}
try {
  browser = await localBrowser.launch({ headless: true, userDataDir: join(directory, "profile") });
  await connectAgent(browser);
  const address = fixture.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await browser.context.newPage(); await page.goto(base + "/list");
  const tab = await browser.context.newPage(); await tab.goto(dashboard.url);
  observer = new BrowserObserver(browser.context, dashboard.origin, (event, page) => controller.activity(event, page), (message) => controller.reportError(message),
    (context, page) => controller.observe(context, page), (status) => controller.clipboardStatus(status));
  controller.observer = observer; await observer.start(); await browser.context.setActivePage(page);
  await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector("#name")!); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); });
  await browser.context.clipboard.copy({ page }); await rememberClipboardVersion();
  await until(() => controller.state.activity.some((event) => event.kind === "copy") && controller.state.clipboard.context?.text === "Jamie Chen");
  await page.goto(base + "/linkedin"); await page.locator("#search").click();
  await until(() => controller.state.prediction?.url === base + "/linkedin" && !controller.state.stale && controller.state.clipboard.lastUsedAt !== null);
  assert.match(controller.state.prediction!.predictions[0]!.action, /Jamie Chen/i);
  if (!live) assert.equal(received?.context?.text, "Jamie Chen");
  await browser.context.clipboard.paste({ page });
  await until(() => controller.state.clipboard.context?.operation === "paste" && controller.state.clipboard.context?.target === "search");
  assert.equal(await page.evaluate(() => (document.querySelector("#search") as HTMLInputElement).value), "Jamie Chen");
  await page.evaluate(() => (document.querySelector("#search") as HTMLInputElement).select());
  await browser.context.clipboard.cut({ page }); await rememberClipboardVersion();
  await until(() => controller.state.clipboard.context?.operation === "cut");
  assert.equal(controller.state.clipboard.context?.text, "Jamie Chen");
  assert.equal(await page.evaluate(() => (document.querySelector("#search") as HTMLInputElement).value), "");
  for (const selector of ["#password", "#payment"]) {
    await page.locator(selector).click(); await browser.context.clipboard.paste({ page });
    await until(() => controller.state.clipboard.status === "redacted");
    assert.equal(controller.state.clipboard.context?.text, undefined);
  }
  let reads = 0; const readText = browser.context.clipboard.readText.bind(browser.context.clipboard);
  browser.context.clipboard.readText = async (options) => { reads++; return readText(options); };
  await observer.sampleClipboard({ time: Date.now(), active: true, accessibility: true, focus: "page", addressSelected: false, clipboardVersion: 1 });
  assert.equal(reads, 0, "Native sampling must not bypass a protected page field");
  await page.locator("#search").click();
  await observer.sampleClipboard({ time: Date.now(), active: true, accessibility: true, focus: "page", addressSelected: false, clipboardVersion: 2 });
  assert.equal(reads, 1); assert.equal(controller.state.clipboard.context?.text, "Jamie Chen");
  await observer.sampleClipboard({ time: Date.now(), active: true, accessibility: true, focus: "address-bar", addressSelected: false, clipboardVersion: 2,
    clipboardShortcut: { id: 1, kind: "paste", target: "address-bar" } });
  assert.equal(controller.state.clipboard.context?.operation, "paste"); assert.equal(controller.state.clipboard.context?.target, "address-bar");
  assert.ok(controller.state.activity.every((event) => event.clipboard?.text === undefined));
  assert.doesNotMatch(JSON.stringify(controller.taskMemory.observations.flatMap((frame) => frame.events)), /"text":"Jamie Chen"/);
  await browser.context.setActivePage(tab);
  await tab.waitForFunction(() => document.querySelector("#clipboard-text")?.textContent === "Jamie Chen");
  await tab.evaluate(() => document.querySelector(".clipboard-panel")?.scrollIntoView());
  await writeFile("/tmp/rebrowse-clipboard-desktop.png", await tab.screenshot());
  await tab.setViewportSize(390, 844); assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await tab.evaluate(() => document.querySelector(".clipboard-panel")?.scrollIntoView());
  await writeFile("/tmp/rebrowse-clipboard-mobile.png", await tab.screenshot());
  await tab.locator("#pause").click(); await until(() => controller.state.paused);
  assert.equal(controller.state.clipboard.context, null);
  const count = controller.state.activity.length;
  await browser.context.setActivePage(page); await page.locator("#search").click(); await browser.context.clipboard.paste({ page });
  await new Promise((resolve) => setTimeout(resolve, 150)); assert.equal(controller.state.activity.length, count);
  assert.equal(controller.runner, undefined, "Clipboard signals cannot authorize any workflow execution");
  console.log(`Passed: ${live ? "live SubQ" : "simulated"} copied-name prediction, trusted copy/cut/paste, actual clipboard reading, protected-field checks, native signal routing, dashboard preview, pause, and responsive layout.`);
} finally {
  controller.stop(); await observer?.stop();
  await restoreClipboard?.(); await browser?.close(); await dashboard.close(); fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve())); await rm(directory, { recursive: true, force: true });
}
