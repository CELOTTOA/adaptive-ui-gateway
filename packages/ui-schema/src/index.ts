import Ajv from "ajv";
import { AugError, hasRequiredScopes } from "@aug/core";
import type { Capability, Principal, UiPlan } from "@aug/core";

export const uiPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "viewId", "title", "components", "actions", "dataSources"],
  properties: {
    schemaVersion: { const: "aug.ui/0.1" },
    viewId: { type: "string", minLength: 1, maxLength: 100 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    components: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "text"],
            properties: {
              id: { $ref: "#/$defs/id" },
              type: { const: "heading" },
              text: { type: "string", minLength: 1, maxLength: 200 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "label", "bind"],
            properties: {
              id: { $ref: "#/$defs/id" },
              type: { const: "text-input" },
              label: { type: "string", minLength: 1, maxLength: 100 },
              bind: { $ref: "#/$defs/stateRef" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "label", "actionRef"],
            properties: {
              id: { $ref: "#/$defs/id" },
              type: { const: "button" },
              label: { type: "string", minLength: 1, maxLength: 100 },
              actionRef: { $ref: "#/$defs/id" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "dataSourceId", "columns"],
            properties: {
              id: { $ref: "#/$defs/id" },
              type: { const: "data-table" },
              dataSourceId: { $ref: "#/$defs/id" },
              columns: {
                type: "array",
                minItems: 1,
                maxItems: 30,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["key", "label"],
                  properties: {
                    key: { type: "string", minLength: 1, maxLength: 100 },
                    label: { type: "string", minLength: 1, maxLength: 100 },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "text"],
            properties: {
              id: { $ref: "#/$defs/id" },
              type: { const: "status-message" },
              text: { type: "string", maxLength: 200 },
            },
          },
        ],
      },
    },
    actions: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "dataSourceId", "args"],
        properties: {
          id: { $ref: "#/$defs/id" },
          type: { const: "query" },
          dataSourceId: { $ref: "#/$defs/id" },
          args: {
            type: "object",
            maxProperties: 20,
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              required: ["stateRef"],
              properties: { stateRef: { $ref: "#/$defs/stateRef" } },
            },
          },
        },
      },
    },
    dataSources: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "capabilityId", "bindingPolicyId", "fields"],
        properties: {
          id: { $ref: "#/$defs/id" },
          capabilityId: { type: "string", minLength: 1, maxLength: 200 },
          bindingPolicyId: { type: "string", minLength: 1, maxLength: 200 },
          fields: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
  },
  $defs: {
    id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
    stateRef: { type: "string", pattern: "^filters\\.[A-Za-z][A-Za-z0-9_-]{0,63}$" },
  },
} as const;

const ajv = new Ajv.default({ allErrors: true, strict: true });
const validateSchema = ajv.compile(uiPlanJsonSchema);

export interface UiPlanValidationOptions {
  capabilities: Capability[];
  principal: Principal;
  allowedBindingPolicyIds: string[];
}

function assertUnique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new AugError("INVALID_UI_PLAN", "UI Plan identifiers must be unique");
  }
}

export function validateUiPlan(input: unknown, options: UiPlanValidationOptions): UiPlan {
  if (!validateSchema(input)) {
    const details = (validateSchema.errors ?? [])
      .slice(0, 5)
      .map((error) => `${error.instancePath} ${error.message ?? "invalid value"}`.trim())
      .join("; ");
    throw new AugError("INVALID_UI_PLAN", `UI Plan schema validation failed: ${details}`);
  }

  const plan = input as UiPlan;
  assertUnique(plan.components.map((component) => component.id));
  assertUnique(plan.actions.map((action) => action.id));
  assertUnique(plan.dataSources.map((source) => source.id));

  const capabilities = new Map(options.capabilities.map((capability) => [capability.id, capability]));
  const sources = new Map(plan.dataSources.map((source) => [source.id, source]));
  const actions = new Set(plan.actions.map((action) => action.id));
  const bindings = new Set(
    plan.components
      .filter((component) => component.type === "text-input")
      .map((component) => component.bind),
  );

  for (const source of plan.dataSources) {
    const capability = capabilities.get(source.capabilityId);
    if (!capability || capability.effect !== "read") {
      throw new AugError("INVALID_UI_PLAN", "UI Plan references an unavailable read capability");
    }
    if (!options.allowedBindingPolicyIds.includes(source.bindingPolicyId)) {
      throw new AugError("INVALID_UI_PLAN", "UI Plan references an unapproved binding policy");
    }
    for (const field of source.fields) {
      const policy = capability.fields[field];
      if (
        !policy ||
        !hasRequiredScopes(options.principal, policy.requiredScopes) ||
        !["public", "internal"].includes(policy.classification)
      ) {
        throw new AugError("INVALID_UI_PLAN", "UI Plan references an unavailable field");
      }
    }
  }

  for (const component of plan.components) {
    if (component.type === "button" && !actions.has(component.actionRef)) {
      throw new AugError("INVALID_UI_PLAN", "UI Plan button references an unknown action");
    }
    if (component.type === "data-table") {
      const source = sources.get(component.dataSourceId);
      if (!source || component.columns.some((column) => !source.fields.includes(column.key))) {
        throw new AugError("INVALID_UI_PLAN", "UI Plan table contains an unauthorized binding");
      }
    }
  }

  for (const action of plan.actions) {
    if (!sources.has(action.dataSourceId)) {
      throw new AugError("INVALID_UI_PLAN", "UI Plan action references an unknown data source");
    }
    if (Object.values(action.args).some((argument) => !bindings.has(argument.stateRef))) {
      throw new AugError("INVALID_UI_PLAN", "UI Plan action references an unknown state binding");
    }
  }

  return plan;
}
