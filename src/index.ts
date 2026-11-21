import "dotenv/config";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { connectAgent, launchBrowser } from "./browser.js";
import { BrowserObserver } from "./observer.js";
import { PredictionDashboard, startDashboard } from "./dashboard.js";
import { DesktopObserver } from "./desktop-context.js";
import { resolve } from "node:path";
import { TaskJournal } from "./tasks.js";
import { browserWorkflowDriver } from "./workflow-browser.js";
import { WorkflowRunJournal } from "./workflow-runner.js";
import { acquireBrowserSession } from "./browser-session.js";

const help = `
Browse normally in the browser. Enter commands here:
  goto https://example.com   Navigate the active tab
  snapshot                  Read the active page without AI
  observe [instruction]     Ask AI for possible page actions
  act <instruction>         Ask AI to perform an action
  dashboard                 Reopen the live prediction dashboard
  help                      Show commands
  quit                      Close this browser session
`;

function webUrl(value: string) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Use a full http:// or https:// URL.");
  }
  return url.href;
}

async function runSession() {
  const startUrl = webUrl(process.env.START_URL || "https://example.com");
  const browser = await launchBrowser();
  let agent: Awaited<ReturnType<typeof connectAgent>> | undefined;
  const predictions = new PredictionDashboard({ journal: new TaskJournal(resolve("session-data/repeatable-tasks.jsonl")) });
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let observer: BrowserObserver | undefined;
  let desktop: DesktopObserver | undefined;
  const terminal = createInterface({ input: stdin, output: stdout });
  let closing = false;
  let ready = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      terminal.close();
      predictions.stop();
      await predictions.finishExecution();
      await predictions.finishRecording();
      await predictions.flushTasks();
      await desktop?.stop();
      await observer?.stop();
      await dashboard?.close();
      try {
        await agent?.close();
      } finally {
        if (!ready && browser.origin === "connected") await browser.disconnect();
        else await browser.close();
      }
    })();
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  terminal.once("SIGINT", onSignal);

  try {
    agent = await connectAgent(browser);
    predictions.attachRunner({ driver: async () => browserWorkflowDriver(browser.context, agent!),
      journal: new WorkflowRunJournal(resolve("session-data/workflow-runs.jsonl")) });
    dashboard = await startDashboard(predictions);
    observer = new BrowserObserver(browser.context, dashboard.origin,
      (event, page) => predictions.activity(event, page),
      (message) => predictions.reportError(message),
      (context, page, options) => predictions.observe(context, page, options),
      (status) => predictions.clipboardStatus(status));
    predictions.observer = observer;
    desktop = new DesktopObserver(resolve("browser-data"), (state) => {
      void observer?.sampleClipboard(state.sample).catch(() => {});
      void observer?.activeContentPage().then((page) => {
        const source = page ?? (state.sample?.focus === "address-bar" ? observer?.lastPage : undefined);
        predictions.desktop({ ...state, pageId: source?.pageId ?? null });
      })
        .catch(() => predictions.desktop({ ...state, pageId: null }));
    },
      (kind, label, addressText) => { void observer?.external(kind, label, addressText); });
    predictions.desktopObserver = desktop;
    const page = await browser.context.activePage() ?? await browser.context.newPage();
    // Reconnecting must not replace an existing review/video tab with START_URL.
    if (browser.origin === "launched") await page.goto(startUrl);
    await observer.start();
    observer.lastPage ??= page;
    void desktop.start();
    const dashboardTab = await browser.context.newPage();
    await dashboardTab.goto(dashboard.url);
    ready = true;
    if (browser.origin === "connected") console.log("Reconnected to the existing Rebrowse browser. Your open tabs were kept.");
    console.log("Rebrowse · Stagehand browser ready.");
    console.log(help);
    console.log(`Live predictions: ${dashboard.url}\nSwitch to your browsing tab to generate signals.\n`);
    if (!process.env.SUBQ_API_KEY?.trim()) {
      console.log("No AI key configured. Browsing, goto, and snapshot still work.");
    }
    terminal.setPrompt("rebrowse> ");
    terminal.prompt();
    for await (const line of terminal) {
      if (closing) break;
      const input = line.trim();
      const separator = input.indexOf(" ");
      const command = separator < 0 ? input : input.slice(0, separator);
      const instruction = separator < 0 ? "" : input.slice(separator + 1).trim();
      if (command === "quit" || command === "exit") break;
      try {
        if (command === "help") console.log(help);
        else if (command === "dashboard") {
          const tab = await browser.context.newPage();
          await tab.goto(dashboard.url);
        }
        else if (command) {
          const foreground = await browser.context.activePage();
          const active = foreground && !(await foreground.url()).startsWith(dashboard.origin)
            ? foreground : observer.lastPage;
          if (!active) throw new Error("Open a browser tab first.");
          if (predictions.executionBusy && ["goto", "act", "observe"].includes(command)) throw new Error("Pause the running workflow before using manual browser commands.");
          if (command === "goto") await active.goto(webUrl(instruction));
          else if (command === "snapshot") console.log((await active.snapshot()).formattedTree);
          else if (command === "act" || command === "observe") {
            if (command === "act" && !instruction) throw new Error("Usage: act <instruction>");
            if (!process.env.SUBQ_API_KEY?.trim()) {
              throw new Error("Add SUBQ_API_KEY to .env, then restart to use AI commands.");
            }
            // Keep manual agent actions out of the human activity stream.
            observer.suppress(true);
            try {
              const result = command === "act"
                ? await agent.act(instruction, { page: active })
                : await agent.observe(instruction || "What actions are available on this page?", { page: active });
              console.log(JSON.stringify(result.data, null, 2));
            } finally { observer.suppress(predictions.state.paused); }
          } else console.log("Unknown command. Type help to see commands.");
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      if (!closing) terminal.prompt();
    }
  } finally {
    await shutdown();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

async function main() {
  const release = await acquireBrowserSession(resolve("browser-data"));
  try { await runSession(); }
  finally { await release(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
