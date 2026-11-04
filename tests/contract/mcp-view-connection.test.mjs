import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { viewOriginPattern } from "@aug/mcp-apps-server";

const source = await readFile(new URL("../../apps/mcp-apps-server/ui/view.js", import.meta.url), "utf8");

async function view(fetch, options = {}) {
  const elements = Object.fromEntries([
    "#app", "#direct-connection", "#gateway-token", "#connect-gateway",
    "#connection-details", "#connection-diagnostics", "status",
  ].map((id) => [id, {
    textContent: "", hidden: true, disabled: false, value: "private-test-token",
    listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; },
  }]));
  elements["#app"].querySelector = () => elements.status;
  const listeners = {};
  const calls = [];
  const bridgeCalls = [];
  const app = {
    connect: async () => {}, getHostContext: () => ({}),
    callServerTool: async (request) => {
      bridgeCalls.push(JSON.parse(JSON.stringify(request)));
      return options.registrationResult ?? { content: [{ type: "text", text: "Registered" }] };
    },
  };
  const context = {
    document: { querySelector: (id) => elements[id] },
    window: {
      origin: options.origin ?? "https://test-host.example", isSecureContext: true,
      addEventListener: (type, callback) => { listeners[type] = callback; },
    },
    McpApps: { App: function () { return app; } },
    AUG_GATEWAY_ORIGIN: "http://127.0.0.1:12345",
    AUG_VIEW_ORIGIN_PATTERN: viewOriginPattern,
    fetch: async (...args) => { calls.push(args); return fetch(...args); },
    console: { warn() {} }, URL, Error, TypeError,
  };
  await runInNewContext(`(async () => { ${source}\n })()`, context);
  app.ontoolinput({ arguments: { intent: "Search", capabilityId: "demo.customers.list" } });
  return { elements, listeners, calls, bridgeCalls, submit: () => elements["#direct-connection"].listeners.submit({ preventDefault() {} }) };
}

test("network failures show safe connection details without leaking the access token", async () => {
  const ui = await view(async () => { throw new TypeError("Failed to fetch"); });
  await ui.submit();
  assert.match(ui.elements.status.textContent, /cannot reach/i);
  assert.equal(ui.elements["#connection-details"].hidden, false);
  const details = ui.elements["#connection-diagnostics"].textContent;
  assert.match(details, /http:\/\/127\.0\.0\.1:12345/);
  assert.match(details, /https:\/\/test-host.example/);
  assert.doesNotMatch(details, /private-test-token/);
  assert.equal(ui.elements["#connect-gateway"].disabled, false);
});

test("HTTP authorization errors remain distinct from network failures", async () => {
  const ui = await view(async () => ({ ok: false, json: async () => ({ error: "Authentication is required" }) }));
  await ui.submit();
  assert.equal(ui.elements.status.textContent, "Authentication is required");
  assert.equal(ui.elements["#connection-details"].hidden, true);
});

test("CSP failures identify the blocked connection without exposing URL query values", async () => {
  let ui;
  ui = await view(async () => {
    ui.listeners.securitypolicyviolation({ effectiveDirective: "connect-src", blockedURI: "http://127.0.0.1:12345/v1/plans?secret=hidden" });
    throw new TypeError("Failed to fetch");
  });
  await ui.submit();
  assert.match(ui.elements["#connection-diagnostics"].textContent, /connect-src/);
  assert.doesNotMatch(ui.elements["#connection-diagnostics"].textContent, /secret|hidden|private-test-token/);
});

test("a rotating Claude origin is registered once and only origin metadata uses MCP", async () => {
  const origin = `https://${"e".repeat(32)}.claudemcpcontent.com`;
  const ui = await view(async () => { throw new TypeError("Failed to fetch"); }, { origin });
  await ui.submit();
  await ui.submit();
  assert.deepEqual(ui.bridgeCalls, [{ name: "aug_register_view_origin", arguments: { origin } }]);
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.calls[0][1].headers.Authorization, "Bearer private-test-token");
  assert.doesNotMatch(JSON.stringify(ui.bridgeCalls), /private-test-token|planId|capabilityId|intent/);
});

test("a refused origin registration stops the direct request without a data-tool fallback", async () => {
  const origin = `https://${"e".repeat(32)}.claudemcpcontent.com`;
  const ui = await view(async () => { throw new Error("HTTP must not be attempted"); }, {
    origin, registrationResult: { isError: true },
  });
  await ui.submit();
  assert.match(ui.elements.status.textContent, /could not register/);
  assert.equal(ui.calls.length, 0);
  assert.equal(ui.bridgeCalls.length, 1);
});

test("ChatGPT's default and dedicated sandbox send only their origin through the bridge", async () => {
  for (const origin of ["https://web-sandbox.oaiusercontent.com", "https://aug-test.web-sandbox.oaiusercontent.com"]) {
    const ui = await view(async () => { throw new TypeError("Failed to fetch"); }, { origin });
    await ui.submit();
    assert.deepEqual(ui.bridgeCalls, [{ name: "aug_register_view_origin", arguments: { origin } }]);
    assert.equal(ui.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(ui.bridgeCalls), /private-test-token|planId|capabilityId|intent/);
  }
});

test("the native Codex sandbox registers before its direct request and sends no token over MCP", async () => {
  const origin = "codex-sandbox://mcp-app-759ffd0cc15e6b093ffcc9e0beb80edc046100e46aa928f0.web-sandbox.oaiusercontent.com";
  let ui;
  ui = await view(async () => {
    assert.equal(ui.bridgeCalls.length, 1, "registration must precede HTTP");
    throw new TypeError("Failed to fetch");
  }, { origin });
  await ui.submit();
  assert.deepEqual(ui.bridgeCalls, [{ name: "aug_register_view_origin", arguments: { origin } }]);
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0][1].headers.Authorization, "Bearer private-test-token");
  assert.doesNotMatch(JSON.stringify(ui.bridgeCalls), /private-test-token|planId|intent|capabilityId/);
});
