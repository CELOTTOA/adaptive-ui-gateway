import test from "node:test";
import assert from "node:assert/strict";
import { ViewOriginRegistry } from "@aug/mcp-apps-server";

const first = `https://${"a".repeat(32)}.claudemcpcontent.com`;
const second = `https://${"b".repeat(32)}.claudemcpcontent.com`;

test("view origins are registered exactly, idempotently and per instance", () => {
  const registry = new ViewOriginRegistry(["null"]);
  const other = new ViewOriginRegistry(["null"]);
  registry.register(first);
  registry.register(first);
  registry.register(second);
  assert.deepEqual(registry.allowedOrigins, ["null", first, second]);
  assert.deepEqual(other.allowedOrigins, ["null"]);
});

test("origin registration rejects foreign origins and deceptive Claude URLs", () => {
  const registry = new ViewOriginRegistry();
  for (const origin of [
    "null", "https://untrusted.example", first.replace("https:", "http:"),
    `${first}.evil.example`, `${first}/`, `${first}?token=secret`, `${first}:443`,
    first.replace(".claudemcpcontent", "@evil.example/.claudemcpcontent"),
    "https://claudemcpcontent.com", "https://*.claudemcpcontent.com",
    `https://${"a".repeat(31)}.claudemcpcontent.com`,
  ]) {
    assert.throws(() => registry.register(origin), { code: "VIEW_ORIGIN_DENIED" });
  }
  assert.deepEqual(registry.allowedOrigins, []);
});

test("ChatGPT sandbox origins enroll exactly without trusting other OpenAI-hosted sites", () => {
  const registry = new ViewOriginRegistry();
  for (const origin of ["https://web-sandbox.oaiusercontent.com", "https://aug-test.web-sandbox.oaiusercontent.com"]) {
    registry.register(origin);
    assert.ok(registry.allowedOrigins.includes(origin));
  }
  for (const origin of [
    "https://chatgpt.com", "https://oaiusercontent.com", "https://other.oaiusercontent.com",
    "https://web-sandbox.oaiusercontent.com.evil.example", "https://evil.example@web-sandbox.oaiusercontent.com",
    "https://web-sandbox.oaiusercontent.com/", "http://web-sandbox.oaiusercontent.com",
    "https://web-sandbox.oaiusercontent.com:443", "https://a.b.web-sandbox.oaiusercontent.com",
    "https://-invalid.web-sandbox.oaiusercontent.com", "https://invalid-.web-sandbox.oaiusercontent.com",
  ]) {
    assert.throws(() => registry.register(origin), { code: "VIEW_ORIGIN_DENIED" });
  }
  assert.equal(registry.allowedOrigins.length, 2);
});

test("dynamic origin registration is bounded and keeps previous entries", () => {
  const registry = new ViewOriginRegistry();
  for (let i = 0; i < 128; i++) {
    registry.register(`https://${i.toString(16).padStart(32, "0")}.claudemcpcontent.com`);
  }
  assert.throws(() => registry.register(first), { code: "VIEW_ORIGIN_LIMIT" });
  registry.register(`https://${"0".repeat(32)}.claudemcpcontent.com`);
  assert.equal(registry.allowedOrigins.length, 128);
});

test("the native Codex sandbox enrolls its exact custom-scheme origin", () => {
  const registry = new ViewOriginRegistry();
  const origin = "codex-sandbox://mcp-app-759ffd0cc15e6b093ffcc9e0beb80edc046100e46aa928f0.web-sandbox.oaiusercontent.com";
  registry.register(origin);
  registry.register(origin);
  assert.deepEqual(registry.allowedOrigins, [origin]);
  for (const invalid of [
    origin.replace("codex-sandbox:", "other-sandbox:"),
    origin.replace("mcp-app-", "other-app-"),
    origin.replace("759ffd", "z59ffd"),
    origin.replace("759ffd", "59ffd"),
    `${origin}/`, `${origin}:443`, `${origin}?token=secret`, `${origin}.evil.example`,
    origin.replace("mcp-app-", "user@mcp-app-"),
    "codex-sandbox://web-sandbox.oaiusercontent.com",
    "codex-sandbox://evil.web-sandbox.oaiusercontent.com",
  ]) {
    assert.throws(() => registry.register(invalid), { code: "VIEW_ORIGIN_DENIED" });
  }
  assert.deepEqual(registry.allowedOrigins, [origin]);
});
