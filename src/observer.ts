import { readFile } from "node:fs/promises";
import type { BrowserContext, CDPSubscription, Page } from "@browserbasehq/stagehand";
import { z } from "zod";
import type { DesktopSample } from "./desktop-context.js";
import { clipboardEnabled, sanitizeClipboard, type ClipboardData, type ClipboardState } from "./clipboard-context.js";

export type Activity = { id: number; pageId: string; time: number; kind: string; label: string; url: string; addressText?: string; clipboard?: ClipboardData };
const marker = "__rebrowse_activity_v1__";

export function cleanUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.href;
  } catch { return ""; }
}

// Ordinary observation excludes input values. Explicit clipboard operations
// may read selected/copied/pasted text, after protected-field checks.
const collector = await readFile(new URL("./collector.js", import.meta.url), "utf8");
const contextReader = await readFile(new URL("./context-reader.js", import.meta.url), "utf8");
const clipboardGuard = await readFile(new URL("./clipboard-guard.js", import.meta.url), "utf8");
const pageClipboardSchema = z.object({ text: z.string().max(2048).optional(), format: z.enum(["text", "non-text", "unavailable"]),
  truncated: z.boolean(), source: z.literal("page"), target: z.enum(["page", "field", "search"]), redacted: z.boolean().optional() });
function installScript(dashboardOrigin: string) {
  return `(${collector})(${JSON.stringify({ marker, dashboardOrigin, clipboardEnabled: clipboardEnabled() })})`;
}

export type PageContext = { url: string; title: string; headings: string[]; actions: string[]; excerpt: string; lists?: Array<{ label: string; items: string[]; truncated: boolean }> };

export async function readContext(page: Page): Promise<PageContext> {
  const url = await page.url();
  if (url === "about:blank" || /^chrome:\/\/newtab\/?$/.test(url)) {
    return { url, title: "New tab", headings: [], actions: [], excerpt: "No website is open. Browser navigation and search controls are available." };
  }
  const context = await page.evaluate<PageContext>(`(${contextReader})()`);
  return { ...context, url: cleanUrl(context.url) };
}

export class BrowserObserver {
  private subscriptions = new Map<string, CDPSubscription>();
  private urls = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private sequence = 0;
  private suppressed = false;
  private scanPromise?: Promise<void>;
  private clipboardEpoch = 0;
  private clipboardBusy = false;
  private nativeClipboard?: DesktopSample;
  private nativeClipboardScope = "";
  private nativeClipboardVersion?: number;
  private nativeShortcutId?: number;
  private pendingClipboardShortcut?: { shortcut: NonNullable<DesktopSample["clipboardShortcut"]>; time: number };
  private lastClipboardKey = "";
  private lastClipboardTime = 0;
  lastPage?: Page;

  constructor(
    private context: BrowserContext,
    private dashboardOrigin: string,
    private onActivity: (activity: Activity, page: Page) => void,
    private onError: (message: string) => void,
    private onContext?: (context: PageContext, page: Page) => void,
    private onClipboardStatus?: (status: ClipboardState["status"]) => void,
  ) {}

  async start() {
    await this.context.addInitScript(installScript(this.dashboardOrigin));
    await this.beginScan();
  }

  suppress(value: boolean) {
    this.suppressed = value; this.clipboardEpoch++;
    this.nativeClipboard = undefined; this.nativeClipboardVersion = undefined; this.nativeClipboardScope = ""; this.lastClipboardKey = "";
    this.pendingClipboardShortcut = undefined;
    const epoch = this.clipboardEpoch;
    if (this.subscriptions.size) void this.context.pages().then((pages) => {
      if (this.clipboardEpoch !== epoch) return;
      return Promise.allSettled(pages.filter((page) => this.subscriptions.has(page.pageId)).map((page) =>
        page.evaluate((suppressed) => { (window as unknown as { __rebrowseSuppressed: boolean }).__rebrowseSuppressed = suppressed; }, this.suppressed)));
    }).catch(() => {});
  }

  async sampleClipboard(sample: DesktopSample | null) {
    this.nativeClipboard = sample ?? undefined;
    if (this.stopped || this.suppressed || !clipboardEnabled()) return;
    if (!sample?.active) {
      this.clipboardEpoch++; this.nativeClipboardVersion = undefined; this.nativeClipboardScope = ""; this.lastClipboardKey = "";
      this.pendingClipboardShortcut = undefined; this.nativeShortcutId = undefined;
      this.onClipboardStatus?.(sample ? "inactive" : "waiting"); return;
    }
    if (sample.clipboardShortcut && sample.clipboardShortcut.id !== this.nativeShortcutId) this.pendingClipboardShortcut = { shortcut: sample.clipboardShortcut, time: sample.time };
    if (sample.clipboardVersion === undefined || Date.now() - sample.time > 3000 || this.clipboardBusy) return;
    this.clipboardBusy = true;
    const epoch = this.clipboardEpoch;
    const shortcut = this.pendingClipboardShortcut && Date.now() - this.pendingClipboardShortcut.time < 3000 ? this.pendingClipboardShortcut.shortcut : undefined;
    try {
      let page = await this.activeContentPage();
      const controls = shortcut?.target || (["address-bar", "toolbar", "browser-controls"].includes(sample.focus) ? sample.focus === "address-bar" ? "address-bar" : "browser-controls" : undefined);
      if (!page && controls) page = this.lastPage;
      if (!page || !controls && sample.focus !== "page") return;
      const scope = `${page.pageId}:${controls || "page"}`;
      if (!shortcut && sample.clipboardVersion === this.nativeClipboardVersion && scope === this.nativeClipboardScope) return;
      const stillCurrent = () => !this.stopped && !this.suppressed && epoch === this.clipboardEpoch
        && !!this.nativeClipboard?.active && this.nativeClipboard.clipboardVersion === sample.clipboardVersion && Date.now() - this.nativeClipboard.time < 3000;
      if (!stillCurrent()) return;
      const target = controls || "page";
      const allowed = controls || await page.evaluate<boolean>(`(${clipboardGuard})()`);
      if (!stillCurrent()) return;
      if (!allowed) {
        this.nativeClipboardVersion = sample.clipboardVersion; this.nativeClipboardScope = scope;
        this.onClipboardStatus?.("redacted"); return;
      }
      let text: string;
      try { text = await this.context.clipboard.readText({ page }); }
      catch { if (stillCurrent()) { this.nativeClipboardVersion = sample.clipboardVersion; this.nativeClipboardScope = scope; if (!this.lastClipboardKey) this.onClipboardStatus?.("unavailable"); } return; }
      if (!stillCurrent()) return;
      const active = await this.activeContentPage();
      if (active?.pageId !== page.pageId && !controls) return;
      if (!controls && !await page.evaluate<boolean>(`(${clipboardGuard})()`)) { this.onClipboardStatus?.("redacted"); return; }
      if (!stillCurrent()) return;
      const changed = this.nativeClipboardVersion !== undefined && this.nativeClipboardVersion !== sample.clipboardVersion;
      this.nativeClipboardVersion = sample.clipboardVersion; this.nativeClipboardScope = scope;
      if (shortcut) { this.nativeShortcutId = shortcut.id; this.pendingClipboardShortcut = undefined; }
      const data = sanitizeClipboard({ text, format: "text", truncated: false, source: "system", target });
      const clipboardKey = JSON.stringify([data.text, data.format, data.redacted]);
      if (!shortcut && clipboardKey === this.lastClipboardKey && Date.now() - this.lastClipboardTime < 120000) return;
      this.lastClipboardKey = clipboardKey; this.lastClipboardTime = Date.now();
      const kind = shortcut?.kind || (changed ? "clipboard-change" : "clipboard-available");
      const label = shortcut ? `${shortcut.kind === "paste" ? "Pasted" : shortcut.kind === "cut" ? "Cut" : "Copied"} clipboard text ${shortcut.target === "address-bar" ? "in the address bar" : "in browser controls"}`
        : changed ? "System clipboard changed · source not observed" : "Clipboard text available · source not observed";
      this.record(page, kind, label, cleanUrl(await page.url()), undefined, data);
    } finally { this.clipboardBusy = false; }
  }

  async activeContentPage() {
    if (this.stopped) return undefined;
    const page = await this.context.activePage();
    if (!page) return undefined;
    const url = await page.url();
    if (!/^(https?:|chrome:\/\/newtab\/?$|about:blank$)/.test(url) || new URL(url).origin === this.dashboardOrigin) return undefined;
    return page;
  }

  async external(kind: string, label: string, addressText?: string) {
    if (this.stopped || this.suppressed) return;
    try {
      // An address-bar selection removes DOM focus, so ask the browser which
      // tab is active rather than depending on document.hasFocus().
      let page = await this.activeContentPage();
      if (!page && ["address-select", "address-focus", "address-edit"].includes(kind)) {
        const foreground = await this.context.activePage();
        if (foreground && new URL(await foreground.url()).origin === this.dashboardOrigin) {
          // Native browser controls are not dashboard page activity. Use the
          // last browsed page as background context without reading dashboard DOM.
          page = this.lastPage;
          label += " (dashboard tab)";
        }
      }
      if (!page) return;
      const url = await page.url();
      // The scan may not have noticed a just-completed navigation yet. Mark
      // its URL here so an older navigation cannot supersede this new signal.
      this.urls.set(page.pageId, cleanUrl(url));
      this.record(page, kind, label, cleanUrl(url), kind === "address-edit" ? addressText?.slice(0, 2048) : undefined);
    } catch { /* A closing tab must not interrupt desktop observation. */ }
  }

  private beginScan() {
    this.scanPromise = this.scan();
    return this.scanPromise;
  }

  private async scan() {
    if (this.stopped) return;
    try {
      const pages = await this.context.pages();
      for (const page of pages) {
        const rawUrl = await page.url().catch(() => "");
        if (!/^https?:/.test(rawUrl) || new URL(rawUrl).origin === this.dashboardOrigin) continue;
        if (!this.subscriptions.has(page.pageId)) {
          const subscription = await page.on("console", (event) => {
            if (this.stopped || this.suppressed) return;
            const args = event.params.args;
            if (!Array.isArray(args)) return;
            for (const arg of args) {
              if (!arg || typeof arg !== "object" || !("value" in arg) || typeof arg.value !== "string") continue;
              if (!arg.value.startsWith(marker) || arg.value.length > 20000) continue;
              try {
                const data = JSON.parse(arg.value.slice(marker.length));
                if (!["click", "hover", "edit", "focus", "scroll", "tab", "copy", "cut", "paste"].includes(data.kind) || typeof data.label !== "string") continue;
                let clipboard: ClipboardData | undefined;
                if (["copy", "cut", "paste"].includes(data.kind)) {
                  if (!clipboardEnabled()) continue;
                  clipboard = sanitizeClipboard(pageClipboardSchema.parse(data.clipboard));
                  this.lastClipboardKey = JSON.stringify([clipboard.text, clipboard.format, clipboard.redacted]);
                  this.lastClipboardTime = Date.now();
                }
                this.record(page, data.kind, data.label.slice(0, 100), this.urls.get(page.pageId) || cleanUrl(rawUrl), undefined, clipboard);
              } catch { /* Ignore unrelated or malformed page console output. */ }
            }
          });
          this.subscriptions.set(page.pageId, subscription);
          await page.evaluate(installScript(this.dashboardOrigin));
        }
        const url = cleanUrl(rawUrl);
        const focused = await page.evaluate((suppressed) => {
          (window as unknown as { __rebrowseSuppressed: boolean }).__rebrowseSuppressed = suppressed;
          return document.hasFocus() && !document.hidden;
        }, this.suppressed).catch(() => false);
        if (focused) this.lastPage = page;
        if (this.urls.get(page.pageId) !== url) {
          this.urls.set(page.pageId, url);
          if (focused || this.lastPage?.pageId === page.pageId) this.record(page, "navigate", "Opened a page", url);
        }
        if (this.onContext && !this.suppressed && (focused || this.lastPage?.pageId === page.pageId)) {
          const context = await readContext(page).catch(() => null);
          if (context && !this.stopped && !this.suppressed && this.lastPage?.pageId === page.pageId) this.onContext(context, page);
        }
      }
      const alive = new Set(pages.map((page) => page.pageId));
      for (const [id, sub] of this.subscriptions) {
        if (!alive.has(id)) {
          await sub.unsubscribe().catch(() => {});
          this.subscriptions.delete(id); this.urls.delete(id);
          if (this.lastPage?.pageId === id) this.lastPage = undefined;
        }
      }
    } catch (error) {
      if (!this.stopped) this.onError(error instanceof Error ? error.message : "Browser observation failed");
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.beginScan(), 800);
    }
  }

  private record(page: Page, kind: string, label: string, url: string, addressText?: string, clipboard?: ClipboardData) {
    if (this.stopped || this.suppressed) return;
    this.lastPage = page;
    this.onActivity({ id: ++this.sequence, pageId: page.pageId, time: Date.now(), kind, label, url, ...(addressText !== undefined ? { addressText } : {}), ...(clipboard ? { clipboard } : {}) }, page);
  }

  async stop() {
    this.stopped = true;
    this.clipboardEpoch++; this.nativeClipboard = undefined;
    clearTimeout(this.timer);
    await this.scanPromise;
    await Promise.allSettled([...this.subscriptions.values()].map((sub) => sub.unsubscribe()));
    this.subscriptions.clear();
  }
}
