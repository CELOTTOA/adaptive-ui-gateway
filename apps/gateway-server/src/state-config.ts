import { AugError } from "@aug/core";
import { SqliteInvocationStore } from "./sqlite-invocation-store.js";
import type { InvocationStore } from "./invocation-store.js";

/** Explicit opt-in; never silently fall back to memory with partial persistent configuration. */
export function operationStoreFromEnv(env: Record<string, string | undefined>): (() => InvocationStore) | undefined {
  const path = env.AUG_STATE_DB, encoded = env.AUG_STATE_KEY;
  if (!path && !encoded) return undefined;
  if (!path?.trim() || !encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new AugError("INVALID_STATE_CONFIG", "AUG_STATE_DB and a base64-encoded 32-byte AUG_STATE_KEY are required together");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw new AugError("INVALID_STATE_CONFIG", "State encryption key is invalid");
  return () => new SqliteInvocationStore({ path, key });
}
