import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { resolve } from "node:path";
import { createSubqModel } from "./subq.js";

export async function launchBrowser() {
  return localBrowser.launch({
    headless: false,
    userDataDir: resolve("browser-data"),
    preserveUserDataDir: true,
  });
}

export async function connectAgent(browser: Awaited<ReturnType<typeof launchBrowser>>) {
  return Stagehand.create({
    browser,
    model: createSubqModel(process.env.SUBQ_API_KEY?.trim() ?? "", process.env.SUBQ_MODEL?.trim() || "subq-preview"),
  });
}
