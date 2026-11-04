import { createServer } from "node:http";

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function measure(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid declared measurement");
  }
  return value;
}

export function theatreRow(sheet) {
  if (typeof sheet.codice !== "string" || typeof sheet.nome !== "string" ||
      typeof sheet.fonte !== "string" || !sheet.rilevati || typeof sheet.rilevati !== "object") {
    throw new Error("Invalid theatre sheet");
  }
  // Only explicitly declared measurements. No estimates or feasibility decisions.
  return {
    codice: sheet.codice,
    nome: sheet.nome,
    boccascenaLarghezzaMetri: measure(sheet.rilevati.boccascena?.larghezza),
    boccascenaAltezzaMetri: measure(sheet.rilevati.boccascena?.altezza),
    palcoProfonditaMetri: measure(sheet.rilevati.palco?.profonditaUtile),
    capienza: measure(sheet.rilevati.capienza),
    provenienza: "Valori dichiarati in rilevati; fattibilità non verificata da questa vista.",
    fonte: sheet.fonte,
  };
}

async function readSheet(url) {
  const response = await fetch(url, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(3_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Source sheet unavailable");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 100_000) throw new Error("Source sheet too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Narrow read facade over the existing Archteathos static JSON endpoints. */
export function createTheatreAdapter({ sourceOrigin, files, backendToken, tenantId, stats }) {
  return createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${backendToken}`) {
      return json(response, 401, { error: "Authentication required" });
    }
    if (request.headers["x-aug-tenant"] !== tenantId) {
      return json(response, 403, { error: "Tenant denied" });
    }
    const url = new URL(request.url, "http://adapter.local");
    if (request.method !== "GET" || url.pathname !== "/theatres") {
      return json(response, 404, { error: "Read operation unavailable" });
    }
    const q = url.searchParams.get("q") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 25);
    if (q.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        [...url.searchParams.keys()].some((key) => !["q", "limit"].includes(key))) {
      return json(response, 400, { error: "Invalid query" });
    }
    try {
      const rows = await Promise.all(files.map(async (file) => {
        stats.sourceReads++;
        const sheet = await readSheet(new URL(`/simulazione/teatri/${file}`, sourceOrigin));
        return theatreRow(sheet);
      }));
      const search = q.trim().toLocaleLowerCase("it");
      return json(response, 200, rows.filter((row) =>
        `${row.codice} ${row.nome}`.toLocaleLowerCase("it").includes(search)).slice(0, limit));
    } catch {
      // No partial list masquerading as a complete inventory; no source values in errors.
      return json(response, 502, { error: "Archteathos sheets unavailable or invalid" });
    }
  });
}
