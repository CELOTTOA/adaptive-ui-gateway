import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { RuntimeElement } from "../helpers/runtime-dom.mjs";

const source = await readFile(new URL("../../apps/mcp-apps-server/ui/runtime.js", import.meta.url), "utf8");

test("the embedded runtime enrolls only its origin and keeps credentials, inputs and confirmations off MCP", async () => {
  const elements = Object.fromEntries(["runtime-connect", "runtime-token", "runtime-connect-button", "runtime-connect-status", "runtime-app", "runtime-connection"].map((id) => [`#${id}`, new RuntimeElement("div")]));
  const bridge = [], network = [];
  let app, options;
  const origin = `https://${"c".repeat(32)}.claudemcpcontent.com`;
  class App {
    constructor() { app = this; }
    async connect() {}
    async callServerTool(value) { bridge.push(value); return {}; }
    sendMessage() { assert.fail("No data may be sent to chat"); }
    updateModelContext() { assert.fail("No data may be sent to model context"); }
  }
  await vm.runInNewContext(`(async () => { ${source} })()`, {
    McpApps: { App }, window: { origin },
    document: { querySelector: (selector) => elements[selector] },
    AUG_GATEWAY_ORIGIN: "https://gateway.example", AUG_VIEW_ORIGIN_PATTERN: /^https:\/\/[c]+\.claudemcpcontent\.com$/,
    createOperationRuntime: (_root, value) => { options = value; return { ready: Promise.resolve(true), dispose() {} }; },
    fetch: async (url, init) => { network.push({ url, init }); return { ok: true, json: async () => ({ state: "running" }) }; },
  });
  app.ontoolresult({ structuredContent: { view: { operationId: "demo.adjust" } } });
  elements["#runtime-token"].value = "view-secret";
  await elements["#runtime-connect"].listeners.submit({ preventDefault() {} });
  assert.equal(options.operationId, "demo.adjust");
  assert.equal(elements["#runtime-token"].value, "");
  assert.equal(elements["#runtime-connection"].open, false);
  assert.equal(bridge.length, 1);
  assert.equal(bridge[0].name, "aug_register_view_origin");
  assert.equal(bridge[0].arguments.origin, origin);
  const signal = new AbortController().signal;
  await options.request("/v1/aug/invocations", { input: { secret: "PRIVATE-CANARY" } }, { signal });
  await options.request("/v1/aug/invocations/control", { action: "confirm", token: "private-confirmation" }, { signal });
  assert.doesNotMatch(JSON.stringify(bridge), /view-secret|PRIVATE-CANARY|private-confirmation/);
  assert.equal(network.length, 2);
  assert.equal(network[0].url, "https://gateway.example/v1/aug/invocations");
  assert.equal(network[0].init.headers.Authorization, "Bearer view-secret");
  assert.equal(network[0].init.signal, signal);
  assert.equal(network[0].init.credentials, "omit");
});
