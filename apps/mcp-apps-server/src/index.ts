import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { AugError } from "@aug/core";
import type { Principal } from "@aug/core";
import type { GatewayService } from "@aug/gateway-server";
import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { ViewOriginRegistry } from "./view-origins.js";
import { viewOriginPattern } from "./view-origins.js";

export { principalFromEnv } from "./principal.js";
export { backendConfigFromEnv } from "./backend-config.js";
export type { McpBackendConfig } from "./backend-config.js";
export { ViewOriginRegistry, viewOriginPattern } from "./view-origins.js";

export const searchViewUri = "ui://aug/search-view.html";
export const runtimeViewUri = "ui://aug/runtime-view.html";
export const toolNames = {
  listCapabilities: "aug_list_capabilities",
  createView: "aug_create_search_view",
  registerOrigin: "aug_register_view_origin",
  openRuntime: "aug_open_runtime",
} as const;

export interface AugMcpServerOptions {
  service: GatewayService;
  /** The authenticated principal this server instance acts for. */
  principal: Principal;
  /** Origin the view may call directly for UI Plans and protected records. */
  directGatewayOrigin: string;
  /** Exact origins enrolled by views on this local authenticated MCP connection. */
  viewOrigins?: ViewOriginRegistry;
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof AugError ? error.message : "Internal gateway error";
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Inlines the ext-apps browser bundle, exposing only the App class as `McpApps.App`. */
async function buildViewHtml(directGatewayOrigin: string, runtime = false): Promise<string> {
  const require = createRequire(import.meta.url);
  const bundle = await readFile(
    require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    "utf8",
  );
  const exported = /export\s*\{([^}]*)\};?\s*$/.exec(bundle);
  const appLocal = exported?.[1]
    ?.split(",")
    .map((entry) => entry.trim().split(/\s+as\s+/))
    .find(([, name]) => name === "App")?.[0];
  if (!exported || !appLocal) {
    throw new Error("Unsupported ext-apps bundle format");
  }
  const appLibrary = `${bundle.slice(0, exported.index)}\nconst McpApps = { App: ${appLocal} };\n`;
  const [template, view, renderer, style] = await Promise.all([
    readFile(new URL(runtime ? "../ui/runtime.html" : "../ui/view.html", import.meta.url), "utf8"),
    readFile(new URL(runtime ? "../ui/runtime.js" : "../ui/view.js", import.meta.url), "utf8"),
    readFile(require.resolve(runtime ? "@aug/ui-renderer/operation-runtime.js" : "@aug/ui-renderer/plan-renderer.js"), "utf8"),
    runtime ? readFile(require.resolve("@aug/ui-renderer/runtime.css"), "utf8") : Promise.resolve(""),
  ]);
  // The shared renderer is an ES module; inlined into one script, its exports become locals.
  const sharedRenderer = renderer.replace(/^export (?=function )/gm, "");
  const gateway = `const AUG_GATEWAY_ORIGIN = ${JSON.stringify(directGatewayOrigin)};\n` +
    `const AUG_VIEW_ORIGIN_PATTERN = ${viewOriginPattern.toString()};\n`;
  const script = `${appLibrary}\n${gateway}${sharedRenderer}\n${view}`.replaceAll("</script", "<\\/script");
  return template.replace(runtime ? "/*__AUG_RUNTIME_SCRIPT__*/" : "/*__AUG_VIEW_SCRIPT__*/", () => script)
    .replace("/*__AUG_RUNTIME_STYLE__*/", () => style);
}

export async function createAugMcpServer(options: AugMcpServerOptions): Promise<McpServer> {
  const { service, principal } = options;
  const gatewayUrl = new URL(options.directGatewayOrigin);
  if (gatewayUrl.protocol !== "http:" && gatewayUrl.protocol !== "https:") {
    throw new Error("The direct gateway origin must use HTTP or HTTPS");
  }
  const directGatewayOrigin = gatewayUrl.origin;
  const viewCsp = { connectDomains: [directGatewayOrigin], resourceDomains: [] as string[] };
  const html = await buildViewHtml(directGatewayOrigin);
  const runtimeHtml = await buildViewHtml(directGatewayOrigin, true);
  const server = new McpServer({ name: "adaptive-ui-gateway", version: "0.1.0" });

  if (options.viewOrigins) {
    const viewOrigins = options.viewOrigins;
    server.registerTool(
      toolNames.registerOrigin,
      {
        title: "Register AUG view origin",
        description: "Registers this view's exact browser origin for CORS. No data or credentials are returned.",
        inputSchema: z.object({ origin: z.string().max(200) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        _meta: { ui: { visibility: ["app"] } },
      },
      async ({ origin }) => {
        try {
          viewOrigins.register(origin);
          return { content: [{ type: "text", text: "View origin registered. Direct requests still require authentication." }] };
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  server.registerTool(
    toolNames.listCapabilities,
    {
      title: "List AUG capabilities",
      description:
        "Lists read-only data capabilities the user may open as an interactive search view. " +
        "Returns authorized input schemas and visible field names only (no records).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const capabilities = service.listCatalog(principal).map((capability) => ({
        id: capability.id,
        title: capability.title,
        description: capability.description,
        inputSchema: capability.inputSchema,
        fields: capability.fields,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ capabilities }) }],
        structuredContent: { capabilities },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.createView,
    {
      title: "Open AUG search view",
      description:
        "Opens an interactive, read-only search view for a capability. The user sees the " +
        "records inside the view; they are not returned to this conversation.",
      inputSchema: z.object({
        intent: z.string().min(1).max(500).describe("What the user wants to find"),
        capabilityId: z.string().min(1).max(200).describe("Capability id from aug_list_capabilities"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: searchViewUri } },
    },
    async ({ intent, capabilityId }) => {
      try {
        const capability = service
          .listCatalog(principal)
          .find((candidate) => candidate.id === capabilityId);
        if (!capability) {
          throw new AugError("CAPABILITY_NOT_FOUND", "Capability is not available", 404);
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Opening the "${capability.title}" view. The UI Plan and records are fetched ` +
                "directly by the view and are not available in this conversation.",
            },
          ],
          structuredContent: {
            title: capability.title,
            transport: "direct",
            view: { intent, capabilityId },
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  registerAppResource(
    server,
    "AUG search view",
    searchViewUri,
    {
      description: "Fixed, precompiled renderer for validated AUG UI Plans",
      _meta: { ui: { csp: viewCsp, prefersBorder: true } },
    },
    async () => ({
      contents: [
        {
          uri: searchViewUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: { ui: { csp: viewCsp, prefersBorder: true } },
        },
      ],
    }),
  );

  registerAppTool(server, toolNames.openRuntime, {
    title: "Open AUG operation runtime",
    description: "Opens the generic AUG operation view. Inputs, confirmation tokens and results use a direct authenticated connection and are not returned to the conversation.",
    inputSchema: z.object({ operationId: z.string().min(1).max(200).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: runtimeViewUri } },
  }, async ({ operationId }) => {
    try {
      if (operationId && !service.listOperations(principal).some((operation) => operation.id === operationId)) {
        throw new AugError("OPERATION_NOT_FOUND", "Operation is not available", 404);
      }
      return {
        content: [{ type: "text", text: "Opening the AUG operation view. Inputs, confirmations and results remain on its direct connection." }],
        structuredContent: { view: { operationId: operationId ?? null } },
      };
    } catch (error) { return failure(error); }
  });

  registerAppResource(server, "AUG operation runtime", runtimeViewUri, {
    description: "Fixed runtime for backend-declared AUG operations",
    _meta: { ui: { csp: viewCsp, prefersBorder: true } },
  }, async () => ({ contents: [{ uri: runtimeViewUri, mimeType: RESOURCE_MIME_TYPE, text: runtimeHtml,
    _meta: { ui: { csp: viewCsp, prefersBorder: true } } }] }));

  return server;
}
