import { resolve } from "node:path";
import type { Principal } from "@aug/core";
import { principalFromEnv } from "./principal.js";

export interface McpBackendConfig {
  mode: "demo" | "external";
  openApiFile: string;
  backendBaseUrl?: string;
  backendToken: string;
  accessToken: string;
  principal: Principal;
}

const backendKeys = ["AUG_OPENAPI_FILE", "AUG_BACKEND_URL", "AUG_BACKEND_TOKEN"] as const;
const identityKeys = ["AUG_PRINCIPAL_ID", "AUG_TENANT_ID", "AUG_SCOPES"] as const;

function secret(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value || value.length < 16 || value.length > 8192 || /[\r\n]/.test(value)) {
    throw new Error(`${key} must contain 16–8192 characters without line breaks`);
  }
  return value;
}

/** Explicit external configuration; absence of backend settings retains the synthetic demo. */
export function backendConfigFromEnv(
  env: Record<string, string | undefined>,
  options: { cwd: string; demoOpenApiFile: string },
): McpBackendConfig {
  const external = backendKeys.some((key) => Boolean(env[key]));
  if (!external) {
    return {
      mode: "demo",
      openApiFile: options.demoOpenApiFile,
      backendToken: "demo-backend-service-token",
      accessToken: env.AUG_ACCESS_TOKEN ? secret(env, "AUG_ACCESS_TOKEN") : "demo-analyst-token",
      principal: principalFromEnv(env),
    };
  }
  for (const key of [...backendKeys, "AUG_ACCESS_TOKEN", ...identityKeys]) {
    // An explicit empty scope list is allowed: it authorizes no capabilities.
    if (env[key] === undefined || (key !== "AUG_SCOPES" && !env[key])) {
      throw new Error(`${key} is required for an external backend`);
    }
  }
  let url: URL;
  try {
    url = new URL(env.AUG_BACKEND_URL!);
  } catch {
    throw new Error("AUG_BACKEND_URL must be a valid HTTPS or loopback HTTP URL");
  }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("AUG_BACKEND_URL must use HTTPS or loopback HTTP without credentials, query or fragment");
  }
  const backendToken = secret(env, "AUG_BACKEND_TOKEN");
  const accessToken = secret(env, "AUG_ACCESS_TOKEN");
  if (backendToken === accessToken) {
    throw new Error("AUG_ACCESS_TOKEN must differ from AUG_BACKEND_TOKEN");
  }
  return {
    mode: "external",
    openApiFile: resolve(options.cwd, env.AUG_OPENAPI_FILE!),
    backendBaseUrl: url.href,
    backendToken,
    accessToken,
    principal: principalFromEnv(env),
  };
}
