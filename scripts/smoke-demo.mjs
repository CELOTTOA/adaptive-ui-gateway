import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";

// Exercise the actual compiled launcher on free ports, without any provider key.
const child = spawn(process.execPath, ["apps/gateway-server/dist/demo.js"], {
  env: { ...process.env, GROK_API_KEY: "", AUG_PORT: "0", AUG_BACKEND_PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let output = "";
let errorOutput = "";
child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-4000); });
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Demo startup timed out")), 10_000);
    const fail = (error) => { clearTimeout(timeout); reject(error); };
    child.once("error", fail);
    child.once("exit", () => fail(new Error("Demo exited before startup")));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/AUG demo: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const request = async (path, value, token = "demo-analyst-token") => {
    const response = await fetch(url + path, {
      method: value ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(value ? { "Content-Type": "application/json" } : {}) },
      ...(value ? { body: JSON.stringify(value) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const catalog = await request("/v1/catalog");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.capabilities.length, 1);
  const plan = await request("/v1/plans", {
    intent: "Search customers", capabilityId: catalog.body.capabilities[0].id,
  });
  assert.equal(plan.status, 201);
  assert.equal(plan.body.planner.source, "deterministic");
  assert.doesNotMatch(JSON.stringify(plan.body), /CANARY-A|CANARY-NOTE/);
  const query = { planId: plan.body.planId, actionId: "query-data", state: { filters: { q: "CANARY" } } };
  const result = await request("/v1/data/query", query);
  assert.equal(result.status, 200);
  assert.equal(result.body.rows.length, 1);
  assert.equal(result.body.rows[0].id, "cus-a-001");
  assert.deepEqual(Object.keys(result.body.rows[0]).sort(), ["amountDue", "city", "id", "name"]);
  assert.equal((await request("/v1/data/query", query, "demo-other-tenant-token")).status, 404);
  assert.equal((await request("/v1/catalog", undefined, "invalid")).status, 401);
  const page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  console.log("Demo launcher smoke passed: API-key-free startup, catalog, deterministic plan, projected query, access denial and page CSP.");
  console.log("This is an HTTP/process check; it does not automate browser interaction or a desktop sandbox.");
} catch (error) {
  console.error(errorOutput || "No launcher diagnostics available");
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "exit");
    child.kill();
    await closed;
  }
}
