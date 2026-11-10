import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import type { BrowserContext, Page } from "@browserbasehq/stagehand";
import { BrowserObserver, type Activity } from "./observer.js";
import { sanitizeClipboard, freshClipboard, clipboardMetadata, CLIPBOARD_LIMIT, type ClipboardData } from "./clipboard-context.js";
import { TaskMemory } from "./tasks.js";
import type { DesktopSample } from "./desktop-context.js";

const text = (value: string): ClipboardData => ({ text: value, source: "page", target: "page", format: "text", truncated: false });
test("clipboard text is bounded, known credentials are excluded and stale context cannot reach predictions", () => {
  const bounded = sanitizeClipboard(text("x".repeat(CLIPBOARD_LIMIT + 1)));
  assert.equal(bounded.text?.length, CLIPBOARD_LIMIT); assert.equal(bounded.truncated, true);
  for (const value of ["sk-proj-abcdefghijklmnopqrstuvwxyz1234", "password=private-value", "Bearer a-token-with-at-least-16-chars", "-----BEGIN PRIVATE KEY-----\nprivate"]) {
    const sanitized = sanitizeClipboard(text(value)); assert.equal(sanitized.text, undefined); assert.equal(sanitized.redacted, true);
  }
  assert.equal(sanitizeClipboard(text("Jamie Chen")).text, "Jamie Chen");
  const state = { status: "ready" as const, context: { ...text("Jamie Chen"), time: 1000, operation: "copy" as const, pageId: "p", url: "https://example.com" }, lastUsedAt: null };
  assert.ok(freshClipboard(state, 2000)); assert.equal(freshClipboard(state, 122000), null);
  assert.equal(freshClipboard({ ...state, status: "paused" }, 2000), null);
  assert.equal(Object.hasOwn(clipboardMetadata(text("secret")), "text"), false);
});

const collector = await readFile(new URL("./collector.js", import.meta.url), "utf8");
function collectorHarness() {
  const handlers = new Map<string, (event: object) => void>(); const events: Array<{ kind: string; clipboard: ClipboardData }> = [];
  class Element {
    constructor(public type = "page", public value = "", public protectedField = false) {}
    selectionStart: number | null = 0; selectionEnd: number | null = 0;
    matches(selector: string) { return selector === 'input[type="search"]' ? this.type === "search" : /input,textarea,select/.test(selector) && ["input", "search"].includes(this.type); }
    closest(selector: string) { return /password|data-private/.test(selector) ? this.protectedField ? this : null : null; }
    getAttribute() { return ""; }
  }
  class Input extends Element {}
  class Textarea extends Element {}
  const window = { top: undefined as unknown, __rebrowseSuppressed: false, getSelection: () => ({ isCollapsed: false, rangeCount: 1, anchorNode: { parentElement: new Element() }, getRangeAt: () => ({ intersectsNode: () => false }), toString: () => "Selected name" }), addEventListener() {} };
  window.top = window;
  const document = { visibilityState: "visible", activeElement: new Element(), addEventListener: (kind: string, handler: (event: object) => void) => handlers.set(kind, handler), querySelectorAll: () => [] };
  vm.runInNewContext(`(${collector})({marker:'MARK',dashboardOrigin:'http://dashboard',clipboardEnabled:true})`, {
    window, document, location: { origin: "https://example.com", protocol: "https:", href: "https://example.com?private=1" },
    Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, URL, scrollY: 0, innerHeight: 800, setTimeout, clearTimeout,
    console: { debug(value: string) { events.push(JSON.parse(value.slice(4))); } },
  });
  const emit = (kind: string, target = new Element(), isTrusted = true, clipboardData?: unknown) => handlers.get(kind)!({ isTrusted, target, clipboardData });
  return { events, emit, Element, Input, document, window };
}
test("trusted copy/cut/paste captures explicit transfer text, including a selected portion of a safe field", () => {
  const f = collectorHarness();
  f.emit("copy"); assert.equal(f.events[0]?.clipboard.text, "Selected name");
  const input = new f.Input("input", "first Jamie Chen last"); input.selectionStart = 6; input.selectionEnd = 16;
  f.emit("cut", input); assert.equal(f.events[1]?.clipboard.text, "Jamie Chen");
  f.emit("paste", new f.Element("search"), true, { types: ["text/plain"], getData: () => "Pasted search" });
  assert.equal(f.events[2]?.clipboard.text, "Pasted search"); assert.equal(f.events[2]?.clipboard.target, "search");
});
test("protected fields exclude data before reading it; synthetic, hidden, paused and non-text events cannot leak text", () => {
  const f = collectorHarness(); const clipboardData = { types: ["text/plain"], getData: () => { throw new Error("Protected data must never be read"); } };
  f.emit("paste", new f.Input("input", "password", true), true, clipboardData);
  assert.equal(f.events[0]?.clipboard.redacted, true); assert.equal(f.events[0]?.clipboard.text, undefined);
  f.emit("paste", new f.Element(), false, clipboardData);
  f.document.visibilityState = "hidden"; f.emit("copy"); f.document.visibilityState = "visible";
  f.window.__rebrowseSuppressed = true; f.emit("copy"); f.window.__rebrowseSuppressed = false;
  assert.equal(f.events.length, 1);
  f.emit("paste", new f.Element(), true, { types: ["Files"], getData: clipboardData.getData });
  assert.equal(f.events[1]?.clipboard.format, "non-text"); assert.equal(f.events[1]?.clipboard.text, undefined);
});

function nativeHarness() {
  let allowed = true; let active = true; let reads = 0; let value = "Jamie Chen";
  let read: () => Promise<string> = async () => value;
  const page = { pageId: "page", url: async () => "https://example.com", evaluate: async () => allowed } as unknown as Page;
  const dashboard = { pageId: "dashboard", url: async () => "http://dashboard/session" } as unknown as Page;
  const events: Activity[] = []; const statuses: string[] = [];
  const context = { activePage: async () => active ? page : dashboard, pages: async () => [], clipboard: { readText: async () => { reads++; return read(); } } } as unknown as BrowserContext;
  const observer = new BrowserObserver(context, "http://dashboard", (event) => events.push(event), () => {}, undefined, (status) => statuses.push(status));
  const sample = (version = 1, overrides: Partial<DesktopSample> = {}): DesktopSample => ({ time: Date.now(), active: true, accessibility: true, focus: "page", addressSelected: false, clipboardVersion: version, ...overrides });
  return { observer, events, statuses, sample, reads: () => reads, setAllowed: (next: boolean) => { allowed = next; }, setActive: (next: boolean) => { active = next; }, setValue: (next: string) => { value = next; }, setRead: (next: () => Promise<string>) => { read = next; }, page };
}
test("native clipboard reads are foreground-only, deduplicated and distinguish availability from observed paste", async () => {
  const f = nativeHarness();
  await f.observer.sampleClipboard(f.sample(1, { active: false })); assert.equal(f.reads(), 0);
  await f.observer.sampleClipboard(f.sample()); assert.equal(f.events[0]?.kind, "clipboard-available"); assert.equal(f.events[0]?.clipboard?.text, "Jamie Chen");
  await f.observer.sampleClipboard(f.sample()); assert.equal(f.reads(), 1);
  f.setValue("Taylor Reed"); await f.observer.sampleClipboard(f.sample(2)); assert.equal(f.events[1]?.kind, "clipboard-change");
  await f.observer.sampleClipboard(f.sample(2, { focus: "address-bar", clipboardShortcut: { id: 1, kind: "paste", target: "address-bar" } }));
  assert.equal(f.events[2]?.kind, "paste"); assert.equal(f.events[2]?.clipboard?.target, "address-bar");
  await f.observer.stop();
});
test("native reads exclude protected fields, dashboard page activity and stale samples", async () => {
  const f = nativeHarness(); f.setAllowed(false);
  await f.observer.sampleClipboard(f.sample()); assert.equal(f.reads(), 0); assert.equal(f.statuses.at(-1), "redacted");
  f.setAllowed(true); f.setActive(false); await f.observer.sampleClipboard(f.sample(2)); assert.equal(f.reads(), 0);
  f.setActive(true); await f.observer.sampleClipboard(f.sample(2, { time: Date.now() - 10000 })); assert.equal(f.reads(), 0);
  await f.observer.stop();
});
test("pausing or losing foreground while clipboard reading is in flight discards the result", async () => {
  for (const pause of [true, false]) {
    const f = nativeHarness(); let release: ((value: string) => void) | undefined;
    f.setRead(async () => new Promise((resolve) => { release = resolve; }));
    const pending = f.observer.sampleClipboard(f.sample());
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    if (pause) f.observer.suppress(true); else await f.observer.sampleClipboard(f.sample(1, { active: false }));
    release!("Must not leak"); await pending; assert.equal(f.events.length, 0); await f.observer.stop();
  }
});
test("the safety gate is checked again after a clipboard read and unsupported readers do not stop observation", async () => {
  const f = nativeHarness(); f.setRead(async () => { f.setAllowed(false); return "secret"; });
  await f.observer.sampleClipboard(f.sample()); assert.equal(f.events.length, 0); assert.equal(f.statuses.at(-1), "redacted");
  f.setAllowed(true); f.setRead(async () => { throw new Error("read denied"); });
  await f.observer.sampleClipboard(f.sample(2)); assert.equal(f.statuses.at(-1), "unavailable"); await f.observer.stop();
});
test("workflow observation memory retains clipboard metadata without raw transfer text", () => {
  const memory = new TaskMemory();
  memory.observe({ url: "https://example.com", title: "List", headings: [], actions: [], excerpt: "" }, "page", [{ id: 1, pageId: "page", time: Date.now(), kind: "copy", label: "Copied", url: "https://example.com", clipboard: text("Raw transfer to exclude") }]);
  assert.doesNotMatch(JSON.stringify(memory.observations), /Raw transfer to exclude/);
  assert.equal(memory.observations[0]?.events[0]?.clipboard?.source, "page");
});
