import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startCustomerApi } from "@aug/example-customer-api";
import { startGatewayServer } from "@aug/gateway-server";
import { httpsJson } from "../helpers/https-client.mjs";

const backendToken = "demo-backend-service-token";
const token = "demo-analyst-token";
const principal = { id: "analyst", tenantId: "tenant-a", scopes: ["customers:read"] };
const origin = "codex-sandbox://mcp-app-759ffd0cc15e6b093ffcc9e0beb80edc046100e46aa928f0.web-sandbox.oaiusercontent.com";
const cert = await readFile(new URL("../fixtures/tls/test-only.cert.pem", import.meta.url));
const key = await readFile(new URL("../fixtures/tls/test-only.key.pem", import.meta.url));
let backend, gateway, gatewayUrl;

before(async () => {
  backend = await startCustomerApi({ port: 0, backendToken });
  const openApiSource = await readFile(new URL("../../examples/customer-api/openapi.json", import.meta.url), "utf8");
  gateway = await startGatewayServer({
    port: 0, openApiSource, backendBaseUrl: `http://127.0.0.1:${backend.address().port}`,
    backendToken, authenticate: (value) => value === token ? principal : undefined,
    allowedOrigins: [origin], tls: { cert, key },
  });
  gatewayUrl = `https://127.0.0.1:${gateway.address().port}`;
});

after(async () => {
  gateway?.closeAllConnections();
  backend?.closeAllConnections();
  await Promise.all([gateway, backend].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
});

test("HTTPS verifies the certificate and needs explicit trust for a self-signed fixture", async () => {
  await assert.rejects(httpsJson(`${gatewayUrl}/health`), (error) => error.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
  const trusted = await httpsJson(`${gatewayUrl}/health`, { ca: cert });
  assert.equal(trusted.status, 200);
  assert.deepEqual(trusted.body, { status: "ok", mode: "protected" });
});

test("HTTPS supports native-origin CORS, authenticated plans and protected queries", async () => {
  const preflight = await httpsJson(`${gatewayUrl}/v1/plans`, {
    ca: cert, method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  const headers = { Origin: origin, Authorization: `Bearer ${token}` };
  const created = await httpsJson(`${gatewayUrl}/v1/plans`, {
    ca: cert, method: "POST", headers,
    body: { intent: "Search customers", capabilityId: "demo.customers.list" },
  });
  assert.equal(created.status, 201);
  const queried = await httpsJson(`${gatewayUrl}/v1/data/query`, {
    ca: cert, method: "POST", headers,
    body: { planId: created.body.planId, actionId: "query-data", state: { filters: { q: "CANARY" } } },
  });
  assert.equal(queried.status, 200);
  assert.equal(queried.body.rows.length, 1);
  assert.equal(queried.body.rows[0].name, "Aurora CANARY-A-7F3A");
  const refused = await httpsJson(`${gatewayUrl}/v1/plans`, {
    ca: cert, method: "OPTIONS", headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["access-control-allow-origin"], undefined);
  const unauthorized = await httpsJson(`${gatewayUrl}/v1/plans`, {
    ca: cert, method: "POST", headers: { Origin: origin },
    body: { intent: "Search", capabilityId: "demo.customers.list" },
  });
  assert.equal(unauthorized.status, 401);
});

test("same-origin HTTPS is accepted without trusting an unconfigured cross-origin caller", async () => {
  const created = await httpsJson(`${gatewayUrl}/v1/plans`, {
    ca: cert, method: "POST", headers: { Origin: gatewayUrl, Authorization: `Bearer ${token}` },
    body: { intent: "Search", capabilityId: "demo.customers.list" },
  });
  assert.equal(created.status, 201);
});
