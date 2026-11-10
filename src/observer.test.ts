import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Page } from "@browserbasehq/stagehand";
import { BrowserObserver, type Activity } from "./observer.js";

test("address-bar activity from the dashboard uses the last browsing tab without reading dashboard DOM", async () => {
  const page = { pageId: "content", url: async () => "https://example.com/products" } as unknown as Page;
  const dashboard = { pageId: "dashboard", url: async () => "http://127.0.0.1:4000/session/test/" } as unknown as Page;
  const context = { activePage: async () => dashboard } as unknown as BrowserContext;
  const events: Activity[] = [];
  const observer = new BrowserObserver(context, "http://127.0.0.1:4000", (event) => events.push(event), () => {});
  observer.lastPage = page;
  await observer.external("address-select", "Address bar selected");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "address-select");
  assert.equal(events[0]!.pageId, "content");
  assert.match(events[0]!.label, /dashboard tab/);
  await observer.external("address-edit", "Address-bar text updated", "wasd");
  assert.equal(events[1]!.addressText, "wasd");
  await observer.external("pointer-dwell", "Pointer over dashboard toolbar");
  assert.equal(events.length, 2, "Ordinary dashboard interaction stays excluded");
  observer.suppress(true);
  await observer.external("address-focus", "Address bar focused");
  assert.equal(events.length, 2, "Pause must still suppress browser-control events");
});

test("browser controls follow the active window, not the last page that had DOM focus", async () => {
  const previous = { pageId: "old-window", url: async () => "https://example.com/old" } as unknown as Page;
  const current = { pageId: "focused-window", url: async () => "https://example.com/current" } as unknown as Page;
  const dashboard = { pageId: "dashboard-window", url: async () => "http://127.0.0.1:4000/session/test/" } as unknown as Page;
  let active = current;
  const context = { activePage: async () => active } as unknown as BrowserContext;
  const events: Activity[] = [];
  const observer = new BrowserObserver(context, "http://127.0.0.1:4000", (event) => events.push(event), () => {});
  observer.lastPage = previous;
  await observer.external("address-focus", "Address bar focused");
  assert.equal(events[0]!.pageId, "focused-window");
  assert.equal(observer.lastPage?.pageId, "focused-window");
  active = dashboard;
  await observer.external("address-select", "Address bar selected");
  assert.equal(events[1]!.pageId, "focused-window");
  assert.match(events[1]!.label, /dashboard tab/);
});
