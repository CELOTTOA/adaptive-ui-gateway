import type { Principal } from "@aug/core";

const identifier = /^[A-Za-z0-9._:@-]{1,100}$/;
const scope = /^[A-Za-z0-9._:-]{1,100}$/;
const maxScopes = 50;

/**
 * Principal for a local (stdio) MCP server, where the host provides no user identity.
 * Remote deployments must derive it from authenticated host/OAuth identity instead.
 */
export function principalFromEnv(env: Record<string, string | undefined>): Principal {
  const id = env.AUG_PRINCIPAL_ID ?? "demo-analyst";
  const tenantId = env.AUG_TENANT_ID ?? "tenant-a";
  if (!identifier.test(id)) {
    throw new Error("AUG_PRINCIPAL_ID must be 1-100 characters of letters, digits or ._:@-");
  }
  if (!identifier.test(tenantId)) {
    throw new Error("AUG_TENANT_ID must be 1-100 characters of letters, digits or ._:@-");
  }
  const rawScopes = env.AUG_SCOPES ?? "customers:read";
  const scopes = rawScopes
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (scopes.length > maxScopes || scopes.some((value) => !scope.test(value))) {
    throw new Error(`AUG_SCOPES must be a comma-separated list of at most ${maxScopes} scopes`);
  }
  return { id, tenantId, scopes };
}
