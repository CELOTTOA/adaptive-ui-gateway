import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import outputSchema from "./schemas/output.json" with { type: "json" };
import runtimeSchema from "./schemas/runtime.json" with { type: "json" };
import collectionSchema from "./schemas/collection.json" with { type: "json" };
import type {
  Audience, AugOutput, AugRuntimeCapabilities, CollectionValue, JsonValue, NegotiatedOutput,
} from "./types.js";

export type * from "./types.js";
export { collectionSchema, outputSchema, runtimeSchema };

export const protocolVersion = "aug/0.2";
export const profiles = {
  json: "aug.json/0.1",
  collection: "aug.collection/0.1",
  text: "aug.text/0.1",
  document: "aug.document/0.1",
} as const;

export type ProtocolErrorCode =
  | "INVALID_OUTPUT" | "INVALID_RUNTIME" | "INVALID_PROFILE_CONTENT"
  | "INVALID_OPERATION" | "INVALID_INVOCATION" | "INVALID_INPUT" | "INVALID_TRANSITION" | "INVALID_OPERATION_OUTPUT"
  | "UNSUPPORTED_PROTOCOL_VERSION" | "NO_COMPATIBLE_REPRESENTATION";

export class AugProtocolError extends Error {
  constructor(public readonly code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "AugProtocolError";
  }
}

const ajv = new Ajv.default({ strict: true, allErrors: false, ownProperties: true });
const checkOutput = ajv.compile(outputSchema);
const checkRuntime = ajv.compile(runtimeSchema);
const checkCollection = ajv.compile(collectionSchema);

function assertSchema(check: ValidateFunction, input: unknown, code: ProtocolErrorCode): void {
  if (!check(input)) {
    // Static messages deliberately exclude values, prompts, URLs and validator error details.
    throw new AugProtocolError(code, "AUG message does not match its schema");
  }
}

/** Validate retrieved reference content too, before passing it to a profile renderer. */
export function validateProfileContent(profile: string, value: JsonValue): void {
  if (profile === profiles.text && typeof value !== "string") {
    throw new AugProtocolError("INVALID_PROFILE_CONTENT", "Text profile requires a string");
  }
  if (profile === profiles.collection) {
    assertSchema(checkCollection, value, "INVALID_PROFILE_CONTENT");
    const collection = value as unknown as CollectionValue;
    const keys = collection.columns.map((column) => column.key);
    if (new Set(keys).size !== keys.length || collection.rows.some((row) =>
      Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))) {
      throw new AugProtocolError("INVALID_PROFILE_CONTENT", "Collection fields must match declared columns");
    }
  }
  // Custom profile semantics are the responsibility of their registered implementation.
}

function validateReference(href: string): void {
  const relative = href.startsWith("/") && !href.startsWith("//");
  let url: URL;
  try {
    url = new URL(href, "https://aug.invalid");
  } catch {
    throw new AugProtocolError("INVALID_OUTPUT", "Invalid content reference");
  }
  if (
    /[\s\\]/.test(href) || url.username || url.password || url.hash ||
    (relative ? url.origin !== "https://aug.invalid" : !href.startsWith("https://"))
  ) {
    throw new AugProtocolError("INVALID_OUTPUT", "References require a root-relative path or HTTPS URL without credentials or fragment");
  }
}

export function validateOutput(input: unknown): AugOutput {
  assertSchema(checkOutput, input, "INVALID_OUTPUT");
  const output = input as AugOutput;
  if (output.protocolVersion !== protocolVersion) {
    throw new AugProtocolError("UNSUPPORTED_PROTOCOL_VERSION", "Unsupported AUG protocol version");
  }
  if (new Set(output.representations.map((entry) => entry.id)).size !== output.representations.length) {
    throw new AugProtocolError("INVALID_OUTPUT", "Representation identifiers must be unique");
  }
  for (const representation of output.representations) {
    const { profile, mediaType, delivery } = representation;
    if (
      ((profile === profiles.json || profile === profiles.collection) && mediaType !== "application/json") ||
      (profile === profiles.text && mediaType !== "text/plain") ||
      (profile === profiles.document && (mediaType !== "application/pdf" || delivery.kind !== "reference"))
    ) {
      throw new AugProtocolError("INVALID_PROFILE_CONTENT", "Representation does not match its profile");
    }
    if (delivery.kind === "reference") validateReference(delivery.href);
    else validateProfileContent(profile, delivery.value);
  }
  return output;
}

export function validateRuntimeCapabilities(input: unknown): AugRuntimeCapabilities {
  assertSchema(checkRuntime, input, "INVALID_RUNTIME");
  return input as AugRuntimeCapabilities;
}

/** Pure selection: never fetches URLs, runs code or grants access to a backend operation. */
export function negotiateOutput(
  outputInput: unknown,
  runtimeInput: unknown,
  audience: Audience,
): NegotiatedOutput {
  const output = validateOutput(outputInput);
  const runtime = validateRuntimeCapabilities(runtimeInput);
  if (!runtime.protocolVersions.includes(output.protocolVersion)) {
    throw new AugProtocolError("UNSUPPORTED_PROTOCOL_VERSION", "No supported AUG protocol version");
  }
  const representation = output.representations.find((entry) =>
    entry.audiences.includes(audience) && runtime.profiles.includes(entry.profile) &&
    runtime.mediaTypes.includes(entry.mediaType) && runtime.deliveryKinds.includes(entry.delivery.kind));
  if (!representation) {
    throw new AugProtocolError("NO_COMPATIBLE_REPRESENTATION", "No permitted compatible representation");
  }
  return { protocolVersion: output.protocolVersion, outputId: output.id, audience, representation };
}

/** Producer helper; the backend deliberately declares both collection and generic JSON views. */
export function collectionOutput(id: string, value: CollectionValue, audiences: Audience[]): AugOutput {
  const content = value as unknown as JsonValue;
  return validateOutput({
    protocolVersion, id,
    representations: [
      { id: "collection", profile: profiles.collection, mediaType: "application/json", audiences,
        delivery: { kind: "inline", value: content } },
      { id: "json", profile: profiles.json, mediaType: "application/json", audiences,
        delivery: { kind: "inline", value: content } },
    ],
  });
}
