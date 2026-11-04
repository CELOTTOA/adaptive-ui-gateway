import { readFile } from "node:fs/promises";
import { startCustomerApi } from "@aug/example-customer-api";
import type { Principal } from "@aug/core";
import { createPlannerFromEnv, startGatewayServer } from "./index.js";

const backendToken = "demo-backend-service-token";
const principals = new Map<string, Principal>([
  [
    "demo-analyst-token",
    { id: "demo-analyst", tenantId: "tenant-a", scopes: ["customers:read"] },
  ],
  [
    "demo-other-tenant-token",
    { id: "demo-other-tenant", tenantId: "tenant-b", scopes: ["customers:read"] },
  ],
  ["demo-no-scope-token", { id: "demo-no-scope", tenantId: "tenant-a", scopes: [] }],
]);

const openApiSource = await readFile(
  new URL("../../../examples/customer-api/openapi.json", import.meta.url),
  "utf8",
);
// Real model planning is opt-in: GROK_API_KEY, optional XAI_MODEL and PLANNER_TIMEOUT_MS.
const { planner, description: plannerDescription } = createPlannerFromEnv(process.env, {
  onEvent: (event) => console.log("planner", JSON.stringify(event)),
});

function port(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("Demo ports must be integers from 0 to 65535");
  }
  return parsed;
}
const gatewayPort = port(process.env.AUG_PORT, 4000);
const backendPort = port(process.env.AUG_BACKEND_PORT, 4100);
const customerApi = await startCustomerApi({ port: backendPort, backendToken });
const backendAddress = customerApi.address();
if (!backendAddress || typeof backendAddress === "string") throw new Error("Backend did not start");
const gateway = await startGatewayServer({
  port: gatewayPort,
  openApiSource,
  backendBaseUrl: `http://127.0.0.1:${backendAddress.port}`,
  backendToken,
  authenticate: (token) => principals.get(token),
  ...(planner ? { planner } : {}),
  onAudit: (event) => console.log("audit", JSON.stringify(event)),
}).catch((error: unknown) => {
  customerApi.close();
  throw error;
});

const gatewayAddress = gateway.address();
if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Gateway did not start");
console.log(`AUG demo: http://127.0.0.1:${gatewayAddress.port}`);
console.log("Demo access token: demo-analyst-token");
console.log(`Planner: ${plannerDescription}`);

async function shutdown(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => gateway.close(() => resolve())),
    new Promise<void>((resolve) => customerApi.close(() => resolve())),
  ]);
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
