import "dotenv/config";
import { browserbase, type StagehandBrowser } from "@browserbasehq/stagehand";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { connectAgent } from "./browser.js";
import { dashboardRoutes, PredictionDashboard } from "./dashboard.js";
import { BrowserObserver } from "./observer.js";
import { browserWorkflowDriver } from "./workflow-browser.js";

const cookieName = "rebrowse_session";
const dashboardPath = "/dashboard/";
const lifetimeSeconds = 300;
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
} as const;

type BrowserService = {
  launch(): Promise<StagehandBrowser>;
  liveViews(sessionId: string): Promise<Map<string, string>>;
};

function browserService(apiKey: string, projectId: string): BrowserService {
  return {
    launch: () => browserbase.launch({ apiKey, projectId, api_timeout: lifetimeSeconds,
      clientOptions: { timeout: 15_000, maxRetries: 0 },
      browserSettings: { recordSession: false, logSession: false, solveCaptchas: false } }),
    async liveViews(sessionId) {
      const response = await fetch(`https://api.browserbase.com/v1/sessions/${encodeURIComponent(sessionId)}/debug`, {
        headers: { "X-BB-API-Key": apiKey }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("The browser view could not connect.");
      const { pages } = await response.json() as { pages: { id: string; debuggerFullscreenUrl: string }[] };
      return new Map(pages.flatMap(({ id, debuggerFullscreenUrl }) => {
        const url = new URL(debuggerFullscreenUrl);
        const allowed = url.hostname === "browserbase.com" || url.hostname.endsWith(".browserbase.com");
        return url.protocol === "https:" && allowed ? [[id, url.href] as const] : [];
      }));
    },
  };
}

type Session = {
  browser: StagehandBrowser;
  controller: PredictionDashboard;
  dashboard: ReturnType<typeof dashboardRoutes>;
  views: Map<string, string>;
  refresh: Promise<void> | undefined;
  refreshedAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  close(): Promise<void>;
};

async function openSession(service: BrowserService, origin: string) {
  const browser = await service.launch();
  const controller = new PredictionDashboard({ intervalMs: 3000 });
  const dashboard = dashboardRoutes(controller, true);
  let observer: BrowserObserver | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= (async () => {
    dashboard.close();
    controller.stop();
    await Promise.allSettled([observer?.stop(), controller.finishExecution(), browser.close()]);
  })();
  try {
    const agent = await connectAgent(browser);
    controller.attachRunner({ driver: async () => browserWorkflowDriver(browser.context, agent) });
    observer = new BrowserObserver(browser.context, origin,
      (activity, page) => controller.activity(activity, page),
      () => controller.reportError("The browser connection was interrupted."),
      (context, page, options) => controller.observe(context, page, options));
    controller.observer = observer;
    const page = await browser.context.activePage() ?? await browser.context.newPage();
    await observer.start();
    observer.lastPage = page;
    return { browser, controller, dashboard, close };
  } catch (error) {
    await close();
    throw error;
  }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(response: ServerResponse, status: number, value: object) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

async function input(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new RequestError(413, "The browser request is too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as { tabId?: string; url?: string; action?: string };
  }
  catch { throw new RequestError(400, "The browser request is invalid."); }
}

function destination(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new RequestError(400, "Enter a website address.");
  try {
    const text = value.trim();
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Use the same message for malformed and unsupported addresses. */ }
  throw new RequestError(400, "Enter a valid HTTP or HTTPS address.");
}

export function hostedServer(service: BrowserService, origin: string, limits: { concurrent: number; daily: number }) {
  const sessions = new Map<string, Session>();
  const pending = new Set<Promise<void>>();
  let inUse = 0;
  let day = "";
  let starts = 0;
  let closing = false;
  const host = new URL(origin).host;
  const cookie = (token: string, age: number) => `${cookieName}=${token}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${origin.startsWith("https:") ? "; Secure" : ""}`;

  async function end(token: string, session: Session) {
    if (!sessions.delete(token)) return;
    clearTimeout(session.timer);
    try { await session.close(); }
    finally { inUse--; }
  }

  async function tabs(session: Session) {
    const pages = await session.browser.context.pages();
    if (pages.some((page) => !session.views.has(page.pageId)) && Date.now() - session.refreshedAt > 1000) {
      session.refresh ??= service.liveViews(session.browser.sessionId!).then((views) => { session.views = views; })
        .finally(() => { session.refresh = undefined; session.refreshedAt = Date.now(); });
      await session.refresh;
    }
    return Promise.all(pages.map(async (page) => ({
      id: page.pageId,
      title: await page.title().catch(() => "") || "New tab",
      url: page.ref.url || "about:blank",
      view: session.views.get(page.pageId) ?? null,
    })));
  }

  async function start(response: ServerResponse) {
    if (closing || inUse >= limits.concurrent) throw new RequestError(503, "All browsers are in use. Try again in a few minutes.");
    const today = new Date().toISOString().slice(0, 10);
    if (day !== today) { day = today; starts = 0; }
    if (starts >= limits.daily) throw new RequestError(429, "Today’s browser session limit has been reached.");
    const token = randomBytes(24).toString("hex");
    const expiresAt = Date.now() + lifetimeSeconds * 1000;
    starts++;
    inUse++;
    const browser = await openSession(service, origin).catch(() => {
      inUse--;
      throw new RequestError(502, "The cloud browser couldn’t start. Try again shortly.");
    });
    const timer = setTimeout(() => { void end(token, session); }, Math.max(0, expiresAt - Date.now()));
    const session: Session = { ...browser, views: new Map(), refresh: undefined, refreshedAt: 0, expiresAt, timer };
    sessions.set(token, session);
    try {
      const pages = await tabs(session);
      if (closing || response.destroyed) { await end(token, session); return; }
      response.setHeader("Set-Cookie", cookie(token, lifetimeSeconds));
      json(response, 201, { tabs: pages, expiresAt });
    } catch {
      await end(token, session);
      throw new RequestError(502, "The cloud browser opened, but its live view couldn’t connect.");
    }
  }

  async function requestHandler(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; frame-src 'self' https://browserbase.com https://*.browserbase.com; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    const path = request.url ?? "";
    if (path === "/health" && request.method === "GET") { response.writeHead(204).end(); return; }
    if (request.headers.host !== host) { response.writeHead(403).end(); return; }
    if (request.method !== "GET" && request.headers.origin !== origin) { response.writeHead(403).end(); return; }

    const token = request.headers.cookie?.match(/(?:^|;\s*)rebrowse_session=([a-f0-9]{48})(?:;|$)/)?.[1] ?? "";
    let session = sessions.get(token);
    if (session && (Date.now() >= session.expiresAt || !session.browser.connected)) {
      void end(token, session);
      session = undefined;
    }
    if (path === "/api/session") {
      if (request.method === "DELETE") {
        if (session) await end(token, session);
        response.setHeader("Set-Cookie", cookie("", 0));
        response.writeHead(204).end();
      } else if (request.method === "POST" && !session) {
        const startPromise = start(response);
        pending.add(startPromise);
        try { await startPromise; }
        finally { pending.delete(startPromise); }
      } else if (request.method === "GET" || request.method === "POST") {
        if (!session) throw new RequestError(404, "Your browser session has ended.");
        json(response, 200, { tabs: await tabs(session), expiresAt: session.expiresAt });
      } else response.writeHead(405).end();
      return;
    }
    if (path === "/api/tab" && request.method === "POST") {
      if (!session) throw new RequestError(404, "Your browser session has ended.");
      const { action, url, tabId } = await input(request);
      if (!["select", "navigate", "new", "close", "back", "forward", "reload"].includes(action ?? "")) throw new RequestError(400, "Unknown browser action.");
      const target = action === "navigate" || (action === "new" && url) ? destination(url) : null;
      const context = session.browser.context;
      const pages = await context.pages();
      if (action === "new" && pages.length >= 20) throw new RequestError(409, "Close a tab before opening another.");
      const page = action === "new" ? await context.newPage() : pages.find((candidate) => candidate.pageId === tabId);
      if (!page) throw new RequestError(404, "This tab has closed.");
      if (action === "close") {
        if (pages.length === 1) throw new RequestError(409, "Keep at least one tab open.");
        await page.close();
      } else {
        await context.setActivePage(page);
        const options = { waitUntil: "domcontentloaded", timeout: 8000 } as const;
        if (target) await page.goto(target, options);
        else if (action === "back") await page.goBack(options);
        else if (action === "forward") await page.goForward(options);
        else if (action === "reload") await page.reload(options);
      }
      json(response, 200, { tabs: await tabs(session), selected: action === "close" ? null : page.pageId });
      return;
    }
    if (path.startsWith(dashboardPath)) {
      if (!session) { response.writeHead(404).end(); return; }
      await session.dashboard.handle(request, response, path.slice(dashboardPath.length), origin);
      return;
    }
    const asset = Object.hasOwn(files, path) ? files[path as keyof typeof files] : undefined;
    if (!asset || request.method !== "GET") { response.writeHead(404).end(); return; }
    const body = await readFile(new URL(`./hosted/${asset[0]}`, import.meta.url));
    response.writeHead(200, { "Content-Type": asset[1] }).end(body);
  }

  const server = createServer((request, response) => {
    void requestHandler(request, response).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) { response.end(); return; }
      if (error instanceof RequestError) json(response, error.status, { error: error.message });
      else json(response, 502, { error: "The browser didn’t complete that request." });
    });
  });
  return {
    server,
    async close() {
      closing = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...sessions].map(([token, session]) => end(token, session)));
      await Promise.allSettled(pending);
      server.closeAllConnections();
      await closed;
    },
  };
}

function main() {
  const port = Number(process.env.PORT || 3000);
  const publicUrl = new URL(process.env.REBROWSE_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`);
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  if (!apiKey || !projectId || !process.env.SUBQ_API_KEY?.trim()) {
    throw new Error("Configure BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, and SUBQ_API_KEY on the host.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (publicUrl.protocol !== "https:" && publicUrl.hostname !== "localhost")) {
    throw new Error("Configure a valid PORT and an HTTPS public origin.");
  }
  const limit = (value: string | undefined, fallback: number) => value ? Number(value) : fallback;
  const limits = { concurrent: limit(process.env.REBROWSE_CONCURRENT_SESSIONS, 1), daily: limit(process.env.REBROWSE_DAILY_SESSIONS, 12) };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("Session limits must be positive integers.");
  process.env.REBROWSE_CLIPBOARD_CONTEXT = "false";
  const app = hostedServer(browserService(apiKey, projectId), publicUrl.origin, limits);
  app.server.listen(port, publicUrl.hostname === "localhost" ? "127.0.0.1" : "0.0.0.0", () => console.log(`Rebrowse live at ${publicUrl.origin}`));
  process.once("SIGTERM", () => { void app.close(); });
  process.once("SIGINT", () => { void app.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
