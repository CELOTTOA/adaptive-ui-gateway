import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startGatewayServer } from "@aug/gateway-server";
import { validateOperation, validateInvocation } from "@aug/protocol/operations";
import { createOperationRuntime } from "@aug/ui-renderer/operation-runtime.js";
import { TerminalRuntime, capabilities, renderInvocation } from "../../examples/independent/runtime.mjs";
import { RuntimeElement, runtimeDocument, nodes, byTag, button, text } from "../helpers/runtime-dom.mjs";

const descriptors = JSON.parse(await readFile(new URL("../../examples/independent/operations.json", import.meta.url), "utf8"));
const vectors = JSON.parse(await readFile(new URL("../fixtures/aug-interop.json", import.meta.url), "utf8"));
const token = "independent-demo-token", otherToken = "independent-other-token", deniedToken = "independent-denied-token";
const allowedOrigin = "https://view.example";
const endpoints = [{ name: "Python standard-library backend" }, { name: "TypeScript reference broker" }];
let python, gateway, pythonExited, standalone;

async function startPython() {
  const child = spawn(process.env.AUG_PYTHON ?? "python", ["-I", "-u", "-B", join(standalone, "backend.py"),
    "--port", "0", "--allow-origin", allowedOrigin], { cwd: standalone, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  python = child;
  pythonExited = new Promise((resolve) => child.once("close", resolve));
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Python backend startup timed out")); }, 10000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Python 3.11+ required; set AUG_PYTHON to its executable")); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Python backend exited before readiness")); });
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.split("\n")[0]).origin); } catch { reject(new Error("Invalid Python readiness metadata")); }
    });
    // Consume diagnostics without exposing potential request data in a failing assertion.
    child.stderr.resume();
  });
}

async function startReference() {
  const stock = {
    "tenant-a": [{ sku: "BOLT-A", available: 20 }, { sku: "WASHER-A", available: 30 }],
    "tenant-b": [{ sku: "BOLT-B", available: 9 }],
  };
  const actors = new Map([
    [token, { id: "alice", tenantId: "tenant-a", scopes: ["stock:use"] }],
    [otherToken, { id: "bob", tenantId: "tenant-b", scopes: ["stock:use"] }],
    [deniedToken, { id: "alice", tenantId: "tenant-a", scopes: [] }],
  ]);
  gateway = await startGatewayServer({ port: 0, allowedOrigins: [allowedOrigin], authenticate: (value) => actors.get(value),
    openApiSource: JSON.stringify({ openapi: "3.0.3", info: { title: "Native only", version: "1" }, paths: {} }),
    backendBaseUrl: "http://127.0.0.1:1", backendToken: "unused-independent-fixture", planner: {
      planSearch() { throw new Error("Interop must not use UI planning"); },
    }, operations: descriptors.map((operation) => ({ operation, authorize: (actor) => actor.scopes.includes("stock:use"),
      execute(input, context) {
        const items = stock[context.principal.tenantId];
        let value;
        if (operation.effect === "read") {
          const rows = items.filter((item) => item.sku.toLowerCase().includes((input.q ?? "").toLowerCase())).map((item) => ({ ...item }));
          value = { columns: [{ key: "sku" }, { key: "available" }], rows };
        } else {
          const item = items.find((item) => item.sku === input.sku);
          if (!item || item.available < input.quantity) throw new Error("Domain refusal");
          item.available -= input.quantity;
          value = { sku: item.sku, reserved: input.quantity, available: item.available };
        }
        return { protocolVersion: "aug/0.2", id: randomUUID(), representations: operation.output.map((offer) => ({
          id: offer.id, profile: offer.profile, mediaType: offer.mediaType, audiences: offer.audiences,
          delivery: { kind: "inline", value: offer.profile === "aug.text/0.1" ? value.rows.map((row) => `${row.sku}: ${row.available}`).join("\n") : value },
        })) };
      },
    })) });
  return `http://127.0.0.1:${gateway.address().port}`;
}

before(async () => {
  standalone = await mkdtemp(join(tmpdir(), "aug-independent-"));
  await Promise.all(["backend.py", "operations.json", "runtime.mjs"].map((file) =>
    copyFile(new URL("../../examples/independent/" + file, import.meta.url), join(standalone, file))));
  const origins = await Promise.allSettled([startPython(), startReference()]);
  const failure = origins.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  endpoints.forEach((endpoint, index) => { endpoint.origin = origins[index].value; });
});
after(async () => {
  if (python && python.exitCode === null) python.kill();
  if (pythonExited) await pythonExited;
  if (gateway) { gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)); }
  if (standalone) {
    assert.equal(dirname(resolve(standalone)), resolve(tmpdir()));
    assert.ok(basename(standalone).startsWith("aug-independent-"));
    await rm(standalone, { recursive: true, force: true });
  }
});

async function api(endpoint, path, body = {}, credential = token, headers = {}) {
  const response = await fetch(endpoint.origin + "/v1/aug/" + path, { method: "POST", headers: {
    Authorization: `Bearer ${credential}`, "Content-Type": "application/json", ...headers,
  }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
function request(patch = {}) {
  return { protocolVersion: "aug/0.2", requestId: randomUUID(), operationId: "inventory.stock.list", operationVersion: "1",
    input: { q: "BOLT" }, runtime: structuredClone(capabilities), ...patch };
}
const control = (invocation, action = "status") => ({ protocolVersion: "aug/0.2", action, invocationId: invocation.id,
  ...(action === "confirm" ? { token: invocation.confirmation.token } : {}) });
async function terminal(endpoint, current, credential = token) {
  for (let i = 0; current.state === "running" && i < 100; i++) {
    await delay(5); current = (await api(endpoint, "invocations/control", control(current), credential)).body;
  }
  assert.notEqual(current.state, "running"); return validateInvocation(current);
}
function client(endpoint, options = {}) { return new TerminalRuntime({ origin: endpoint.origin, token, ...options }); }
async function stockCount(endpoint, sku = "BOLT-A") {
  const result = await client(endpoint).start("inventory.stock.list", { q: sku });
  const final = await terminal(endpoint, result);
  return final.output.representation.delivery.value.rows[0].available;
}

for (const endpoint of endpoints) {
  test(`${endpoint.name}: discovery is compatible and contains no record values`, async () => {
    const response = await api(endpoint, "operations");
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.body.protocolVersion, "aug/0.2");
    assert.equal(response.body.operations.length, 2);
    response.body.operations.forEach(validateOperation);
    assert.doesNotMatch(JSON.stringify(response.body), /BOLT-A|BOLT-B|independent-demo-token/);
    assert.deepEqual((await api(endpoint, "operations", {}, deniedToken)).body.operations, []);
  });

  for (const vector of vectors.negotiation) test(`${endpoint.name}: ${vector.name}`, async () => {
    const runtime = client(endpoint, { profiles: vector.profiles });
    const result = await runtime.wait(await runtime.start("inventory.stock.list", { q: "BOLT" }));
    validateInvocation(result); assert.equal(result.state, "succeeded");
    assert.equal(result.output.representation.profile, vector.profile);
    assert.match(renderInvocation(result), /BOLT-A/); assert.doesNotMatch(renderInvocation(result), /BOLT-B/);
  });

  for (const vector of vectors.requests) test(`${endpoint.name}: ${vector.name}`, async () => {
    const response = await api(endpoint, "invocations", request(vector.patch));
    assert.equal(response.status, vector.status); assert.equal(response.body.code, vector.code);
  });

  test(`${endpoint.name}: preflight refuses unsupported representations before an effect`, async () => {
    const before = await stockCount(endpoint);
    for (const runtime of [
      { ...capabilities, profiles: ["example.unknown/1"] },
      { ...capabilities, protocolVersions: ["aug/0.1"] },
      { ...capabilities, deliveryKinds: ["reference"] },
      { ...capabilities, mediaTypes: ["application/pdf"] },
    ]) {
      const response = await api(endpoint, "invocations", request({ operationId: "inventory.stock.reserve", input: { sku: "BOLT-A", quantity: 2 }, runtime }));
      assert.equal(response.status, 406);
    }
    assert.equal(await stockCount(endpoint), before);
  });

  test(`${endpoint.name}: empty collections retain their declared columns`, async () => {
    const runtime = client(endpoint);
    const done = await runtime.wait(await runtime.start("inventory.stock.list", { q: "NO-SUCH-STOCK" }));
    const value = done.output.representation.delivery.value;
    assert.deepEqual(value.rows, []);
    assert.deepEqual(value.columns, [{ key: "sku" }, { key: "available" }]);
    assert.equal(renderInvocation(done), "sku | available");
  });

  test(`${endpoint.name}: uncertain effects remain terminal and are not repeated`, async () => {
    const runtime = client(endpoint), before = await stockCount(endpoint);
    const input = { sku: "UNKNOWN-SKU", quantity: 1 }, options = { requestId: randomUUID() };
    const pending = await runtime.start("inventory.stock.reserve", input, options);
    const done = await runtime.wait(await runtime.confirm(pending.id));
    assert.equal(done.state, "indeterminate");
    assert.equal(done.error.code, "EXECUTION_OUTCOME_UNKNOWN");
    assert.deepEqual(await runtime.start("inventory.stock.reserve", input, options), done);
    assert.deepEqual(await runtime.status(done.id), done);
    await assert.rejects(runtime.confirm(done.id), { code: "CONFIRMATION_NOT_PENDING" });
    assert.equal(await stockCount(endpoint), before);
  });

  test(`${endpoint.name}: authentication, exact origins and tenant ownership are enforced`, async () => {
    assert.equal((await api(endpoint, "operations", {}, "invalid")).status, 401);
    assert.equal((await api(endpoint, "operations", {}, token, { Origin: "https://evil.example" })).status, 403);
    const preflight = await fetch(endpoint.origin + "/v1/aug/operations", { method: "OPTIONS", headers: { Origin: allowedOrigin } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);
    const current = await terminal(endpoint, (await api(endpoint, "invocations", request())).body);
    for (const credential of [otherToken, deniedToken]) assert.equal((await api(endpoint, "invocations/control", control(current), credential)).status, 404);
    const other = await terminal(endpoint, (await api(endpoint, "invocations", request(), otherToken)).body, otherToken);
    assert.match(JSON.stringify(other.output), /BOLT-B/); assert.doesNotMatch(JSON.stringify(other.output), /BOLT-A/);
  });

  test(`${endpoint.name}: request replay ignores object-key order but rejects changed input`, async () => {
    const original = request({ operationId: "inventory.stock.reserve", input: { sku: "BOLT-A", quantity: 1 } });
    const first = await api(endpoint, "invocations", original);
    const reordered = { ...original, input: { quantity: 1, sku: "BOLT-A" }, runtime: Object.fromEntries(Object.entries(original.runtime).reverse()) };
    assert.equal((await api(endpoint, "invocations", reordered)).body.id, first.body.id);
    const numeric = JSON.stringify(original).replace('"quantity":1', '"quantity":1.0');
    assert.equal((await api(endpoint, "invocations", numeric)).body.id, first.body.id);
    const conflict = await api(endpoint, "invocations", { ...original, input: { sku: "BOLT-A", quantity: 2 } });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "IDEMPOTENCY_CONFLICT");
  });

  test(`${endpoint.name}: explicit confirmation, saved input and repeated confirmation`, async () => {
    const runtime = client(endpoint), before = await stockCount(endpoint);
    const input = { sku: "BOLT-A", quantity: 2 };
    const pending = validateInvocation(await runtime.start("inventory.stock.reserve", input));
    assert.equal(pending.state, "awaiting_confirmation");
    assert.deepEqual(pending.confirmation.input, input);
    assert.equal(await stockCount(endpoint), before);
    const confirm = control(pending, "confirm");
    assert.equal((await api(endpoint, "invocations/control", { ...confirm, input: { quantity: 50 } })).status, 400);
    assert.equal((await api(endpoint, "invocations/control", { ...confirm, token: "forged" })).status, 403);
    assert.equal((await api(endpoint, "invocations/control", confirm, otherToken)).status, 404);
    assert.equal((await api(endpoint, "invocations/control", confirm, deniedToken)).status, 404);
    const [confirmed] = await Promise.all([runtime.confirm(pending.id), api(endpoint, "invocations/control", confirm), api(endpoint, "invocations/control", confirm)]);
    const done = await runtime.wait(confirmed);
    assert.equal(done.state, "succeeded"); assert.equal(done.output.representation.delivery.value.reserved, 2);
    assert.equal(await stockCount(endpoint), before - 2);
    const replay = await api(endpoint, "invocations/control", confirm);
    assert.equal((await terminal(endpoint, replay.body)).id, done.id);
    assert.equal((await api(endpoint, "invocations/control", { ...confirm, token: "wrong-after-completion" })).status, 403);
    assert.equal(await stockCount(endpoint), before - 2);
    assert.doesNotMatch(renderInvocation(pending), new RegExp(pending.confirmation.token));
  });

  test(`${endpoint.name}: original browser runtime consumes independent wire messages`, async () => {
    for (const operationId of ["inventory.stock.list", "inventory.stock.reserve"]) {
      const root = new RuntimeElement("div");
      const runtime = createOperationRuntime(root, { document: runtimeDocument, operationId, pollMs: 1,
        request: async (path, body) => {
          const response = await api(endpoint, path.slice("/v1/aug/".length), body);
          if (response.status >= 400) throw Object.assign(new Error("Refused"), { code: response.body.code });
          return response.body;
        },
      });
      try {
        assert.equal(await runtime.ready, true);
        const field = (name) => nodes(root, (node) => node.name === name)[0];
        if (operationId.endsWith("list")) field("q").value = "WASHER";
        else { field("sku").value = "WASHER-A"; field("quantity").value = "1"; }
        byTag(root, "form")[0].listeners.submit({ preventDefault() {} });
        if (operationId.endsWith("reserve")) {
          await until(() => button(root, "Confirm operation"));
          button(root, "Confirm operation").listeners.click();
        }
        await until(() => text(root).includes("Operation completed."));
        assert.match(text(root), /WASHER-A/);
      } finally { runtime.dispose(); }
    }
  });
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail("Runtime failed to reach the expected view state");
}

test("terminal executable reads the Python backend without AUG packages or build output", async () => {
  const executable = join(standalone, "runtime.mjs");
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, endpoints[0].origin, ...args], {
      cwd: standalone, env: { ...process.env, AUG_VIEW_TOKEN: token, NODE_PATH: "" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", error = "";
    child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { error += data; });
    child.once("error", reject); child.once("exit", (code) => resolve({ code, output, error }));
  });
  const listing = await run(["list"]);
  assert.equal(listing.code, 0); assert.match(listing.output, /inventory.stock.list/); assert.doesNotMatch(listing.output, /BOLT-A/);
  const reading = await run(["run", "inventory.stock.list", "--input", '{"q":"BOLT"}']);
  assert.equal(reading.code, 0); assert.match(reading.output, /BOLT-A/); assert.equal(reading.error, "");
  const before = await stockCount(endpoints[0]);
  const pending = await run(["run", "inventory.stock.reserve", "--input", '{"sku":"BOLT-A","quantity":1}']);
  assert.equal(pending.code, 1); assert.equal(pending.error.trim(), "INTERACTIVE_CONFIRMATION_REQUIRED");
  assert.equal(await stockCount(endpoints[0]), before);
});
