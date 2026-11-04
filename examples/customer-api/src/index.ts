import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";

const customers = [
  {
    id: "cus-a-001",
    name: "Aurora CANARY-A-7F3A",
    city: "Milano",
    amountDue: 1250.5,
    internalNotes: "CANARY-NOTE-A-91C7",
    tenantId: "tenant-a",
  },
  {
    id: "cus-a-002",
    name: "Nimbus Trattoria",
    city: "Torino",
    amountDue: 480,
    internalNotes: "Synthetic internal note",
    tenantId: "tenant-a",
  },
  {
    id: "cus-b-001",
    name: "Borealis CANARY-B-9B2E",
    city: "Oslo",
    amountDue: 7300,
    internalNotes: "CANARY-NOTE-B-44D2",
    tenantId: "tenant-b",
  },
];

export interface CustomerApiOptions {
  backendToken: string;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export function createCustomerApi(options: CustomerApiOptions): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/customers") {
      json(response, 404, { error: "Not found" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${options.backendToken}`) {
      json(response, 401, { error: "Unauthorized" });
      return;
    }
    const tenantId = request.headers["x-aug-tenant"];
    if (tenantId !== "tenant-a" && tenantId !== "tenant-b") {
      json(response, 403, { error: "Forbidden" });
      return;
    }

    const query = (url.searchParams.get("q") ?? "").toLocaleLowerCase();
    const requestedLimit = Number(url.searchParams.get("limit") ?? "25");
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 25;
    const rows = customers
      .filter(
        (customer) =>
          customer.tenantId === tenantId &&
          (!query ||
            customer.name.toLocaleLowerCase().includes(query) ||
            customer.city.toLocaleLowerCase().includes(query)),
      )
      .slice(0, limit);
    json(response, 200, rows);
  });
}

export async function startCustomerApi(
  options: CustomerApiOptions & { port: number },
): Promise<Server> {
  const server = createCustomerApi(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
