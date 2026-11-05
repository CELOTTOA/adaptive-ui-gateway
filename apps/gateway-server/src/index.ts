import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as HttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { AugError } from "@aug/core";
import { AugProtocolError, protocolVersion } from "@aug/protocol";
import type { Principal } from "@aug/core";
import type { UiPlanner } from "@aug/ui-planner";
import { GatewayService } from "./gateway-service.js";
import type { GatewayServiceOptions } from "./gateway-service.js";

export { GatewayService, bindingPolicyId } from "./gateway-service.js";
export type { AuditEvent, CreatedPlan, GatewayServiceOptions } from "./gateway-service.js";
export { OperationBroker } from "./operation-broker.js";
export type { OperationBrokerOptions, OperationContext, OperationEvent, OperationRegistration } from "./operation-broker.js";
export { MemoryInvocationStore } from "./invocation-store.js";
export type { InvocationStore, InvocationReceipt, StoredInvocation } from "./invocation-store.js";
export { SqliteInvocationStore } from "./sqlite-invocation-store.js";
export { operationStoreFromEnv } from "./state-config.js";
export { createPlannerFromEnv } from "./planner-config.js";
export type { PlannerConfig, PlannerConfigOverrides } from "./planner-config.js";

export interface GatewayServerOptions {
  openApiSource: string;
  backendBaseUrl: string;
  backendToken: string;
  authenticate: (token: string) => Principal | undefined;
  /** Additional exact Origin values allowed for direct MCP App view requests. */
  allowedOrigins?: string[];
  /** Optional HTTPS certificate and private key; HTTP remains the default. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  tenantIds?: string[];
  planner?: UiPlanner;
  planTtlMs?: number;
  onAudit?: GatewayServiceOptions["onAudit"];
  operations?: GatewayServiceOptions["operations"];
  operationBroker?: GatewayServiceOptions["operationBroker"];
  operationStore?: GatewayServiceOptions["operationStore"];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function principal(request: IncomingMessage, options: GatewayServerOptions): Principal {
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const authenticated = token ? options.authenticate(token) : undefined;
  if (!authenticated) {
    throw new AugError("UNAUTHORIZED", "Authentication is required", 401);
  }
  return authenticated;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new AugError("UNSUPPORTED_MEDIA_TYPE", "A JSON request body is required", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) {
      throw new AugError("REQUEST_TOO_LARGE", "Request body is too large", 413);
    }
    chunks.push(buffer);
  }
  try {
    return asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new AugError("INVALID_JSON", "Request body must be valid JSON");
  }
}

function checkOrigin(request: IncomingMessage, options: GatewayServerOptions): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers.host;
  const scheme = (request.socket as TLSSocket).encrypted ? "https" : "http";
  const sameOrigin = Boolean(host && origin === `${scheme}://${host}`);
  if (!sameOrigin && !options.allowedOrigins?.includes(origin)) {
    throw new AugError("ORIGIN_DENIED", "Request origin is not allowed", 403);
  }
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayServerOptions,
): void {
  response.setHeader("Vary", "Origin");
  const origin = request.headers.origin;
  if (!origin || !options.allowedOrigins?.includes(origin)) return;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Max-Age", "600");
}

const document = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AUG protected read-only demo</title>
  <link rel="stylesheet" href="/styles.css">
  <script type="module" src="/renderer.js"></script>
</head>
<body>
  <main>
    <p class="eyebrow">Adaptive UI Gateway</p>
    <h1>Protected read-only demo</h1>
    <p>The interface is generated from capability metadata. Records stay outside the planning channel.</p>
    <section aria-labelledby="connection-title">
      <h2 id="connection-title">Demo session</h2>
      <label for="token">Demo access token</label>
      <input id="token" type="password" autocomplete="off" required>
      <button id="load-plan" type="button">Create search interface</button>
      <p id="setup-status" role="status"></p>
    </section>
    <div id="app"></div>
  </main>
</body>
</html>`;

async function asset(
  response: ServerResponse,
  url: URL,
  contentType: string,
): Promise<void> {
  const content = await readFile(url);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

const sharedRendererUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("@aug/ui-renderer/plan-renderer.js"),
);
const rendererRequire = createRequire(import.meta.url);
const operationRuntimeUrl = pathToFileURL(rendererRequire.resolve("@aug/ui-renderer/operation-runtime.js"));
const runtimeStyleUrl = pathToFileURL(rendererRequire.resolve("@aug/ui-renderer/runtime.css"));

const runtimeDocument = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AUG operations</title><link rel="stylesheet" href="/runtime.css"><script type="module" src="/runtime-page.js"></script></head>
<body class="aug-runtime-page"><main>
<header><h1>AUG operations</h1><a href="/">Search demo</a></header>
<details id="runtime-connection" open><summary>Connection</summary><form id="runtime-connect" class="aug-connect">
<label>Direct AUG access token<input id="runtime-token" type="password" autocomplete="off" required></label>
<button id="runtime-connect-button" type="submit">Connect</button>
<p id="runtime-connect-status" role="status">Connect to see the operations available to you.</p>
</form></details><div id="runtime-app"></div></main></body></html>`;

export async function createGatewayServer(options: GatewayServerOptions): Promise<Server | HttpsServer> {
  const service = new GatewayService(options);

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    applyCors(request, response, options);
    try {
      const url = new URL(request.url ?? "/", "http://gateway.local");
      if (request.method === "OPTIONS") {
        checkOrigin(request, options);
        if (["/v1/plans", "/v1/data/query", "/v1/aug/query", "/v1/aug/operations", "/v1/aug/invocations", "/v1/aug/invocations/control"].includes(url.pathname)) {
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok", mode: "protected" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        });
        response.end(document);
        return;
      }
      if (request.method === "GET" && url.pathname === "/runtime") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
        response.end(runtimeDocument);
        return;
      }
      if (request.method === "GET" && url.pathname === "/operation-runtime.js") {
        await asset(response, operationRuntimeUrl, "text/javascript; charset=utf-8"); return;
      }
      if (request.method === "GET" && url.pathname === "/runtime.css") {
        await asset(response, runtimeStyleUrl, "text/css; charset=utf-8"); return;
      }
      if (request.method === "GET" && url.pathname === "/runtime-page.js") {
        await asset(response, new URL("../public/runtime-page.js", import.meta.url), "text/javascript; charset=utf-8"); return;
      }
      if (request.method === "GET" && url.pathname === "/renderer.js") {
        await asset(
          response,
          new URL("../public/renderer.js", import.meta.url),
          "text/javascript; charset=utf-8",
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/plan-renderer.js") {
        await asset(response, sharedRendererUrl, "text/javascript; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname === "/styles.css") {
        await asset(response, new URL("../public/styles.css", import.meta.url), "text/css; charset=utf-8");
        return;
      }

      const currentPrincipal = principal(request, options);
      if (request.method === "GET" && url.pathname === "/v1/catalog") {
        json(response, 200, { capabilities: service.listCatalog(currentPrincipal) });
        return;
      }
      checkOrigin(request, options);
      if (request.method === "POST" && url.pathname === "/v1/aug/operations") {
        json(response, 200, { protocolVersion, operations: service.listOperations(currentPrincipal) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/aug/invocations") {
        const invocation = service.invokeOperation(currentPrincipal, await body(request));
        json(response, ["running", "awaiting_confirmation"].includes(invocation.state) ? 202 : 200, invocation);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/aug/invocations/control") {
        const invocation = service.controlInvocation(currentPrincipal, await body(request));
        json(response, ["running", "awaiting_confirmation"].includes(invocation.state) ? 202 : 200, invocation);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/aug/query") {
        const input = await body(request);
        const result = await service.queryOutput(
          currentPrincipal, input.planId, input.actionId, input.state, input.runtime,
        );
        json(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/plans") {
        const input = await body(request);
        const { planId, expiresAt, plan, source } = await service.createPlan(
          currentPrincipal,
          input.intent,
          input.capabilityId,
        );
        json(response, 201, { planId, expiresAt, plan, planner: { source } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/data/query") {
        const input = await body(request);
        const result = await service.query(
          currentPrincipal,
          input.planId,
          input.actionId,
          input.state,
        );
        json(response, 200, result);
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof AugProtocolError) {
        const status = ["NO_COMPATIBLE_REPRESENTATION", "UNSUPPORTED_PROTOCOL_VERSION"].includes(error.code)
          ? 406 : ["INVALID_RUNTIME", "INVALID_INVOCATION", "INVALID_INPUT"].includes(error.code) ? 400 : 500;
        json(response, status, { error: error.message, code: error.code });
      } else if (error instanceof AugError) {
        json(response, error.status, { error: error.message, code: error.code });
      } else {
        json(response, 500, { error: "Internal gateway error", code: "INTERNAL_ERROR" });
      }
    }
  };
  const server = options.tls ? createHttpsServer(options.tls, handleRequest) : createServer(handleRequest);
  server.once("close", () => service.close());
  server.once("error", () => service.close());
  return server;
}

export async function startGatewayServer(
  options: GatewayServerOptions & { port: number },
): Promise<Server | HttpsServer> {
  const server = await createGatewayServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
