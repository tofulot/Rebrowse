import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseRecording, replayExpectationSchema } from "../src/recording.js";
import { replayRecording, replayReportMarkdown } from "../src/replay.js";

const args = process.argv.slice(2);
const path = args[0];
if (!path || path.startsWith("--")) throw new Error("Use: npm run replay -- <recording.jsonl> [--live] [--max-steps 12] [--expect calculus,review | --expect-none] [--by-step 2] [--out report.json]");
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const live = args.includes("--live");
if (live && !process.env.SUBQ_API_KEY?.trim()) throw new Error("Set SUBQ_API_KEY to make fresh SubQ predictions. Omit --live to inspect recorded findings without model calls.");
const records = parseRecording(await readFile(resolve(path), "utf8"));
const header = records[0]; if (header.type !== "session") throw new Error("Session header is missing.");
const terms = value("--expect");
const expected = args.includes("--expect-none") ? { expectPattern: false, terms: [], byStep: 2 }
  : terms !== undefined ? replayExpectationSchema.parse({ expectPattern: true, terms: terms.split(",").map((term) => term.trim()).filter(Boolean), byStep: Number(value("--by-step") || 2) }) : header.expected;
const maxSteps = Number(value("--max-steps") || 12);
if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) throw new Error("--max-steps must be between 1 and 1000.");
console.log(`${live ? "Fresh SubQ evaluation" : "Recorded findings only; no new inference"}: ${header.name}. Up to ${maxSteps} steps. No browser actions.`);
const report = await replayRecording(records, { mode: live ? "live" : "recorded", expected, maxSteps,
  progress: (row) => console.log(`Step ${row.step}: ${row.error || row.detected || (row.proposed ? "proposed but not accepted" : "no accepted pattern")} · ${row.confidence === null ? "—" : Math.round(row.confidence * 100) + "%"} · ${row.durationMs ?? "no recorded response"} ms`),
});
const output = resolve(value("--out") || `session-data/replay-reports/${basename(path, ".jsonl")}-${Date.now()}.json`);
if (output === resolve(path)) throw new Error("The report path must differ from the recording path.");
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
await writeFile(output.replace(/\.json$/, "") + ".md", replayReportMarkdown(report), { flag: "wx", mode: 0o600 });
console.log(`${report.expected ? report.verdict.toUpperCase() : ["error", "incomplete"].includes(report.verdict) ? "REPLAY INCOMPLETE" : "DISCOVERY REPLAY COMPLETE"}: first discovered pattern at step ${report.firstDetectionStep ?? "none yet"}; ${report.expected ? `expected match at step ${report.firstMatchingStep ?? "none"}; ` : ""}mean response ${report.meanInferenceMs ?? "unknown"} ms.`);
console.log(`Report saved: ${output}`);
if (["fail", "error", "incomplete"].includes(report.verdict)) process.exitCode = 1;
