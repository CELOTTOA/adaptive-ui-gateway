import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { searchViewUri, toolNames } from "@aug/mcp-apps-server";
import { httpsJson } from "../helpers/https-client.mjs";

test("multiple stdio instances start with independent direct gateways", { timeout: 20_000 }, async (t) => {
  const origins = [];
  const clients = [];
  const viewOrigin = "https://aug-view.example";
  for (let i = 0; i < 2; i++) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../apps/mcp-apps-server/dist/main.js", import.meta.url))],
      env: { ...process.env, GROK_API_KEY: "", AUG_VIEW_ORIGINS: `null,${viewOrigin}` },
      stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr.on("data", (chunk) => { diagnostics += chunk; });
    const client = new Client({ name: `parallel-host-${i}`, version: "0.0.0" });
    t.after(() => client.close());
    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close();
      throw new Error(`Instance ${i} did not start: ${diagnostics}`, { cause: error });
    }
    clients.push(client);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === toolNames.createView));
    const { contents } = await client.readResource({ uri: searchViewUri });
    const [origin] = contents[0]._meta.ui.csp.connectDomains;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(contents[0].text.includes(`const AUG_GATEWAY_ORIGIN = ${JSON.stringify(origin)}`));
    origins.push(origin);
  }
  assert.notEqual(origins[0], origins[1]);
  for (const origin of origins) {
    const response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", mode: "protected" });
    for (const [requestOrigin, expectedStatus] of [[viewOrigin, 204], ["https://untrusted.example", 403]]) {
      const preflight = await fetch(`${origin}/v1/plans`, {
        method: "OPTIONS",
        headers: {
          Origin: requestOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      assert.equal(preflight.status, expectedStatus);
      assert.equal(preflight.headers.get("access-control-allow-origin"), expectedStatus === 204 ? viewOrigin : null);
    }
  }
  for (const rotatedOrigin of [
    "https://aug-test.web-sandbox.oaiusercontent.com",
    "codex-sandbox://mcp-app-759ffd0cc15e6b093ffcc9e0beb80edc046100e46aa928f0.web-sandbox.oaiusercontent.com",
  ]) {
    const preflight = (gateway) => fetch(`${gateway}/v1/plans`, {
      method: "OPTIONS", headers: { Origin: rotatedOrigin, "Access-Control-Request-Method": "POST" },
    });
    assert.equal((await preflight(origins[0])).status, 403);
    const registered = await clients[0].callTool({ name: toolNames.registerOrigin, arguments: { origin: rotatedOrigin } });
    assert.notEqual(registered.isError, true);
    const accepted = await preflight(origins[0]);
    assert.equal(accepted.status, 204);
    assert.equal(accepted.headers.get("access-control-allow-origin"), rotatedOrigin);
    assert.equal((await preflight(origins[1])).status, 403, "registration must not affect another MCP process");
    const headers = { Origin: rotatedOrigin, Authorization: "Bearer demo-analyst-token", "Content-Type": "application/json" };
    const created = await fetch(`${origins[0]}/v1/plans`, {
      method: "POST", headers,
      body: JSON.stringify({ intent: "Search customers", capabilityId: "demo.customers.list" }),
    });
    assert.equal(created.status, 201);
    const plan = await created.json();
    const queried = await fetch(`${origins[0]}/v1/data/query`, {
      method: "POST", headers,
      body: JSON.stringify({ planId: plan.planId, actionId: "query-data", state: { filters: { q: "CANARY" } } }),
    });
    assert.equal(queried.status, 200);
    assert.equal((await queried.json()).rows.length, 1);
  }
});

test("a real stdio instance advertises and serves a verified HTTPS data gateway", { timeout: 20_000 }, async (t) => {
  const certPath = fileURLToPath(new URL("../fixtures/tls/test-only.cert.pem", import.meta.url));
  const keyPath = fileURLToPath(new URL("../fixtures/tls/test-only.key.pem", import.meta.url));
  const cert = await readFile(certPath);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../apps/mcp-apps-server/dist/main.js", import.meta.url))],
    env: { ...process.env, GROK_API_KEY: "", AUG_VIEW_ORIGINS: "null", AUG_GATEWAY_TLS_CERT: certPath, AUG_GATEWAY_TLS_KEY: keyPath },
    stderr: "pipe",
  });
  transport.stderr.on("data", () => {});
  const client = new Client({ name: "https-test-host", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const { contents } = await client.readResource({ uri: searchViewUri });
  const [gateway] = contents[0]._meta.ui.csp.connectDomains;
  assert.match(gateway, /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(contents[0].text.includes(`const AUG_GATEWAY_ORIGIN = ${JSON.stringify(gateway)}`));
  assert.doesNotMatch(contents[0].text, /BEGIN (?:RSA )?PRIVATE KEY/);
  const origin = "codex-sandbox://mcp-app-759ffd0cc15e6b093ffcc9e0beb80edc046100e46aa928f0.web-sandbox.oaiusercontent.com";
  const registered = await client.callTool({ name: toolNames.registerOrigin, arguments: { origin } });
  assert.notEqual(registered.isError, true);
  const headers = { Origin: origin, Authorization: "Bearer demo-analyst-token" };
  const created = await httpsJson(`${gateway}/v1/plans`, {
    ca: cert, method: "POST", headers, body: { intent: "Search customers", capabilityId: "demo.customers.list" },
  });
  assert.equal(created.status, 201);
  const queried = await httpsJson(`${gateway}/v1/data/query`, {
    ca: cert, method: "POST", headers,
    body: { planId: created.body.planId, actionId: "query-data", state: { filters: { q: "CANARY" } } },
  });
  assert.equal(queried.status, 200);
  assert.equal(queried.body.rows.length, 1);
});

test("an incomplete TLS configuration fails before starting the MCP server", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../apps/mcp-apps-server/dist/main.js", import.meta.url))], {
    env: { ...process.env, AUG_GATEWAY_TLS_CERT: "configured.cert.pem", AUG_GATEWAY_TLS_KEY: "" },
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUG_GATEWAY_TLS_CERT and AUG_GATEWAY_TLS_KEY must be configured together/);
  assert.equal(result.stdout, "");
});
