import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { backendConfigFromEnv } from "@aug/mcp-apps-server";
import { ProtectedDataGateway } from "@aug/security";

const options = { cwd: process.cwd(), demoOpenApiFile: "/demo/openapi.json" };
const external = {
  AUG_OPENAPI_FILE: "inventory.openapi.json",
  AUG_BACKEND_URL: "http://127.0.0.1:4102/api",
  AUG_BACKEND_TOKEN: "external-backend-secret-7f3a",
  AUG_ACCESS_TOKEN: "external-view-secret-8a21",
  AUG_PRINCIPAL_ID: "reader", AUG_TENANT_ID: "inventory", AUG_SCOPES: "inventory:read",
};

test("IPv6 loopback URLs are accepted consistently by configuration and the data gateway", () => {
  const config = backendConfigFromEnv({ ...external, AUG_BACKEND_URL: "http://[::1]:4102" }, options);
  assert.doesNotThrow(() => new ProtectedDataGateway({ backendBaseUrl: config.backendBaseUrl, backendToken: config.backendToken }));
  assert.throws(() => backendConfigFromEnv({ ...external, AUG_BACKEND_URL: "http://[fe80::1]:4102" }, options), /AUG_BACKEND_URL/);
});

test("MCP backend configuration preserves the default demo and allows a separate view token", () => {
  const demo = backendConfigFromEnv({}, options);
  assert.equal(demo.mode, "demo");
  assert.equal(demo.openApiFile, options.demoOpenApiFile);
  assert.equal(demo.accessToken, "demo-analyst-token");
  assert.equal(backendConfigFromEnv({ AUG_ACCESS_TOKEN: external.AUG_ACCESS_TOKEN }, options).accessToken, external.AUG_ACCESS_TOKEN);
});

test("an external MCP backend resolves its schema and uses explicit identity and credentials", () => {
  const config = backendConfigFromEnv(external, options);
  assert.equal(config.mode, "external");
  assert.equal(config.openApiFile, resolve(options.cwd, external.AUG_OPENAPI_FILE));
  assert.equal(config.backendBaseUrl, external.AUG_BACKEND_URL);
  assert.deepEqual(config.principal, { id: "reader", tenantId: "inventory", scopes: ["inventory:read"] });
  assert.deepEqual(backendConfigFromEnv({ ...external, AUG_SCOPES: "" }, options).principal.scopes, []);
});

test("partial external MCP configuration never falls back to demo credentials or identity", () => {
  for (const key of Object.keys(external)) {
    const env = { ...external };
    delete env[key];
    assert.throws(() => backendConfigFromEnv(env, options), new RegExp(key));
  }
});

test("unsafe backend URLs and invalid/shared credentials fail without echoing their values", () => {
  for (const url of ["not a url", "http://public.example/api", "https://user:secret@example.com", "https://example.com/?secret=1", "file:///private"]) {
    assert.throws(() => backendConfigFromEnv({ ...external, AUG_BACKEND_URL: url }, options), /AUG_BACKEND_URL/);
  }
  for (const value of ["short", "secret-with-line\nbreak"]) {
    assert.throws(() => backendConfigFromEnv({ ...external, AUG_BACKEND_TOKEN: value }, options), (error) => {
      assert.equal(error.message.includes(value), false);
      return /AUG_BACKEND_TOKEN/.test(error.message);
    });
  }
  assert.throws(() => backendConfigFromEnv({ ...external, AUG_ACCESS_TOKEN: external.AUG_BACKEND_TOKEN }, options), /must differ/);
});
