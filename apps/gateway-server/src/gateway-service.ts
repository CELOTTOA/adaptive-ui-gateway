import { randomUUID } from "node:crypto";
import { AugError } from "@aug/core";
import type { Capability, Principal, QueryResult, UiAction, UiPlan } from "@aug/core";
import { CapabilityCatalog } from "@aug/capability-catalog";
import { discoverReadCapabilities } from "@aug/discovery-openapi";
import { ProtectedDataGateway } from "@aug/security";
import { DeterministicUiPlanner, toPlanningCapability } from "@aug/ui-planner";
import type { PlanSource, PlanningCapability, UiPlanner } from "@aug/ui-planner";
import { validateUiPlan } from "@aug/ui-schema";
import { collectionOutput, negotiateOutput, profiles, protocolVersion, validateRuntimeCapabilities } from "@aug/protocol";
import type { JsonObject, NegotiatedOutput } from "@aug/protocol";
import type { AugInvocation, AugOperation } from "@aug/protocol/operations";
import { OperationBroker } from "./operation-broker.js";
import type { OperationBrokerOptions, OperationRegistration } from "./operation-broker.js";
import type { InvocationStore } from "./invocation-store.js";

export const bindingPolicyId = "protected.standalone.read-only.v1";

interface PlanSession {
  principalId: string;
  tenantId: string;
  plan: UiPlan;
  expiresAt: number;
}

/**
 * Audit record for the data plane. Contains identifiers, field names and counts only:
 * never record values, query arguments or plan session ids.
 */
export interface AuditEvent {
  type: "plan.created" | "query.executed" | "query.denied";
  at: string;
  principalId: string;
  tenantId: string;
  capabilityId?: string;
  fields?: string[];
  rowCount?: number;
  planSource?: PlanSource;
  code?: string;
}

export interface GatewayServiceOptions {
  openApiSource: string;
  backendBaseUrl: string;
  backendToken: string;
  tenantIds?: string[];
  planner?: UiPlanner;
  planTtlMs?: number;
  maxSessions?: number;
  onAudit?: (event: AuditEvent) => void;
  /** Backend-native operation registrations; existing OpenAPI reads are also exposed. */
  operations?: OperationRegistration[];
  operationBroker?: OperationBrokerOptions;
  operationStore?: () => InvocationStore;
}

export interface CreatedPlan {
  planId: string;
  expiresAt: number;
  plan: UiPlan;
  source: PlanSource;
  capability: Capability;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveArgument(state: Record<string, unknown>, stateRef: string): unknown {
  const [group, key] = stateRef.split(".");
  return group && key ? asRecord(state[group])[key] : undefined;
}

function findAction(plan: UiPlan, actionId: unknown): UiAction {
  const action = plan.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new AugError("ACTION_NOT_FOUND", "Action is not available in this session", 404);
  }
  return action;
}

/**
 * Transport-independent Protected-mode core: catalog, planning, plan sessions and
 * authorized data queries. Used by the standalone HTTP server and host adapters.
 */
export class GatewayService {
  private readonly catalog = new CapabilityCatalog();
  private readonly planner: UiPlanner;
  private readonly dataGateway: ProtectedDataGateway;
  private readonly sessions = new Map<string, PlanSession>();
  private readonly planTtlMs: number;
  private readonly maxSessions: number;
  private readonly onAudit: ((event: AuditEvent) => void) | undefined;
  private readonly operationRegistrations: OperationRegistration[];
  private readonly brokerOptions: OperationBrokerOptions;
  private broker?: OperationBroker;
  private readonly storeFactory?: () => InvocationStore;

  constructor(options: GatewayServiceOptions) {
    const imported = discoverReadCapabilities(options.openApiSource);
    for (const tenantId of options.tenantIds ?? ["tenant-a", "tenant-b"]) {
      for (const capability of imported) {
        this.catalog.register(tenantId, capability);
      }
    }
    this.planner = options.planner ?? new DeterministicUiPlanner();
    this.dataGateway = new ProtectedDataGateway({
      backendBaseUrl: options.backendBaseUrl,
      backendToken: options.backendToken,
    });
    this.planTtlMs = options.planTtlMs ?? 15 * 60 * 1000;
    this.maxSessions = options.maxSessions ?? 10_000;
    this.onAudit = options.onAudit;
    this.brokerOptions = options.operationBroker ?? {};
    this.operationRegistrations = [
      ...imported.map(({ capability }) => this.readOperation(capability)),
      ...(options.operations ?? []),
    ];
    this.storeFactory = options.operationStore;
    if (this.storeFactory && this.brokerOptions.store) throw new AugError("INVALID_STATE_CONFIG", "Configure one operation store source");
    if (this.storeFactory || this.brokerOptions.store) this.operations();
  }

  listOperations(principal: Principal): AugOperation[] { return this.operations().list(principal); }

  invokeOperation(principal: Principal, request: unknown): AugInvocation {
    return this.operations().invoke(principal, request);
  }

  controlInvocation(principal: Principal, request: unknown): AugInvocation {
    return this.operations().control(principal, request);
  }

  private operations(): OperationBroker {
    if (!this.broker) {
      // Unsupported legacy metadata must not change startup or the existing search path.
      const broker = new OperationBroker({ ...this.brokerOptions, ...(this.storeFactory ? { store: this.storeFactory } : {}) });
      try {
        for (const registration of this.operationRegistrations) broker.register(registration);
        this.broker = broker;
      } catch (error) { broker.close(); throw error; }
    }
    return this.broker;
  }

  private readOperation(capability: Capability): OperationRegistration {
    return {
      operation: {
        protocolVersion, id: capability.id, version: capability.version,
        title: capability.title, description: capability.description,
        effect: "read", confirmation: "none", inputSchema: capability.inputSchema as JsonObject,
        output: [profiles.collection, profiles.json].map((profile, index) => ({
          id: index === 0 ? "collection" : "json", profile, mediaType: "application/json",
          audiences: ["view"], deliveryKind: "inline",
        })),
      },
      authorize: (principal) => {
        const current = this.catalog.getForPrincipal(principal, capability.id);
        return toPlanningCapability(current, principal).fields.length > 0;
      },
      execute: async (input, { principal }) => {
        const current = this.catalog.getForPrincipal(principal, capability.id);
        const fields = toPlanningCapability(current, principal).fields;
        const result = await this.dataGateway.query({
          principal, capability: current, binding: this.catalog.getBinding(principal, capability.id),
          fields, args: input,
        });
        return collectionOutput(randomUUID(), { columns: fields.map((key) => ({ key })), rows: result.rows }, ["view"]);
      },
    };
  }

  listCatalog(principal: Principal): PlanningCapability[] {
    return this.catalog
      .listForPrincipal(principal)
      .map((capability) => toPlanningCapability(capability, principal));
  }

  close(): void { this.broker?.close(); }

  async createPlan(principal: Principal, intent: unknown, capabilityId: unknown): Promise<CreatedPlan> {
    if (
      typeof intent !== "string" ||
      intent.length === 0 ||
      intent.length > 500 ||
      typeof capabilityId !== "string"
    ) {
      throw new AugError("INVALID_PLAN_REQUEST", "Intent and capabilityId are required");
    }
    const capability = this.catalog.getForPrincipal(principal, capabilityId);
    const { plan, source } = await this.planner.planSearch({
      intent,
      capability: toPlanningCapability(capability, principal),
      bindingPolicyId,
    });
    validateUiPlan(plan, {
      capabilities: [capability],
      principal,
      allowedBindingPolicyIds: [bindingPolicyId],
    });
    this.sweepExpired();
    if (this.sessions.size >= this.maxSessions) {
      throw new AugError("TOO_MANY_SESSIONS", "Too many active plan sessions", 503);
    }
    const planId = randomUUID();
    const expiresAt = Date.now() + this.planTtlMs;
    this.sessions.set(planId, {
      principalId: principal.id,
      tenantId: principal.tenantId,
      plan,
      expiresAt,
    });
    this.audit({
      type: "plan.created",
      principalId: principal.id,
      tenantId: principal.tenantId,
      capabilityId: capability.id,
      planSource: source,
    });
    return { planId, expiresAt, plan, source, capability };
  }

  async query(
    principal: Principal,
    planId: unknown,
    actionId: unknown,
    stateValue: unknown,
  ): Promise<QueryResult> {
    return (await this.executeQuery(principal, planId, actionId, stateValue)).result;
  }

  /** Opt-in protocol delivery. All records remain on the authenticated view data plane. */
  async queryOutput(
    principal: Principal,
    planId: unknown,
    actionId: unknown,
    stateValue: unknown,
    runtimeInput: unknown,
  ): Promise<NegotiatedOutput> {
    const runtime = validateRuntimeCapabilities(runtimeInput);
    // Check compatibility before touching the backend. Empty output has identical delivery requirements.
    negotiateOutput(collectionOutput("query", { columns: [], rows: [] }, ["view"]), runtime, "view");
    const { result, fields } = await this.executeQuery(principal, planId, actionId, stateValue);
    return negotiateOutput(collectionOutput(randomUUID(), {
      columns: fields.map((key) => ({ key })),
      rows: result.rows,
    }, ["view"]), runtime, "view");
  }

  private async executeQuery(
    principal: Principal,
    planId: unknown,
    actionId: unknown,
    stateValue: unknown,
  ): Promise<{ result: QueryResult; capabilityId: string; fields: string[] }> {
    try {
      const { result, capabilityId, fields } = await this.runQuery(
        principal,
        planId,
        actionId,
        stateValue,
      );
      this.audit({
        type: "query.executed",
        principalId: principal.id,
        tenantId: principal.tenantId,
        capabilityId,
        fields,
        rowCount: result.rows.length,
      });
      return { result, capabilityId, fields };
    } catch (error) {
      this.audit({
        type: "query.denied",
        principalId: principal.id,
        tenantId: principal.tenantId,
        code: error instanceof AugError ? error.code : "INTERNAL_ERROR",
      });
      throw error;
    }
  }

  private async runQuery(
    principal: Principal,
    planId: unknown,
    actionId: unknown,
    stateValue: unknown,
  ): Promise<{ result: QueryResult; capabilityId: string; fields: string[] }> {
    const session = typeof planId === "string" ? this.sessions.get(planId) : undefined;
    if (
      !session ||
      session.expiresAt <= Date.now() ||
      session.principalId !== principal.id ||
      session.tenantId !== principal.tenantId
    ) {
      throw new AugError("PLAN_SESSION_NOT_FOUND", "Plan session is not available", 404);
    }
    const action = findAction(session.plan, actionId);
    const source = session.plan.dataSources.find((candidate) => candidate.id === action.dataSourceId);
    if (!source || source.bindingPolicyId !== bindingPolicyId) {
      throw new AugError("QUERY_DENIED", "Action has no approved data source", 403);
    }
    const state = asRecord(stateValue);
    const args = Object.fromEntries(
      Object.entries(action.args).map(([name, reference]) => [
        name,
        resolveArgument(state, reference.stateRef),
      ]),
    );
    const result = await this.dataGateway.query({
      principal,
      capability: this.catalog.getForPrincipal(principal, source.capabilityId),
      binding: this.catalog.getBinding(principal, source.capabilityId),
      fields: source.fields,
      args,
    });
    return { result, capabilityId: source.capabilityId, fields: [...source.fields] };
  }

  private audit(event: Omit<AuditEvent, "at">): void {
    try {
      this.onAudit?.({ at: new Date().toISOString(), ...event });
    } catch {
      // An audit sink failure must not change the outcome of the request.
    }
  }

  /** Number of stored sessions, for tests and monitoring. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [planId, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(planId);
      }
    }
  }
}
