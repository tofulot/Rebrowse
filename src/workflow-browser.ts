import type { BrowserContext, Page, Stagehand } from "@browserbasehq/stagehand";
import { readContext } from "./observer.js";
import type { WorkflowDriver } from "./workflow-runner.js";
import { resourceUrl } from "./workflow-pattern.js";

// The step runner owns its tab; resource workflows can open multiple tabs.
// observe resolves a single Action; act gets
// that Action object, never an open-ended multi-step instruction.
export function browserWorkflowDriver(context: BrowserContext, agent: Stagehand): WorkflowDriver {
  let page: Page | undefined;
  const owned = new Set<string>();
  const current = () => { if (!page) throw new Error("The workflow tab is unavailable."); return page; };
  return {
    async openResource(url, follow = false) {
      let existing = false;
      if (follow && page && owned.has(page.pageId)) {
        await page.goto(url);
      } else {
        const pages = await context.pages();
        const found = (await Promise.all(pages.map(async (tab) => ({ tab, url: resourceUrl(await tab.url().catch(() => "")) })))).find((entry) => entry.url === resourceUrl(url));
        if (found) { page = found.tab; existing = true; }
        else { page = await context.newPage(); owned.add(page.pageId); await page.goto(url); }
      }
      return { pageId: page!.pageId, context: await readContext(page!), existing };
    },
    async open(url) {
      page ??= await context.newPage();
      await context.setActivePage(page);
      await page.goto(url); // Keep the source fixed for this bounded batch.
    },
    async capture() { const tab = current(); return { pageId: tab.pageId, context: await readContext(tab) }; },
    async locate(instruction) { return (await agent.observe(instruction, { page: current(), cache: false, timeout: 30000 })).data; },
    async validate(action, allowedOrigins) {
      const tab = current();
      if (!allowedOrigins.includes(new URL(await tab.url()).origin)) throw new Error("The workflow tab is outside its target websites.");
      const result = await tab.evaluate(({ selector }) => {
        let elements: Element[] = [];
        try {
          if (selector.startsWith("xpath=") || selector.startsWith("/")) {
            const nodes = document.evaluate(selector.replace(/^xpath=/, ""), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < nodes.snapshotLength; i++) { const node = nodes.snapshotItem(i); if (node instanceof Element) elements.push(node); }
          } else elements = Array.from(document.querySelectorAll(selector.replace(/^css=/, "")));
        } catch { return { error: "The action target could not be verified.", destinations: [] as string[] }; }
        if (elements.length !== 1 || !elements[0]!.getClientRects().length) return { error: "The action target is missing or ambiguous.", destinations: [] as string[] };
        const element = elements[0]!;
        if (element.closest('input[type="password"],input[type="file"],[autocomplete^="cc-"],[autocomplete*="password"],[autocomplete="one-time-code"]')) return { error: "This field is excluded from automatic interaction.", destinations: [] as string[] };
        const link = element.closest("a");
        if (link?.target && link.target !== "_self") return { error: "This non-resource step opens an unsupported tab or window.", destinations: [] as string[] };
        const form = element.closest("form");
        return { error: "", destinations: [link?.getAttribute("href") ? link.href : "", form?.action || ""].filter(Boolean) };
      }, { selector: action.selector });
      if (result.error) throw new Error(result.error);
      for (const destination of result.destinations) {
        const url = new URL(destination);
        if (!["http:", "https:"].includes(url.protocol) || !allowedOrigins.includes(url.origin)) throw new Error("This action targets a destination outside the observed workflow websites.");
      }
    },
    async perform(action) { return (await agent.act(action, { page: current(), cache: false, timeout: 15000 })).data.success; },
  };
}
