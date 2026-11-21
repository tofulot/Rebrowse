import assert from "node:assert/strict";
import test from "node:test";
import { createConfiguredSubqModel, createSubqModel, subqModelName } from "./subq.js";

const params = {
  messages: [{ role: "user" as const, content: { type: "text" as const, text: "Find the link" } }],
  responseFormat: {
    type: "json_schema" as const,
    name: "action",
    schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
  },
};

function completion(content: string | null, finish = "stop", refusal?: string) {
  return Response.json({
    choices: [{ message: { content, refusal }, finish_reason: finish }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  });
}

test("routes structured multimodal generation to SubQ and maps the result", async () => {
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.subq.ai/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "subq-savant-1.4");
    assert.match(body.messages[0].content, /^Use the page/);
    assert.match(body.messages[0].content, /Return only valid JSON/);
    assert.ok(body.messages[0].content.includes(JSON.stringify(params.responseFormat.schema)));
    assert.equal(body.reasoning_effort, "low");
    assert.deepEqual(body.messages.slice(1), [
      { role: "user", content: [
        { type: "text", text: "Find the link" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ] },
    ]);
    assert.deepEqual(body.response_format.json_schema, { name: "action", schema: params.responseFormat.schema, strict: true });
    assert.equal(body.store, false);
    assert.equal(Object.hasOwn(body, "temperature"), false);
    assert.deepEqual(body.stop, ["END"]);
    return completion('{"label":"Learn more"}');
  };
  const result = await createSubqModel("test-key", undefined, request).generate({
    ...params,
    systemPrompt: "Use the page",
    temperature: 0,
    stopSequences: ["END"],
    messages: [{ role: "user", content: [params.messages[0]!.content, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }],
  });
  assert.equal(result.outputFormat, "json_schema");
  if (result.outputFormat === "json_schema") assert.deepEqual(result.structuredContent, { label: "Learn more" });
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 5, totalTokens: 25 });
});

test("configured requests use the supported default and preserve custom model names", async (t) => {
  const originalModel = process.env.SUBQ_MODEL;
  const originalKey = process.env.SUBQ_API_KEY;
  t.after(() => {
    if (originalModel === undefined) delete process.env.SUBQ_MODEL;
    else process.env.SUBQ_MODEL = originalModel;
    if (originalKey === undefined) delete process.env.SUBQ_API_KEY;
    else process.env.SUBQ_API_KEY = originalKey;
  });
  process.env.SUBQ_API_KEY = " test-key ";
  const request = t.mock.method(globalThis, "fetch", async (..._args: Parameters<typeof fetch>) => completion('{"label":"Learn more"}'));
  for (const [configured, expected] of [
    [" ", "subq-savant-1.4"],
    [" subq-preview ", "subq-savant-1.4"],
    [" subq-savant-latest ", "subq-savant-latest"],
  ]) {
    process.env.SUBQ_MODEL = configured;
    assert.equal(subqModelName(), expected);
    await createConfiguredSubqModel().generate(params);
    const [, init] = request.mock.calls.at(-1)!.arguments;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    assert.equal(JSON.parse(String(init?.body)).model, expected);
  }
});

test("rejects incomplete, refused, empty, and malformed model output", async () => {
  for (const [response, message] of [
    [completion('{"label":', "length"), /complete response/],
    [completion(null, "stop", "Cannot comply"), /declined/],
    [completion(""), /empty response/],
    [completion("not json"), /invalid JSON/],
    [completion('We need answer requested JSON object.{"label":"Learn more"}'), /invalid JSON/],
  ] as const) {
    const model = createSubqModel("test-key", undefined, async () => response);
    await assert.rejects(model.generate(params), message);
  }
});

test("reports HTTP failures without leaking the provider response body", async () => {
  const model = createSubqModel("test-key", "subq-savant-latest", async () => new Response("private content", { status: 403 }));
  await assert.rejects(model.generate(params), (error: Error) => {
    assert.match(error.message, /403.*access to subq-savant-latest/);
    assert.doesNotMatch(error.message, /private content|test-key/);
    return true;
  });
});

test("missing key fails before any request", async () => {
  const model = createSubqModel("", undefined, async () => { throw new Error("Must not call network"); });
  await assert.rejects(model.generate(params), /SUBQ_API_KEY/);
});

test("does not silently drop unsupported tool history", async () => {
  const model = createSubqModel("test-key", undefined, async () => { throw new Error("Must not call network"); });
  await assert.rejects(model.generate({
    ...params,
    messages: [{ role: "assistant", content: { type: "tool_use", id: "one", name: "click", input: {} } }],
  }), /Unsupported tool history/);
});
