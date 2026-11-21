import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRecording, SessionRecorder } from "./recording.js";
import type { Observation } from "./tasks.js";

const frame = (unit: number): Observation => ({ id: unit, time: Date.now(), pageId: `unit-${unit}`, actor: "user", context: {
  url: "https://www.youtube.com/watch?token=private-url", publicUrl: `https://www.youtube.com/watch?v=real${unit}&token=private-url`, title: `AP Calculus Unit ${unit} Review`,
  headings: [], actions: [], excerpt: "" }, events: [] });
test("recording saves a private state/action timeline, strips transfer/input text, and preserves native signals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-record-test-"));
  const recorder = new SessionRecorder(directory);
  try {
    await recorder.start({ name: "Unit review demonstration" }, [frame(1)], 1);
    const f = frame(2);
    recorder.activity({ id: 1, time: Date.now(), pageId: f.pageId, url: f.context.url, kind: "paste", label: "Pasted text", addressText: "TYPED_QUERY_TO_EXCLUDE",
      clipboard: { text: "RAW_CLIPBOARD_TO_EXCLUDE", format: "text", source: "page", target: "search", truncated: false } });
    recorder.desktop({ status: "ready", message: "Native metadata", path: [], pageId: f.pageId, sample: { time: Date.now(), active: true, accessibility: true,
      focus: "address-bar", addressSelected: true, addressText: "TYPED_QUERY_TO_EXCLUDE", browserPid: 555, clipboardVersion: 22,
      pointer: { x: 100, y: 50, space: "browser-window", region: "address-bar" } } });
    recorder.observation(f);
    recorder.observation(f);
    await recorder.stop();
    const contents = await recorder.download();
    assert.doesNotMatch(contents, /RAW_CLIPBOARD|TYPED_QUERY|private-url|browserPid|clipboardVersion|addressText/);
    const records = parseRecording(contents);
    assert.ok(records.some((record) => record.type === "desktop" && record.sample.pointer?.x === 100));
    assert.ok(records.some((record) => record.type === "activity" && record.event.clipboard?.target === "search"));
    assert.equal(recorder.state.steps, 1); assert.equal(recorder.state.baselineCount, 1);
    assert.equal(recorder.state.frames, 1); assert.equal(recorder.state.actions, 1); assert.equal(recorder.state.status, "saved");
    assert.equal((await stat(join(directory, recorder.state.file!))).mode & 0o777, 0o600);
    recorder.observation(frame(3));
    assert.equal(await recorder.download(), contents, "Stopped recordings cannot keep collecting");
    await recorder.start({ name: "Fresh" }); assert.equal(recorder.state.steps, 0); assert.equal(recorder.state.actions, 0);
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("agent output and repeated unchanged states cannot manufacture demonstration steps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-record-actor-")); const recorder = new SessionRecorder(directory);
  try {
    await recorder.start({});
    recorder.observation({ ...frame(1), actor: "workflow" });
    assert.equal(recorder.state.steps, 0);
    recorder.observation(frame(2)); recorder.observation(frame(2));
    assert.equal(recorder.state.steps, 1);
    recorder.activity({ id: 2, time: Date.now(), pageId: "unit-2", kind: "hover", label: "Review", url: "https://www.youtube.com/watch" });
    recorder.observation(frame(2)); assert.equal(recorder.state.steps, 1);
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("malformed recordings fail with a line number and never echo recorded content", () => {
  assert.throws(() => parseRecording('{"secret":"PRIVATE_CONTENT"}\n'), /Invalid recording at line 1/);
  assert.throws(() => parseRecording(""), /empty/);
});

test("a source click and its background-opened review share one replay step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-record-background-")); const recorder = new SessionRecorder(directory);
  const source = { ...frame(10), pageId: "source", context: { ...frame(10).context, url: "https://example.com/library", publicUrl: "https://example.com/library", title: "Review library" } };
  try {
    await recorder.start({}, [source]);
    for (const unit of [1, 2]) {
      recorder.activity({ id: unit, time: Date.now(), pageId: source.pageId, kind: "click", label: `Unit ${unit} review`, url: source.context.url });
      recorder.observation(source, source.pageId);
      recorder.observation(frame(unit), source.pageId);
      assert.equal(recorder.state.steps, unit, "The click and arriving resource cannot be counted twice");
    }
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent recording starts cannot mix session files or replace the active recording", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-record-concurrent-")); const recorder = new SessionRecorder(directory);
  try {
    const results = await Promise.allSettled([recorder.start({ name: "First" }), recorder.start({ name: "Second" })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    await recorder.stop();
    const header = parseRecording(await recorder.download())[0];
    assert.equal(header.type === "session" && header.id, recorder.state.id);
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("automatically counted steps do not double-count navigation notifications arriving after page state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-late-navigation-")); const recorder = new SessionRecorder(directory);
  try {
    await recorder.start({});
    for (const unit of [1, 2]) {
      const current = { ...frame(unit), pageId: "browsing" };
      recorder.observation(current);
      recorder.activity({ id: unit, time: Date.now(), pageId: current.pageId, url: current.context.url, kind: "navigate", label: "Opened a page" });
      recorder.observation(current);
      assert.equal(recorder.state.steps, unit);
    }
    assert.equal(recorder.state.actions, 2);
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});
