import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startCustomerApi } from "@aug/example-customer-api";
import { GatewayService } from "@aug/gateway-server";

const backendToken = "demo-backend-service-token";
const analyst = { id: "analyst", tenantId: "tenant-a", scopes: ["customers:read"] };
const other = { id: "other", tenantId: "tenant-b", scopes: ["customers:read"] };
const events = [];
let backend;
let service;

before(async () => {
  backend = await startCustomerApi({ port: 0, backendToken });
  service = new GatewayService({
    openApiSource: await readFile(
      new URL("../../examples/customer-api/openapi.json", import.meta.url),
      "utf8",
    ),
    backendBaseUrl: `http://127.0.0.1:${backend.address().port}`,
    backendToken,
    onAudit: (event) => events.push(event),
  });
});

after(() => new Promise((resolve) => backend.close(resolve)));

test("plan creation and queries emit value-free audit events", async () => {
  events.length = 0;
  const { planId } = await service.createPlan(analyst, "Search", "demo.customers.list");
  await service.query(analyst, planId, "query-data", { filters: { q: "CANARY" } });

  assert.deepEqual(
    events.map(({ type, principalId, tenantId, capabilityId, rowCount, planSource }) => ({
      type, principalId, tenantId, capabilityId, rowCount, planSource,
    })),
    [
      { type: "plan.created", principalId: "analyst", tenantId: "tenant-a", capabilityId: "demo.customers.list", rowCount: undefined, planSource: "deterministic" },
      { type: "query.executed", principalId: "analyst", tenantId: "tenant-a", capabilityId: "demo.customers.list", rowCount: 1, planSource: undefined },
    ],
  );
  assert.deepEqual(events[1].fields, ["id", "name", "city", "amountDue"]);
  for (const event of events) {
    assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
  }
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /CANARY|Aurora|Milano|1250/);
  assert.doesNotMatch(serialized, new RegExp(planId));
});

test("denied queries are audited with the error code only", async () => {
  events.length = 0;
  const { planId } = await service.createPlan(analyst, "Search", "demo.customers.list");
  await assert.rejects(service.query(other, planId, "query-data", {}));
  await assert.rejects(service.query(analyst, planId, "forged-action", {}));

  const denied = events.filter((event) => event.type === "query.denied");
  assert.deepEqual(
    denied.map(({ principalId, tenantId, code }) => ({ principalId, tenantId, code })),
    [
      { principalId: "other", tenantId: "tenant-b", code: "PLAN_SESSION_NOT_FOUND" },
      { principalId: "analyst", tenantId: "tenant-a", code: "ACTION_NOT_FOUND" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(events), new RegExp(planId));
});

test("an audit sink failure does not break or leak the request", async () => {
  const failing = new GatewayService({
    openApiSource: await readFile(
      new URL("../../examples/customer-api/openapi.json", import.meta.url),
      "utf8",
    ),
    backendBaseUrl: `http://127.0.0.1:${backend.address().port}`,
    backendToken,
    onAudit: () => {
      throw new Error("sink down");
    },
  });
  const { planId } = await failing.createPlan(analyst, "Search", "demo.customers.list");
  const result = await failing.query(analyst, planId, "query-data", {});
  assert.equal(result.rows.length > 0, true);
});
