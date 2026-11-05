import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startCustomerApi } from "@aug/example-customer-api";
import { startGatewayServer } from "@aug/gateway-server";
import { protocolVersion } from "@aug/protocol";
import { operation, invoke, control, output, settled } from "../helpers/operation-fixtures.mjs";

const actors = new Map([
  ["analyst", { id: "analyst", tenantId: "tenant-a", scopes: ["customers:read", "demo:use"] }],
  ["other", { id: "other", tenantId: "tenant-b", scopes: ["customers:read", "demo:use"] }],
  ["denied", { id: "analyst", tenantId: "tenant-a", scopes: [] }],
]);
const origin = "https://view.example";
const events = [];
let backend, gateway, base;
let writes = 0;
let planCalls = 0;

before(async () => {
  backend = await startCustomerApi({ port: 0, backendToken: "demo-backend-service-token" });
  gateway = await startGatewayServer({
    port: 0,
    openApiSource: await readFile(new URL("../../examples/customer-api/openapi.json", import.meta.url), "utf8"),
    backendBaseUrl: `http://127.0.0.1:${backend.address().port}`,
    backendToken: "demo-backend-service-token", authenticate: (token) => actors.get(token), allowedOrigins: [origin],
    planner: { planSearch: async () => { planCalls++; throw new Error("Operation invocation must not call the UI planner"); } },
    operationBroker: { onEvent: (event) => events.push(event) },
    operations: [
      { operation: operation(), authorize: (actor) => actor.scopes.includes("demo:use"), execute: (input) => output({ total: input.amount * 2 }) },
      { operation: operation({ id: "demo.adjust", effect: "write", confirmation: "explicit" }),
        authorize: (actor) => actor.tenantId === "tenant-a" && actor.scopes.includes("demo:use"),
        execute: (input) => { writes++; return output({ applied: input.amount }); } },
      { operation: operation({ id: "demo.fail" }), authorize: (actor) => actor.scopes.includes("demo:use"),
        execute: () => { throw new Error("PRIVATE-CANARY credential"); } },
    ],
  });
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  gateway?.closeAllConnections();
  backend?.closeAllConnections();
  await Promise.all([gateway, backend].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function api(path, payload, token = "analyst", headers = {}) {
  const response = await fetch(`${base}/v1/aug/${path}`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function finish(current, token = "analyst") {
  return settled(async () => {
    const response = await api("invocations/control", control(current), token);
    assert.ok(response.status === 200 || response.status === 202);
    return response.body;
  });
}

test("authorized operation discovery exposes versioned contracts without records or credentials", async () => {
  const response = await api("operations");
  assert.equal(response.status, 200);
  assert.equal(response.body.protocolVersion, protocolVersion);
  assert.equal(response.body.operations.length, 4);
  const read = response.body.operations.find(({ id }) => id === "demo.customers.list");
  assert.equal(read.effect, "read");
  assert.equal(read.inputSchema.properties.limit.minimum, 1);
  assert.doesNotMatch(JSON.stringify(response.body), /CANARY|Aurora|demo-backend-service-token|internalNotes/);
  assert.deepEqual((await api("operations", undefined, "denied")).body.operations, []);
});

test("a declared search runs directly through AUG without a UI plan or model call", async () => {
  const response = await api("invocations", invoke({ requestId: "search-1", operationId: "demo.customers.list", input: { q: "CANARY", limit: 1 } }));
  assert.equal(response.status, 202);
  const result = await finish(response.body);
  assert.equal(result.state, "succeeded");
  assert.equal(result.output.audience, "view");
  assert.equal(result.output.representation.profile, "aug.json/0.1");
  const value = result.output.representation.delivery.value;
  assert.equal(value.rows.length, 1);
  assert.equal(value.rows[0].name, "Aurora CANARY-A-7F3A");
  assert.deepEqual(Object.keys(value.rows[0]).sort(), ["amountDue", "city", "id", "name"]);
  assert.doesNotMatch(JSON.stringify(result), /internalNotes|Borealis|CANARY-NOTE/);
  assert.equal(planCalls, 0);
  const other = await api("invocations", invoke({ requestId: "search-1", operationId: "demo.customers.list", input: { q: "CANARY", limit: 1 } }), "other");
  const otherResult = await finish(other.body, "other");
  assert.equal(otherResult.output.representation.delivery.value.rows[0].name, "Borealis CANARY-B-9B2E");
  assert.doesNotMatch(JSON.stringify(otherResult), /Aurora|CANARY-A/);
  const invalid = await api("invocations", invoke({ requestId: "invalid-search", operationId: "demo.customers.list", input: { limit: 0 } }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "INVALID_INPUT");
});

test("the same HTTP contract invokes an unrelated native backend operation and deduplicates retries", async () => {
  const request = invoke({ requestId: "calculate-1", input: { amount: 12 } });
  const response = await api("invocations", request);
  const completed = await finish(response.body);
  assert.deepEqual(completed.output.representation.delivery.value, { total: 24 });
  const replay = await api("invocations", request);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, completed.id);
  const conflict = await api("invocations", { ...request, input: { amount: 13 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
  const stale = await api("invocations", invoke({ operationVersion: "2" }));
  assert.equal(stale.status, 409);
});

test("HTTP effects require an owned, version-bound confirmation of immutable input", async () => {
  const prepared = await api("invocations", invoke({ requestId: "write-1", operationId: "demo.adjust", input: { amount: 7, note: "PRIVATE-CANARY" } }));
  assert.equal(prepared.status, 202);
  assert.equal(prepared.body.state, "awaiting_confirmation");
  assert.equal(writes, 0);
  const confirmation = control(prepared.body, "confirm");
  const changed = await api("invocations/control", { ...confirmation, input: { amount: 90 } });
  assert.equal(changed.status, 400);
  assert.equal((await api("invocations/control", confirmation, "other")).status, 404);
  assert.equal((await api("invocations/control", confirmation, "denied")).status, 404);
  assert.equal((await api("invocations/control", { ...confirmation, token: "forged" })).status, 403);
  assert.equal(writes, 0);
  const confirmed = await api("invocations/control", confirmation);
  assert.equal(confirmed.status, 202);
  const result = await finish(confirmed.body);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.output.representation.delivery.value, { applied: 7 });
  await api("invocations/control", confirmation);
  assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-CANARY|amount|token|requestId|invocationId/);
});

test("handler failures expose a terminal code without raw backend messages", async () => {
  const prepared = await api("invocations", invoke({ requestId: "failure-1", operationId: "demo.fail" }));
  const result = await finish(prepared.body);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.error, { code: "OPERATION_FAILED" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CANARY|credential/);
});

test("new operation routes retain authentication and exact-origin preflight", async () => {
  for (const path of ["operations", "invocations", "invocations/control"]) {
    assert.equal((await api(path, {}, "")).status, 401);
    assert.equal((await api(path, {}, "analyst", { Origin: "https://untrusted.example" })).status, 403);
    const preflight = await fetch(`${base}/v1/aug/${path}`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  }
  const incompatible = await api("invocations", invoke({ requestId: "unsupported", operationId: "demo.adjust", runtime: { ...invoke().runtime, profiles: ["example.unsupported/1"] } }));
  assert.equal(incompatible.status, 406);
  assert.equal(incompatible.body.code, "NO_COMPATIBLE_REPRESENTATION");
});
