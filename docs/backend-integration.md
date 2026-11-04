# Connecting a backend

The current integration contract is a configured backend origin plus an annotated OpenAPI
3.x document. The sample MCP launcher is wired to the synthetic backend; the core and HTTP
server can be composed independently inside the monorepo.

## Smallest compatible operation

Use GET, declare `x-aug-effect: read` and a stable `operationId`, return a JSON array of
objects with scalar fields, and classify each visible field explicitly. For example:

```yaml
openapi: 3.0.3
info: {title: Inventory example, version: 0.1.0}
paths:
  /items:
    get:
      operationId: searchItems
      summary: Inventory search
      x-aug-id: inventory.items.search
      x-aug-effect: read
      x-aug-required-scopes: [inventory:read]
      x-aug-classification: internal
      parameters:
        - name: q
          in: query
          schema: {type: string, maxLength: 200}
      responses:
        '200':
          description: Items
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    name: {type: string, x-aug-classification: internal}
                    available: {type: integer, x-aug-classification: internal}
```

Search inputs named `q`, `query` or `search` are recognized by the search planner. Fields
classified `public` or `internal` are UI candidates if their scopes are met. Unknown
classifications default to `restricted`, not public. `x-aug-required-scopes` can also be
declared on individual fields. See the [complete sample](../examples/customer-api/openapi.json).

Local `$ref` schemas are supported within this subset; external references, path-parameter
execution, pagination envelopes, arrays of nested objects and arbitrary workflow forms
are not. OpenAPI import is not a general purpose specification validator.

## Start the gateway against it

After `npm ci` and `npm run build`, save a launcher within this repository, configure the
three environment variables below, and run it with Node. Replace the demo principal mapping
with your actual authentication integration before using real multi-user data.

```js
import { readFile } from "node:fs/promises";
import { startGatewayServer } from "@aug/gateway-server";

const { BACKEND_URL, BACKEND_SERVICE_TOKEN, LOCAL_VIEW_TOKEN } = process.env;
if (!BACKEND_URL || !BACKEND_SERVICE_TOKEN || !LOCAL_VIEW_TOKEN) {
  throw new Error("Configure the backend URL, service token and local view token");
}
const server = await startGatewayServer({
  port: 4002,
  openApiSource: await readFile("./inventory.openapi.yaml", "utf8"),
  backendBaseUrl: BACKEND_URL,
  backendToken: BACKEND_SERVICE_TOKEN,
  tenantIds: ["inventory-demo"],
  authenticate: (token) => token === LOCAL_VIEW_TOKEN
    ? {id: "local-reader", tenantId: "inventory-demo", scopes: ["inventory:read"]}
    : undefined,
});
process.once("SIGINT", () => server.close());
```

Open http://127.0.0.1:4002 and enter your local view token. The standalone loader currently
requires exactly one authorized capability. The backend receives a service Bearer token
and `X-AUG-Tenant` / `X-AUG-Principal` context. It must validate these through a trustworthy
service boundary and enforce its own business/tenant rules. Do not expose a backend that
trusts arbitrary public callers to supply these headers.

## If the backend does not match

Write a small facade that exposes only the needed operation, translates the response and
preserves provenance/authorization. Keep credentials server-side. Do not quietly infer
missing values or discard an error to return a seemingly complete partial result.

The [Archteathos example](../examples/archteathos/README.md) uses this approach for nested,
static theatre sheets. Its custom adapter is part of the integration cost, which should
be measured and reported rather than presented as automatic discovery.

Before contributing an adapter, verify a normal query, no results, missing values,
unauthorized token/scope/tenant and excluded fields. Show that record values and credentials
do not enter the planning/audit channels. Use synthetic data in public tests and reports.
