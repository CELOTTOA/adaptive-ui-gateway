import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { startGatewayServer, operationStoreFromEnv } from "@aug/gateway-server";
import { principal, operation, output, invoke, control, settled } from "../helpers/operation-fixtures.mjs";

async function fixture(t, execute, descriptor = operation({ effect: "write", confirmation: "explicit" })) {
  const directory = mkdtempSync(join(tmpdir(), "aug-http-state-"));
  const operationStore = operationStoreFromEnv({ AUG_STATE_DB: join(directory, "state.sqlite"), AUG_STATE_KEY: randomBytes(32).toString("base64") });
  let server, base;
  async function stop() {
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
  async function start() {
    server = await startGatewayServer({ port: 0, openApiSource: '{"openapi":"3.0.3","paths":{}}',
      backendBaseUrl: "http://127.0.0.1:1", backendToken: "unused", operationStore,
      authenticate: (token) => token === "valid" ? principal : token === "other" ? { ...principal, tenantId: "other" } : undefined,
      operations: [{ operation: descriptor, authorize: () => true, execute }],
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  t.after(async () => {
    await stop();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "aug-http-state-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const request = async (path, body, token = "valid") => {
    const response = await fetch(`${base}/v1/aug/${path}`, { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const finish = (current) => settled(async () => (await request("invocations/control", control(current))).body);
  await start();
  return { start, stop, request, finish };
}

test("HTTP shutdown/restart restores confirmation and completed results with durable deduplication", async (t) => {
  let effects = 0;
  const f = await fixture(t, (input) => { effects++; return output({ applied: input.amount }); });
  const request = invoke();
  const pending = await f.request("invocations", request);
  assert.equal(pending.status, 202); assert.equal(pending.body.state, "awaiting_confirmation");
  await f.stop(); await f.start();
  const restored = await f.request("invocations/control", control(pending.body));
  assert.deepEqual(restored.body.confirmation, pending.body.confirmation);
  assert.equal((await f.request("invocations/control", control(pending.body), "other")).status, 404);
  const confirmed = await f.request("invocations/control", control(pending.body, "confirm"));
  assert.equal(confirmed.status, 202);
  assert.equal((await f.finish(confirmed.body)).state, "succeeded");
  await f.stop(); await f.start();
  const replay = await f.request("invocations", request);
  assert.equal(replay.status, 200); assert.equal(replay.body.id, pending.body.id);
  assert.equal(replay.body.state, "succeeded");
  assert.deepEqual(replay.body.output.representation.delivery.value, { applied: 10 });
  assert.equal(effects, 1);
});

test("HTTP restart recovers in-flight work as unknown without repeating the original handler", async (t) => {
  let effects = 0, release;
  const f = await fixture(t, () => { effects++; return new Promise((resolve) => { release = resolve; }); }, operation());
  const running = await f.request("invocations", invoke());
  assert.equal(running.body.state, "running"); assert.equal(effects, 1);
  await f.stop(); await f.start();
  const replay = await f.request("invocations", invoke());
  assert.equal(replay.body.id, running.body.id); assert.equal(replay.body.state, "indeterminate");
  assert.deepEqual(replay.body.error, { code: "EXECUTION_OUTCOME_UNKNOWN" });
  release(output()); await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.request("invocations/control", control(running.body))).body.state, "indeterminate");
  assert.equal(effects, 1);
});
