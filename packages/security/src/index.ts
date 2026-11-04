import { AugError, hasRequiredScopes } from "@aug/core";
import type {
  Capability,
  DataClassification,
  OperationBinding,
  Principal,
  QueryResult,
} from "@aug/core";

type UnknownRecord = Record<string, unknown>;

interface ProtectedDataGatewayOptions {
  backendBaseUrl: string;
  backendToken: string;
  allowedRendererClassifications?: DataClassification[];
  fetchImplementation?: typeof fetch;
}

export interface ProtectedQuery {
  principal: Principal;
  capability: Capability;
  binding: OperationBinding;
  fields: string[];
  args: Record<string, unknown>;
}

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

export class ProtectedDataGateway {
  private readonly baseUrl: URL;
  private readonly backendToken: string;
  private readonly allowedRendererClassifications: DataClassification[];
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ProtectedDataGatewayOptions) {
    this.baseUrl = new URL(options.backendBaseUrl);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(this.baseUrl.hostname);
    if (this.baseUrl.protocol !== "https:" && !(this.baseUrl.protocol === "http:" && loopback)) {
      throw new AugError("UNSAFE_BACKEND_URL", "Backend URLs must use HTTPS or loopback HTTP", 500);
    }
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new AugError("UNSAFE_BACKEND_URL", "Backend URL contains unsupported components", 500);
    }
    this.backendToken = options.backendToken;
    this.allowedRendererClassifications = options.allowedRendererClassifications ?? [
      "public",
      "internal",
    ];
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async query(input: ProtectedQuery): Promise<QueryResult> {
    const { principal, capability, binding, fields } = input;
    if (
      capability.effect !== "read" ||
      binding.capabilityId !== capability.id ||
      binding.method !== "GET" ||
      !hasRequiredScopes(principal, capability.requiredScopes)
    ) {
      throw new AugError("QUERY_DENIED", "Data query is not authorized", 403);
    }
    if (new Set(fields).size !== fields.length || fields.length === 0) {
      throw new AugError("QUERY_DENIED", "Requested fields are invalid", 403);
    }
    for (const field of fields) {
      const policy = capability.fields[field];
      if (
        !policy ||
        !hasRequiredScopes(principal, policy.requiredScopes) ||
        !this.allowedRendererClassifications.includes(policy.classification)
      ) {
        throw new AugError("FIELD_DENIED", "A requested field cannot be disclosed to this renderer", 403);
      }
    }

    const url = this.buildUrl(capability, binding, input.args);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.backendToken}`,
          "X-AUG-Tenant": principal.tenantId,
          "X-AUG-Principal": principal.id,
        },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new AugError("BACKEND_UNAVAILABLE", "Backend request failed", 502);
    }
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      throw new AugError("BACKEND_REQUEST_FAILED", "Backend returned an invalid response", 502);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > 1_000_000) {
      throw new AugError("BACKEND_RESPONSE_TOO_LARGE", "Backend response is too large", 502);
    }
    const body = await response.text();
    if (body.length > 1_000_000) {
      throw new AugError("BACKEND_RESPONSE_TOO_LARGE", "Backend response is too large", 502);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new AugError("INVALID_BACKEND_RESPONSE", "Backend returned invalid JSON", 502);
    }
    if (!Array.isArray(payload)) {
      throw new AugError("INVALID_BACKEND_RESPONSE", "Backend response must be an array", 502);
    }

    const rows: QueryResult["rows"] = [];
    for (const value of payload.slice(0, 100)) {
      const record = asRecord(value);
      const row: QueryResult["rows"][number] = {};
      for (const field of fields) {
        const fieldValue = record[field];
        if (
          fieldValue !== undefined &&
          fieldValue !== null &&
          !["string", "number", "boolean"].includes(typeof fieldValue)
        ) {
          throw new AugError("INVALID_BACKEND_RESPONSE", "Backend returned a non-scalar field", 502);
        }
        if (fieldValue !== undefined) {
          row[field] = fieldValue as string | number | boolean | null;
        }
      }
      rows.push(row);
    }
    return { rows };
  }

  private buildUrl(
    capability: Capability,
    binding: OperationBinding,
    args: Record<string, unknown>,
  ): URL {
    if (binding.path.includes("{")) {
      throw new AugError("UNSUPPORTED_OPERATION", "Path parameters are not supported in this slice", 400);
    }
    const base = this.baseUrl.pathname.endsWith("/")
      ? this.baseUrl
      : new URL(`${this.baseUrl.href}/`);
    const url = new URL(binding.path.replace(/^\//, ""), base);
    if (url.origin !== this.baseUrl.origin) {
      throw new AugError("QUERY_DENIED", "Operation target is not allowlisted", 403);
    }

    const properties = asRecord(capability.inputSchema.properties);
    const effectiveArgs = { ...args };
    if ("limit" in properties && effectiveArgs.limit === undefined) {
      effectiveArgs.limit = 25;
    }
    for (const [name, value] of Object.entries(effectiveArgs)) {
      if (value === undefined || value === "") {
        continue;
      }
      const schema = asRecord(properties[name]);
      if (Object.keys(schema).length === 0 || name.startsWith("_")) {
        throw new AugError("INVALID_QUERY_ARGUMENT", "Query argument is not allowlisted");
      }
      if (schema.type === "string") {
        if (typeof value !== "string" || value.length > 200) {
          throw new AugError("INVALID_QUERY_ARGUMENT", "Query argument has an invalid value");
        }
      } else if (schema.type === "integer" || schema.type === "number") {
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          (schema.type === "integer" && !Number.isInteger(value))
        ) {
          throw new AugError("INVALID_QUERY_ARGUMENT", "Query argument has an invalid value");
        }
      } else if (schema.type === "boolean" && typeof value !== "boolean") {
        throw new AugError("INVALID_QUERY_ARGUMENT", "Query argument has an invalid value");
      } else if (!["string", "integer", "number", "boolean"].includes(String(schema.type))) {
        throw new AugError("INVALID_QUERY_ARGUMENT", "Query argument type is not supported");
      }
      url.searchParams.set(name, String(value));
    }
    return url;
  }
}
