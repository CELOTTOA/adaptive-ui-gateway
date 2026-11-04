import test from "node:test";
import assert from "node:assert/strict";
import { XaiModelProvider } from "@aug/model-provider-xai";

const request = {
  purpose: "ui-layout-proposal",
  system: "SYSTEM PROMPT",
  input: '{"intent":"x"}',
  responseSchema: { type: "object", properties: {}, additionalProperties: false },
  maxOutputTokens: 512,
};

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

const ok = (content) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("sends only the system prompt and model input with a JSON schema response format", async () => {
  const fetch = fakeFetch(() => ok('{"title":"t"}'));
  const provider = new XaiModelProvider({ apiKey: "test-key", model: "grok-test", fetch });
  const signal = new AbortController().signal;
  const output = await provider.complete(request, { signal });

  assert.equal(output, '{"title":"t"}');
  assert.equal(provider.id, "xai:grok-test");
  const [call] = fetch.calls;
  assert.equal(call.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, "Bearer test-key");
  assert.equal(call.init.signal, signal);
  assert.deepEqual(call.body.messages, [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: '{"intent":"x"}' },
  ]);
  assert.equal(call.body.model, "grok-test");
  assert.equal(call.body.max_tokens, 512);
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.response_format.type, "json_schema");
  assert.deepEqual(call.body.response_format.json_schema.schema, request.responseSchema);
});

test("HTTP errors do not expose the response body or the API key", async () => {
  const fetch = fakeFetch(
    () => new Response('{"error":"bad key test-key, upstream secret"}', { status: 401 }),
  );
  const provider = new XaiModelProvider({ apiKey: "test-key", model: "grok-test", fetch });
  await assert.rejects(provider.complete(request, { signal: new AbortController().signal }), (error) => {
    assert.match(error.message, /401/);
    assert.doesNotMatch(error.message, /test-key|secret/);
    return true;
  });
});

test("a response without text content is rejected", async () => {
  const fetch = fakeFetch(
    () => new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), { status: 200 }),
  );
  const provider = new XaiModelProvider({ apiKey: "test-key", model: "grok-test", fetch });
  await assert.rejects(provider.complete(request, { signal: new AbortController().signal }));
});

test("an API key and a model are required", () => {
  assert.throws(() => new XaiModelProvider({ apiKey: "", model: "grok-test" }));
  assert.throws(() => new XaiModelProvider({ apiKey: "k", model: "" }));
});
