/** Independent AUG 0.2 terminal runtime. Node built-ins only; no @aug imports. */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

const version = "aug/0.2";
const supported = {
  "aug.collection/0.1": "application/json",
  "aug.json/0.1": "application/json",
  "aug.text/0.1": "text/plain",
};
export const capabilities = {
  protocolVersions: [version], profiles: Object.keys(supported),
  mediaTypes: ["application/json", "text/plain"], deliveryKinds: ["inline"],
};

export class RuntimeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function ensure(value, code = "INVALID_RESPONSE") { if (!value) throw new RuntimeError(code); }
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max;
function exact(value, required, optional = []) {
  ensure(object(value) && required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key)));
}
function list(value, allowed) {
  ensure(Array.isArray(value) && value.length > 0 && value.length <= 128 &&
    value.every((item) => string(item) && (!allowed || allowed.includes(item))) && new Set(value).size === value.length);
}
function jsonValue(value, depth = 0) {
  ensure(depth <= 32);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { ensure(Number.isFinite(value)); return; }
  ensure(Array.isArray(value) || object(value));
  for (const child of Object.values(value)) jsonValue(child, depth + 1);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function descriptor(value) {
  exact(value, ["protocolVersion", "id", "version", "title", "description", "effect", "confirmation", "inputSchema", "output"]);
  ensure(value.protocolVersion === version, "UNSUPPORTED_PROTOCOL_VERSION");
  ensure(string(value.id) && string(value.version, 64) && string(value.title) && typeof value.description === "string" && value.description.length <= 2000);
  ensure(["read", "write", "destructive", "external_side_effect"].includes(value.effect));
  ensure(["none", "explicit"].includes(value.confirmation) && (value.effect === "read" || value.confirmation === "explicit"));
  ensure(object(value.inputSchema) && value.inputSchema.type === "object");
  ensure(Array.isArray(value.output) && value.output.length > 0 && value.output.length <= 32);
  const ids = new Set();
  for (const offer of value.output) {
    exact(offer, ["id", "profile", "mediaType", "audiences", "deliveryKind"]);
    ensure(string(offer.id, 100) && string(offer.profile, 300) && string(offer.mediaType) && !ids.has(offer.id));
    ensure(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(offer.mediaType));
    ids.add(offer.id); list(offer.audiences, ["view", "model"]);
    ensure(["inline", "reference"].includes(offer.deliveryKind));
    if (Object.hasOwn(supported, offer.profile)) ensure(offer.mediaType === supported[offer.profile]);
  }
  return value;
}

function selectedOffer(operation, runtime) {
  ensure(runtime.protocolVersions.includes(version), "UNSUPPORTED_PROTOCOL_VERSION");
  const selected = operation.output.find((offer) => offer.audiences.includes("view") &&
    runtime.profiles.includes(offer.profile) && runtime.mediaTypes.includes(offer.mediaType) && runtime.deliveryKinds.includes(offer.deliveryKind));
  ensure(selected, "NO_COMPATIBLE_REPRESENTATION");
  return selected;
}

function content(profile, value) {
  jsonValue(value);
  if (profile === "aug.text/0.1") ensure(typeof value === "string");
  if (profile === "aug.collection/0.1") {
    exact(value, ["columns", "rows"]);
    ensure(Array.isArray(value.columns) && value.columns.length <= 256 && Array.isArray(value.rows) && value.rows.length <= 10000);
    const keys = value.columns.map((column) => {
      exact(column, ["key"], ["label"]);
      ensure(string(column.key) && (column.label === undefined || string(column.label)));
      return column.key;
    });
    ensure(new Set(keys).size === keys.length);
    for (const row of value.rows) exact(row, keys);
  }
}

function snapshot(value, context) {
  const common = ["protocolVersion", "id", "operationId", "operationVersion", "revision", "state"];
  ensure(object(value));
  const payload = { awaiting_confirmation: ["confirmation"], running: [], succeeded: ["output"], failed: ["error"], expired: [], indeterminate: ["error"] };
  ensure(Object.hasOwn(payload, value.state));
  exact(value, [...common, ...payload[value.state]]);
  ensure(value.protocolVersion === version, "UNSUPPORTED_PROTOCOL_VERSION");
  ensure(string(value.id, 128) && value.operationId === context.operation.id && value.operationVersion === context.operation.version);
  ensure(Number.isSafeInteger(value.revision) && value.revision >= 1);
  if (value.state === "awaiting_confirmation") {
    exact(value.confirmation, ["token", "expiresAt", "input"]);
    ensure(context.operation.confirmation === "explicit" && string(value.confirmation.token, 128) &&
      Number.isFinite(value.confirmation.expiresAt) && value.confirmation.expiresAt >= 0 &&
      canonical(value.confirmation.input) === canonical(context.input));
  }
  if (value.state === "succeeded") {
    const out = value.output, offer = context.offer;
    exact(out, ["protocolVersion", "outputId", "audience", "representation"]);
    ensure(out.protocolVersion === version && string(out.outputId) && out.audience === "view");
    const representation = out.representation;
    exact(representation, ["id", "profile", "mediaType", "audiences", "delivery"]);
    ensure(representation.id === offer.id && representation.profile === offer.profile && representation.mediaType === offer.mediaType);
    list(representation.audiences, offer.audiences);
    ensure(representation.audiences.includes("view"));
    exact(representation.delivery, ["kind", "value"]);
    ensure(representation.delivery.kind === "inline" && offer.deliveryKind === "inline");
    content(offer.profile, representation.delivery.value);
  }
  if (value.state === "failed" || value.state === "indeterminate") {
    exact(value.error, ["code"]); ensure(string(value.error.code, 100));
    if (value.state === "indeterminate") ensure(value.error.code === "EXECUTION_OUTCOME_UNKNOWN");
  }
  const previous = context.last;
  if (previous) {
    ensure(value.id === previous.id && value.revision >= previous.revision);
    if (value.revision === previous.revision) ensure(canonical(value) === canonical(previous));
    else {
      const reachable = {
        awaiting_confirmation: ["running", "expired", "succeeded", "failed", "indeterminate"],
        running: ["succeeded", "failed", "indeterminate"], succeeded: [], failed: [], expired: [], indeterminate: [],
      };
      ensure(reachable[previous.state].includes(value.state));
    }
  }
  context.last = structuredClone(value);
  return structuredClone(value);
}

/** The supplied origin is operator configuration, never read from an operation descriptor. */
export class TerminalRuntime {
  #origin; #token; #runtime; #fetch; #contexts = new Map(); #operations;
  constructor({ origin, token, profiles = capabilities.profiles, fetchImpl = fetch }) {
    const url = new URL(origin);
    ensure(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "INVALID_CONNECTION");
    ensure(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)), "INVALID_CONNECTION");
    ensure(string(token, 8192) && !/[\r\n]/.test(token), "INVALID_CONNECTION");
    list(profiles, Object.keys(supported));
    this.#origin = url.origin; this.#token = token; this.#fetch = fetchImpl;
    this.#runtime = { ...structuredClone(capabilities), profiles: [...profiles] };
  }

  async #post(path, body, effectMayHaveStarted = false) {
    let response;
    try {
      response = await this.#fetch(this.#origin + path, { method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(5000),
        credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      ensure(response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json");
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; ensure(size <= 1048576, "RESPONSE_TOO_LARGE"); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (!response.ok) {
        // Display codes only; never relay raw backend error messages or request data.
        throw new RuntimeError(object(value) && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.code) ? value.code : "REQUEST_REFUSED");
      }
      ensure(response.status === 200 || response.status === 202);
      ensure(object(value));
      if (object(value) && Object.hasOwn(value, "state")) {
        ensure((response.status === 202) === ["awaiting_confirmation", "running"].includes(value.state));
      }
      jsonValue(value);
      return value;
    } catch (error) {
      if (error instanceof RuntimeError && response && !response.ok) throw error;
      throw new RuntimeError(effectMayHaveStarted ? "REQUEST_OUTCOME_UNKNOWN" : "INVALID_OR_UNAVAILABLE_RESPONSE");
    }
  }

  async discover() {
    const value = await this.#post("/v1/aug/operations");
    exact(value, ["protocolVersion", "operations"]);
    ensure(value.protocolVersion === version, "UNSUPPORTED_PROTOCOL_VERSION");
    ensure(Array.isArray(value.operations) && value.operations.length <= 1000);
    const operations = value.operations.map(descriptor);
    ensure(new Set(operations.map((operation) => operation.id)).size === operations.length);
    this.#operations = operations;
    return structuredClone(operations);
  }

  async start(operationId, input, { requestId = randomUUID() } = {}) {
    ensure(object(input) && string(requestId, 128), "INVALID_INPUT"); jsonValue(input);
    if (!this.#operations) await this.discover();
    const operation = this.#operations.find((operation) => operation.id === operationId);
    ensure(operation, "OPERATION_NOT_FOUND");
    const offer = selectedOffer(operation, this.#runtime);
    const saved = structuredClone(input);
    const result = await this.#post("/v1/aug/invocations", { protocolVersion: version, requestId,
      operationId, operationVersion: operation.version, input: saved, runtime: this.#runtime }, true);
    const context = this.#contexts.get(result.id) ?? { operation, offer, input: saved };
    let current;
    try {
      ensure(canonical(context.input) === canonical(saved)); current = snapshot(result, context);
    } catch { throw new RuntimeError("REQUEST_OUTCOME_UNKNOWN"); }
    this.#contexts.set(current.id, context); return current;
  }

  async #control(invocationId, action) {
    const context = this.#contexts.get(invocationId); ensure(context, "UNKNOWN_INVOCATION");
    const body = { protocolVersion: version, action, invocationId };
    if (action === "confirm") {
      ensure(context.last.state === "awaiting_confirmation", "CONFIRMATION_NOT_PENDING");
      body.token = context.last.confirmation.token;
    }
    const result = await this.#post("/v1/aug/invocations/control", body, action === "confirm");
    try { return snapshot(result, context); } catch {
      throw new RuntimeError(action === "confirm" ? "REQUEST_OUTCOME_UNKNOWN" : "INVALID_RESPONSE");
    }
  }
  status(invocationId) { return this.#control(invocationId, "status"); }
  // Calling this method is the adapter's explicit approval boundary; start/status never call it.
  confirm(invocationId) { return this.#control(invocationId, "confirm"); }
  async wait(current, { maxPolls = 40, pollMs = 100 } = {}) {
    for (let n = 0; current.state === "running" && n < maxPolls; n++) {
      await new Promise((resolve) => setTimeout(resolve, pollMs)); current = await this.status(current.id);
    }
    return current;
  }
}

// Escape terminal control sequences in backend-authored labels and values.
const safe = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
export function renderInvocation(invocation) {
  if (invocation.state === "awaiting_confirmation") return `Review saved input:\n${safe(JSON.stringify(invocation.confirmation.input))}`;
  if (invocation.state !== "succeeded") return `${safe(invocation.state)}${invocation.error ? ": " + safe(invocation.error.code) : ""}`;
  const { profile, delivery } = invocation.output.representation;
  if (profile === "aug.collection/0.1") {
    const { columns, rows } = delivery.value;
    return [columns.map((c) => safe(c.label ?? c.key)).join(" | "), ...rows.map((row) =>
      columns.map((c) => safe(typeof row[c.key] === "string" ? row[c.key] : JSON.stringify(row[c.key]))).join(" | "))].join("\n");
  }
  return safe(profile === "aug.text/0.1" ? delivery.value : JSON.stringify(delivery.value));
}

async function main(args) {
  const [origin, command, operationId, ...options] = args;
  ensure(origin && ["list", "run"].includes(command), "USAGE: runtime.mjs ORIGIN list | run OPERATION --input JSON [--request-id ID]");
  const settings = new Map();
  for (let i = 0; i < options.length; i += 2) {
    ensure(["--input", "--request-id"].includes(options[i]) && options[i + 1] !== undefined && !settings.has(options[i]), "INVALID_ARGUMENTS");
    settings.set(options[i], options[i + 1]);
  }
  const client = new TerminalRuntime({ origin, token: process.env.AUG_VIEW_TOKEN });
  const operations = await client.discover();
  if (command === "list") {
    ensure(!operationId && options.length === 0, "INVALID_ARGUMENTS");
    for (const operation of operations) console.log(`${safe(operation.id)} — ${safe(operation.title)} (${safe(operation.effect)})\n${safe(JSON.stringify(operation.inputSchema))}`);
    return;
  }
  ensure(operationId && settings.has("--input"), "INVALID_ARGUMENTS");
  const input = JSON.parse(settings.get("--input"));
  const requestId = settings.get("--request-id") ?? randomUUID();
  console.log(`Request ID: ${safe(requestId)}`);
  let current = await client.start(operationId, input, { requestId });
  if (current.state === "awaiting_confirmation") {
    console.log(renderInvocation(current));
    ensure(process.stdin.isTTY && process.stdout.isTTY, "INTERACTIVE_CONFIRMATION_REQUIRED");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question("Type CONFIRM to execute the saved input: ");
      if (answer !== "CONFIRM") { console.log("Left unconfirmed; no effect dispatched."); return; }
    } finally { terminal.close(); }
    current = await client.confirm(current.id);
  }
  current = await client.wait(current);
  console.log(renderInvocation(current));
  if (current.state !== "succeeded") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof RuntimeError ? error.code : "INVALID_ARGUMENTS_OR_RESPONSE"); process.exitCode = 1;
  });
}
