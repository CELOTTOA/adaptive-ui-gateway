import { randomUUID } from "node:crypto";
import { AugError } from "@aug/core";
import type { Capability, Principal, QueryResult, UiAction, UiPlan } from "@aug/core";
import { CapabilityCatalog } from "@aug/capability-catalog";
import { discoverReadCapabilities } from "@aug/discovery-openapi";
import { ProtectedDataGateway } from "@aug/security";
import { DeterministicUiPlanner, toPlanningCapability } from "@aug/ui-planner";
import type { PlanSource, PlanningCapability, UiPlanner } from "@aug/ui-planner";
import { validateUiPlan } from "@aug/ui-schema";

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
  }

  listCatalog(principal: Principal): PlanningCapability[] {
    return this.catalog
      .listForPrincipal(principal)
      .map((capability) => toPlanningCapability(capability, principal));
  }

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
      return result;
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
