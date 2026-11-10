export const CLIPBOARD_LIMIT = 2048;
export const CLIPBOARD_TTL_MS = 120000;
export type ClipboardData = {
  text?: string; format: "text" | "non-text" | "unavailable"; truncated: boolean;
  source: "page" | "system"; target: "page" | "field" | "search" | "address-bar" | "browser-controls";
  redacted?: boolean;
};
export type ClipboardContext = ClipboardData & { time: number; operation: "copy" | "cut" | "paste" | "clipboard-available" | "clipboard-change"; pageId: string; url: string };
export type ClipboardState = {
  status: "waiting" | "ready" | "redacted" | "empty" | "unavailable" | "inactive" | "paused" | "disabled";
  context: ClipboardContext | null;
  lastUsedAt: number | null;
};
export function clipboardEnabled() { return process.env.REBROWSE_CLIPBOARD_CONTEXT !== "false"; }
export function clipboardMetadata(data: ClipboardData): Omit<ClipboardData, "text"> { const { text: _text, ...metadata } = data; return metadata; }
// These are obvious credential formats, not a guarantee that arbitrary text
// contains no secrets. Sensitive field exclusion happens before text capture.
export function sanitizeClipboard(input: ClipboardData): ClipboardData {
  const text = typeof input.text === "string" ? input.text : undefined;
  const secret = text !== undefined && (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)
    || /\b(?:sk-(?:proj-|ant-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)
    || /\b(?:Bearer\s+\S{16,}|(?:api[_ -]?key|access[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*\S{6,})/i.test(text));
  const { text: _text, redacted: _redacted, ...metadata } = input;
  if (input.redacted || secret) return { ...metadata, format: "unavailable", redacted: true };
  return { ...metadata, ...(text === undefined ? {} : { text: text.slice(0, CLIPBOARD_LIMIT) }), truncated: input.truncated || (text?.length ?? 0) > CLIPBOARD_LIMIT };
}
export function freshClipboard(state: ClipboardState | null | undefined, now = Date.now()): ClipboardContext | null {
  const context = state?.context;
  if (state?.status !== "ready" || !context || context.format !== "text" || context.redacted || context.text === undefined || now - context.time > CLIPBOARD_TTL_MS || now < context.time) return null;
  const sanitized = sanitizeClipboard(context);
  return sanitized.redacted ? null : { ...context, ...sanitized };
}
export function clipboardStatus(data: ClipboardData): ClipboardState["status"] {
  return data.redacted ? "redacted" : data.format === "unavailable" ? "unavailable" : data.format === "non-text" ? "unavailable" : data.text ? "ready" : "empty";
}
