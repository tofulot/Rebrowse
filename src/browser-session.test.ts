import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBrowserSession, chromeDebuggingUrl } from "./browser-session.js";

test("recovery identifies only the dedicated main Chrome profile and a valid local debugging port", () => {
  const profile = "/tmp/rebrowse profile";
  const command = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=53550 --user-data-dir=${profile} about:blank`;
  assert.equal(chromeDebuggingUrl(command, profile), "http://127.0.0.1:53550");
  for (const other of [command.replace(profile, profile + "-other"), command.replace(profile, profile + " other"), command.replace(profile, "/tmp/regular-chrome"),
    command + " --type=renderer", command.replace("=53550", "=0"), command.replace("=53550", "=99999"),
    command.replace("--remote-debugging-port=53550 ", ""), command.replace("/Google Chrome --", "/another-app --")]) {
    assert.equal(chromeDebuggingUrl(other, profile), null);
  }
});

test("duplicate agents are rejected, release is idempotent, and another owner cannot be removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-session-test-"));
  try {
    const release = await acquireBrowserSession(directory);
    await assert.rejects(acquireBrowserSession(directory), /Rebrowse is already running/);
    await release(); await release();
    const second = await acquireBrowserSession(directory);
    const path = join(directory, ".rebrowse-agent.lock");
    const newer = JSON.stringify({ pid: process.pid, host: hostname(), token: "another-owner" });
    await writeFile(path, newer);
    await second(); assert.equal(await readFile(path, "utf8"), newer);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a stopped agent's lock is reclaimed without touching Chrome profile data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rebrowse-stale-session-"));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    await writeFile(join(directory, ".rebrowse-agent.lock"), JSON.stringify({ pid: Number(stdout), host: hostname(), token: "stale" }));
    await writeFile(join(directory, "profile-fixture"), "Keep saved profile data");
    const release = await acquireBrowserSession(directory);
    assert.equal(JSON.parse(await readFile(join(directory, ".rebrowse-agent.lock"), "utf8")).pid, process.pid);
    assert.equal(await readFile(join(directory, "profile-fixture"), "utf8"), "Keep saved profile data");
    await release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
