import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createOperationRuntime, runtimeCapabilities } from "@aug/ui-renderer/operation-runtime.js";
import { OperationBroker } from "@aug/gateway-server";
import { collectionOutput } from "@aug/protocol";
import { operation, output, principal } from "../helpers/operation-fixtures.mjs";
import { RuntimeElement, runtimeDocument, nodes, byTag, button, text } from "../helpers/runtime-dom.mjs";

async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await delay(5); }
  assert.fail("Runtime did not reach the expected state");
}
const submit = (root) => byTag(root, "form")[0].listeners.submit({ preventDefault() {} });

async function setup({ descriptor = operation(), execute = (input) => output({ total: input.amount * 2 }), intercept, maxPolls = 20 } = {}) {
  const broker = new OperationBroker();
  let calls = 0, ids = 0;
  const requests = [];
  broker.register({ operation: descriptor, authorize: () => true, execute: (input) => { calls++; return execute(input); } });
  const root = new RuntimeElement("div");
  const runtime = createOperationRuntime(root, { document: runtimeDocument, pollMs: 0, maxPolls,
    newRequestId: () => `request-${++ids}`, request: async (path, input, options) => {
      requests.push({ path, input: structuredClone(input), signal: options.signal });
      const run = () => path.endsWith("/operations") ? { protocolVersion: "aug/0.2", operations: broker.list(principal) } :
        path.endsWith("/control") ? broker.control(principal, input) : broker.invoke(principal, input);
      return intercept ? intercept(path, input, run) : run();
    } });
  await runtime.ready;
  return { root, runtime, requests, calls: () => calls };
}

test("typed inputs preserve numbers, boolean false, enums and nested JSON", async () => {
  let actual;
  const descriptor = operation({ inputSchema: {
    type: "object", additionalProperties: false, required: ["count", "enabled", "mode", "config", "empty"],
    properties: { count: { type: "integer" }, enabled: { type: "boolean" }, mode: { enum: ["a", "b"] }, config: { type: "object" }, empty: { type: "string" }, optional: { type: "string" } },
  } });
  const { root, runtime } = await setup({ descriptor, execute: (input) => { actual = input; return output(); } });
  const input = (name) => nodes(root, (node) => node.name === name)[0];
  input("count").value = "0"; input("enabled").value = "false"; input("mode").value = '"b"'; input("config").value = '{"nested":[1,2]}';
  submit(root);
  await until(() => text(root).includes("Operation completed."));
  assert.deepEqual(actual, { count: 0, enabled: false, mode: "b", config: { nested: [1, 2] }, empty: "" });
  runtime.dispose();
});

test("the same runtime executes again with a fresh request after a terminal result", async () => {
  const { root, runtime, calls, requests } = await setup();
  nodes(root, (node) => node.name === "amount")[0].value = "10";
  submit(root); submit(root);
  await until(() => text(root).includes("Operation completed."));
  assert.equal(calls(), 1);
  submit(root);
  await until(() => calls() === 2 && text(root).includes("Operation completed."));
  assert.deepEqual(requests.filter(({ path }) => path.endsWith("/invocations")).map(({ input }) => input.requestId), ["request-1", "request-2"]);
  runtime.dispose();
});

test("lost invocation replies recover with the original request ID and unchanged input", async () => {
  let lost = false;
  const { root, runtime, calls, requests } = await setup({ intercept: (path, _input, run) => {
    const value = run();
    if (path.endsWith("/invocations") && !lost) { lost = true; throw new Error("PRIVATE-CANARY transport error"); }
    return value;
  } });
  nodes(root, (node) => node.name === "amount")[0].value = "10";
  submit(root);
  await until(() => !button(root, "Retry request").hidden);
  assert.equal(byTag(root, "fieldset")[0].disabled, true);
  assert.doesNotMatch(text(root), /PRIVATE-CANARY/);
  button(root, "Retry request").listeners.click();
  await until(() => text(root).includes("Operation completed."));
  const starts = requests.filter(({ path }) => path.endsWith("/invocations"));
  assert.equal(starts.length, 2); assert.deepEqual(starts[0].input, starts[1].input); assert.equal(calls(), 1);
  runtime.dispose();
});

test("explicit review displays saved inputs as text and sends only the token on confirmation", async () => {
  const { root, runtime, calls, requests } = await setup({ descriptor: operation({ effect: "write", confirmation: "explicit" }) });
  nodes(root, (node) => node.name === "amount")[0].value = "8";
  nodes(root, (node) => node.name === "note")[0].value = "<img src=x onerror=alert(1)>";
  submit(root);
  await until(() => button(root, "Confirm operation"));
  assert.equal(calls(), 0);
  assert.match(text(root), /<img src=x onerror=alert\(1\)>/);
  assert.equal(byTag(root, "img").length, 0);
  const confirm = button(root, "Confirm operation");
  confirm.listeners.click(); confirm.listeners.click();
  assert.equal(button(root, "Back to inputs").disabled, true);
  await until(() => text(root).includes("Operation completed."));
  assert.equal(calls(), 1);
  const control = requests.find(({ input }) => input.action === "confirm");
  assert.deepEqual(Object.keys(control.input).sort(), ["action", "invocationId", "protocolVersion", "token"]);
  assert.equal(text(root).includes(control.input.token), false);
  runtime.dispose();
});

test("complex input schemas use the JSON editor and malformed JSON never reaches the backend", async () => {
  const { root, runtime, requests } = await setup({ descriptor: operation({ inputSchema: { type: "object", additionalProperties: true } }), execute: (input) => output(input) });
  byTag(root, "textarea")[0].value = "{";
  submit(root);
  assert.equal(requests.length, 1);
  byTag(root, "textarea")[0].value = '{"value":{"nested":true}}';
  submit(root);
  await until(() => text(root).includes("Operation completed."));
  assert.deepEqual(requests[1].input.input, { value: { nested: true } });
  runtime.dispose();
});

test("JSON input mode preserves typed values and can express optional empty strings", async () => {
  const { root, runtime, requests } = await setup();
  nodes(root, (node) => node.name === "amount")[0].value = "4";
  button(root, "Edit inputs as JSON").listeners.click();
  assert.deepEqual(JSON.parse(byTag(root, "textarea")[0].value), { amount: 4 });
  byTag(root, "textarea")[0].value = '{"amount":4,"note":""}';
  submit(root);
  await until(() => text(root).includes("Operation completed."));
  assert.deepEqual(requests[1].input.input, { amount: 4, note: "" });
  runtime.dispose();
});

test("collections page locally and numeric cells use right-aligned tabular figures", async () => {
  const descriptor = operation({ output: ["collection", "json"].map((id) => ({ id, profile: `aug.${id}/0.1`, mediaType: "application/json", audiences: ["view"], deliveryKind: "inline" })) });
  const { root, runtime } = await setup({ descriptor, execute: () => collectionOutput("rows", {
    columns: [{ key: "name" }, { key: "amount" }], rows: Array.from({ length: 55 }, (_, i) => ({ name: `record-${i}`, amount: i })),
  }, ["view"]) });
  nodes(root, (node) => node.name === "amount")[0].value = "1";
  submit(root);
  await until(() => text(root).includes("Operation completed."));
  assert.equal(byTag(root, "tbody")[0].children.length, 50);
  assert.equal(byTag(root, "td")[1].className, "aug-number");
  button(root, "Show more rows").listeners.click();
  assert.equal(byTag(root, "tbody")[0].children.length, 55);
  assert.match(text(root), /Showing 1–55 of 55/);
  runtime.dispose();
});

test("long-running operations recover by status, and disposal aborts pending polling", async () => {
  let finish;
  const { root, runtime, requests } = await setup({ maxPolls: 0, execute: () => new Promise((resolve) => { finish = resolve; }) });
  nodes(root, (node) => node.name === "amount")[0].value = "1";
  submit(root);
  await until(() => button(root, "Check status"));
  assert.match(text(root), /still running/);
  finish(output());
  await delay(0);
  button(root, "Check status").listeners.click();
  await until(() => text(root).includes("Operation completed."));
  assert.equal(requests.filter(({ path }) => path.endsWith("/invocations")).length, 1);
  runtime.dispose();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(root.children.length, 0);
});

test("the advertised runtime has only implemented inline profiles", () => {
  assert.deepEqual(runtimeCapabilities().deliveryKinds, ["inline"]);
  assert.equal(runtimeCapabilities().profiles.includes("aug.document/0.1"), false);
});

test("an uncertain effect locks new requests and status checks never invoke it again", async () => {
  const { root, runtime, calls, requests } = await setup({ descriptor: operation({ effect: "write", confirmation: "explicit" }),
    execute: () => { throw new Error("PRIVATE-CANARY after effect"); } });
  nodes(root, (node) => node.name === "amount")[0].value = "8";
  submit(root); await until(() => button(root, "Confirm operation"));
  button(root, "Confirm operation").listeners.click();
  await until(() => text(root).includes("execution outcome is unknown"));
  assert.equal(byTag(root, "fieldset")[0].disabled, true);
  button(root, "Check status").listeners.click();
  await until(() => !button(root, "Check status").disabled);
  assert.equal(calls(), 1);
  assert.equal(requests.filter(({ path }) => path.endsWith("/invocations")).length, 1);
  assert.doesNotMatch(text(root), /PRIVATE-CANARY/);
  runtime.dispose();
});
