import test from "node:test";
import assert from "node:assert/strict";
import { principalFromEnv } from "@aug/mcp-apps-server";

test("defaults to the synthetic demo analyst", () => {
  assert.deepEqual(principalFromEnv({}), {
    id: "demo-analyst",
    tenantId: "tenant-a",
    scopes: ["customers:read"],
  });
});

test("reads identity, tenant and scopes from the environment", () => {
  assert.deepEqual(
    principalFromEnv({
      AUG_PRINCIPAL_ID: "user@example.com",
      AUG_TENANT_ID: "tenant-b",
      AUG_SCOPES: " customers:read , reports:read ",
    }),
    { id: "user@example.com", tenantId: "tenant-b", scopes: ["customers:read", "reports:read"] },
  );
  assert.deepEqual(principalFromEnv({ AUG_SCOPES: "" }).scopes, []);
});

test("invalid identity settings fail at startup", () => {
  for (const env of [
    { AUG_PRINCIPAL_ID: "" },
    { AUG_PRINCIPAL_ID: "bad id with spaces" },
    { AUG_TENANT_ID: "../tenant" },
    { AUG_SCOPES: "customers:read,bad scope" },
    { AUG_SCOPES: Array.from({ length: 51 }, (_, i) => `s${i}`).join(",") },
  ]) {
    assert.throws(() => principalFromEnv(env), /AUG_(PRINCIPAL_ID|TENANT_ID|SCOPES)/, JSON.stringify(env));
  }
});
