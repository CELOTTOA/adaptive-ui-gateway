import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPlannerFromEnv } from "@aug/gateway-server";
import { discoverReadCapabilities } from "@aug/discovery-openapi";
import { toPlanningCapability } from "@aug/ui-planner";

const source = await readFile(
  new URL("../../examples/customer-api/openapi.json", import.meta.url),
  "utf8",
);
const principal = { id: "analyst", tenantId: "tenant-a", scopes: ["customers:read"] };

function planningInput() {
  const capability = discoverReadCapabilities(source)[0].capability;
  return {
    intent: "Search customers",
    capability: toPlanningCapability(capability, principal),
    bindingPolicyId: "protected.standalone.read-only.v1",
  };
}

// A provider HTTP call that never answers until aborted.
const hangingFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

test("without an API key the deterministic planner is used", () => {
  const config = createPlannerFromEnv({});
  assert.equal(config.planner, undefined);
  assert.equal(config.description, "deterministic");
});

test("defaults to the fast Grok model and a 10 s timeout", () => {
  const config = createPlannerFromEnv({ GROK_API_KEY: "k" });
  assert.ok(config.planner);
  assert.equal(config.description, "model-assisted (grok-4.20-0309-non-reasoning, timeout 10000 ms)");
});

test("XAI_MODEL and PLANNER_TIMEOUT_MS are applied", async () => {
  const events = [];
  const config = createPlannerFromEnv(
    { GROK_API_KEY: "k", XAI_MODEL: "grok-4.3", PLANNER_TIMEOUT_MS: "1000" },
    { fetch: hangingFetch, onEvent: (event) => events.push(event) },
  );
  assert.equal(config.description, "model-assisted (grok-4.3, timeout 1000 ms)");
  const result = await config.planner.planSearch(planningInput());
  assert.equal(result.source, "deterministic-fallback");
  assert.equal(result.fallbackReason, "timeout");
  assert.equal(events[0].providerId, "xai:grok-4.3");
  assert.ok(events[0].durationMs >= 900 && events[0].durationMs < 5000);
});

test("invalid timeouts are rejected at startup", () => {
  for (const value of ["", "abc", "999", "60001", "1500.5", "-1", "1e4"]) {
    assert.throws(
      () => createPlannerFromEnv({ GROK_API_KEY: "k", PLANNER_TIMEOUT_MS: value }),
      /PLANNER_TIMEOUT_MS must be an integer between 1000 and 60000/,
      `value ${JSON.stringify(value)}`,
    );
  }
});
