import { createHash } from "node:crypto";
import { AugError } from "@aug/core";
import { validateInvocation, validateInvokeRequest } from "@aug/protocol/operations";
import type { AugInvocation, AugInvokeRequest } from "@aug/protocol/operations";

export interface StoredInvocation {
  invocation: AugInvocation;
  request: AugInvokeRequest;
  principalId: string;
  tenantId: string;
  callerScopes: string[];
  selectedId: string;
  fingerprint: string;
  contractHash: string;
  key: string;
  confirmationToken?: string;
  confirmationDeadline?: number;
  /** null means active; finite timestamps are eligible for payload retirement. */
  keepUntil: number | null;
}

export interface InvocationReceipt { invocationId: string; fingerprint: string; contractHash: string }

/** One exclusive broker owner. Methods must commit synchronously or throw without partial changes. */
export interface InvocationStore {
  readonly durable: boolean;
  claim(): void;
  all(): StoredInvocation[];
  get(id: string): StoredInvocation | undefined;
  lookup(key: string): InvocationReceipt | undefined;
  insert(record: StoredInvocation): void;
  replace(record: StoredInvocation, expectedRevision: number): void;
  retire(record: StoredInvocation): void;
  close(): void;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function validateStoredInvocation(input: unknown): StoredInvocation {
  const record = input as StoredInvocation;
  try {
    validateInvocation(record.invocation);
    validateInvokeRequest(record.request);
    if (typeof record.principalId !== "string" || !record.principalId || typeof record.tenantId !== "string" || !record.tenantId ||
      !Array.isArray(record.callerScopes) || record.callerScopes.some((scope) => typeof scope !== "string") || new Set(record.callerScopes).size !== record.callerScopes.length ||
      typeof record.selectedId !== "string" || !record.selectedId || !/^[a-f0-9]{64}$/.test(record.contractHash) ||
      record.fingerprint !== fingerprint(record.request) ||
      record.key !== JSON.stringify([record.tenantId, record.principalId, record.request.requestId]) ||
      record.request.operationId !== record.invocation.operationId || record.request.operationVersion !== record.invocation.operationVersion ||
      !(record.keepUntil === null || (Number.isSafeInteger(record.keepUntil) && record.keepUntil >= 0))) throw new Error();
    if (record.invocation.state === "awaiting_confirmation" &&
      (record.confirmationToken !== record.invocation.confirmation.token || record.confirmationDeadline !== record.invocation.confirmation.expiresAt ||
      canonical(record.invocation.confirmation.input) !== canonical(record.request.input))) throw new Error();
    if (record.invocation.state === "succeeded" && (record.invocation.output.audience !== "view" || record.invocation.output.representation.id !== record.selectedId)) throw new Error();
    return record;
  } catch { throw new AugError("STATE_STORE_INVALID", "Stored invocation state is invalid", 503); }
}

export class MemoryInvocationStore implements InvocationStore {
  readonly durable = false;
  private readonly records = new Map<string, StoredInvocation>();
  private readonly requests = new Map<string, InvocationReceipt>();
  private claimed = false;
  private closed = false;
  claim(): void {
    if (this.claimed || this.closed) throw new AugError("STATE_STORE_IN_USE", "Invocation store is not available", 503);
    this.claimed = true;
  }
  private check(): void { if (this.closed) throw new AugError("STATE_STORE_UNAVAILABLE", "Invocation store is closed", 503); }
  all(): StoredInvocation[] { this.check(); return structuredClone([...this.records.values()]); }
  get(id: string): StoredInvocation | undefined { this.check(); return structuredClone(this.records.get(id)); }
  lookup(key: string): InvocationReceipt | undefined { this.check(); return structuredClone(this.requests.get(key)); }
  insert(record: StoredInvocation): void {
    this.check();
    if (this.requests.has(record.key) || this.records.has(record.invocation.id)) throw new AugError("IDEMPOTENCY_CONFLICT", "Invocation already exists", 409);
    this.records.set(record.invocation.id, structuredClone(record));
    this.requests.set(record.key, { invocationId: record.invocation.id, fingerprint: record.fingerprint, contractHash: record.contractHash });
  }
  replace(record: StoredInvocation, expectedRevision: number): void {
    this.check();
    if (this.records.get(record.invocation.id)?.invocation.revision !== expectedRevision) throw new AugError("STATE_CONFLICT", "Invocation state has changed", 409);
    this.records.set(record.invocation.id, structuredClone(record));
  }
  retire(record: StoredInvocation): void {
    this.check();
    if (this.records.get(record.invocation.id)?.invocation.revision !== record.invocation.revision) throw new AugError("STATE_CONFLICT", "Invocation state has changed", 409);
    this.records.delete(record.invocation.id); this.requests.delete(record.key);
  }
  close(): void { this.closed = true; this.records.clear(); this.requests.clear(); }
}
