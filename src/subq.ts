import type { ClientLLM } from "@browserbasehq/stagehand";

type GenerateParams = Parameters<ClientLLM["generate"]>[0];

/** Stagehand v4 custom model callback; all inference goes directly to SubQ. */
export function createSubqModel(
  apiKey: string,
  model = "subq-preview",
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): ClientLLM {
  return {
    async generate(params: GenerateParams) {
      if (!apiKey.trim()) throw new Error("Add SUBQ_API_KEY to .env, then restart to use AI commands.");
      if ("tools" in params && params.tools?.length) {
        throw new Error("The SubQ adapter supports Stagehand structured actions, not tool-calling generations.");
      }
      const messages = params.messages.map((message) => ({
        role: message.role,
        content: (Array.isArray(message.content) ? message.content : [message.content]).map((block) => {
          if (block.type === "text") return { type: "text", text: block.text };
          if (block.type === "image") {
            return { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } };
          }
          throw new Error("Unsupported tool history in SubQ generation.");
        }),
      }));
      const format = params.responseFormat;
      const systemPrompt = [
        params.systemPrompt,
        ...(format?.type === "json_schema" ? [
          "Return only valid JSON matching the following schema. Do not include analysis, commentary, or Markdown fences.",
          JSON.stringify(format.schema),
        ] : []),
      ].filter(Boolean).join("\n\n");
      const response = await request("https://api.subq.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model,
          messages: [
            ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
            ...messages,
          ],
          stream: false,
          store: false,
          // Preview currently puts analysis into content with "none". "low"
          // keeps reasoning separate from the JSON that Stagehand consumes.
          reasoning_effort: "low",
          max_tokens: 8192,
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.stopSequences?.length ? { stop: params.stopSequences } : {}),
          ...(format?.type === "json_schema" ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: format.name, schema: format.schema, strict: true },
            },
          } : {}),
        }),
      });
      if (!response.ok) {
        const detail: Record<number, string> = {
          401: "Check SUBQ_API_KEY.",
          402: "Check your SubQ credits.",
          403: "Check that this key has access to subq-preview.",
          429: "SubQ rate limit reached. Try again later.",
        };
        // Do not print response bodies: providers can echo request content.
        throw new Error(`SubQ request failed (HTTP ${response.status}). ${detail[response.status] ?? "Check SubQ availability and model configuration."}`);
      }
      const result = await response.json() as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      const choice = result.choices?.[0];
      if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
        throw new Error("SubQ declined this request.");
      }
      if (choice?.finish_reason !== "stop") {
        throw new Error("SubQ did not return a complete response. No action was accepted.");
      }
      const text = choice.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new Error("SubQ returned an empty response.");
      const base = {
        role: "assistant" as const,
        content: { type: "text" as const, text },
        stopReason: choice.finish_reason,
        ...(result.usage ? { usage: {
          inputTokens: result.usage.prompt_tokens,
          outputTokens: result.usage.completion_tokens,
          totalTokens: result.usage.total_tokens,
        } } : {}),
      };
      if (format?.type === "json_schema") {
        let structuredContent;
        try {
          structuredContent = JSON.parse(text);
        } catch {
          throw new Error("SubQ returned invalid JSON. No action was accepted.");
        }
        // Stagehand validates this object against its requested action schema.
        return { ...base, outputFormat: "json_schema", structuredContent };
      }
      return { ...base, outputFormat: "text" };
    },
  };
}
