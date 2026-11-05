import { profiles, protocolVersion } from "@aug/protocol";
import { validateInvocation } from "@aug/protocol/operations";
import { setTimeout as delay } from "node:timers/promises";

export const principal = { id: "analyst", tenantId: "tenant-a", scopes: ["demo:use"] };
export const runtime = {
  protocolVersions: [protocolVersion], profiles: [profiles.json],
  mediaTypes: ["application/json"], deliveryKinds: ["inline"],
};

export function operation(changes = {}) {
  return {
    protocolVersion, id: "demo.calculate", version: "1", title: "Calculate", description: "Synthetic backend operation",
    effect: "read", confirmation: "none",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["amount"],
      properties: { amount: { type: "number", minimum: 0, maximum: 100 }, note: { type: "string", maxLength: 80 } },
    },
    output: [{ id: "json", profile: profiles.json, mediaType: "application/json", audiences: ["view"], deliveryKind: "inline" }],
    ...changes,
  };
}

export function output(value = { total: 10 }) {
  return { protocolVersion, id: "result", representations: [{
    id: "json", profile: profiles.json, mediaType: "application/json", audiences: ["view"],
    delivery: { kind: "inline", value },
  }] };
}

export function invoke(changes = {}) {
  return { protocolVersion, requestId: "request-1", operationId: "demo.calculate", operationVersion: "1", input: { amount: 10 }, runtime, ...changes };
}

export function control(invocation, action = "status", changes = {}) {
  return { protocolVersion, action, invocationId: invocation.id,
    ...(action === "confirm" ? { token: invocation.confirmation.token } : {}), ...changes };
}

export async function settled(read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = validateInvocation(await read());
    if (current.state !== "running") return current;
    await delay(10);
  }
  throw new Error("Invocation did not settle");
}
