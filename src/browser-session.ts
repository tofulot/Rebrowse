import { execFile } from "node:child_process";
import { mkdir, open, readFile, readlink, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const inUse = () => new Error("Rebrowse is already running for this browser profile. Use its existing terminal, or stop that session before starting another.");
const browserInUse = () => new Error("The Rebrowse browser is still open, but its connection is unavailable. Close only the Rebrowse browser window, then run npm start again. Your saved profile and logins will be kept.");
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** One agent owns this persistent profile; an orphaned Chrome is reusable. */
export async function acquireBrowserSession(profile: string) {
  await mkdir(profile, { recursive: true });
  const path = join(profile, ".rebrowse-agent.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number; host?: string } | undefined;
      try { owner = JSON.parse(await readFile(path, "utf8")); } catch { /* Another startup may still be writing its owner. */ }
      if (owner && Number.isInteger(owner.pid) && owner.pid! > 0) {
        if (owner.host !== hostname() || alive(owner.pid!)) throw inUse();
      } else {
        const info = await stat(path).catch(() => null);
        if (!info) continue;
        if (Date.now() - info.mtimeMs < 30000) throw inUse();
      }
      await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      continue;
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token })); }
    catch (error) { await unlink(path).catch(() => {}); throw error; }
    finally { await file.close(); }
    return async () => {
      try {
        const current = JSON.parse(await readFile(path, "utf8"));
        if (current.token === token) await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
  }
  throw inUse();
}

/** Parse only the exact dedicated profile's main Chrome process. */
export function chromeDebuggingUrl(command: string, profile: string) {
  if (!/(?:Google Chrome|Chromium|chrome)(?:\s|$)/i.test(command) || /(?:^|\s)--type=/.test(command)) return null;
  const marker = `--user-data-dir=${resolve(profile)}`;
  const start = command.indexOf(marker);
  if (start < 0 || start > 0 && !/\s/.test(command[start - 1]) || command[start + marker.length] && !/\s/.test(command[start + marker.length])) return null;
  const rest = command.slice(start + marker.length).trimStart();
  if (rest && !/^(?:--|about:blank(?:\s|$)|https?:\/\/)/.test(rest)) return null;
  const port = Number(command.match(/(?:^|\s)--remote-debugging-port=(\d+)(?=\s|$)/)?.[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : null;
}

export async function runningBrowserUrl(profile: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  let pid: number;
  try { pid = Number((await readlink(join(profile, "SingletonLock"))).match(/-(\d+)$/)?.[1]); }
  catch (error) { if (["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code || "")) return null; throw error; }
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null;
  let command: string;
  try { command = (await promisify(execFile)("ps", ["-ww", "-p", String(pid), "-o", "args="], { timeout: 2000, maxBuffer: 65536 })).stdout; }
  catch { if (!alive(pid)) return null; throw browserInUse(); }
  const cdpUrl = chromeDebuggingUrl(command, profile);
  if (!cdpUrl) throw browserInUse();
  try {
    const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000), redirect: "error" });
    if (!response.ok) throw browserInUse();
    const version = await response.json() as { webSocketDebuggerUrl?: string };
    const socket = new URL(version.webSocketDebuggerUrl || "");
    if (socket.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(socket.hostname)
      || socket.port !== new URL(cdpUrl).port || !socket.pathname.startsWith("/devtools/browser/")) throw browserInUse();
    return cdpUrl;
  } catch { if (!alive(pid)) return null; throw browserInUse(); }
}

/** Chrome may keep running after its last window/default context is closed. */
export async function ensureBrowserWindow(cdpUrl: string) {
  const version = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000), redirect: "error" }).then((response) => response.json()) as { webSocketDebuggerUrl: string };
  const endpoint = new URL(version.webSocketDebuggerUrl);
  if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.port !== new URL(cdpUrl).port || !endpoint.pathname.startsWith("/devtools/browser/")) throw browserInUse();
  const socket = new WebSocket(endpoint);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(browserInUse()); }, 3000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(browserInUse()); };
    });
    let sequence = 0;
    const send = (method: string, params = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(browserInUse()), 3000);
      const fail = () => { clearTimeout(timer); reject(browserInUse()); };
      socket.onclose = fail; socket.onerror = fail;
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          clearTimeout(timer);
          if (message.error) reject(browserInUse()); else resolve(message.result);
        } catch { fail(); }
      };
      socket.send(JSON.stringify({ id, method, params }));
    });
    const { targetInfos } = await send("Target.getTargets");
    if (!Array.isArray(targetInfos)) throw browserInUse();
    if (!targetInfos.some((target) => target.type === "page")) await send("Target.createTarget", { url: "about:blank", newWindow: true });
  } finally { socket.close(); }
}
