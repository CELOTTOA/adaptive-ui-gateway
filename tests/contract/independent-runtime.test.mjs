import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TerminalRuntime, renderInvocation } from "../../examples/independent/runtime.mjs";

const operations = JSON.parse(await readFile(new URL("../../examples/independent/operations.json", import.meta.url), "utf8"));
const origin = "http://127.0.0.1:4200", token = "independent-demo-token";
const identity = { protocolVersion: "aug/0.2", id: "invocation", operationId: "inventory.stock.reserve", operationVersion: "1", revision: 1 };
const pending = () => ({ ...identity, state: "awaiting_confirmation", confirmation: { token: "private-confirmation", expiresAt: Date.now() + 10000, input: { sku: "BOLT-A", quantity: 1 } } });
function setup(intercept) {
  const requests = [];
  const client = new TerminalRuntime({ origin, token, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, options, body });
    if (url.endsWith("/operations")) return Response.json({ protocolVersion: "aug/0.2", operations });
    return intercept(body, options, requests);
  } });
  return { client, requests };
}

test("terminal runtime uses only the configured origin and sends private requests", async () => {
  const { client, requests } = setup(() => Response.json(pending(), { status: 202 }));
  await client.start("inventory.stock.reserve", { sku: "BOLT-A", quantity: 1 });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.ok(request.url.startsWith(origin + "/v1/aug/"));
    assert.equal(request.options.redirect, "error"); assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.cache, "no-store"); assert.equal(request.options.referrerPolicy, "no-referrer");
    assert.equal(request.options.headers.Authorization, "Bearer " + token);
  }
  assert.equal(requests.filter(({ body }) => body.action === "confirm").length, 0);
  assert.doesNotMatch(renderInvocation(pending()), /private-confirmation/);
});

test("terminal runtime refuses unsupported profiles before sending invocation inputs", async () => {
  let calls = 0;
  const textOnly = new TerminalRuntime({ origin, token, profiles: ["aug.text/0.1"], fetchImpl: async (url) => {
    calls++; assert.ok(url.endsWith("/operations")); return Response.json({ protocolVersion: "aug/0.2", operations });
  } });
  await assert.rejects(textOnly.start("inventory.stock.reserve", { sku: "BOLT-A", quantity: 1 }), { code: "NO_COMPATIBLE_REPRESENTATION" });
  assert.equal(calls, 1);
});

test("lost start replies require an explicit retry using the same caller-supplied ID", async () => {
  let lost = true;
  const { client, requests } = setup(() => {
    if (lost) { lost = false; throw new Error("PRIVATE-CANARY upstream credential"); }
    return Response.json(pending(), { status: 202 });
  });
  const input = { sku: "BOLT-A", quantity: 1 }, options = { requestId: "saved-request" };
  await assert.rejects(client.start("inventory.stock.reserve", input, options), { code: "REQUEST_OUTCOME_UNKNOWN", message: "REQUEST_OUTCOME_UNKNOWN" });
  assert.equal(requests.length, 2);
  const recovered = await client.start("inventory.stock.reserve", input, options);
  assert.equal(recovered.state, "awaiting_confirmation");
  assert.deepEqual(requests[1].body, requests[2].body);
  assert.equal(requests.filter(({ body }) => body.action === "confirm").length, 0);
});

test("a lost confirmation is recovered by status without a second automatic confirmation", async () => {
  const { client, requests } = setup((body) => {
    if (body.action === "confirm") throw new Error("Lost reply");
    return Response.json(body.action === "status" ? { ...identity, revision: 2, state: "running" } : pending(), { status: 202 });
  });
  const current = await client.start("inventory.stock.reserve", { sku: "BOLT-A", quantity: 1 });
  await assert.rejects(client.confirm(current.id), { code: "REQUEST_OUTCOME_UNKNOWN" });
  assert.equal((await client.status(current.id)).state, "running");
  assert.equal(requests.filter(({ body }) => body.action === "confirm").length, 1);
  assert.deepEqual(Object.keys(requests.find(({ body }) => body.action === "confirm").body).sort(), ["action", "invocationId", "protocolVersion", "token"]);
});

test("changed saved inputs and malformed success representations are refused", async () => {
  const mutations = [
    (value) => { value.confirmation.input.quantity = 9; },
    (value) => { value.protocolVersion = "aug/0.1"; },
    (value) => { value.revision = 0; },
    (value) => { value.endpoint = "https://untrusted.example"; },
  ];
  const empty = setup(() => Response.json(null));
  await assert.rejects(empty.client.start("inventory.stock.reserve", {}), { code: "REQUEST_OUTCOME_UNKNOWN" });
  for (const mutate of mutations) {
    const { client } = setup(() => { const value = pending(); mutate(value); return Response.json(value, { status: 202 }); });
    await assert.rejects(client.start("inventory.stock.reserve", { sku: "BOLT-A", quantity: 1 }), { code: "REQUEST_OUTCOME_UNKNOWN" });
  }
  for (const mutate of [
    (value) => { value.output.audience = "model"; },
    (value) => { value.output.representation.profile = "example.plugin/1"; },
    (value) => { value.output.representation.delivery = { kind: "reference", href: "https://untrusted.example" }; },
    (value) => { value.output.representation.id = "undeclared"; },
  ]) {
    const { client } = setup(() => {
      const value = { ...identity, revision: 3, state: "succeeded", output: { protocolVersion: "aug/0.2", outputId: "out", audience: "view",
        representation: { id: "json", profile: "aug.json/0.1", mediaType: "application/json", audiences: ["view"], delivery: { kind: "inline", value: {} } } } };
      mutate(value); return Response.json(value);
    });
    await assert.rejects(client.start("inventory.stock.reserve", { sku: "BOLT-A", quantity: 1 }), { code: "REQUEST_OUTCOME_UNKNOWN" });
  }
});

test("terminal state cannot regress and raw backend errors are never displayed", async () => {
  const { client } = setup((body) => Response.json(body.action === "status" ? pending() :
    { ...identity, revision: 3, state: "indeterminate", error: { code: "EXECUTION_OUTCOME_UNKNOWN" } }, { status: body.action ? 202 : 200 }));
  const current = await client.start("inventory.stock.reserve", { sku: "BOLT-A", quantity: 1 });
  await assert.rejects(client.status(current.id), { code: "INVALID_RESPONSE" });
  await assert.rejects(client.confirm(current.id), { code: "CONFIRMATION_NOT_PENDING" });
  const refusing = setup(() => Response.json({ code: "INVALID_INPUT", message: "PRIVATE-CANARY" }, { status: 400 }));
  await assert.rejects(refusing.client.start("inventory.stock.reserve", {}), { code: "INVALID_INPUT", message: "INVALID_INPUT" });
});

test("streamed responses have a byte cap and do not expose the returned body", async () => {
  const { client } = setup(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(1048577)); controller.close();
  } }), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(client.start("inventory.stock.reserve", {}), { code: "REQUEST_OUTCOME_UNKNOWN" });
  const valid = { ...identity, state: "succeeded", output: { protocolVersion: "aug/0.2", outputId: "out", audience: "view",
    representation: { id: "json", profile: "aug.json/0.1", mediaType: "application/json", audiences: ["view"],
      delivery: { kind: "inline", value: "REPLACE" } } } };
  const raw = Buffer.from(JSON.stringify(valid));
  raw[raw.indexOf("REPLACE")] = 0xff;
  const malformed = setup(() => new Response(raw, { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(malformed.client.start("inventory.stock.reserve", {}), { code: "REQUEST_OUTCOME_UNKNOWN" });
});

test("collection columns and terminal control characters are handled safely", async () => {
  const { client } = setup(() => Response.json({ ...identity, operationId: "inventory.stock.list", state: "succeeded", output: {
    protocolVersion: "aug/0.2", outputId: "rows", audience: "view", representation: {
      id: "collection", profile: "aug.collection/0.1", mediaType: "application/json", audiences: ["view"],
      delivery: { kind: "inline", value: { columns: [{ key: "name" }], rows: [{ name: "\u001b[2J" }] } },
    },
  } }));
  const result = await client.start("inventory.stock.list", {});
  assert.doesNotMatch(renderInvocation(result), /\u001b/);
  assert.match(renderInvocation(result), /\\u001b/);
  const malformed = setup(() => Response.json({ ...result, output: { ...result.output, representation: {
    ...result.output.representation, delivery: { kind: "inline", value: { columns: [{ key: "name" }], rows: [{ other: "value" }] } },
  } } }));
  await assert.rejects(malformed.client.start("inventory.stock.list", {}), { code: "REQUEST_OUTCOME_UNKNOWN" });
});
