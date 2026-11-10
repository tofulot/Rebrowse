import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "@browserbasehq/stagehand";
import { PredictionDashboard } from "./dashboard.js";
import { cleanUrl, type Activity } from "./observer.js";
import type { Prediction } from "./predictor.js";
import { CLIPBOARD_TTL_MS } from "./clipboard-context.js";

const page = { pageId: "test", url: async () => "https://example.com/products", evaluate: async () => ({ title: "Products", url: "https://example.com/products", headings: [], actions: [], excerpt: "" }) } as unknown as Page;
const event = (id: number): Activity => ({ id, pageId: "test", time: Date.now(), kind: "click", label: "Product details", url: "https://example.com/products" });
const prediction = (intent: string): Prediction => ({ intent, summary: "Based on a click", predictions: [{ action: "Read details", confidence: 0.6, evidence: "Clicked a product" }], repeatableTask: null });
async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "Condition should become true");
}

test("late predictions cannot overwrite newer activity", async () => {
  const complete: Array<(value: Prediction) => void> = [];
  const dashboard = new PredictionDashboard({
    isConfigured: () => true, debounceMs: 0, intervalMs: 0,
    predict: async () => new Promise((resolve) => complete.push(resolve)),
  });
  try {
    dashboard.activity(event(1), page);
    await waitUntil(() => complete.length === 1);
    dashboard.activity(event(2), page);
    complete[0]!(prediction("Old"));
    await waitUntil(() => complete.length === 2);
    assert.equal(dashboard.state.prediction, null);
    complete[1]!(prediction("New"));
    await waitUntil(() => dashboard.state.status === "ready");
    assert.equal((dashboard.state.prediction as Prediction | null)?.intent, "New");
  } finally { dashboard.stop(); }
});

test("pause aborts in-flight inference and ignores further activity", async () => {
  let signal: AbortSignal | undefined;
  let finish: ((value: Prediction) => void) | undefined;
  const dashboard = new PredictionDashboard({
    isConfigured: () => true, debounceMs: 0, intervalMs: 0,
    predict: async (_context, _events, abort) => {
      signal = abort;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  try {
    dashboard.activity(event(1), page);
    await waitUntil(() => !!finish);
    dashboard.setPaused(true);
    dashboard.activity(event(2), page);
    assert.equal(signal?.aborted, true);
    assert.equal(dashboard.state.activity.length, 1);
    finish!(prediction("Late"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(dashboard.state.status, "paused");
    assert.equal(dashboard.state.prediction, null);
  } finally { dashboard.stop(); }
});

test("missing key shows an actionable dashboard state without calling inference", async () => {
  const dashboard = new PredictionDashboard({ isConfigured: () => false, debounceMs: 0, predict: async () => { throw new Error("Must not call"); } });
  try {
    dashboard.activity(event(1), page);
    await waitUntil(() => dashboard.state.status === "needs-key");
    assert.match(dashboard.state.error || "", /SUBQ_API_KEY/);
    assert.equal(dashboard.state.requests, 0);
  } finally { dashboard.stop(); }
});

test("URL context removes credentials, queries, and fragments", () => {
  assert.equal(cleanUrl("https://user:secret@example.com/path?token=secret#private"), "https://example.com/path");
});

test("address-bar signals cancel a page prediction and bypass the regular cooldown", async () => {
  let initialSignal: AbortSignal | undefined;
  let calls = 0;
  const dashboard = new PredictionDashboard({
    isConfigured: () => true, debounceMs: 0, intervalMs: 60000,
    predict: async (_context, _events, signal) => {
      calls++;
      if (calls === 1) {
        initialSignal = signal;
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      return prediction("Start a new search");
    },
  });
  try {
    dashboard.activity(event(1), page);
    await waitUntil(() => !!initialSignal);
    dashboard.activity({ ...event(2), kind: "address-select", label: "Address bar selected" }, page);
    await waitUntil(() => dashboard.state.status === "ready");
    assert.equal(initialSignal?.aborted, true);
    assert.equal(calls, 2);
    assert.equal(dashboard.state.prediction?.intent, "Start a new search");
  } finally { dashboard.stop(); }
});

test("changing address text invalidates an in-flight prediction immediately", async () => {
  let finish: ((value: Prediction) => void) | undefined;
  let signal: AbortSignal | undefined;
  const dashboard = new PredictionDashboard({
    isConfigured: () => true, debounceMs: 0, intervalMs: 0,
    predict: async (_context, _events, abort) => {
      signal = abort;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  try {
    dashboard.activity(event(1), page);
    await waitUntil(() => !!finish);
    dashboard.desktop({ status: "ready", message: "", path: [], addressInput: { text: "wasd", time: Date.now() },
      sample: { time: Date.now(), accessibility: true, active: true, focus: "address-bar", addressSelected: false, addressText: "wasd" } });
    assert.equal(signal?.aborted, true);
    finish!(prediction("Old query"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(dashboard.state.prediction, null);
  } finally { dashboard.stop(); }
});

test("live page updates add memory without starving an in-flight prediction", async () => {
  let finish: ((value: Prediction) => void) | undefined;
  let signal: AbortSignal | undefined;
  const dashboard = new PredictionDashboard({
    isConfigured: () => true, debounceMs: 0, intervalMs: 60000,
    predict: async (_context, _events, abort) => {
      signal = abort;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  try {
    dashboard.activity(event(1), page);
    await waitUntil(() => !!finish);
    dashboard.observe({ title: "Products", url: "https://example.com/products", headings: [], actions: [], excerpt: "Outcome updated" }, page);
    assert.equal(signal?.aborted, false);
    finish!(prediction("Available result"));
    await waitUntil(() => dashboard.state.status === "ready");
    assert.equal(dashboard.state.prediction?.intent, "Available result");
    assert.equal(dashboard.state.stale, true, "Newer DOM evidence should mark the result for refresh");
    assert.ok(dashboard.state.observationCount >= 2);
  } finally { dashboard.stop(); }
});

test("copy text reaches the next prediction across pages without entering raw event history", async () => {
  let received: string | undefined;
  const dashboard = new PredictionDashboard({ isConfigured: () => true, debounceMs: 0, intervalMs: 0,
    predict: async (_context, _events, _signal, _desktop, workflow, clipboard) => {
      received = clipboard?.context?.text;
      assert.doesNotMatch(JSON.stringify(workflow?.recentActivity), /Jamie Chen/);
      return prediction("Search for the copied person");
    } });
  try {
    dashboard.activity({ ...event(1), kind: "copy", label: "Copied text", clipboard: { text: "Jamie Chen", format: "text", truncated: false, source: "page", target: "page" } }, page);
    assert.equal(dashboard.state.clipboard.context?.text, "Jamie Chen");
    assert.equal(dashboard.state.activity[0]?.clipboard?.text, undefined);
    await waitUntil(() => dashboard.state.status === "ready");
    assert.equal(received, "Jamie Chen"); assert.ok(dashboard.state.clipboard.lastUsedAt);
    dashboard.setPaused(true);
    assert.equal(dashboard.state.clipboard.context, null); assert.equal(dashboard.state.clipboard.lastUsedAt, null);
  } finally { dashboard.stop(); }
});

test("a newer paste cancels an older copy prediction and protected fields clear clipboard text", async () => {
  let aborted: AbortSignal | undefined;
  let calls = 0;
  const dashboard = new PredictionDashboard({ isConfigured: () => true, debounceMs: 0, intervalMs: 0,
    predict: async (_context, _events, signal) => {
      if (++calls === 1) { aborted = signal; return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); }
      return prediction("Submit the pasted search");
    } });
  const transfer = { format: "text" as const, truncated: false, source: "page" as const, target: "search" as const };
  try {
    dashboard.activity({ ...event(1), kind: "copy", clipboard: { ...transfer, text: "Old name" } }, page);
    await waitUntil(() => !!aborted);
    dashboard.activity({ ...event(2), kind: "paste", clipboard: { ...transfer, text: "New name" } }, page);
    assert.equal(aborted?.aborted, true);
    await waitUntil(() => dashboard.state.status === "ready");
    assert.equal(dashboard.state.clipboard.context?.text, "New name");
    dashboard.clipboardStatus("redacted"); assert.equal(dashboard.state.clipboard.context, null);
  } finally { dashboard.stop(); }
});

test("expired and redacted clipboard text is never provided for prediction", async () => {
  let calls = 0;
  const dashboard = new PredictionDashboard({ isConfigured: () => true, debounceMs: 0, intervalMs: 0,
    predict: async (_context, _events, _signal, _desktop, _workflow, clipboard) => { calls++; assert.equal(clipboard, null); return prediction("Unknown clipboard"); } });
  try {
    dashboard.activity({ ...event(1), time: Date.now() - CLIPBOARD_TTL_MS - 10, kind: "copy", clipboard: { text: "Expired text", format: "text", truncated: false, source: "page", target: "page" } }, page);
    await waitUntil(() => calls === 1);
    dashboard.activity({ ...event(2), kind: "paste", clipboard: { text: "password=fixture-private", format: "text", truncated: false, source: "page", target: "field" } }, page);
    await waitUntil(() => calls === 2);
    assert.equal(dashboard.state.clipboard.status, "redacted"); assert.equal(dashboard.state.clipboard.context?.text, undefined);
  } finally { dashboard.stop(); }
});
