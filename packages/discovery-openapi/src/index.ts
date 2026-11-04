import { parse } from "yaml";
import { AugError } from "@aug/core";
import type {
  CapabilityEffect,
  DataClassification,
  ImportedCapability,
  JsonSchema,
} from "@aug/core";

type UnknownRecord = Record<string, unknown>;

const classifications = new Set<DataClassification>([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function resolveReference(document: UnknownRecord, reference: string): UnknownRecord {
  if (!reference.startsWith("#/")) {
    throw new AugError("UNSUPPORTED_OPENAPI_REF", "Only local OpenAPI references are supported");
  }
  const value = reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part) => asRecord(current)[part], document);
  return asRecord(value);
}

function resolveSchema(document: UnknownRecord, schema: unknown): UnknownRecord {
  const record = asRecord(schema);
  return typeof record.$ref === "string"
    ? resolveSchema(document, resolveReference(document, record.$ref))
    : record;
}

function classification(value: unknown): DataClassification {
  return typeof value === "string" && classifications.has(value as DataClassification)
    ? (value as DataClassification)
    : "restricted";
}

function effect(value: unknown): CapabilityEffect {
  return value === "read" ||
    value === "write" ||
    value === "destructive" ||
    value === "external_side_effect"
    ? value
    : "write";
}

function outputSchema(operation: UnknownRecord): JsonSchema {
  const responses = asRecord(operation.responses);
  const response = asRecord(responses["200"]);
  const content = asRecord(response.content);
  const json = asRecord(content["application/json"]);
  return asRecord(json.schema);
}

function inputSchema(document: UnknownRecord, operation: UnknownRecord): JsonSchema {
  const properties: UnknownRecord = {};
  const required: string[] = [];
  for (const parameterValue of Array.isArray(operation.parameters) ? operation.parameters : []) {
    const parameter = asRecord(parameterValue);
    if (typeof parameter.name !== "string" || !["query", "path"].includes(String(parameter.in))) {
      continue;
    }
    properties[parameter.name] = resolveSchema(document, parameter.schema);
    if (parameter.required === true) {
      required.push(parameter.name);
    }
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

export function discoverReadCapabilities(source: string): ImportedCapability[] {
  const document = asRecord(parse(source));
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.")) {
    throw new AugError("UNSUPPORTED_OPENAPI_VERSION", "An OpenAPI 3.x document is required");
  }

  const imported: ImportedCapability[] = [];
  for (const [path, pathItemValue] of Object.entries(asRecord(document.paths))) {
    const pathItem = asRecord(pathItemValue);
    const operation = asRecord(pathItem.get);
    if (Object.keys(operation).length === 0 || effect(operation["x-aug-effect"]) !== "read") {
      continue;
    }
    if (typeof operation.operationId !== "string") {
      throw new AugError("MISSING_OPERATION_ID", "Read operations require an operationId");
    }

    const responseSchema = outputSchema(operation);
    const itemSchema = resolveSchema(document, asRecord(responseSchema).items);
    const outputProperties = asRecord(itemSchema.properties);
    const fields: ImportedCapability["capability"]["fields"] = {};
    for (const [fieldName, fieldValue] of Object.entries(outputProperties)) {
      const field = resolveSchema(document, fieldValue);
      fields[fieldName] = {
        classification: classification(field["x-aug-classification"]),
        requiredScopes: stringArray(field["x-aug-required-scopes"]),
      };
    }

    const requiredScopes = stringArray(operation["x-aug-required-scopes"]);
    const capabilityId =
      typeof operation["x-aug-id"] === "string"
        ? operation["x-aug-id"]
        : operation.operationId;
    imported.push({
      capability: {
        id: capabilityId,
        title:
          typeof operation["x-aug-title"] === "string"
            ? operation["x-aug-title"]
            : typeof operation.summary === "string"
              ? operation.summary
              : operation.operationId,
        source: "openapi",
        sourceOperationId: operation.operationId,
        description:
          typeof operation.description === "string"
            ? operation.description
            : typeof operation.summary === "string"
              ? operation.summary
              : operation.operationId,
        inputSchema: inputSchema(document, operation),
        outputSchema: responseSchema,
        effect: "read",
        requiredScopes,
        confirmation: "none",
        dataClassification: classification(operation["x-aug-classification"]),
        fields,
        version: typeof operation["x-aug-version"] === "string" ? operation["x-aug-version"] : "1",
      },
      binding: {
        capabilityId,
        method: "GET",
        path,
      },
    });
  }
  return imported;
}
