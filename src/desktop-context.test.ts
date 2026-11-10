import test from "node:test";
import assert from "node:assert/strict";
import { DesktopSignals, type DesktopSample } from "./desktop-context.js";

const sample = (overrides: Partial<DesktopSample> = {}): DesktopSample => ({
  time: 1000, active: true, accessibility: true, focus: "page", addressSelected: false,
  pointer: { x: 100, y: 200, space: "browser-window", region: "page", width: 1200, height: 800 }, ...overrides,
});

test("address selection is a strong distinct signal, emitted once per transition", () => {
  const signals = new DesktopSignals();
  assert.deepEqual(signals.consume(sample()), []);
  assert.equal(signals.consume(sample({ focus: "address-bar", addressSelected: true }))[0]?.kind, "address-select");
  assert.deepEqual(signals.consume(sample({ focus: "address-bar", addressSelected: true })), []);
  assert.equal(signals.consume(sample())[0]?.kind, "browser-focus");
});

test("focus without selection is not reported as selected text", () => {
  const signals = new DesktopSignals();
  assert.equal(signals.consume(sample({ focus: "address-bar" }))[0]?.kind, "address-focus");
});

test("continuous pointer samples do not flood prediction; toolbar dwell emits once", () => {
  const signals = new DesktopSignals();
  const pointer = { x: 100, y: 50, space: "browser-window" as const, region: "address-bar" as const, width: 1200, height: 800 };
  assert.deepEqual(signals.consume(sample({ pointer })), []);
  assert.deepEqual(signals.consume(sample({ time: 1500, pointer })), []);
  assert.equal(signals.consume(sample({ time: 1900, pointer }))[0]?.kind, "pointer-dwell");
  assert.deepEqual(signals.consume(sample({ time: 2500, pointer })), []);
});

test("other applications generate no activity; resetting clears signal history", () => {
  const signals = new DesktopSignals();
  assert.deepEqual(signals.consume(sample({ active: false, focus: "address-bar", addressSelected: true })), []);
  assert.equal(signals.consume(sample({ focus: "address-bar", addressSelected: true }))[0]?.kind, "address-select");
  signals.reset();
  assert.equal(signals.consume(sample({ focus: "address-bar", addressSelected: true }))[0]?.kind, "address-select");
});

test("address edits are debounced and carry exact text without reporting initial URL selection as typing", () => {
  const signals = new DesktopSignals();
  const focused = { focus: "address-bar" as const, addressSelected: true, addressText: "https://example.com" };
  assert.deepEqual(signals.consume(sample(focused)).map((event) => event.kind), ["address-select"]);
  assert.deepEqual(signals.consume(sample({ ...focused, addressSelected: false, addressText: "w", time: 1150 })), []);
  assert.deepEqual(signals.consume(sample({ ...focused, addressSelected: false, addressText: "wasd", time: 1300 })), []);
  assert.deepEqual(signals.consume(sample({ ...focused, addressSelected: false, addressText: "wasd", time: 1600 })), []);
  const events = signals.consume(sample({ ...focused, addressSelected: false, addressText: "wasd", time: 1800 }));
  assert.equal(events[0]?.kind, "address-edit");
  assert.equal(events[0]?.addressText, "wasd");
  assert.deepEqual(signals.consume(sample({ ...focused, addressSelected: false, addressText: "wasd", time: 2400 })), []);
});

test("page inputs and inactive applications cannot emit address text", () => {
  const signals = new DesktopSignals();
  assert.deepEqual(signals.consume(sample({ addressText: "not an address input" })), []);
  assert.deepEqual(signals.consume(sample({ addressText: "different field value", time: 2000 })), []);
  assert.deepEqual(signals.consume(sample({ active: false, focus: "address-bar", addressText: "ignored" })), []);
});

test("clearing the address bar emits an empty value and pending edits stop on blur", () => {
  const signals = new DesktopSignals();
  signals.consume(sample({ focus: "address-bar", addressText: "wasd" }));
  signals.consume(sample({ focus: "address-bar", addressText: "", time: 1200 }));
  assert.equal(signals.consume(sample({ focus: "address-bar", addressText: "", time: 1800 }))[0]?.addressText, "");
  signals.consume(sample({ focus: "address-bar", addressText: "a", time: 2000 }));
  signals.consume(sample({ focus: "page", time: 2100 }));
  assert.deepEqual(signals.consume(sample({ focus: "page", time: 3000 })), []);
});
