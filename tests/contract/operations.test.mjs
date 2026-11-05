import test from "node:test";
import assert from "node:assert/strict";
import { compileOperation, negotiateOperation, validateControlRequest, validateInvokeRequest, validateInvocation, assertInvocationTransition } from "@aug/protocol/operations";
import { operation, invoke, output, runtime } from "../helpers/operation-fixtures.mjs";

test("operation schemas validate nested constraints without coercing or filling inputs", () => {
  const { validateInput } = compileOperation(operation({ inputSchema: {
    type: "object", additionalProperties: false, required: ["items"],
    properties: { items: { type: "array", minItems: 1, maxItems: 2, items: {
      type: "object", additionalProperties: false, required: ["code", "quantity"],
      properties: { code: { type: "string", pattern: "^[A-Z]{2}$" }, quantity: { type: "integer", minimum: 1 } },
    } }, note: { type: "string", default: "unchanged" } },
  } }));
  const valid = { items: [{ code: "AB", quantity: 2 }] };
  assert.equal(validateInput(valid), valid);
  assert.equal("note" in valid, false);
  for (const value of [{}, { items: [] }, { items: [{ code: "bad", quantity: 2 }] }, { items: [{ code: "AB", quantity: "2" }] }, { items: [{ code: "AB", quantity: 0, extra: true }] }]) {
    assert.throws(() => validateInput(value), (error) => error.code === "INVALID_INPUT");
  }
});

test("all effects require explicit confirmation; malformed, remote or async schemas fail closed", () => {
  for (const effect of ["write", "destructive", "external_side_effect"]) {
    assert.throws(() => compileOperation(operation({ effect })), (error) => error.code === "INVALID_OPERATION");
    assert.equal(compileOperation(operation({ effect, confirmation: "explicit" })).operation.effect, effect);
  }
  for (const inputSchema of [
    { type: "object", $async: true },
    { type: "object", properties: { value: { $ref: "https://schemas.example/remote" } } },
    { type: "object", properties: { value: { type: "made-up-type" } } },
  ]) assert.throws(() => compileOperation(operation({ inputSchema })), (error) => error.code === "INVALID_OPERATION");
});

test("preflight validates declared offers and their destination before execution", () => {
  assert.equal(negotiateOperation(operation(), runtime, "view").id, "json");
  assert.throws(() => negotiateOperation(operation(), runtime, "model"), (error) => error.code === "NO_COMPATIBLE_REPRESENTATION");
  assert.throws(() => compileOperation(operation({ output: [{ ...operation().output[0], mediaType: "text/plain" }] })));
});

test("invoke and control messages reject forged fields and version mismatches", () => {
  assert.throws(() => validateInvokeRequest(invoke({ protocolVersion: "aug/0.1" })), (error) => error.code === "UNSUPPORTED_PROTOCOL_VERSION");
  assert.throws(() => validateInvokeRequest(invoke({ audience: "model" })), (error) => error.code === "INVALID_INVOCATION");
  assert.throws(() => validateInvokeRequest(invoke({ protocolVersion: "aug/999" })), (error) => error.code === "UNSUPPORTED_PROTOCOL_VERSION");
  assert.throws(() => validateControlRequest({ protocolVersion: "aug/0.2", action: "confirm", invocationId: "1", token: "token", input: { amount: 100 } }), (error) => error.code === "INVALID_INVOCATION");
});

test("invocation states have exclusive payloads and terminal states cannot be restarted", () => {
  const identity = { protocolVersion: "aug/0.2", id: "1", operationId: "demo.calculate", operationVersion: "1", revision: 1 };
  validateInvocation({ ...identity, state: "running" });
  for (const invalid of [
    { ...identity, state: "succeeded" },
    { ...identity, state: "failed", output: {} },
    { ...identity, state: "running", confirmation: {} },
    { ...identity, state: "awaiting_confirmation" },
  ]) assert.throws(() => validateInvocation(invalid), (error) => error.code === "INVALID_INVOCATION");
  assertInvocationTransition("awaiting_confirmation", "running");
  assertInvocationTransition("running", "succeeded");
  for (const from of ["succeeded", "failed", "expired", "indeterminate"]) {
    assert.throws(() => assertInvocationTransition(from, "running"), (error) => error.code === "INVALID_TRANSITION");
  }
  const selected = { protocolVersion: "aug/0.2", outputId: "result", audience: "model", representation: output().representations[0] };
  assert.throws(() => validateInvocation({ ...identity, state: "succeeded", output: selected }), (error) => error.code === "INVALID_INVOCATION");
});
