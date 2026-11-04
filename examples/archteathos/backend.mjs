import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTheatreAdapter } from "./adapter.mjs";

export const capabilityId = "archteathos.theatres.search";
export const tenantId = "archteathos-local";
export const openApiFile = fileURLToPath(new URL("./openapi.json", import.meta.url));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function stop(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}

/** Existing Archteathos HTTP implementation and read facade, independent of AUG/MCP. */
export async function startArchteathosBackend({ root, backendToken = randomBytes(32).toString("hex") } = {}) {
  const sourceRoot = resolve(root ?? "C:/Archteathos");
  const files = (await readdir(join(sourceRoot, "simulazione", "teatri")))
    .filter((file) => /^[a-z0-9-]+\.json$/.test(file)).sort();
  if (files.length === 0 || files.length > 100) throw new Error("Expected 1–100 theatre sheets");
  const { creaServer } = await import(pathToFileURL(join(sourceRoot, "server", "server.mjs")).href);
  const handler = creaServer().listeners("request")[0];
  const paths = new Set(files.map((file) => `/simulazione/teatri/${file}`));
  const stats = { sourceReads: 0, sourceRequests: 0 };
  // Publish only actual JSON sheets, never arbitrary-file or provider routes.
  const source = createServer((request, response) => {
    const path = new URL(request.url, "http://source.local").pathname;
    if (request.method !== "GET" || !paths.has(path)) {
      response.writeHead(403); return response.end("Read-only test: route unavailable");
    }
    stats.sourceRequests++;
    void handler(request, response);
  });
  let adapter;
  const close = async () => { await stop(adapter); await stop(source); };
  try {
    const sourceUrl = await listen(source);
    adapter = createTheatreAdapter({ sourceOrigin: sourceUrl, files, backendToken, tenantId, stats });
    const adapterUrl = await listen(adapter);
    return { sourceUrl, adapterUrl, backendToken, files, stats, close };
  } catch (error) {
    await close(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const profileFile = join(repoRoot, ".local", "archteathos", `mcp-${process.pid}.env`);
  const backend = await startArchteathosBackend({ root: process.env.ARCHTEATHOS_ROOT });
  const accessToken = randomBytes(24).toString("hex");
  try {
    await mkdir(dirname(profileFile), { recursive: true });
    const profile = {
      AUG_OPENAPI_FILE: openApiFile.replaceAll("\\", "/"),
      AUG_BACKEND_URL: backend.adapterUrl, AUG_BACKEND_TOKEN: backend.backendToken,
      AUG_ACCESS_TOKEN: accessToken, AUG_PRINCIPAL_ID: "archteathos-reader",
      AUG_TENANT_ID: tenantId, AUG_SCOPES: "theatres:read", GROK_API_KEY: "",
    };
    await writeFile(profileFile, Object.entries(profile).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
    console.log(`Archteathos backend ready: ${backend.files.length} theatre sheets (read only).`);
    console.log(`MCP env profile (temporary credentials): ${profileFile}`);
    console.log("Set AUG_ENV_FILE to this path and run apps/mcp-apps-server/dist/main.js.");
    console.log(`View access token for this run: ${accessToken}`);
    console.log("Keep this backend running; the profile expires when it stops. No host settings were changed.");
  } catch (error) {
    await backend.close(); throw error;
  }
  process.once("SIGINT", () => void backend.close());
  process.once("SIGTERM", () => void backend.close());
}
