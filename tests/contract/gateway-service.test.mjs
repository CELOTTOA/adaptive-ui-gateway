import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayService } from "@aug/gateway-server";
import { protocolVersion } from "@aug/protocol";

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

test("unsupported runtime negotiation stops before the protected backend query", async () => {
  const events = [];
  const gateway = service({ onAudit: (event) => events.push(event) });
  const { planId } = await gateway.createPlan(principal, "Search", "demo.customers.list");
  await assert.rejects(gateway.queryOutput(principal, planId, "query-data", {}, {
    protocolVersions: [protocolVersion], profiles: ["example.unknown/1"],
    mediaTypes: ["application/json"], deliveryKinds: ["inline"],
  }), (error) => error.code === "NO_COMPATIBLE_REPRESENTATION");
  assert.deepEqual(events.map((event) => event.type), ["plan.created"]);
});
