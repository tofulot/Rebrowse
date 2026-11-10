import type { BrowserContext, Page, Stagehand } from "@browserbasehq/stagehand";
import { readContext } from "./observer.js";
import type { WorkflowDriver } from "./workflow-runner.js";

// One owned tab per approved run. observe resolves a single Action; act gets
// that Action object, never an open-ended multi-step instruction.
export function browserWorkflowDriver(context: BrowserContext, agent: Stagehand): WorkflowDriver {
  let page: Page | undefined;
  const current = () => { if (!page) throw new Error("The workflow tab is unavailable."); return page; };
  return {
    async open(url) {
      page ??= await context.newPage();
      await context.setActivePage(page);
      await page.goto(url); // The source URL is frozen by explicit approval.
    },
    async capture() { const tab = current(); return { pageId: tab.pageId, context: await readContext(tab) }; },
    async locate(instruction) { return (await agent.observe(instruction, { page: current(), cache: false, timeout: 30000 })).data; },
    async validate(action, allowedOrigins) {
      const tab = current();
      if (!allowedOrigins.includes(new URL(await tab.url()).origin)) throw new Error("The workflow tab is outside the approved websites.");
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
        if (element.closest('input[type="password"],input[type="file"],[autocomplete^="cc-"],[autocomplete*="password"],[autocomplete="one-time-code"]')) return { error: "This field needs manual review.", destinations: [] as string[] };
        const link = element.closest("a");
        if (link?.target && link.target !== "_self") return { error: "This action opens another tab or window; review it manually.", destinations: [] as string[] };
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
