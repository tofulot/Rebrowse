import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBrowser } from "@browserbasehq/stagehand";
import { connectAgent } from "../src/browser.js";
import { BrowserObserver } from "../src/observer.js";
import { buildDesktopHelper, desktopSampleSchema, readNativeClipboardText } from "../src/desktop-context.js";

if (process.platform !== "darwin") throw new Error("The native focus regression check requires macOS.");
const directory = await mkdtemp(join(tmpdir(), "rebrowse-focus-"));
const profile = join(directory, "profile");
const fixture = createServer((_request, response) => response.end("<!doctype html><title>Rebrowse focus regression</title><h1>Passive observation</h1>"));
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
let observer: BrowserObserver | undefined;
try {
  const helper = await buildDesktopHelper();
  browser = await localBrowser.launch({ headless: false, userDataDir: profile });
  await connectAgent(browser);
  const address = fixture.address(); assert(address && typeof address !== "string");
  const page = await browser.context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
  const pid = (await readlink(join(profile, "SingletonLock"))).match(/-(\d+)$/)?.[1]; assert(pid);
  const sample = async () => desktopSampleSchema.parse(JSON.parse((await promisify(execFile)(helper, ["--pid", pid, "--once", "--clipboard-context"], { timeout: 5000 })).stdout));
  if (!(await sample()).accessibility) {
    console.log("Skipped native focus check: Accessibility is unavailable. No permission prompt or keyboard event was sent.");
  } else {
    // Target only this throwaway browser process. Focus its address control
    // directly through Accessibility, without global keyboard events.
    const focusHelper = join(directory, "select-address");
    await writeFile(focusHelper + ".swift", `import AppKit
import ApplicationServices
let pid = Int32(CommandLine.arguments[1])!
guard let app = NSRunningApplication(processIdentifier: pid), app.activate(options: [.activateIgnoringOtherApps]) else { exit(1) }
RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { exit(2) }
func attribute(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
  var result: CFTypeRef?; guard AXUIElementCopyAttributeValue(node, key as CFString, &result) == .success else { return nil }; return result
}
func findAddress(_ node: AXUIElement, _ depth: Int = 0) -> AXUIElement? {
  if depth > 16 { return nil }
  let role = attribute(node, kAXRoleAttribute) as? String ?? ""
  if role == "AXWebArea" { return nil }
  let description = (attribute(node, kAXDescriptionAttribute) as? String ?? "").lowercased()
  let identifier = (attribute(node, "AXIdentifier") as? String ?? "").lowercased()
  if (role == "AXTextField" || role == "AXComboBox") && (description.contains("address and search") || identifier.contains("omnibox")) { return node }
  for child in (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(100) { if let found = findAddress(child, depth + 1) { return found } }
  return nil
}
let root = AXUIElementCreateApplication(pid)
guard let field = findAddress(root), let value = attribute(field, kAXValueAttribute) as? String, value.contains(CommandLine.arguments[2]) else { exit(3) }
guard AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { exit(4) }
var selection = CFRange(location: 0, length: value.utf16.count)
guard let range = AXValueCreate(.cfRange, &selection), AXUIElementSetAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, range) == .success else { exit(5) }
`);
    await promisify(execFile)("swiftc", [focusHelper + ".swift", "-o", focusHelper, "-framework", "AppKit", "-framework", "ApplicationServices"]);
    observer = new BrowserObserver(browser.context, "http://dashboard.invalid", () => {}, () => {});
    observer.lastPage = page;
    await observer.start();
    for (let selection = 0; selection < 2; selection++) {
      await promisify(execFile)(focusHelper, [pid, `127.0.0.1:${address.port}`]);
      let selected = await sample();
      const deadline = Date.now() + 3000;
      while ((!selected.active || selected.focus !== "address-bar" || !selected.addressSelected) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100)); selected = await sample();
      }
      assert.equal(selected.focus, "address-bar"); assert.equal(selected.addressSelected, true);
      for (let read = 0; read < 4; read++) {
        await observer.sampleClipboard(selected);
        await readNativeClipboardText(selected); // Discard text; never print or send it to a model.
        selected = await sample();
        assert.equal(selected.active, true);
        assert.equal(selected.focus, "address-bar", "Passive clipboard/context observation must not focus the web page");
        assert.equal(selected.addressSelected, true, "The address selection must remain intact across repeated reads");
      }
      assert.equal(await page.evaluate(() => document.hasFocus()), false);
    }
    console.log("Passed: native address-bar selection survives repeated passive clipboard reads and the running page observer; no clipboard writes or model calls.");
  }
} finally {
  await observer?.stop(); await browser?.close(); fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve())); await rm(directory, { recursive: true, force: true });
}
