import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startCustomerApi } from "@aug/example-customer-api";
import { startGatewayServer } from "@aug/gateway-server";
import { ModelAssistedUiPlanner } from "@aug/ui-planner";
import { profiles, protocolVersion } from "@aug/protocol";
import { RecordingModelProvider } from "../helpers/recording-model-provider.mjs";

const backendToken = "demo-backend-service-token";
const tokens = {
  analyst: "demo-analyst-token",
  otherTenant: "demo-other-tenant-token",
  noScope: "demo-no-scope-token",
};
const principals = new Map([
  [tokens.analyst, { id: "analyst", tenantId: "tenant-a", scopes: ["customers:read"] }],
  [tokens.otherTenant, { id: "other", tenantId: "tenant-b", scopes: ["customers:read"] }],
  [tokens.noScope, { id: "no-scope", tenantId: "tenant-a", scopes: [] }],
]);

let backend;
let gateway;
let gatewayUrl;
let backendUrl;
const defaultLayout = {
  title: "Customer search",
  columns: [
    { field: "id", label: "ID" },
    { field: "name", label: "Customer" },
    { field: "city", label: "City" },
    { field: "amountDue", label: "Amount due" },
  ],
  includeSearch: true,
  searchLabel: "Search",
  statusText: "Ready",
};
let modelResponse = () => JSON.stringify(defaultLayout);
const provider = new RecordingModelProvider((request, options) => modelResponse(request, options));
const plannerEvents = [];
const protocolRuntime = {
  protocolVersions: [protocolVersion],
  profiles: [profiles.collection, profiles.json],
  mediaTypes: ["application/json"],
  deliveryKinds: ["inline"],
};

before(async () => {
  backend = await startCustomerApi({ port: 0, backendToken });
  const backendAddress = backend.address();
  assert.equal(typeof backendAddress, "object");
  backendUrl = `http://127.0.0.1:${backendAddress.port}`;
  const openApiSource = await readFile(
    new URL("../../examples/customer-api/openapi.json", import.meta.url),
    "utf8",
  );
  gateway = await startGatewayServer({
    port: 0,
    openApiSource,
    backendBaseUrl: backendUrl,
    backendToken,
    authenticate: (token) => principals.get(token),
    planner: new ModelAssistedUiPlanner({
      provider,
      onEvent: (event) => plannerEvents.push(event),
    }),
  });
  const gatewayAddress = gateway.address();
  assert.equal(typeof gatewayAddress, "object");
  gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}`;
});

after(async () => {
  await Promise.all([
    gateway?.listening ? new Promise((resolve) => gateway.close(resolve)) : Promise.resolve(),
    backend?.listening ? new Promise((resolve) => backend.close(resolve)) : Promise.resolve(),
  ]);
});

async function api(path, token, options = {}) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

async function createPlan(token = tokens.analyst) {
  return api("/v1/plans", token, {
    method: "POST",
    body: JSON.stringify({
      intent: "Search customers by name or city",
      capabilityId: "demo.customers.list",
    }),
  });
}

async function queryPlan(planId, token = tokens.analyst, actionId = "query-data", q = "") {
  return api("/v1/data/query", token, {
    method: "POST",
    body: JSON.stringify({ planId, actionId, state: { filters: { q } } }),
  });
}

async function queryOutput(planId, runtime = protocolRuntime, options = {}) {
  return api("/v1/aug/query", options.token ?? tokens.analyst, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify({
      planId, actionId: options.actionId ?? "query-data",
      state: { filters: { q: options.q ?? "CANARY" } }, runtime,
    }),
  });
}

test("negotiated HTTP output keeps tenant projection and records on the view data plane", async () => {
  const plan = await createPlan();
  const { response, body } = await queryOutput(plan.body.planId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.protocolVersion, protocolVersion);
  assert.equal(body.audience, "view");
  assert.equal(body.representation.profile, profiles.collection);
  assert.deepEqual(body.representation.audiences, ["view"]);
  const content = body.representation.delivery.value;
  assert.deepEqual(content.columns.map(({ key }) => key), ["id", "name", "city", "amountDue"]);
  assert.equal(content.rows.length, 1);
  assert.equal(content.rows[0].name, "Aurora CANARY-A-7F3A");
  assert.doesNotMatch(JSON.stringify(body), /internalNotes|CANARY-NOTE|Borealis/);
  assert.doesNotMatch(provider.channel(), /CANARY/);
  assert.equal("representations" in body, false);
});

test("JSON-only runtimes receive an explicit alternative with schema preserved on empty results", async () => {
  const plan = await createPlan();
  const { response, body } = await queryOutput(plan.body.planId, {
    ...protocolRuntime, profiles: [profiles.json],
  }, { q: "NO-SUCH-CUSTOMER" });
  assert.equal(response.status, 200);
  assert.equal(body.representation.profile, profiles.json);
  assert.deepEqual(body.representation.delivery.value.rows, []);
  assert.deepEqual(body.representation.delivery.value.columns.map(({ key }) => key), ["id", "name", "city", "amountDue"]);
  assert.equal(body.audience, "view");
});

test("negotiated queries retain authentication, session, action and origin checks", async () => {
  const plan = await createPlan();
  const unauthenticated = await api("/v1/aug/query", undefined, {
    method: "POST", body: JSON.stringify({ runtime: protocolRuntime }),
  });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal((await queryOutput(plan.body.planId, protocolRuntime, { token: tokens.otherTenant })).response.status, 404);
  assert.equal((await queryOutput(plan.body.planId, protocolRuntime, { token: tokens.noScope })).response.status, 404);
  assert.equal((await queryOutput(plan.body.planId, protocolRuntime, { actionId: "forged-action" })).response.status, 404);
  assert.equal((await queryOutput(plan.body.planId, protocolRuntime, { headers: { Origin: "https://untrusted.example" } })).response.status, 403);
});

test("invalid and incompatible runtime declarations have distinct safe HTTP errors", async () => {
  const plan = await createPlan();
  const invalid = await queryOutput(plan.body.planId, { extra: "PRIVATE-CANARY" });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.code, "INVALID_RUNTIME");
  assert.doesNotMatch(JSON.stringify(invalid.body), /PRIVATE-CANARY/);
  for (const runtime of [
    { ...protocolRuntime, profiles: ["example.unsupported/1"] },
    { ...protocolRuntime, protocolVersions: ["aug/999"] },
    { ...protocolRuntime, deliveryKinds: ["reference"] },
  ]) {
    const unsupported = await queryOutput(plan.body.planId, runtime);
    assert.equal(unsupported.response.status, 406);
    assert.equal("representation" in unsupported.body, false);
  }
});

test("standalone renderer assets are served with a restrictive CSP", async () => {
  const page = await fetch(`${gatewayUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await page.text(), /Protected read-only demo/);
  const renderer = await fetch(`${gatewayUrl}/renderer.js`);
  assert.equal(renderer.status, 200);
  assert.match(await renderer.text(), /import \{ renderPlan \} from "\/plan-renderer\.js"/);
  const shared = await fetch(`${gatewayUrl}/plan-renderer.js`);
  assert.equal(shared.status, 200);
  assert.match(shared.headers.get("content-type"), /text\/javascript/);
  assert.match(await shared.text(), /export function renderPlan\(root, plan/);
});

test("model-assisted planning returns a valid plan without customer canaries or credentials", async () => {
  const { response, body } = await createPlan();
  assert.equal(response.status, 201);
  assert.equal(body.planner.source, "model");
  assert.equal(body.plan.schemaVersion, "aug.ui/0.1");
  assert.deepEqual(body.plan.dataSources[0].fields, ["id", "name", "city", "amountDue"]);
  assert.equal(provider.requests.length > 0, true);
  const modelChannel = provider.channel();
  assert.doesNotMatch(modelChannel, /CANARY|Nimbus Trattoria|Borealis|Aurora/);
  assert.doesNotMatch(modelChannel, new RegExp(backendToken));
  assert.doesNotMatch(modelChannel, new RegExp(tokens.analyst));
});

test("a malicious model response falls back without widening data access", async () => {
  modelResponse = () =>
    JSON.stringify({
      ...defaultLayout,
      columns: [{ field: "internalNotes", label: "Notes" }],
      bindingPolicyId: "unrestricted",
    });
  try {
    const plan = await createPlan();
    assert.equal(plan.response.status, 201);
    assert.equal(plan.body.planner.source, "deterministic-fallback");
    assert.equal(plannerEvents.at(-1).fallbackReason, "invalid_output");
    const result = await queryPlan(plan.body.planId, tokens.analyst, "query-data", "CANARY");
    assert.equal(result.response.status, 200);
    assert.deepEqual(Object.keys(result.body.rows[0]).sort(), ["amountDue", "city", "id", "name"]);
    assert.doesNotMatch(JSON.stringify(result.body), /internalNotes|CANARY-NOTE/);
  } finally {
    modelResponse = () => JSON.stringify(defaultLayout);
  }
});

test("authorized renderer fetch returns only tenant rows and approved fields", async () => {
  const plan = await createPlan();
  const result = await queryPlan(plan.body.planId, tokens.analyst, "query-data", "CANARY");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.rows.length, 1);
  assert.equal(result.body.rows[0].name, "Aurora CANARY-A-7F3A");
  assert.deepEqual(Object.keys(result.body.rows[0]).sort(), ["amountDue", "city", "id", "name"]);
  assert.doesNotMatch(JSON.stringify(result.body), /internalNotes|tenantId|CANARY-NOTE/);
  assert.doesNotMatch(provider.channel(), /CANARY/);
});

test("a plan session cannot be replayed by another tenant or a guessed identifier", async () => {
  const plan = await createPlan();
  const crossTenant = await queryPlan(plan.body.planId, tokens.otherTenant);
  assert.equal(crossTenant.response.status, 404);
  const guessed = await queryPlan(crypto.randomUUID(), tokens.analyst);
  assert.equal(guessed.response.status, 404);
});

test("each tenant receives only its own backend records", async () => {
  const plan = await createPlan(tokens.otherTenant);
  const result = await queryPlan(plan.body.planId, tokens.otherTenant, "query-data", "CANARY");
  assert.equal(result.response.status, 200);
  assert.equal(result.body.rows.length, 1);
  assert.equal(result.body.rows[0].name, "Borealis CANARY-B-9B2E");
  assert.doesNotMatch(JSON.stringify(result.body), /Aurora|CANARY-A/);
});

test("missing scopes, unknown actions and untrusted origins fail closed", async () => {
  const deniedPlan = await createPlan(tokens.noScope);
  assert.equal(deniedPlan.response.status, 404);
  const plan = await createPlan();
  const unknownAction = await queryPlan(plan.body.planId, tokens.analyst, "forged-action");
  assert.equal(unknownAction.response.status, 404);
  const untrustedOrigin = await api("/v1/plans", tokens.analyst, {
    method: "POST",
    headers: { Origin: "https://untrusted.example" },
    body: JSON.stringify({ intent: "Search", capabilityId: "demo.customers.list" }),
  });
  assert.equal(untrustedOrigin.response.status, 403);
});

test("the backend rejects direct requests without its server-side credential", async () => {
  const response = await fetch(`${backendUrl}/customers`, {
    headers: { "X-AUG-Tenant": "tenant-a" },
  });
  assert.equal(response.status, 401);
});
