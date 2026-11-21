import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readlink, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { z } from "zod";
import { clipboardEnabled } from "./clipboard-context.js";

const pointerSchema = z.object({
  x: z.number(), y: z.number(), space: z.enum(["screen", "browser-window"]),
  region: z.enum(["unknown", "page", "address-bar", "toolbar", "browser-controls", "outside-window"]),
  width: z.number().optional(), height: z.number().optional(),
});
export const desktopSampleSchema = z.object({
  time: z.number(), active: z.boolean(), accessibility: z.boolean(),
  focus: z.enum(["unknown", "page", "address-bar", "toolbar", "browser-controls"]),
  addressSelected: z.boolean(), pointer: pointerSchema.optional(),
  focusAvailable: z.boolean().optional(), otherBrowserActive: z.boolean().optional(),
  addressText: z.string().max(2048).optional(),
  clipboardVersion: z.number().int().optional(),
  browserPid: z.number().int().positive().optional(),
  clipboardShortcut: z.object({ id: z.number().int().positive(), kind: z.enum(["copy", "cut", "paste"]), target: z.enum(["address-bar", "browser-controls"]) }).optional(),
});
export type DesktopSample = z.infer<typeof desktopSampleSchema>;
export type DesktopState = {
  status: "starting" | "ready" | "permission-needed" | "focus-unavailable" | "inactive" | "disabled" | "unsupported" | "error";
  message: string;
  sample: DesktopSample | null;
  path: Array<{ x: number; y: number; time: number }>;
  pageId?: string | null;
  addressInput?: { text: string; time: number } | null;
};

/** Only transitions and dwell signals trigger prediction; raw movement does not. */
export class DesktopSignals {
  private previous?: DesktopSample;
  private anchor?: { x: number; y: number; time: number; region: string };
  private dwelled = false;
  private edit?: { text: string; time: number; emitted: boolean };
  consume(sample: DesktopSample): Array<{ kind: string; label: string; addressText?: string }> {
    const events: Array<{ kind: string; label: string; addressText?: string }> = [];
    if (!sample.active) { this.reset(); return events; }
    if (sample.focus === "address-bar" && sample.addressText !== undefined) {
      if (this.previous?.focus === "address-bar" && this.previous.addressText !== undefined && sample.addressText !== this.previous.addressText) {
        this.edit = { text: sample.addressText, time: sample.time, emitted: false };
      }
      if (this.edit && !this.edit.emitted && sample.time - this.edit.time >= 450) {
        events.push({ kind: "address-edit", label: "Address-bar text updated", addressText: this.edit.text });
        this.edit.emitted = true;
      }
    } else this.edit = undefined;
    if (sample.focus === "address-bar" && sample.addressSelected && (!this.previous?.addressSelected || this.previous.focus !== "address-bar")) {
      events.push({ kind: "address-select", label: "Address bar text selected · may replace URL or start a search" });
    } else if (sample.focus === "address-bar" && this.previous?.focus !== "address-bar") {
      events.push({ kind: "address-focus", label: "Address bar focused · navigation or search possible" });
    } else if (sample.focus !== "address-bar" && sample.focus !== "unknown" && this.previous?.focus === "address-bar") {
      events.push({ kind: "browser-focus", label: sample.focus === "page" ? "Returned from the address bar to the page" : "Left the address bar for another browser control" });
    }
    const pointer = sample.pointer;
    if (pointer) {
      if (!this.anchor || this.anchor.region !== pointer.region || Math.hypot(pointer.x - this.anchor.x, pointer.y - this.anchor.y) > 16) {
        this.anchor = { ...pointer, time: sample.time }; this.dwelled = false;
      } else if (!this.dwelled && sample.time - this.anchor.time >= 800 && ["address-bar", "toolbar"].includes(pointer.region)) {
        events.push({ kind: "pointer-dwell", label: `Pointer paused over ${pointer.region === "address-bar" ? "the address bar" : "browser toolbar"}` });
        this.dwelled = true;
      }
    }
    this.previous = sample;
    return events;
  }
  reset() { this.previous = undefined; this.anchor = undefined; this.dwelled = false; this.edit = undefined; }
}

export async function buildDesktopHelper() {
  const source = fileURLToPath(new URL("../native/DesktopObserver.swift", import.meta.url));
  const destination = resolve(".cache/desktop-observer");
  const [input, output] = await Promise.all([stat(source), stat(destination).catch(() => null)]);
  if (!output || input.mtimeMs > output.mtimeMs) {
    await mkdir(resolve(".cache"), { recursive: true });
    await promisify(execFile)("swiftc", [source, "-o", destination, "-framework", "AppKit", "-framework", "ApplicationServices"], { timeout: 120000 });
  }
  return destination;
}

export async function readNativeClipboardText(sample: DesktopSample): Promise<string> {
  if (process.platform !== "darwin" || !sample.active || !sample.browserPid || sample.clipboardVersion === undefined) throw new Error("Passive clipboard access is unavailable.");
  const executable = await buildDesktopHelper();
  const { stdout } = await promisify(execFile)(executable, ["--pid", String(sample.browserPid), "--read-clipboard", "--clipboard-version", String(sample.clipboardVersion)],
    { timeout: 3000, maxBuffer: 65536 });
  const result = z.object({ text: z.string().optional(), unavailable: z.boolean().optional() }).parse(JSON.parse(stdout));
  if (result.unavailable || result.text === undefined) throw new Error("The browser or clipboard changed before reading completed.");
  return result.text;
}

export class DesktopObserver {
  private process?: ChildProcess;
  private stopped = false;
  private paused = false;
  private executable?: string;
  private lastPublish = 0;
  private signals = new DesktopSignals();
  readonly state: DesktopState = { status: "starting", message: "Connecting browser-level signals…", sample: null, path: [] };

  constructor(
    private profile: string,
    private update: (state: DesktopState) => void,
    private activity: (kind: string, label: string, addressText?: string) => void,
  ) {}

  private publish(status: DesktopState["status"], message: string) {
    this.state.status = status; this.state.message = message;
    this.update({ ...this.state, path: [...this.state.path] });
  }
  async start() {
    if (process.env.REBROWSE_DESKTOP_CONTEXT === "false") { this.publish("disabled", "Desktop context disabled."); return; }
    if (process.platform !== "darwin") { this.publish("unsupported", "Browser-level observation is currently available on macOS."); return; }
    try {
      this.executable = await buildDesktopHelper();
      if (this.stopped) return;
      const lock = await readlink(resolve(this.profile, "SingletonLock"));
      const pid = lock.match(/-(\d+)$/)?.[1];
      if (!pid) throw new Error("Could not identify this browser process.");
      this.process = spawn(this.executable, ["--pid", pid, ...(clipboardEnabled() ? ["--clipboard-context"] : [])], { stdio: ["ignore", "pipe", "ignore"] });
      const lines = createInterface({ input: this.process.stdout! });
      if (this.paused) this.process.kill("SIGSTOP");
      lines.on("line", (line) => {
        if (this.stopped || this.paused || line.length > 20000) return;
        try { this.consume(desktopSampleSchema.parse(JSON.parse(line))); } catch { /* Ignore invalid native messages. */ }
      });
      this.process.once("error", () => this.publish("error", "Browser-level observer could not start."));
      this.process.once("exit", () => { lines.close(); if (!this.stopped) this.publish("error", "Browser-level observer disconnected. Restart to reconnect."); });
    } catch {
      this.publish("error", "Could not start desktop context. macOS Command Line Tools and a running browser are required.");
    }
  }

  private consume(sample: DesktopSample) {
    // Defense in depth: even a malformed helper cannot attach page input text.
    if (!sample.active || sample.focus !== "address-bar") delete sample.addressText;
    const clipboardChanged = sample.clipboardVersion !== this.state.sample?.clipboardVersion || sample.clipboardShortcut !== undefined;
    this.state.sample = sample;
    const textChanged = sample.addressText !== undefined && sample.addressText !== this.state.addressInput?.text;
    if (sample.addressText !== undefined) this.state.addressInput = { text: sample.addressText, time: sample.time };
    if (sample.active && sample.pointer) {
      this.state.path = [...this.state.path.filter((point) => sample.time - point.time < 4000), { x: sample.pointer.x, y: sample.pointer.y, time: sample.time }].slice(-24);
    } else this.state.path = [];
    const events = this.signals.consume(sample);
    const status = !sample.accessibility ? "permission-needed" : sample.active && sample.focusAvailable === false ? "focus-unavailable" : sample.active ? "ready" : "inactive";
    if (clipboardChanged || textChanged || events.length || Date.now() - this.lastPublish >= 300 || status !== this.state.status) {
      this.lastPublish = Date.now();
      this.publish(status, !sample.accessibility
        ? "Enable macOS Accessibility to detect address-bar focus and selection."
        : sample.active && sample.focusAvailable === false ? "Browser is active, but macOS focus data is unavailable. Reconnect the observer or restart the browser."
        : sample.active ? "Tracking this browser’s pointer and browser controls."
        : sample.otherBrowserActive ? "A different Chrome window is active. Switch to the browser opened by Rebrowse."
        : "Browser is in the background. Other apps are not observed.");
    }
    for (const event of events) this.activity(event.kind, event.label, event.addressText);
  }

  setPaused(value: boolean) {
    this.paused = value; this.signals.reset();
    this.process?.kill(value ? "SIGSTOP" : "SIGCONT");
    if (value) { this.state.sample = null; this.state.path = []; this.state.addressInput = null; this.update({ ...this.state }); }
  }

  async requestPermission() {
    if (!this.executable) return;
    if (!this.state.sample?.accessibility) await promisify(execFile)(this.executable, ["--request-permission"], { timeout: 10000 });
    await this.stop();
    this.stopped = false;
    this.signals.reset();
    this.state.sample = null; this.state.path = []; this.state.addressInput = null;
    this.publish("starting", "Reconnecting browser context…");
    await this.start();
  }

  async stop() {
    this.stopped = true;
    if (!this.process || this.process.exitCode !== null || this.process.signalCode !== null) return;
    const child = this.process;
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGCONT"); child.kill("SIGTERM"); });
  }
}
