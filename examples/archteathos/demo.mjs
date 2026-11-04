import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startGatewayServer } from "@aug/gateway-server";
import { startArchteathosBackend, tenantId, openApiFile } from "./backend.mjs";

export { capabilityId, tenantId } from "./backend.mjs";

export async function startArchteathosDemo({ root, port = 4001, planner, onAudit,
  accessToken = randomBytes(24).toString("hex"), extraPrincipals = new Map() } = {}) {
  const backend = await startArchteathosBackend({ root });
  let gateway;
  const close = async () => {
    if (gateway?.listening) {
      await new Promise((resolve) => { gateway.close(resolve); gateway.closeAllConnections(); });
    }
    await backend.close();
  };
  try {
    const principals = new Map(extraPrincipals);
    principals.set(accessToken, { id: "archteathos-reader", tenantId, scopes: ["theatres:read"] });
    gateway = await startGatewayServer({
      port,
      openApiSource: await readFile(openApiFile, "utf8"),
      backendBaseUrl: backend.adapterUrl,
      backendToken: backend.backendToken,
      tenantIds: [tenantId],
      authenticate: (token) => principals.get(token),
      ...(planner ? { planner } : {}), ...(onAudit ? { onAudit } : {}),
    });
    const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
    return { gatewayUrl, sourceUrl: backend.sourceUrl, adapterUrl: backend.adapterUrl,
      accessToken, files: backend.files, stats: backend.stats, close };
  } catch (error) {
    await close(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startArchteathosDemo({
    root: process.env.ARCHTEATHOS_ROOT, port: Number(process.env.AUG_PORT ?? 4001),
  });
  console.log(`Archteathos via AUG: ${demo.gatewayUrl}`);
  console.log(`Schede disponibili: ${demo.files.length}; planner deterministico, nessun provider esterno.`);
  console.log(`Token temporaneo (solo questa esecuzione): ${demo.accessToken}`);
  process.once("SIGINT", () => void demo.close());
  process.once("SIGTERM", () => void demo.close());
}
