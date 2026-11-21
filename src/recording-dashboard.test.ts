import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@browserbasehq/stagehand";
import { PredictionDashboard, startDashboard } from "./dashboard.js";
import { SessionRecorder, parseRecording } from "./recording.js";

test("record controls enforce the session origin, honor pause and save a downloadable replayable demonstration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-record-dashboard-"));
  const recorder = new SessionRecorder(directory);
  const dashboard = new PredictionDashboard({ recorder, isConfigured: () => true, debounceMs: 60000 });
  const server = await startDashboard(dashboard);
  const context = { url: "https://example.com/unit/1", title: "AP Calculus Unit 1 Review", headings: [], actions: [], excerpt: "" };
  const page = { pageId: "unit-1", url: async () => context.url, evaluate: async () => context } as unknown as Page;
  const post = (route: string, body?: object, origin = server.origin) => fetch(server.url + route, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await post("recording-start", {}, "https://other.example")).status, 403);
    assert.equal(recorder.state.status, "idle");
    assert.equal((await post("recording-start", { expected: { expectPattern: true, terms: ["calculus"], byStep: 2 } })).status, 400);
    assert.equal((await post("recording-start")).status, 204);
    assert.match(recorder.state.name, /^Browsing session /);
    assert.equal(recorder.active, true);
    assert.equal((await fetch(server.url + "recording.jsonl")).status, 409);
    dashboard.observe(context, page);
    dashboard.setPaused(true);
    dashboard.activity({ id: 1, time: Date.now(), pageId: page.pageId, kind: "click", label: "IGNORED_WHILE_PAUSED", url: context.url }, page);
    assert.equal((await post("recording-stop")).status, 204);
    const download = await fetch(server.url + "recording.jsonl");
    assert.equal(download.status, 200);
    const contents = await download.text();
    assert.doesNotMatch(contents, /IGNORED_WHILE_PAUSED/);
    const records = parseRecording(contents);
    assert.equal(records.filter((record) => record.type === "observation").length, 1);
    assert.equal(records[0].type === "session" && records[0].expected, null, "User recordings never require or embed a task hint or step target");
    assert.equal(recorder.active, false);
    assert.equal(dashboard.state.recording?.status, "saved");
  } finally { dashboard.stop(); await dashboard.finishRecording(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
