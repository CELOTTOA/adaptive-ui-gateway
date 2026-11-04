// stdio entrypoint for MCP hosts such as Claude Desktop (spike configuration).
// stdout is reserved for the MCP protocol: all diagnostics go to stderr.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { startCustomerApi } from "@aug/example-customer-api";
import { GatewayService, createPlannerFromEnv, startGatewayServer } from "@aug/gateway-server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createAugMcpServer, principalFromEnv, ViewOriginRegistry } from "./index.js";

const envFile = new URL("../../../.envlocal", import.meta.url);
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
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

// Local stdio server: identity comes from AUG_PRINCIPAL_ID / AUG_TENANT_ID / AUG_SCOPES.
const principal = principalFromEnv(process.env);
const backendToken = "demo-backend-service-token";

const openApiSource = await readFile(
  new URL("../../../examples/customer-api/openapi.json", import.meta.url),
  "utf8",
);
const backend = await startCustomerApi({ port: 0, backendToken });
const address = backend.address();
if (typeof address !== "object" || address === null) {
  throw new Error("Synthetic backend did not start");
}
const { planner, description } = createPlannerFromEnv(process.env, {
  onEvent: (event) => console.error("aug planner", JSON.stringify(event)),
});
const service = new GatewayService({
  openApiSource,
  backendBaseUrl: `http://127.0.0.1:${address.port}`,
  backendToken,
  ...(planner ? { planner } : {}),
  onAudit: (event) => console.error("aug audit", JSON.stringify(event)),
});
const viewOrigins = new ViewOriginRegistry((process.env.AUG_VIEW_ORIGINS ?? "null")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean));
const dataGateway = await startGatewayServer({
  // Hosts may launch separate stdio instances for chat, Cowork and Code.
  // Give each instance its own listener and advertise that origin to its view.
  port: 0,
  openApiSource,
  backendBaseUrl: `http://127.0.0.1:${address.port}`,
  backendToken,
  authenticate: (token) => (token === "demo-analyst-token" ? principal : undefined),
  allowedOrigins: viewOrigins.allowedOrigins,
  ...(gatewayTls ? { tls: gatewayTls } : {}),
  ...(planner ? { planner } : {}),
  onAudit: (event) => console.error("aug audit", JSON.stringify(event)),
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
const server = await createAugMcpServer({ service, principal, directGatewayOrigin, viewOrigins });
server.server.oninitialized = () => {
  // Host diagnostics: capability names and client info only.
  const capabilities = server.server.getClientCapabilities() ?? {};
  console.error(
    "aug host",
    JSON.stringify({
      client: server.server.getClientVersion(),
      capabilities: Object.keys(capabilities),
      extensions: (capabilities as { extensions?: unknown }).extensions ?? null,
    }),
  );
};
await server.connect(new StdioServerTransport());
console.error(`aug mcp-apps server ready (planner: ${description}, tenant: ${principal.tenantId})`);
console.error(`aug direct data gateway ready (${directGatewayOrigin})`);

let closing = false;
// Let the event loop drain instead of process.exit(): exiting while stdin is closing
// triggers a libuv assertion on Windows.
const shutdown = () => {
  if (closing) return;
  closing = true;
  void server.close().finally(() => {
    dataGateway.closeAllConnections();
    dataGateway.close();
    backend.closeAllConnections();
    backend.close();
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("close", shutdown);
