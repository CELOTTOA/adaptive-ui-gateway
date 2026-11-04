export type JsonSchema = Record<string, unknown>;

export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export type CapabilityEffect = "read" | "write" | "destructive" | "external_side_effect";
export type ConfirmationLevel = "none" | "explicit" | "strong";

export interface Principal {
  id: string;
  tenantId: string;
  scopes: string[];
}

export interface FieldPolicy {
  classification: DataClassification;
  requiredScopes: string[];
}

export interface Capability {
  id: string;
  title: string;
  source: "openapi" | "mcp";
  sourceOperationId: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  effect: CapabilityEffect;
  requiredScopes: string[];
  confirmation: ConfirmationLevel;
  dataClassification: DataClassification;
  fields: Record<string, FieldPolicy>;
  version: string;
}

export interface OperationBinding {
  capabilityId: string;
  method: "GET";
  path: string;
}

export interface ImportedCapability {
  capability: Capability;
  binding: OperationBinding;
}

export interface StateReference {
  stateRef: string;
}

export interface UiAction {
  id: string;
  type: "query";
  dataSourceId: string;
  args: Record<string, StateReference>;
}

export interface DataSourcePlan {
  id: string;
  capabilityId: string;
  bindingPolicyId: string;
  fields: string[];
}

export type UiComponent =
  | { id: string; type: "heading"; text: string }
  | { id: string; type: "text-input"; label: string; bind: string }
  | { id: string; type: "button"; label: string; actionRef: string }
  | {
      id: string;
      type: "data-table";
      dataSourceId: string;
      columns: { key: string; label: string }[];
    }
  | { id: string; type: "status-message"; text: string };

export interface UiPlan {
  schemaVersion: "aug.ui/0.1";
  viewId: string;
  title: string;
  components: UiComponent[];
  actions: UiAction[];
  dataSources: DataSourcePlan[];
}

export interface QueryResult {
  rows: Record<string, string | number | boolean | null>[];
}

export class AugError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "AugError";
  }
}

export function hasRequiredScopes(principal: Principal, requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => principal.scopes.includes(scope));
}
