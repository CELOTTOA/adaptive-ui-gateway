import { randomUUID, timingSafeEqual } from "node:crypto";
import { AugError } from "@aug/core";
import type { Principal } from "@aug/core";
import { negotiateOutput, protocolVersion } from "@aug/protocol";
import type { JsonObject } from "@aug/protocol";
import {
  assertInvocationTransition, compileOperation, negotiateOperation,
  validateControlRequest, validateInvokeRequest, validateOperationOutput,
} from "@aug/protocol/operations";
import type { AugInvocation, AugInvokeRequest, AugOperation } from "@aug/protocol/operations";
import { fingerprint, MemoryInvocationStore } from "./invocation-store.js";
import type { InvocationStore, StoredInvocation } from "./invocation-store.js";

export interface OperationContext {
  principal: Principal;
  /** Pass through to the backend's own durable idempotency implementation for effects. */
  requestId: string;
  invocationId: string;
}

export interface OperationRegistration {
  operation: AugOperation;
  authorize: (principal: Principal) => boolean;
  /** Current resource-level authorization; called for invocation, replay, status, confirmation and dispatch. */
  authorizeInvocation?: (input: JsonObject, principal: Principal) => boolean;
  execute: (input: JsonObject, context: OperationContext) => unknown | Promise<unknown>;
}

export interface OperationEvent {
  operationId: string;
  operationVersion: string;
  principalId: string;
  tenantId: string;
  state: AugInvocation["state"];
  code?: string;
}

interface Registration extends OperationRegistration {
  validateInput: (input: unknown) => JsonObject;
  contractHash: string;
}

type InvocationRecord = StoredInvocation;

export interface OperationBrokerOptions {
  maxInvocations?: number;
  retentionMs?: number;
  confirmationTtlMs?: number;
  now?: () => number;
  onEvent?: (event: OperationEvent) => void;
  store?: InvocationStore | (() => InvocationStore);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function allowed(registration: Registration, principal: Principal): boolean {
  try { return registration.authorize(principal) === true; } catch { return false; }
}

function allowedInput(registration: Registration, principal: Principal, input: JsonObject): boolean {
  try { return !registration.authorizeInvocation || registration.authorizeInvocation(input, principal) === true; } catch { return false; }
}

/** Backend-side reference broker; persistence and durable request receipts are adapter-owned. */
export class OperationBroker {
  private readonly operations = new Map<string, Registration>();
  private readonly store: InvocationStore;
  private closed = false;
  private faulted = false;
  private readonly options: Required<Pick<OperationBrokerOptions, "maxInvocations" | "retentionMs" | "confirmationTtlMs" | "now">> & Pick<OperationBrokerOptions, "onEvent">;

  constructor(options: OperationBrokerOptions = {}) {
    this.options = {
      maxInvocations: options.maxInvocations ?? 1000,
      retentionMs: options.retentionMs ?? 15 * 60_000,
      confirmationTtlMs: options.confirmationTtlMs ?? 5 * 60_000,
      now: options.now ?? Date.now,
      onEvent: options.onEvent,
    };
    for (const key of ["maxInvocations", "retentionMs", "confirmationTtlMs"] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) {
        throw new AugError("INVALID_BROKER_CONFIG", "Broker limits must be positive safe integers");
      }
    }
    this.store = typeof options.store === "function" ? options.store() : options.store ?? new MemoryInvocationStore();
    this.store.claim();
    try {
      if (this.store.durable) for (const record of this.store.all()) {
        if (record.invocation.state === "running") this.move(record, {
          ...this.identity(record), state: "indeterminate", error: { code: "EXECUTION_OUTCOME_UNKNOWN" },
        });
      }
    } catch (error) { this.store.close(); throw error; }
  }

  register(input: OperationRegistration): void {
    this.check();
    const compiled = compileOperation(freeze(structuredClone(input.operation)));
    if (this.operations.has(compiled.operation.id)) throw new AugError("DUPLICATE_OPERATION", "Operation is already registered", 409);
    this.operations.set(compiled.operation.id, { ...input, ...compiled, contractHash: fingerprint(compiled.operation) });
  }

  list(principal: Principal): AugOperation[] {
    this.check();
    return [...this.operations.values()].filter((entry) => allowed(entry, principal))
      .map((entry) => structuredClone(entry.operation));
  }

  invoke(principal: Principal, input: unknown): AugInvocation {
    this.check();
    const request = freeze(structuredClone(validateInvokeRequest(input)));
    const registration = this.operation(principal, request.operationId);
    if (registration.operation.version !== request.operationVersion) {
      throw new AugError("OPERATION_VERSION_MISMATCH", "Operation version has changed", 409);
    }
    registration.validateInput(request.input);
    if (!allowedInput(registration, principal, request.input)) throw new AugError("OPERATION_NOT_FOUND", "Operation is not available", 404);
    const selected = negotiateOperation(registration.operation, request.runtime, "view");
    this.sweep();
    const key = JSON.stringify([principal.tenantId, principal.id, request.requestId]);
    const requestFingerprint = fingerprint(request);
    const receipt = this.store.lookup(key);
    if (receipt) {
      if (receipt.fingerprint !== requestFingerprint) throw new AugError("IDEMPOTENCY_CONFLICT", "Request identifier was already used for different input", 409);
      if (receipt.contractHash !== registration.contractHash) throw new AugError("OPERATION_CONTRACT_CHANGED", "Operation contract has changed", 409);
      const previous = this.store.get(receipt.invocationId);
      if (!previous) throw new AugError("INVOCATION_RETIRED", "Invocation payload has expired; its request identifier remains reserved", 410);
      this.checkRetainedAccess(previous, principal);
      return this.snapshot(previous);
    }
    if (this.store.all().length >= this.options.maxInvocations) throw new AugError("TOO_MANY_INVOCATIONS", "Too many retained invocations", 503);
    const id = randomUUID();
    const identity = { protocolVersion, id, operationId: registration.operation.id, operationVersion: registration.operation.version, revision: 1 };
    const token = registration.operation.confirmation === "explicit" ? randomUUID() : undefined;
    const deadline = token ? this.options.now() + this.options.confirmationTtlMs : undefined;
    const invocation: AugInvocation = token ? {
      ...identity, state: "awaiting_confirmation",
      confirmation: { token, expiresAt: deadline!, input: request.input },
    } : { ...identity, state: "running" };
    const record: InvocationRecord = {
      invocation, request, principalId: principal.id, tenantId: principal.tenantId, callerScopes: [...new Set(principal.scopes)].sort(),
      selectedId: selected.id, fingerprint: requestFingerprint, contractHash: registration.contractHash,
      key, confirmationToken: token, confirmationDeadline: deadline, keepUntil: null,
    };
    this.store.insert(record); // Commit the request reservation before any handler can run.
    this.event(record);
    if (!token) this.execute(record, registration, principal);
    return this.snapshot(record);
  }

  control(principal: Principal, input: unknown): AugInvocation {
    this.check();
    const request = validateControlRequest(input);
    this.sweep();
    const record = this.store.get(request.invocationId);
    if (!record || record.principalId !== principal.id || record.tenantId !== principal.tenantId) {
      throw new AugError("INVOCATION_NOT_FOUND", "Invocation is not available", 404);
    }
    this.checkRetainedAccess(record, principal);
    const registration = this.operation(principal, record.request.operationId);
    if (registration.operation.version !== record.request.operationVersion) {
      throw new AugError("OPERATION_VERSION_MISMATCH", "Operation version has changed", 409);
    }
    if (registration.contractHash !== record.contractHash) throw new AugError("OPERATION_CONTRACT_CHANGED", "Operation contract has changed", 409);
    if (!allowedInput(registration, principal, freeze(structuredClone(record.request.input)))) throw new AugError("OPERATION_NOT_FOUND", "Operation is not available", 404);
    if (request.action === "confirm") {
      const token = record.confirmationToken;
      const expected = Buffer.from(token ?? "");
      const provided = Buffer.from(request.token);
      if (!token || expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        throw new AugError("CONFIRMATION_DENIED", "Confirmation is not available", 403);
      }
      if (record.invocation.state === "expired") throw new AugError("CONFIRMATION_EXPIRED", "Confirmation has expired", 409);
      if (record.invocation.state === "awaiting_confirmation") {
        registration.validateInput(record.request.input);
        this.move(record, { ...this.identity(record), state: "running" });
        this.execute(record, registration, principal);
      }
      // A repeated valid confirmation returns current state; it never starts another execution.
    }
    return this.snapshot(record);
  }

  private operation(principal: Principal, id: string): Registration {
    const registration = this.operations.get(id);
    if (!registration || !allowed(registration, principal)) throw new AugError("OPERATION_NOT_FOUND", "Operation is not available", 404);
    return registration;
  }

  private execute(record: InvocationRecord, registration: Registration, principal: Principal): void {
    const context = freeze({ principal: structuredClone(principal), requestId: record.request.requestId, invocationId: record.invocation.id });
    const savedInput = freeze(structuredClone(record.request.input));
    let dispatched = false;
    void Promise.resolve().then(() => {
      if (this.closed || this.faulted) return;
      if (!allowed(registration, context.principal) || !allowedInput(registration, context.principal, savedInput)) throw new Error("Operation permission was revoked");
      dispatched = true;
      return registration.execute(savedInput, context);
    }).then((result) => {
      if (this.closed || this.faulted) return;
      const output = validateOperationOutput(registration.operation, result);
      const selected = output.representations.find((entry) => entry.id === record.selectedId);
      if (!selected) throw new Error("Promised representation is absent");
      const negotiated = negotiateOutput({ ...output, representations: [selected] }, record.request.runtime, "view");
      // Detach handler-owned objects before retaining results across polls or retries.
      this.move(record, { ...this.identity(record), state: "succeeded", output: structuredClone(negotiated) });
    }).catch((error) => {
      if (this.closed || this.faulted) return;
      if (error instanceof AugError && ["STATE_STORE_UNAVAILABLE", "STATE_STORE_INVALID", "STATE_CONFLICT"].includes(error.code)) {
        this.faulted = true; return;
      }
      // Backend messages may contain input, documents, credentials or provider responses.
      try {
        this.move(record, dispatched && registration.operation.effect !== "read"
          ? { ...this.identity(record), state: "indeterminate", error: { code: "EXECUTION_OUTCOME_UNKNOWN" } }
          : { ...this.identity(record), state: "failed", error: { code: "OPERATION_FAILED" } });
      } catch { this.faulted = true; }
    });
  }

  private identity(record: InvocationRecord) {
    const { protocolVersion: version, id, operationId, operationVersion } = record.invocation;
    return { protocolVersion: version, id, operationId, operationVersion, revision: record.invocation.revision + 1 };
  }

  private move(record: InvocationRecord, next: AugInvocation): void {
    assertInvocationTransition(record.invocation.state, next.state);
    const keepUntil = ["succeeded", "failed", "expired", "indeterminate"].includes(next.state)
      ? this.options.now() + this.options.retentionMs : record.keepUntil;
    this.store.replace({ ...record, invocation: next, keepUntil }, record.invocation.revision);
    record.invocation = next;
    record.keepUntil = keepUntil;
    this.event(record);
  }

  private snapshot(record: InvocationRecord): AugInvocation { return structuredClone(record.invocation); }

  private sweep(): void {
    const now = this.options.now();
    for (const record of this.store.all()) {
      if (record.invocation.state === "awaiting_confirmation" && record.confirmationDeadline! <= now) {
        this.move(record, { ...this.identity(record), state: "expired" });
      }
      if (record.keepUntil !== null && record.keepUntil <= now) this.store.retire(record);
    }
  }

  private event(record: InvocationRecord): void {
    const { operationId, operationVersion, state } = record.invocation;
    try {
      this.options.onEvent?.({ operationId, operationVersion, state,
        principalId: record.principalId, tenantId: record.tenantId,
        ...(["failed", "indeterminate"].includes(record.invocation.state) && "error" in record.invocation ? { code: record.invocation.error.code } : {}),
      });
    } catch { /* An audit sink cannot alter execution state. */ }
  }

  private check(): void {
    if (this.closed || this.faulted) throw new AugError("STATE_STORE_UNAVAILABLE", "Operation broker is unavailable", 503);
  }

  private checkRetainedAccess(record: StoredInvocation, principal: Principal): void {
    if (!record.callerScopes.every((scope) => principal.scopes.includes(scope))) throw new AugError("OPERATION_NOT_FOUND", "Operation is not available", 404);
  }

  close(): void { if (!this.closed) { this.closed = true; this.store.close(); } }
}
