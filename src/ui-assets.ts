import { readFile } from "node:fs/promises";

const assets = new Map([
  ["ui/theme.css", "text/css; charset=utf-8"],
  ["ui/icons.svg", "image/svg+xml"],
  ["ui/icons.js", "text/javascript; charset=utf-8"],
  ["ui/inter-latin.woff2", "font/woff2"],
]);

export async function uiAsset(path: string) {
  const contentType = assets.get(path);
  if (contentType) {
    const body = await readFile(new URL(path, import.meta.url));
    return { contentType, body };
  }
}
