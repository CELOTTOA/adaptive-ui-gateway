// Local stdio entrypoint: synthetic demo or explicitly configured OpenAPI backend.
// stdout is reserved for the MCP protocol: all diagnostics go to stderr.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCustomerApi } from "@aug/example-customer-api";
import { GatewayService, createPlannerFromEnv, operationStoreFromEnv, startGatewayServer } from "@aug/gateway-server";
import type { AuditEvent } from "@aug/gateway-server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createAugMcpServer, backendConfigFromEnv, ViewOriginRegistry } from "./index.js";

// Explicit AUG_ENV_FILE is resolved from cwd; an empty value disables local env loading.
const envFile = process.env.AUG_ENV_FILE === undefined
  ? fileURLToPath(new URL("../../../.envlocal", import.meta.url))
  : process.env.AUG_ENV_FILE ? resolve(process.env.AUG_ENV_FILE) : undefined;
if (envFile && existsSync(envFile)) {
  process.loadEnvFile(envFile);
} else if (envFile && process.env.AUG_ENV_FILE) {
  throw new Error("AUG_ENV_FILE does not exist");
}

const tlsCertFile = process.env.AUG_GATEWAY_TLS_CERT;
const tlsKeyFile = process.env.AUG_GATEWAY_TLS_KEY;
if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
  throw new Error("AUG_GATEWAY_TLS_CERT and AUG_GATEWAY_TLS_KEY must be configured together");
}
const gatewayTls = tlsCertFile && tlsKeyFile ? {
  cert: await readFile(tlsCertFile),
  key: await readFile(tlsKeyFile),
} : undefined;

const config = backendConfigFromEnv(process.env, {
  cwd: process.cwd(),
  demoOpenApiFile: fileURLToPath(new URL("../../../examples/customer-api/openapi.json", import.meta.url)),
});
const { principal, backendToken, accessToken } = config;
let openApiSource: string;
try {
  openApiSource = await readFile(config.openApiFile, "utf8");
} catch {
  throw new Error("Unable to read the configured OpenAPI document");
}
const { planner, description } = createPlannerFromEnv(process.env, {
  onEvent: (event) => console.error("aug planner", JSON.stringify(event)),
});
// Only the demo backend is owned by this process. External services are never stopped here.
const operationStore = operationStoreFromEnv(process.env);
const backend = config.mode === "demo" ? await startCustomerApi({ port: 0, backendToken }) : undefined;
const address = backend?.address();
const backendBaseUrl = config.backendBaseUrl ??
  (address && typeof address === "object" ? `http://127.0.0.1:${address.port}` : undefined);
if (!backendBaseUrl) throw new Error("Synthetic backend did not start");

let dataGateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let server: Awaited<ReturnType<typeof createAugMcpServer>> | undefined;
let closing = false;
// Drain the event loop instead of process.exit(), which can assert in libuv on Windows.
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await server?.close();
  } finally {
    dataGateway?.closeAllConnections();
    dataGateway?.close();
    backend?.closeAllConnections();
    backend?.close();
  }
}

async function run(): Promise<void> {
  const serviceOptions = {
    openApiSource,
    backendBaseUrl: backendBaseUrl!,
    backendToken,
    tenantIds: [principal.tenantId],
    ...(planner ? { planner } : {}),
    onAudit: (event: AuditEvent) => console.error("aug audit", JSON.stringify(event)),
  };
  const service = new GatewayService(serviceOptions);
  const viewOrigins = new ViewOriginRegistry((process.env.AUG_VIEW_ORIGINS ?? "null")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean));
  dataGateway = await startGatewayServer({
    // Hosts may launch separate stdio instances for chat, Cowork and Code.
    // Give each instance its own listener and advertise that origin to its view.
    port: 0,
    ...serviceOptions,
    ...(operationStore ? { operationStore } : {}),
    authenticate: (token) => (token === accessToken ? principal : undefined),
    allowedOrigins: viewOrigins.allowedOrigins,
    ...(gatewayTls ? { tls: gatewayTls } : {}),
  });
  const gatewayAddress = dataGateway.address();
  if (typeof gatewayAddress !== "object" || gatewayAddress === null) {
    throw new Error("Direct data gateway did not start");
  }
  const directGatewayOrigin = `${gatewayTls ? "https" : "http"}://127.0.0.1:${gatewayAddress.port}`;
  // Transport diagnostics contain no authorization headers, bodies or record values.
  dataGateway.on("request", (request, response) => {
    const path = request.url?.split("?", 1)[0];
    if (path !== "/v1/plans" && path !== "/v1/data/query") return;
    response.once("finish", () => {
      console.error("aug direct request", JSON.stringify({
        method: request.method,
        path,
        origin: request.headers.origin?.slice(0, 300) ?? null,
        status: response.statusCode,
      }));
    });
  });
  const mcpServer = await createAugMcpServer({ service, principal, directGatewayOrigin, viewOrigins });
  server = mcpServer;
  mcpServer.server.oninitialized = () => {
    // Host diagnostics: capability names and client info only.
    const capabilities = mcpServer.server.getClientCapabilities() ?? {};
    console.error(
      "aug host",
      JSON.stringify({
        client: mcpServer.server.getClientVersion(),
        capabilities: Object.keys(capabilities),
        extensions: (capabilities as { extensions?: unknown }).extensions ?? null,
      }),
    );
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("close", () => void shutdown());
  await mcpServer.connect(new StdioServerTransport());
  console.error(`aug mcp-apps server ready (backend: ${config.mode}, planner: ${description}, tenant: ${principal.tenantId})`);
  console.error(`aug direct data gateway ready (${directGatewayOrigin})`);

}

try {
  await run();
} catch (error) {
  await shutdown();
  throw error;
}
