import test from "node:test";
import assert from "node:assert/strict";
import {
  collectionOutput, negotiateOutput, profiles, protocolVersion,
  validateOutput, validateProfileContent, validateRuntimeCapabilities,
} from "@aug/protocol";

const runtime = {
  protocolVersions: [protocolVersion],
  profiles: [profiles.collection, profiles.json, profiles.text, profiles.document],
  mediaTypes: ["application/json", "text/plain", "application/pdf"],
  deliveryKinds: ["inline", "reference"],
};
const output = (representations) => ({ protocolVersion, id: "result-1", representations });
const representation = (changes = {}) => ({
  id: "primary", profile: profiles.json, mediaType: "application/json", audiences: ["view"],
  delivery: { kind: "inline", value: { state: "ready" } }, ...changes,
});
const fails = (code) => (error) => error.code === code;

test("one collection contract covers unrelated backend domains, including nested values", () => {
  const domains = [
    { columns: [{ key: "invoice" }, { key: "amount" }], rows: [{ invoice: "I-1", amount: 125.5 }] },
    { columns: [{ key: "machine" }, { key: "measurements" }], rows: [{ machine: "M-1", measurements: [12, 13] }] },
    { columns: [{ key: "person" }, { key: "address" }], rows: [{ person: "P-1", address: { city: "Torino" } }] },
    { columns: [{ key: "pending" }], rows: [] },
  ];
  for (const [index, value] of domains.entries()) {
    const declared = collectionOutput(`domain-${index}`, value, ["view"]);
    const selected = negotiateOutput(declared, runtime, "view");
    assert.equal(selected.representation.profile, profiles.collection);
    assert.deepEqual(selected.representation.delivery.value, value);
  }
});

test("a producer-declared JSON alternative serves a runtime without the collection profile", () => {
  const declared = collectionOutput("items", { columns: [{ key: "id" }], rows: [{ id: 7 }] }, ["view"]);
  const selected = negotiateOutput(declared, { ...runtime, profiles: [profiles.json] }, "view");
  assert.equal(selected.representation.id, "json");
  assert.deepEqual(selected.representation.delivery.value.rows, [{ id: 7 }]);
  assert.equal("representations" in selected, false);
});

test("custom profiles extend the contract without changing core or forcing runtime support", () => {
  const declared = output([
    representation({ id: "geometry", profile: "example.geometry/1", delivery: { kind: "inline", value: { vertices: [[0, 0], [1, 1]] } } }),
    representation({ id: "json" }),
  ]);
  assert.equal(negotiateOutput(declared, runtime, "view").representation.id, "json");
  const extended = { ...runtime, profiles: [...runtime.profiles, "example.geometry/1"] };
  assert.equal(negotiateOutput(declared, extended, "view").representation.id, "geometry");
});

test("selection follows producer preference after checking profile, media type and delivery", () => {
  const declared = output([
    representation({ id: "file", profile: profiles.document, mediaType: "application/pdf", delivery: { kind: "reference", href: "/documents/1" } }),
    representation({ id: "text", profile: profiles.text, mediaType: "text/plain", delivery: { kind: "inline", value: "Document available" } }),
  ]);
  assert.equal(negotiateOutput(declared, runtime, "view").representation.id, "file");
  assert.equal(negotiateOutput(declared, { ...runtime, deliveryKinds: ["inline"] }, "view").representation.id, "text");
  assert.equal(negotiateOutput(declared, { ...runtime, mediaTypes: ["text/plain"] }, "view").representation.id, "text");
});

test("fallback never changes audience or invents a model-safe representation", () => {
  const declared = collectionOutput("private", { columns: [{ key: "secret" }], rows: [{ secret: "PRIVATE-CANARY" }] }, ["view"]);
  assert.throws(() => negotiateOutput(declared, runtime, "model"), fails("NO_COMPATIBLE_REPRESENTATION"));
  assert.throws(() => negotiateOutput(declared, { ...runtime, profiles: [profiles.json] }, "model"), fails("NO_COMPATIBLE_REPRESENTATION"));
});

test("only an explicitly permitted model representation is returned, without view content", () => {
  const declared = output([
    representation({ delivery: { kind: "inline", value: { name: "PRIVATE-CANARY" } } }),
    representation({ id: "model-status", audiences: ["model"], delivery: { kind: "inline", value: { state: "available-in-view" } } }),
  ]);
  const selected = negotiateOutput(declared, runtime, "model");
  assert.equal(selected.representation.id, "model-status");
  assert.equal(selected.audience, "model");
  assert.doesNotMatch(JSON.stringify(selected), /PRIVATE-CANARY/);
});

test("unknown protocol versions and unsupported output fail explicitly", () => {
  assert.throws(() => negotiateOutput(output([representation()]), { ...runtime, protocolVersions: ["aug/999"] }, "view"), fails("UNSUPPORTED_PROTOCOL_VERSION"));
  assert.throws(() => validateOutput({ ...output([representation()]), protocolVersion: "aug/999" }), fails("UNSUPPORTED_PROTOCOL_VERSION"));
  assert.throws(() => negotiateOutput(output([representation({ profile: "example.unknown/1" })]), runtime, "view"), fails("NO_COMPATIBLE_REPRESENTATION"));
});

test("wire schemas reject malformed declarations and do not echo sensitive values", () => {
  const malformed = [
    { ...output([representation()]), extra: "PRIVATE-CANARY" },
    output([representation({ audiences: [] })]),
    output([representation({ audiences: ["model", "model"] })]),
    output([representation({ delivery: { kind: "inline", value: { amount: NaN } } })]),
    output([representation({ delivery: { kind: "inline", value: null, href: "/unexpected" } })]),
    output([representation(), representation()]),
  ];
  for (const value of malformed) {
    assert.throws(() => validateOutput(value), (error) => {
      assert.doesNotMatch(error.message, /PRIVATE-CANARY/);
      return error.code === "INVALID_OUTPUT";
    });
  }
  for (const value of [null, {}, { ...runtime, profiles: [] }, { ...runtime, deliveryKinds: ["execute"] }, { ...runtime, extra: true }]) {
    assert.throws(() => validateRuntimeCapabilities(value), fails("INVALID_RUNTIME"));
  }
});

test("collection semantics reject undeclared, missing and duplicate fields", () => {
  for (const value of [
    { columns: [{ key: "id" }], rows: [{ id: 1, secret: "PRIVATE-CANARY" }] },
    { columns: [{ key: "id" }], rows: [{}] },
    { columns: [{ key: "id" }, { key: "id" }], rows: [] },
    { columns: [{ key: "id" }], rows: [null] },
  ]) {
    assert.throws(() => collectionOutput("invalid", value, ["view"]), fails("INVALID_PROFILE_CONTENT"));
  }
  const poisoned = output([representation({ profile: profiles.collection, delivery: { kind: "inline", value: {} } }), representation({ id: "fallback" })]);
  assert.throws(() => negotiateOutput(poisoned, runtime, "view"), fails("INVALID_PROFILE_CONTENT"));
});

test("profile and media mismatches are rejected before rendering", () => {
  for (const value of [
    representation({ profile: profiles.collection, mediaType: "text/plain" }),
    representation({ profile: profiles.text, mediaType: "text/plain", delivery: { kind: "inline", value: 42 } }),
    representation({ profile: profiles.document, mediaType: "application/pdf" }),
  ]) assert.throws(() => validateOutput(output([value])), fails("INVALID_PROFILE_CONTENT"));
  assert.throws(() => validateProfileContent(profiles.collection, { columns: [], rows: [{ extra: true }] }), fails("INVALID_PROFILE_CONTENT"));
});

test("references are negotiated as references, with safe schemes and no implicit fetching", () => {
  for (const href of ["/files/result.pdf", "https://files.example/result.pdf"]) {
    const declared = output([representation({ profile: profiles.document, mediaType: "application/pdf", delivery: { kind: "reference", href } })]);
    assert.deepEqual(negotiateOutput(declared, runtime, "view").representation.delivery, { kind: "reference", href });
  }
  for (const href of ["javascript:alert(1)", "data:text/plain,secret", "//evil.example/file", "/\\evil.example/file", "http://remote.example/file", "https://user:password@example.com/file", "https://example.com/file#secret", "relative/file"]) {
    const declared = output([representation({ delivery: { kind: "reference", href } })]);
    assert.throws(() => validateOutput(declared), fails("INVALID_OUTPUT"));
  }
});
