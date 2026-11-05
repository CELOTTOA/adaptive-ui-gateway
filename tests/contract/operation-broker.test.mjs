import test from "node:test";
import assert from "node:assert/strict";
import { OperationBroker } from "@aug/gateway-server";
import { principal, runtime, operation, invoke, control, output, settled } from "../helpers/operation-fixtures.mjs";

function setup(options = {}, descriptor = operation(), handler = (input) => output({ total: input.amount * 2 })) {
  let calls = 0;
  const broker = new OperationBroker(options);
  broker.register({ operation: descriptor,
    authorize: (actor) => actor.scopes.includes("demo:use"),
    execute: (input, context) => { calls++; return handler(input, context); },
  });
  return { broker, calls: () => calls, start: (request = invoke()) => broker.invoke(principal, request),
    finish: (current) => settled(() => broker.control(principal, control(current))) };
}

test("backend-native operations complete without a UI plan or model request", async () => {
  const { broker, start, finish, calls } = setup();
  const current = start();
  assert.equal(current.state, "running");
  const result = await finish(current);
  assert.equal(result.state, "succeeded");
  assert.equal(result.revision, 2);
  assert.equal(result.output.audience, "view");
  assert.deepEqual(result.output.representation.delivery.value, { total: 20 });
  assert.equal(calls(), 1);
  assert.equal(broker.list({ ...principal, scopes: [] }).length, 0);
  const list = broker.list(principal);
  list[0].version = "tampered";
  assert.equal(broker.list(principal)[0].version, "1");
});

test("invalid inputs, stale versions and incompatible runtimes never execute a handler", () => {
  const { start, calls } = setup();
  for (const request of [invoke({ input: { amount: 101 } }), invoke({ input: { amount: "10" } }), invoke({ input: { amount: 10, extra: true } })]) {
    assert.throws(() => start(request), (error) => error.code === "INVALID_INPUT");
  }
  assert.throws(() => start(invoke({ operationVersion: "2" })), (error) => error.code === "OPERATION_VERSION_MISMATCH");
  assert.throws(() => start(invoke({ runtime: { ...runtime, profiles: ["example.unsupported/1"] } })), (error) => error.code === "NO_COMPATIBLE_REPRESENTATION");
  assert.equal(calls(), 0);
});

test("in-flight and completed retries share one execution; reordered input keys are equivalent", async () => {
  let release;
  const { start, finish, calls } = setup({}, operation(), () => new Promise((resolve) => { release = resolve; }));
  const first = start(invoke({ input: { amount: 10, note: "memo" } }));
  const second = start(invoke({ input: { note: "memo", amount: 10 } }));
  assert.equal(first.id, second.id);
  await Promise.resolve();
  assert.equal(calls(), 1);
  release(output());
  const complete = await finish(first);
  const replay = start(invoke({ input: { amount: 10, note: "memo" } }));
  assert.equal(replay.id, complete.id);
  assert.equal(replay.state, "succeeded");
  assert.equal(calls(), 1);
  replay.output.representation.delivery.value.total = 999;
  assert.equal(start(invoke({ input: { amount: 10, note: "memo" } })).output.representation.delivery.value.total, 10);
  assert.throws(() => start(invoke({ input: { amount: 11 } })), (error) => error.code === "IDEMPOTENCY_CONFLICT");
});

test("confirmation executes the saved inputs once despite concurrent retries and client mutation", async () => {
  const events = [];
  let observed;
  const { broker, start, finish, calls } = setup({ onEvent: (event) => events.push(event) },
    operation({ effect: "write", confirmation: "explicit" }), (input, context) => {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(context.principal.scopes), true);
      observed = input.amount;
      return output({ changed: true });
    });
  const request = invoke({ input: { amount: 10, note: "PRIVATE-CANARY" } });
  const prepared = start(request);
  const confirmation = control(prepared, "confirm");
  assert.equal(prepared.state, "awaiting_confirmation");
  assert.equal(calls(), 0);
  request.input.amount = 99;
  prepared.confirmation.input.amount = 88;
  assert.throws(() => broker.control(principal, { ...confirmation, input: { amount: 50 } }), (error) => error.code === "INVALID_INVOCATION");
  assert.throws(() => broker.control(principal, { ...confirmation, token: "é".repeat(36) }), (error) => error.code === "CONFIRMATION_DENIED");
  const started = broker.control(principal, confirmation);
  assert.equal(started.revision, 2);
  broker.control(principal, confirmation);
  const finished = await finish(started);
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.revision, 3);
  broker.control(principal, confirmation);
  assert.equal(calls(), 1);
  assert.equal(observed, 10);
  assert.deepEqual(events.map(({ state }) => state), ["awaiting_confirmation", "running", "succeeded"]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-CANARY|amount|token|invocationId|requestId/);
  assert.equal(JSON.stringify(events).includes(confirmation.token), false);
});

test("ownership, permissions and token checks also apply to pending confirmations and status", () => {
  const { broker, start, calls } = setup({}, operation({ effect: "destructive", confirmation: "explicit" }));
  const pending = start();
  const confirm = control(pending, "confirm");
  for (const actor of [{ ...principal, tenantId: "tenant-b" }, { ...principal, id: "other" }]) {
    assert.throws(() => broker.control(actor, confirm), (error) => error.code === "INVOCATION_NOT_FOUND");
    assert.throws(() => broker.control(actor, control(pending)), (error) => error.code === "INVOCATION_NOT_FOUND");
  }
  assert.throws(() => broker.control({ ...principal, scopes: [] }, confirm), (error) => error.code === "OPERATION_NOT_FOUND");
  assert.throws(() => broker.control(principal, { ...confirm, token: "wrong" }), (error) => error.code === "CONFIRMATION_DENIED");
  assert.equal(calls(), 0);
});

test("a permission revoked between confirmation and handler dispatch prevents the effect", async () => {
  let permitted = true;
  let calls = 0;
  const broker = new OperationBroker();
  broker.register({
    operation: operation({ effect: "write", confirmation: "explicit" }),
    authorize: () => permitted,
    execute: () => { calls++; return output(); },
  });
  const pending = broker.invoke(principal, invoke());
  broker.control(principal, control(pending, "confirm"));
  permitted = false;
  await new Promise((resolve) => setImmediate(resolve));
  permitted = true;
  assert.equal(broker.control(principal, control(pending)).state, "failed");
  assert.equal(calls, 0);
});

test("confirmation expiry is terminal; retention bounds memory and the deduplication window", () => {
  let now = 1000;
  const { broker, start, calls } = setup({ now: () => now, confirmationTtlMs: 10, retentionMs: 20, maxInvocations: 1 },
    operation({ effect: "write", confirmation: "explicit" }));
  const pending = start();
  const confirm = control(pending, "confirm");
  assert.throws(() => start(invoke({ requestId: "other" })), (error) => error.code === "TOO_MANY_INVOCATIONS");
  now += 10;
  assert.equal(broker.control(principal, control(pending)).state, "expired");
  assert.throws(() => broker.control(principal, confirm), (error) => error.code === "CONFIRMATION_EXPIRED");
  assert.equal(start().state, "expired");
  now += 21;
  assert.throws(() => broker.control(principal, control(pending)), (error) => error.code === "INVOCATION_NOT_FOUND");
  assert.notEqual(start().id, pending.id);
  assert.equal(calls(), 0);
});

test("running invocations survive retention time until they settle", async () => {
  let now = 0;
  let release;
  const { start, finish } = setup({ now: () => now, retentionMs: 10, maxInvocations: 1 }, operation(), () => new Promise((resolve) => { release = resolve; }));
  const current = start();
  await Promise.resolve();
  now = 100;
  assert.equal(start().id, current.id);
  assert.throws(() => start(invoke({ requestId: "other" })), (error) => error.code === "TOO_MANY_INVOCATIONS");
  release(output());
  assert.equal((await finish(current)).state, "succeeded");
});

test("backend errors and undeclared output fail without exposing raw values or retrying effects", async () => {
  for (const handler of [
    () => { throw new Error("PRIVATE-CANARY service-token"); },
    () => ({ ...output(), representations: [{ ...output().representations[0], audiences: ["view", "model"] }] }),
    () => ({ ...output(), representations: [{ ...output().representations[0], id: "undeclared" }] }),
  ]) {
    const { start, finish, calls } = setup({}, operation(), handler);
    const result = await finish(start());
    assert.equal(result.state, "failed");
    assert.deepEqual(result.error, { code: "OPERATION_FAILED" });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CANARY|service-token/);
    assert.equal(start().state, "failed");
    assert.equal(calls(), 1);
  }
});

test("idempotency keys are scoped to the user and tenant and audit failures do not affect results", async () => {
  const { broker, start, finish, calls } = setup({ onEvent: () => { throw new Error("sink failure"); } });
  const first = start();
  const second = broker.invoke({ ...principal, tenantId: "tenant-b" }, invoke());
  const third = broker.invoke({ ...principal, id: "other" }, invoke());
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  assert.equal((await finish(first)).state, "succeeded");
  assert.equal(calls(), 3);
});
