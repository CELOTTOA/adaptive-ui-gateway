import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { discoverReadCapabilities } from "@aug/discovery-openapi";
import { DeterministicUiPlanner, toPlanningCapability } from "@aug/ui-planner";
import { validateUiPlan } from "@aug/ui-schema";

const source = await readFile(
  new URL("../../examples/customer-api/openapi.json", import.meta.url),
  "utf8",
);
const principal = { id: "analyst", tenantId: "tenant-a", scopes: ["customers:read"] };
const bindingPolicyId = "protected.standalone.read-only.v1";

function fixture() {
  const imported = discoverReadCapabilities(source);
  assert.equal(imported.length, 1);
  const capability = imported[0].capability;
  const planningCapability = toPlanningCapability(capability, principal);
  const plan = new DeterministicUiPlanner().createSearchPlan({
    intent: "Search customers",
    capability: planningCapability,
    bindingPolicyId,
  });
  return { capability, planningCapability, plan };
}

function validationOptions(capability) {
  return { capabilities: [capability], principal, allowedBindingPolicyIds: [bindingPolicyId] };
}

test("OpenAPI discovery and deterministic planning expose approved metadata only", () => {
  const { capability, planningCapability, plan } = fixture();
  assert.equal(capability.effect, "read");
  assert.deepEqual(planningCapability.fields, ["id", "name", "city", "amountDue"]);
  assert.equal(validateUiPlan(plan, validationOptions(capability)), plan);
  const planningPayload = JSON.stringify({ planningCapability, plan });
  assert.doesNotMatch(planningPayload, /CANARY|Nimbus Trattoria|demo-backend-service-token/);
});

test("an unknown component is rejected", () => {
  const { capability, plan } = fixture();
  plan.components.push({ id: "unsafe", type: "script", text: "alert(1)" });
  assert.throws(
    () => validateUiPlan(plan, validationOptions(capability)),
    (error) => error.code === "INVALID_UI_PLAN",
  );
});

test("an unknown action target is rejected", () => {
  const { capability, plan } = fixture();
  plan.actions[0].dataSourceId = "guessed-source";
  assert.throws(
    () => validateUiPlan(plan, validationOptions(capability)),
    (error) => error.code === "INVALID_UI_PLAN",
  );
});

test("a protected or unknown field cannot be added to a plan", () => {
  for (const field of ["internalNotes", "tenantId", "notInSchema"]) {
    const { capability, plan } = fixture();
    plan.dataSources[0].fields.push(field);
    assert.throws(
      () => validateUiPlan(plan, validationOptions(capability)),
      (error) => error.code === "INVALID_UI_PLAN",
    );
  }
});

test("an unapproved binding policy is rejected", () => {
  const { capability, plan } = fixture();
  plan.dataSources[0].bindingPolicyId = "unrestricted";
  assert.throws(
    () => validateUiPlan(plan, validationOptions(capability)),
    (error) => error.code === "INVALID_UI_PLAN",
  );
});
