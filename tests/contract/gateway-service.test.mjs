import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayService } from "@aug/gateway-server";

const openApiSource = await readFile(
  new URL("../../examples/customer-api/openapi.json", import.meta.url),
  "utf8",
);
const principal = { id: "analyst", tenantId: "tenant-a", scopes: ["customers:read"] };

function service(options = {}) {
  return new GatewayService({
    openApiSource,
    backendBaseUrl: "http://127.0.0.1:1",
    backendToken: "unused",
    ...options,
  });
}

test("expired plan sessions are removed when new plans are created", async () => {
  const gateway = service({ planTtlMs: 20 });
  await gateway.createPlan(principal, "Search", "demo.customers.list");
  await gateway.createPlan(principal, "Search", "demo.customers.list");
  assert.equal(gateway.sessionCount, 2);
  await delay(40);
  await gateway.createPlan(principal, "Search", "demo.customers.list");
  assert.equal(gateway.sessionCount, 1);
});

test("the number of live sessions is bounded", async () => {
  const gateway = service({ maxSessions: 2 });
  await gateway.createPlan(principal, "Search", "demo.customers.list");
  await gateway.createPlan(principal, "Search", "demo.customers.list");
  await assert.rejects(
    gateway.createPlan(principal, "Search", "demo.customers.list"),
    (error) => error.code === "TOO_MANY_SESSIONS" && error.status === 503,
  );
});
