import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { AugError } from "@aug/core";
import { OperationBroker, SqliteInvocationStore, MemoryInvocationStore, operationStoreFromEnv } from "@aug/gateway-server";
import { principal, operation, invoke, control, output, settled } from "../helpers/operation-fixtures.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "aug-state-"));
  const path = join(directory, "operations.sqlite"), key = randomBytes(32), owners = [];
  t.after(() => {
    for (const owner of owners.reverse()) { try { owner.close(); } catch {} }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "aug-state-"));
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, key, directory, owners, open(descriptor = operation(), execute = (input) => output({ total: input.amount * 2 }), options = {}) {
    const store = new SqliteInvocationStore({ path, key }); owners.push(store);
    const broker = new OperationBroker({ ...options, store }); owners.push(broker);
    broker.register({ operation: descriptor, authorize: (actor) => actor.scopes.includes("demo:use"), execute });
    return { store, broker };
  } };
}
const finish = (broker, current) => settled(() => broker.control(principal, control(current)));

test("completed output and request deduplication survive a real SQLite reopen", async (t) => {
  const f = fixture(t); let calls = 0;
  const execute = () => { calls++; return output({ private: "PRIVATE-RESULT-CANARY" }); };
  const first = f.open(operation(), execute);
  const started = first.broker.invoke(principal, invoke({ input: { amount: 10, note: "PRIVATE-INPUT-CANARY" } }));
  const completed = await finish(first.broker, started);
  assert.equal(completed.state, "succeeded");
  first.broker.close();
  const second = f.open(operation(), execute);
  const replay = second.broker.invoke(principal, invoke({ input: { amount: 10, note: "PRIVATE-INPUT-CANARY" } }));
  assert.equal(replay.id, started.id); assert.equal(replay.state, "succeeded"); assert.equal(calls, 1);
  assert.deepEqual(replay.output.representation.delivery.value, { private: "PRIVATE-RESULT-CANARY" });
  for (const name of readdirSync(f.directory)) {
    const bytes = readFileSync(join(f.directory, name));
    for (const value of ["PRIVATE-RESULT-CANARY", "PRIVATE-INPUT-CANARY", "demo.calculate", "analyst", "tenant-a", "request-1", f.key.toString("base64")]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, "private payload must not be plaintext on disk");
    }
  }
});

test("pending confirmations survive restart with the exact saved input and cannot change contracts", async (t) => {
  const f = fixture(t); let calls = 0;
  const descriptor = operation({ effect: "write", confirmation: "explicit" });
  const execute = (input) => { calls++; assert.equal(Object.isFrozen(input), true); return output({ applied: input.amount }); };
  const first = f.open(descriptor, execute);
  const pending = first.broker.invoke(principal, invoke()); const confirmation = control(pending, "confirm");
  first.broker.close();
  const second = f.open(descriptor, execute);
  const restored = second.broker.control(principal, control(pending));
  assert.deepEqual(restored.confirmation, pending.confirmation);
  second.broker.control(principal, confirmation);
  assert.equal((await finish(second.broker, pending)).state, "succeeded");
  second.broker.close();
  const third = f.open(descriptor, execute);
  third.broker.control(principal, confirmation);
  assert.equal(calls, 1);
  third.broker.close();
  const changed = f.open({ ...descriptor, title: "Changed without a version bump" }, execute);
  assert.throws(() => changed.broker.control(principal, confirmation), (error) => error.code === "OPERATION_CONTRACT_CHANGED");
});

test("a restored running invocation becomes indeterminate and is never automatically dispatched", async (t) => {
  const f = fixture(t); let calls = 0, release;
  const first = f.open(operation(), () => { calls++; return new Promise((resolve) => { release = resolve; }); });
  const running = first.broker.invoke(principal, invoke());
  await Promise.resolve(); assert.equal(calls, 1);
  first.broker.close();
  const second = f.open(operation(), () => { calls++; return output(); });
  const restored = second.broker.control(principal, control(running));
  assert.equal(restored.state, "indeterminate");
  assert.deepEqual(restored.error, { code: "EXECUTION_OUTCOME_UNKNOWN" });
  assert.equal(second.broker.invoke(principal, invoke()).id, running.id);
  release(output()); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.broker.control(principal, control(running)).state, "indeterminate");
  assert.equal(calls, 1);
});

test("a killed worker releases ownership but its committed effect is never replayed after recovery", async (t) => {
  const f = fixture(t), marker = join(f.directory, "effects.txt");
  const child = fork(new URL("../fixtures/persistent-operation-worker.mjs", import.meta.url), [f.path, marker], {
    env: { ...process.env, AUG_TEST_STATE_KEY: f.key.toString("base64") }, silent: true, windowsHide: true,
  });
  try {
    const applied = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker startup timed out")), 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Worker exited before effect")); });
      child.once("message", (value) => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(applied.state, "effect-applied");
    assert.throws(() => new SqliteInvocationStore({ path: f.path, key: f.key }), (error) => error.code === "STATE_STORE_UNAVAILABLE");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    let replayCalls = 0;
    const next = f.open(operation({ effect: "write", confirmation: "explicit" }), () => { replayCalls++; return output(); });
    const restored = next.broker.invoke(principal, invoke());
    assert.equal(restored.id, applied.invocationId);
    assert.equal(restored.state, "indeterminate");
    assert.equal(replayCalls, 0);
    assert.equal(readFileSync(marker, "utf8"), "applied\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
});

test("expired payloads leave durable receipts that block replay and conflicting reuse", async (t) => {
  const f = fixture(t); let now = 1000, calls = 0;
  const options = { now: () => now, retentionMs: 10 };
  const first = f.open(operation(), () => { calls++; return output(); }, options);
  const current = first.broker.invoke(principal, invoke()); await finish(first.broker, current);
  now += 11;
  assert.throws(() => first.broker.invoke(principal, invoke()), (error) => error.code === "INVOCATION_RETIRED" && error.status === 410);
  assert.equal(first.store.all().length, 0);
  first.broker.close();
  const second = f.open(operation(), () => { calls++; return output(); }, options);
  assert.throws(() => second.broker.invoke(principal, invoke()), (error) => error.code === "INVOCATION_RETIRED");
  assert.throws(() => second.broker.invoke(principal, invoke({ input: { amount: 11 } })), (error) => error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(calls, 1);
});

test("persistent ownership is exclusive and wrong keys never fall back to an empty store", (t) => {
  const f = fixture(t), first = f.open();
  assert.throws(() => new SqliteInvocationStore({ path: f.path, key: f.key }), (error) => error.code === "STATE_STORE_UNAVAILABLE");
  assert.throws(() => new OperationBroker({ store: first.store }), (error) => error.code === "STATE_STORE_IN_USE");
  first.broker.close();
  assert.throws(() => new SqliteInvocationStore({ path: f.path, key: randomBytes(32) }), (error) => error.code === "STATE_STORE_KEY_MISMATCH");
  const reopened = f.open(); assert.deepEqual(reopened.store.all(), []);
});

test("ciphertext or metadata tampering is rejected before accepting operations", async (t) => {
  const f = fixture(t), first = f.open();
  await finish(first.broker, first.broker.invoke(principal, invoke()));
  first.broker.close();
  const database = new DatabaseSync(f.path);
  database.exec("UPDATE aug_records SET state='failed'"); database.close();
  assert.throws(() => new SqliteInvocationStore({ path: f.path, key: f.key }), (error) => error.code === "STATE_STORE_INVALID");
});

test("foreign files/databases are never initialized or replaced as AUG state", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, "PRIVATE-FOREIGN-FILE");
  const before = readFileSync(f.path);
  assert.throws(() => new SqliteInvocationStore({ path: f.path, key: f.key }));
  assert.deepEqual(readFileSync(f.path), before);
  const other = join(f.directory, "foreign.sqlite");
  const database = new DatabaseSync(other); database.exec("CREATE TABLE private_data(value TEXT)"); database.close();
  const original = readFileSync(other);
  assert.throws(() => new SqliteInvocationStore({ path: other, key: f.key }), (error) => error.code === "STATE_STORE_INVALID");
  assert.deepEqual(readFileSync(other), original);
});

test("identity and permission checks still apply to restored records", async (t) => {
  const f = fixture(t), first = f.open();
  const started = first.broker.invoke(principal, invoke()); await finish(first.broker, started); first.broker.close();
  const second = f.open();
  assert.throws(() => second.broker.control({ ...principal, tenantId: "tenant-b" }, control(started)), (error) => error.code === "INVOCATION_NOT_FOUND");
  assert.throws(() => second.broker.control({ ...principal, scopes: [] }, control(started)), (error) => error.code === "OPERATION_NOT_FOUND");
});

test("removing any originally granted scope blocks retained output even when the operation remains available", async (t) => {
  const f = fixture(t), first = f.open();
  const privileged = { ...principal, scopes: [...principal.scopes, "private:read"] };
  const current = first.broker.invoke(privileged, invoke());
  await settled(() => first.broker.control(privileged, control(current)));
  first.broker.close();
  const second = f.open();
  assert.equal(second.broker.list(principal).length, 1);
  assert.throws(() => second.broker.control(principal, control(current)), (error) => error.code === "OPERATION_NOT_FOUND");
  assert.throws(() => second.broker.invoke(principal, invoke()), (error) => error.code === "OPERATION_NOT_FOUND");
  assert.equal(second.broker.control(privileged, control(current)).state, "succeeded");
});

test("resource authorization is rechecked for saved input on confirmation and status", async () => {
  const broker = new OperationBroker(); let access = true, calls = 0;
  broker.register({ operation: operation({ effect: "write", confirmation: "explicit" }), authorize: () => true,
    authorizeInvocation: (input) => access && input.amount === 10,
    execute: () => { calls++; return output(); },
  });
  const pending = broker.invoke(principal, invoke()); access = false;
  assert.throws(() => broker.control(principal, control(pending, "confirm")), (error) => error.code === "OPERATION_NOT_FOUND");
  assert.throws(() => broker.control(principal, control(pending)), (error) => error.code === "OPERATION_NOT_FOUND");
  assert.equal(calls, 0); broker.close();
});

test("failure to persist completion faults the broker and preserves an uncertain execution on disk", async (t) => {
  const f = fixture(t), store = new SqliteInvocationStore({ path: f.path, key: f.key }); f.owners.push(store);
  let calls = 0;
  const replace = store.replace.bind(store);
  store.replace = (record, revision) => {
    if (record.invocation.state === "succeeded") throw new AugError("STATE_STORE_UNAVAILABLE", "simulated disk failure", 503);
    replace(record, revision);
  };
  const first = new OperationBroker({ store }); f.owners.push(first);
  first.register({ operation: operation(), authorize: () => true, execute: () => { calls++; return output(); } });
  const started = first.invoke(principal, invoke()); await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => first.control(principal, control(started)), (error) => error.code === "STATE_STORE_UNAVAILABLE");
  first.close();
  const second = f.open(operation(), () => { calls++; return output(); });
  assert.equal(second.broker.invoke(principal, invoke()).state, "indeterminate");
  assert.equal(calls, 1);
});

test("failed start persistence prevents effects and request/state inserts roll back together", (t) => {
  const f = fixture(t), first = f.open(operation({ effect: "write", confirmation: "explicit" }));
  const pending = first.broker.invoke(principal, invoke());
  const record = first.store.get(pending.id);
  assert.throws(() => first.store.insert({ ...record, invocation: { ...record.invocation, id: "other-id" } }), (error) => error.code === "STATE_STORE_UNAVAILABLE");
  assert.equal(first.store.all().length, 1);
  assert.equal(first.store.lookup(record.key).invocationId, pending.id);
  assert.equal(first.store.get("other-id"), undefined);
});

test("a confirmation must commit running state before dispatching its effect", async (t) => {
  const f = fixture(t); let calls = 0;
  const first = f.open(operation({ effect: "write", confirmation: "explicit" }), () => { calls++; return output(); });
  const pending = first.broker.invoke(principal, invoke());
  const replace = first.store.replace.bind(first.store);
  first.store.replace = () => { throw new AugError("STATE_STORE_UNAVAILABLE", "simulated pre-dispatch failure", 503); };
  assert.throws(() => first.broker.control(principal, control(pending, "confirm")), (error) => error.code === "STATE_STORE_UNAVAILABLE");
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 0);
  first.store.replace = replace;
  first.broker.control(principal, control(pending, "confirm"));
  assert.equal((await finish(first.broker, pending)).state, "succeeded"); assert.equal(calls, 1);
});

test("effects with exceptions report an unknown outcome rather than a safe-to-repeat failure", async () => {
  const broker = new OperationBroker(); let effects = 0;
  broker.register({ operation: operation({ effect: "write", confirmation: "explicit" }), authorize: () => true,
    execute: () => { effects++; throw new Error("PRIVATE-CANARY after effect"); } });
  const pending = broker.invoke(principal, invoke()); broker.control(principal, control(pending, "confirm"));
  const terminal = await finish(broker, pending);
  assert.equal(terminal.state, "indeterminate"); assert.doesNotMatch(JSON.stringify(terminal), /PRIVATE-CANARY/);
  broker.control(principal, control(pending, "confirm")); assert.equal(effects, 1); broker.close();
});

test("persistence configuration requires an explicit valid pair and remains opt-in", () => {
  assert.equal(operationStoreFromEnv({}), undefined);
  for (const env of [{ AUG_STATE_DB: "state.sqlite" }, { AUG_STATE_KEY: "PRIVATE-CANARY" }, { AUG_STATE_DB: "state.sqlite", AUG_STATE_KEY: "invalid" }]) {
    assert.throws(() => operationStoreFromEnv(env), (error) => { assert.doesNotMatch(error.message, /PRIVATE-CANARY/); return error.code === "INVALID_STATE_CONFIG"; });
  }
  const memory = new MemoryInvocationStore(); const broker = new OperationBroker({ store: memory }); broker.close();
});

test("invalid broker limits do not create or claim a persistent archive", (t) => {
  const f = fixture(t);
  assert.throws(() => new OperationBroker({ maxInvocations: 0, store: () => new SqliteInvocationStore({ path: f.path, key: f.key }) }),
    (error) => error.code === "INVALID_BROKER_CONFIG");
  assert.equal(existsSync(f.path), false);
  const valid = f.open(); valid.broker.close();
});
