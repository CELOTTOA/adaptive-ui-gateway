import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { searchViewUri, toolNames } from "@aug/mcp-apps-server";

const entrypoint = fileURLToPath(new URL("../../apps/mcp-apps-server/dist/main.js", import.meta.url));
const backendToken = "inventory-service-test-secret";
const accessToken = "inventory-view-test-secret";
const capabilityId = "inventory.stock.search";
const document = {
  openapi: "3.0.3", info: { title: "External inventory", version: "1" },
  paths: { "/stock": { get: {
    operationId: "searchStock", "x-aug-id": capabilityId, summary: "Inventory stock",
    "x-aug-effect": "read", "x-aug-required-scopes": ["stock:read"],
    parameters: [{ name: "q", in: "query", schema: { type: "string", maxLength: 200 } }],
    responses: { "200": { content: { "application/json": { schema: {
      type: "array", items: { type: "object", properties: {
        sku: { type: "string", "x-aug-classification": "internal" },
        quantity: { type: "integer", "x-aug-classification": "internal" },
        privateNote: { type: "string", "x-aug-classification": "restricted" },
      } },
    } } } } },
  } } },
};

function baseEnv() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AUG_"))),
    AUG_ENV_FILE: "", GROK_API_KEY: "" };
}

test("one MCP entrypoint connects an unrelated external backend and keeps its secrets/data out of MCP", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aug-external-"));
  const schema = join(directory, "inventory.json");
  const envFile = join(directory, "inventory.env");
  await writeFile(schema, JSON.stringify(document));
  const requests = [];
  const backend = createServer((request, response) => {
    const url = new URL(request.url, "http://inventory.local");
    requests.push({ path: url.pathname, authorization: request.headers.authorization, tenant: request.headers["x-aug-tenant"], principal: request.headers["x-aug-principal"] });
    response.setHeader("Content-Type", "application/json");
    if (request.method !== "GET" || url.pathname !== "/api/stock") { response.writeHead(404); return response.end("{}"); }
    if (request.headers.authorization !== `Bearer ${backendToken}` || request.headers["x-aug-tenant"] !== "warehouse") {
      response.writeHead(403); return response.end("{}");
    }
    response.end(JSON.stringify(url.searchParams.get("q") === "missing" ? [] :
      [{ sku: "BOX-CANARY-EXTERNAL", quantity: 17, privateNote: "EXTERNAL-NOTE-CANARY" }]));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    await unlink(schema); await unlink(envFile); await rmdir(directory);
  });
  const sourceOrigin = `http://127.0.0.1:${backend.address().port}/api`;
  // Forward slashes avoid dotenv interpreting Windows backslashes as quoted escapes.
  const envContents = Object.entries({
    AUG_OPENAPI_FILE: schema.replaceAll("\\", "/"), AUG_BACKEND_URL: sourceOrigin, AUG_BACKEND_TOKEN: backendToken,
    AUG_ACCESS_TOKEN: accessToken, AUG_PRINCIPAL_ID: "stock-reader", AUG_TENANT_ID: "warehouse", AUG_SCOPES: "stock:read",
  }).map(([key, value]) => `${key}=${value}`).join("\n");
  await writeFile(envFile, envContents);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint],
    env: { ...baseEnv(), AUG_ENV_FILE: envFile }, stderr: "pipe" });
  let diagnostics = "";
  transport.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const client = new Client({ name: "external-backend-host", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const catalog = await client.callTool({ name: toolNames.listCapabilities, arguments: {} });
  const capabilities = catalog.structuredContent.capabilities;
  assert.deepEqual(capabilities.map((item) => item.id), [capabilityId]);
  assert.deepEqual(capabilities[0].fields, ["sku", "quantity"]);
  assert.equal(capabilities[0].inputSchema.properties.q.type, "string");
  assert.equal(requests.length, 0, "discovery must not fetch backend records");
  const view = await client.callTool({ name: toolNames.createView,
    arguments: { intent: "Find stock", capabilityId } });
  const resource = await client.readResource({ uri: searchViewUri });
  const [gateway] = resource.contents[0]._meta.ui.csp.connectDomains;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Origin: "null" };
  const create = await fetch(`${gateway}/v1/plans`, { method: "POST", headers, body: JSON.stringify(view.structuredContent.view) });
  assert.equal(create.status, 201);
  const plan = await create.json();
  const runQuery = (q, token = accessToken) => fetch(`${gateway}/v1/data/query`, {
    method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ planId: plan.planId, actionId: "query-data", state: { filters: { q } } }),
  });
  const result = await runQuery("BOX");
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).rows, [{ sku: "BOX-CANARY-EXTERNAL", quantity: 17 }]);
  assert.deepEqual((await (await runQuery("missing")).json()).rows, []);
  assert.equal((await runQuery("BOX", "demo-analyst-token")).status, 401);
  assert.equal((await runQuery("BOX", backendToken)).status, 401);
  assert.ok(requests.every((request) => request.path === "/api/stock" && request.authorization === `Bearer ${backendToken}` && request.tenant === "warehouse" && request.principal === "stock-reader"));
  const mcpChannel = JSON.stringify({ catalog, view, resource }) + diagnostics;
  for (const value of [accessToken, backendToken, "BOX-CANARY-EXTERNAL", "EXTERNAL-NOTE-CANARY"]) {
    assert.equal(mcpChannel.includes(value), false);
  }
  const deniedTransport = new StdioClientTransport({ command: process.execPath, args: [entrypoint],
    env: { ...baseEnv(), AUG_ENV_FILE: envFile, AUG_SCOPES: "" }, stderr: "pipe" });
  deniedTransport.stderr.on("data", () => {});
  const deniedClient = new Client({ name: "no-scope-host", version: "0.0.0" });
  t.after(() => deniedClient.close());
  await deniedClient.connect(deniedTransport);
  const beforeDenied = requests.length;
  const deniedCatalog = await deniedClient.callTool({ name: toolNames.listCapabilities, arguments: {} });
  assert.deepEqual(deniedCatalog.structuredContent.capabilities, []);
  const deniedView = await deniedClient.callTool({ name: toolNames.createView, arguments: { intent: "Stock", capabilityId } });
  assert.equal(deniedView.isError, true);
  assert.equal(requests.length, beforeDenied);
  await deniedClient.close();
  await client.close();
  assert.equal((await fetch(`${sourceOrigin}/stock`)).status, 403, "closing AUG must leave the external backend running");
});

test("invalid external startup and missing env profiles exit without a demo fallback or secret output", () => {
  for (const overrides of [
    { AUG_BACKEND_URL: "http://127.0.0.1:4102", AUG_BACKEND_TOKEN: backendToken },
    { AUG_ENV_FILE: join(tmpdir(), "aug-profile-does-not-exist-7f3a.env") },
  ]) {
    const result = spawnSync(process.execPath, [entrypoint], { env: { ...baseEnv(), ...overrides },
      encoding: "utf8", timeout: 5_000, windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined, "startup must terminate rather than leave a listener running");
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /aug mcp-apps server ready/);
    assert.equal(result.stderr.includes(backendToken), false);
  }
});
