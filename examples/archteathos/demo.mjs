import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startGatewayServer } from "@aug/gateway-server";
import { createTheatreAdapter } from "./adapter.mjs";

export const capabilityId = "archteathos.theatres.search";
export const tenantId = "archteathos-local";

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function stop(server) {
  return server?.listening ? new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections();
  }) : Promise.resolve();
}

export async function startArchteathosDemo({ root, port = 4001, planner, onAudit,
  accessToken = randomBytes(24).toString("hex"), extraPrincipals = new Map() } = {}) {
  const sourceRoot = resolve(root ?? "C:/Archteathos");
  const files = (await readdir(join(sourceRoot, "simulazione", "teatri")))
    .filter((file) => /^[a-z0-9-]+\.json$/.test(file)).sort();
  if (files.length === 0 || files.length > 100) throw new Error("Expected 1–100 theatre sheets");
  const { creaServer } = await import(pathToFileURL(join(sourceRoot, "server", "server.mjs")).href);
  // Use the real backend's HTTP handler, but publish only the allowlisted JSON files.
  // This avoids exposing its general static file server or generation routes in the test.
  const handler = creaServer().listeners("request")[0];
  const paths = new Set(files.map((file) => `/simulazione/teatri/${file}`));
  const stats = { sourceReads: 0, sourceRequests: 0 };
  const source = createServer((request, response) => {
    const path = new URL(request.url, "http://source.local").pathname;
    if (request.method !== "GET" || !paths.has(path)) {
      response.writeHead(403);
      return response.end("Read-only test: route unavailable");
    }
    stats.sourceRequests++;
    void handler(request, response);
  });
  let adapter;
  let gateway;
  const close = async () => {
    await stop(gateway);
    await stop(adapter);
    await stop(source);
  };
  try {
    const sourceUrl = await listen(source);
    const backendToken = randomBytes(32).toString("hex");
    adapter = createTheatreAdapter({ sourceOrigin: sourceUrl, files, backendToken, tenantId, stats });
    const adapterUrl = await listen(adapter);
    const principals = new Map(extraPrincipals);
    principals.set(accessToken, { id: "archteathos-reader", tenantId, scopes: ["theatres:read"] });
    gateway = await startGatewayServer({
      port,
      openApiSource: await readFile(new URL("./openapi.json", import.meta.url), "utf8"),
      backendBaseUrl: adapterUrl,
      backendToken,
      tenantIds: [tenantId],
      authenticate: (token) => principals.get(token),
      ...(planner ? { planner } : {}),
      ...(onAudit ? { onAudit } : {}),
    });
    const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
    return { gatewayUrl, sourceUrl, adapterUrl, accessToken, files, stats, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startArchteathosDemo({
    root: process.env.ARCHTEATHOS_ROOT,
    port: Number(process.env.AUG_PORT ?? 4001),
  });
  console.log(`Archteathos via AUG: ${demo.gatewayUrl}`);
  console.log(`Schede disponibili: ${demo.files.length}; planner deterministico, nessun provider esterno.`);
  console.log(`Token temporaneo (solo questa esecuzione): ${demo.accessToken}`);
  process.once("SIGINT", () => void demo.close());
  process.once("SIGTERM", () => void demo.close());
}
