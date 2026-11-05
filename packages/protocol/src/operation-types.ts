import type { Audience, DeliveryKind, JsonObject, NegotiatedOutput } from "./types.js";

export interface AugRepresentationOffer {
  id: string;
  profile: string;
  mediaType: string;
  audiences: Audience[];
  deliveryKind: DeliveryKind;
}

export interface AugOperation {
  protocolVersion: string;
  id: string;
  version: string;
  title: string;
  description: string;
  effect: "read" | "write" | "destructive" | "external_side_effect";
  confirmation: "none" | "explicit";
  inputSchema: JsonObject;
  /** Preference-ordered promises; actual output must conform to these offers. */
  output: AugRepresentationOffer[];
}

export interface AugInvokeRequest {
  protocolVersion: string;
  requestId: string;
  operationId: string;
  operationVersion: string;
  input: JsonObject;
  runtime: import("./types.js").AugRuntimeCapabilities;
}

export type AugControlRequest =
  | { protocolVersion: string; action: "status"; invocationId: string }
  | { protocolVersion: string; action: "confirm"; invocationId: string; token: string };

export type AugInvocationState = "awaiting_confirmation" | "running" | "succeeded" | "failed" | "expired" | "indeterminate";

interface InvocationIdentity {
  protocolVersion: string;
  id: string;
  operationId: string;
  operationVersion: string;
  revision: number;
}

export type AugInvocation = InvocationIdentity & (
  | { state: "awaiting_confirmation"; confirmation: { token: string; expiresAt: number; input: JsonObject } }
  | { state: "running" }
  | { state: "succeeded"; output: NegotiatedOutput }
  | { state: "failed"; error: { code: string } }
  | { state: "indeterminate"; error: { code: "EXECUTION_OUTCOME_UNKNOWN" } }
  | { state: "expired" }
);
