import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { AugProtocolError, profiles, protocolVersion, validateOutput, validateRuntimeCapabilities } from "./index.js";
import type { Audience, AugOutput, JsonObject } from "./types.js";
import type { AugControlRequest, AugInvocation, AugInvocationState, AugInvokeRequest, AugOperation, AugRepresentationOffer } from "./operation-types.js";
import operationSchema from "./schemas/operation.json" with { type: "json" };
import invokeSchema from "./schemas/invoke.json" with { type: "json" };
import controlSchema from "./schemas/control.json" with { type: "json" };
import invocationSchema from "./schemas/invocation.json" with { type: "json" };
import outputSchema from "./schemas/output.json" with { type: "json" };
import runtimeSchema from "./schemas/runtime.json" with { type: "json" };

export type * from "./operation-types.js";
export { operationSchema, invokeSchema, controlSchema, invocationSchema };

const ajv = new Ajv.default({ strict: true, allErrors: false, ownProperties: true, addUsedSchema: false });
ajv.addSchema(outputSchema).addSchema(runtimeSchema);
const checkOperation = ajv.compile(operationSchema);
const checkInvoke = ajv.compile(invokeSchema);
const checkControl = ajv.compile(controlSchema);
const checkInvocation = ajv.compile(invocationSchema);

function assertMessage(check: ValidateFunction, input: unknown, code: "INVALID_OPERATION" | "INVALID_INVOCATION"): void {
  if (!check(input)) throw new AugProtocolError(code, "AUG message does not match its schema");
}

function assertVersion(version: string): void {
  if (version !== protocolVersion) throw new AugProtocolError("UNSUPPORTED_PROTOCOL_VERSION", "Unsupported AUG protocol version");
}

export function validateOperation(input: unknown): AugOperation {
  assertMessage(checkOperation, input, "INVALID_OPERATION");
  const operation = input as AugOperation;
  assertVersion(operation.protocolVersion);
  if (operation.inputSchema.type !== "object" ||
    (operation.effect !== "read" && operation.confirmation !== "explicit") ||
    new Set(operation.output.map((offer) => offer.id)).size !== operation.output.length) {
    throw new AugProtocolError("INVALID_OPERATION", "Operation requires object inputs, unique offers and explicit confirmation for effects");
  }
  // Check built-in profile/media/delivery combinations before accepting execution promises.
  validateOutput({ protocolVersion, id: "offer-check", representations: operation.output.map((offer) => ({
    id: offer.id, profile: offer.profile, mediaType: offer.mediaType, audiences: offer.audiences,
    delivery: offer.deliveryKind === "reference" ? { kind: "reference", href: "/aug-offer" } : {
      kind: "inline", value: offer.profile === profiles.collection ? { columns: [], rows: [] } : offer.profile === profiles.text ? "" : null,
    },
  })) });
  return operation;
}

/** Compile backend-owned draft-07 input schemas once; never load external schemas or run async validators. */
export function compileOperation(input: unknown): { operation: AugOperation; validateInput: (input: unknown) => JsonObject } {
  const operation = validateOperation(input);
  let check: ValidateFunction;
  try {
    check = ajv.compile(operation.inputSchema);
    if ("$async" in check && check.$async) throw new Error("Async validation is not supported");
  } catch {
    throw new AugProtocolError("INVALID_OPERATION", "Operation input schema is unsupported or invalid");
  }
  return { operation, validateInput(value: unknown): JsonObject {
    if (!check(value)) throw new AugProtocolError("INVALID_INPUT", "Input does not satisfy the operation schema");
    return value as JsonObject;
  } };
}

export function validateInvokeRequest(input: unknown): AugInvokeRequest {
  assertMessage(checkInvoke, input, "INVALID_INVOCATION");
  const request = input as AugInvokeRequest;
  assertVersion(request.protocolVersion);
  return request;
}

export function validateControlRequest(input: unknown): AugControlRequest {
  assertMessage(checkControl, input, "INVALID_INVOCATION");
  const request = input as AugControlRequest;
  assertVersion(request.protocolVersion);
  return request;
}

export function validateInvocation(input: unknown): AugInvocation {
  assertMessage(checkInvocation, input, "INVALID_INVOCATION");
  const invocation = input as AugInvocation;
  assertVersion(invocation.protocolVersion);
  if (invocation.state === "succeeded") {
    const { output } = invocation;
    assertVersion(output.protocolVersion);
    validateOutput({ protocolVersion: output.protocolVersion, id: output.outputId, representations: [output.representation] });
    if (!output.representation.audiences.includes(output.audience)) {
      throw new AugProtocolError("INVALID_INVOCATION", "Invocation output does not permit its destination");
    }
  }
  return invocation;
}

/** Preflight promises before execution, including effects. No content or network request is needed. */
export function negotiateOperation(operationInput: unknown, runtimeInput: unknown, audience: Audience): AugRepresentationOffer {
  const operation = validateOperation(operationInput);
  const runtime = validateRuntimeCapabilities(runtimeInput);
  if (!runtime.protocolVersions.includes(operation.protocolVersion)) {
    throw new AugProtocolError("UNSUPPORTED_PROTOCOL_VERSION", "No supported AUG protocol version");
  }
  const offer = operation.output.find((entry) => entry.audiences.includes(audience) &&
    runtime.profiles.includes(entry.profile) && runtime.mediaTypes.includes(entry.mediaType) &&
    runtime.deliveryKinds.includes(entry.deliveryKind));
  if (!offer) throw new AugProtocolError("NO_COMPATIBLE_REPRESENTATION", "No permitted compatible representation");
  return offer;
}

export function validateOperationOutput(operationInput: unknown, outputInput: unknown): AugOutput {
  const operation = validateOperation(operationInput);
  const output = validateOutput(outputInput);
  for (const representation of output.representations) {
    const offer = operation.output.find((candidate) => candidate.id === representation.id);
    if (!offer || offer.profile !== representation.profile || offer.mediaType !== representation.mediaType ||
      offer.deliveryKind !== representation.delivery.kind || representation.audiences.some((audience) => !offer.audiences.includes(audience))) {
      throw new AugProtocolError("INVALID_OPERATION_OUTPUT", "Output differs from its declared operation contract");
    }
  }
  return output;
}

const transitions: Record<AugInvocationState, readonly AugInvocationState[]> = {
  awaiting_confirmation: ["running", "expired"], running: ["succeeded", "failed", "indeterminate"],
  succeeded: [], failed: [], expired: [], indeterminate: [],
};

export function assertInvocationTransition(from: AugInvocationState, to: AugInvocationState): void {
  if (!Object.hasOwn(transitions, from) || !transitions[from].includes(to)) {
    throw new AugProtocolError("INVALID_TRANSITION", "Invocation state transition is not allowed");
  }
}
