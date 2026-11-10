import { readFile } from "node:fs/promises";
import type { BrowserContext, CDPSubscription, Page } from "@browserbasehq/stagehand";

export type Activity = { id: number; pageId: string; time: number; kind: string; label: string; url: string; addressText?: string };
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

// Runs in the page. Never reads input values, keystrokes, or editable text.
const collector = await readFile(new URL("./collector.js", import.meta.url), "utf8");
const contextReader = await readFile(new URL("./context-reader.js", import.meta.url), "utf8");
function installScript(dashboardOrigin: string) {
  return `(${collector})(${JSON.stringify({ marker, dashboardOrigin })})`;
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
  lastPage?: Page;

  constructor(
    private context: BrowserContext,
    private dashboardOrigin: string,
    private onActivity: (activity: Activity, page: Page) => void,
    private onError: (message: string) => void,
    private onContext?: (context: PageContext, page: Page) => void,
  ) {}

  async start() {
    await this.context.addInitScript(installScript(this.dashboardOrigin));
    await this.beginScan();
  }

  suppress(value: boolean) { this.suppressed = value; }

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
            const args = event.params.args;
            if (!Array.isArray(args)) return;
            for (const arg of args) {
              if (!arg || typeof arg !== "object" || !("value" in arg) || typeof arg.value !== "string") continue;
              if (!arg.value.startsWith(marker) || arg.value.length > 2000) continue;
              try {
                const data = JSON.parse(arg.value.slice(marker.length));
                if (!["click", "hover", "edit", "focus", "scroll", "tab"].includes(data.kind) || typeof data.label !== "string") continue;
                this.record(page, data.kind, data.label.slice(0, 100), this.urls.get(page.pageId) || cleanUrl(rawUrl));
              } catch { /* Ignore unrelated or malformed page console output. */ }
            }
          });
          this.subscriptions.set(page.pageId, subscription);
          await page.evaluate(installScript(this.dashboardOrigin));
        }
        const url = cleanUrl(rawUrl);
        const focused = await page.evaluate(() => document.hasFocus() && !document.hidden).catch(() => false);
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

  private record(page: Page, kind: string, label: string, url: string, addressText?: string) {
    if (this.stopped || this.suppressed) return;
    this.lastPage = page;
    this.onActivity({ id: ++this.sequence, pageId: page.pageId, time: Date.now(), kind, label, url, ...(addressText !== undefined ? { addressText } : {}) }, page);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.scanPromise;
    await Promise.allSettled([...this.subscriptions.values()].map((sub) => sub.unsubscribe()));
    this.subscriptions.clear();
  }
}
