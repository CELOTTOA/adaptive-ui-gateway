import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { startCustomerApi } from "@aug/example-customer-api";
import { GatewayService, startGatewayServer } from "@aug/gateway-server";
import { createAugMcpServer, searchViewUri, toolNames, ViewOriginRegistry } from "@aug/mcp-apps-server";

const backendToken = "demo-backend-service-token";
const accessToken = "demo-analyst-token";
const principal = { id: "analyst", tenantId: "tenant-a", scopes: ["customers:read"] };
const canaries = /CANARY|Aurora|Borealis|Nimbus/;

let backend;
let gateway;
let gatewayUrl;
let client;
let server;

before(async () => {
  backend = await startCustomerApi({ port: 0, backendToken });
  const openApiSource = await readFile(
    new URL("../../examples/customer-api/openapi.json", import.meta.url),
    "utf8",
  );
  const backendBaseUrl = `http://127.0.0.1:${backend.address().port}`;
  const service = new GatewayService({ openApiSource, backendBaseUrl, backendToken });
  const viewOrigins = new ViewOriginRegistry(["null"]);
  gateway = await startGatewayServer({
    port: 0,
    openApiSource,
    backendBaseUrl,
    backendToken,
    authenticate: (token) => (token === accessToken ? principal : undefined),
    allowedOrigins: viewOrigins.allowedOrigins,
  });
  gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
  server = await createAugMcpServer({ service, principal, directGatewayOrigin: gatewayUrl, viewOrigins });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await server?.close();
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => backend.close(resolve));
});

function modelVisible(result) {
  return JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
}

async function createView() {
  return client.callTool({
    name: toolNames.createView,
    arguments: { intent: "Search customers by name or city", capabilityId: "demo.customers.list" },
  });
}

async function direct(path, input, options = {}) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.token ?? accessToken}`,
      "Content-Type": "application/json",
      Origin: options.origin ?? "null",
    },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  return { response, body };
}

async function createDirectPlan() {
  const opened = await createView();
  const created = await direct("/v1/plans", opened.structuredContent.view);
  assert.equal(created.response.status, 201);
  return { opened, created };
}

test("the host can open views but has no data query tool", async () => {
  const { tools } = await client.listTools();
  const view = tools.find((tool) => tool.name === toolNames.createView);
  assert.equal(view._meta.ui.resourceUri, searchViewUri);
  assert.ok(!view._meta.ui.visibility || view._meta.ui.visibility.includes("model"));
  assert.ok(!tools.some((tool) => tool.name === "aug_query_records"));
  const registration = tools.find((tool) => tool.name === toolNames.registerOrigin);
  assert.deepEqual(registration._meta.ui.visibility, ["app"]);
});

test("a new conversation registers only its exact origin, while data still requires credentials", async () => {
  const origin = `https://${"c".repeat(32)}.claudemcpcontent.com`;
  const sibling = `https://${"d".repeat(32)}.claudemcpcontent.com`;
  const preflight = (value) => fetch(`${gatewayUrl}/v1/plans`, {
    method: "OPTIONS",
    headers: { Origin: value, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
  });
  assert.equal((await preflight(origin)).status, 403);
  const registered = await client.callTool({ name: toolNames.registerOrigin, arguments: { origin } });
  assert.notEqual(registered.isError, true);
  assert.doesNotMatch(JSON.stringify(registered), canaries);
  assert.doesNotMatch(JSON.stringify(registered), /planId|demo-analyst-token|demo-backend-service-token/);
  const accepted = await preflight(origin);
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get("access-control-allow-origin"), origin);
  assert.equal((await preflight(sibling)).status, 403);
  const opened = await createView();
  const denied = await direct("/v1/plans", opened.structuredContent.view, { origin, token: "wrong-token" });
  assert.equal(denied.response.status, 401);
  const created = await direct("/v1/plans", opened.structuredContent.view, { origin });
  assert.equal(created.response.status, 201);
  const result = await direct("/v1/data/query", {
    planId: created.body.planId, actionId: "query-data", state: { filters: { q: "CANARY" } },
  }, { origin });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.rows.length, 1);
  const refused = await client.callTool({ name: toolNames.registerOrigin, arguments: { origin: "https://untrusted.example" } });
  assert.equal(refused.isError, true);
});

test("the fixed view can connect only to the direct gateway and needs no custom result metadata", async () => {
  const { contents } = await client.readResource({ uri: searchViewUri });
  assert.equal(contents.length, 1);
  const [resource] = contents;
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  assert.match(resource.text, /<script type="module">/);
  assert.match(resource.text, /function renderPlan\(root, plan/);
  assert.match(resource.text, /\/v1\/plans/);
  assert.match(resource.text, /\/v1\/data\/query/);
  assert.doesNotMatch(resource.text, /aug_query_records|aug\/rows|aug\/view/);
  assert.doesNotMatch(resource.text, canaries);
  assert.doesNotMatch(resource.text, new RegExp(backendToken));
  assert.doesNotMatch(resource.text, new RegExp(accessToken));
  const csp = resource._meta?.ui?.csp ?? {};
  assert.deepEqual(csp.connectDomains ?? [], [gatewayUrl]);
  assert.deepEqual(csp.resourceDomains ?? [], []);
});

test("opening a view returns request metadata only and no session or plan in custom metadata", async () => {
  const result = await createView();
  assert.notEqual(result.isError, true);
  const visible = modelVisible(result);
  assert.doesNotMatch(visible, canaries);
  assert.doesNotMatch(visible, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.doesNotMatch(visible, new RegExp(accessToken));
  assert.match(visible, /Customer search/);
  assert.equal(result.structuredContent.transport, "direct");
  assert.deepEqual(result.structuredContent.view, {
    intent: "Search customers by name or city",
    capabilityId: "demo.customers.list",
  });
  assert.equal(result._meta, undefined);
});

test("the direct view channel creates plans and fetches records without exposing them to MCP", async () => {
  const { opened, created } = await createDirectPlan();
  assert.equal(created.body.plan.schemaVersion, "aug.ui/0.1");
  const result = await direct("/v1/data/query", {
    planId: created.body.planId,
    actionId: "query-data",
    state: { filters: { q: "CANARY" } },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("access-control-allow-origin"), "null");
  assert.equal(result.body.rows.length, 1);
  assert.equal(result.body.rows[0].name, "Aurora CANARY-A-7F3A");
  assert.deepEqual(Object.keys(result.body.rows[0]).sort(), ["amountDue", "city", "id", "name"]);
  assert.doesNotMatch(JSON.stringify(opened), canaries);
  assert.doesNotMatch(JSON.stringify(opened), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.doesNotMatch(JSON.stringify(result.body), /internalNotes|CANARY-NOTE|Borealis/);
});

test("direct queries reject forged sessions, actions and credentials without a host fallback", async () => {
  const { created } = await createDirectPlan();
  for (const input of [
    { planId: crypto.randomUUID(), actionId: "query-data", state: {} },
    { planId: created.body.planId, actionId: "forged-action", state: {} },
  ]) {
    const result = await direct("/v1/data/query", input);
    assert.equal(result.response.status, 404);
    assert.doesNotMatch(JSON.stringify(result.body), canaries);
  }
  const unauthenticated = await direct(
    "/v1/data/query",
    { planId: created.body.planId, actionId: "query-data", state: {} },
    { token: "wrong-token" },
  );
  assert.equal(unauthenticated.response.status, 401);
  const { tools } = await client.listTools();
  assert.ok(!tools.some((tool) => tool.name === "aug_query_records"));
});

test("the direct endpoint answers preflight only for an allowed view origin", async () => {
  const preflight = await fetch(`${gatewayUrl}/v1/plans`, {
    method: "OPTIONS",
    headers: {
      Origin: "null",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "null");
  assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/);
  const denied = await direct(
    "/v1/plans",
    { intent: "Search", capabilityId: "demo.customers.list" },
    { origin: "https://untrusted.example" },
  );
  assert.equal(denied.response.status, 403);
  assert.equal(denied.response.headers.get("access-control-allow-origin"), null);
});
