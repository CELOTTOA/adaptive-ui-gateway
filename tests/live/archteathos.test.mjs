import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ModelAssistedUiPlanner } from "@aug/ui-planner";
import { RecordingModelProvider } from "../helpers/recording-model-provider.mjs";
import { startArchteathosDemo, capabilityId, tenantId } from "../../examples/archteathos/demo.mjs";
import { theatreRow } from "../../examples/archteathos/adapter.mjs";

const root = process.env.ARCHTEATHOS_ROOT;

test("Archteathos adapter never substitutes estimates for missing declared measurements", () => {
  const row = theatreRow({
    codice: "test", nome: "Test", fonte: "Survey",
    rilevati: { boccascena: { larghezza: 0 } },
    stimati: { boccascena: { altezza: 9 }, capienza: 500 },
    note: "Excluded note", foto: { private: "Excluded path" },
  });
  assert.equal(row.boccascenaLarghezzaMetri, 0);
  assert.equal(row.boccascenaAltezzaMetri, null);
  assert.equal(row.capienza, null);
  assert.match(row.provenienza, /fattibilità non verificata/);
  assert.doesNotMatch(JSON.stringify(row), /Excluded|stimati|foto|note/);
});

test("Archteathos existing backend through AUG", { skip: !root && "Set ARCHTEATHOS_ROOT to the existing checkout" }, async (t) => {
  const audit = [];
  const provider = new RecordingModelProvider((request) => {
    const input = JSON.parse(request.input);
    // A simulated provider: real HTTP/backend/data policy, no external AI request.
    return JSON.stringify({
      title: "Archteathos — ricerca teatri",
      columns: input.capability.fields.map((field) => ({ field, label: field })),
      includeSearch: true, searchLabel: "Nome o codice", statusText: "Pronto",
    });
  });
  const demo = await startArchteathosDemo({
    root, port: 0,
    planner: new ModelAssistedUiPlanner({ provider }),
    onAudit: (event) => audit.push(event),
    extraPrincipals: new Map([
      ["no-scope", { id: "no-scope", tenantId, scopes: [] }],
      ["other-tenant", { id: "other", tenantId: "other", scopes: ["theatres:read"] }],
    ]),
  });
  t.after(() => demo.close());
  const originals = new Map(await Promise.all(demo.files.map(async (file) =>
    [file, createHash("sha256").update(await readFile(join(root, "simulazione", "teatri", file))).digest("hex")])));
  async function api(path, payload, token = demo.accessToken) {
    const response = await fetch(`${demo.gatewayUrl}${path}`, {
      method: payload ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const create = (token) => api("/v1/plans", { intent: "Cerca teatri per nome o codice", capabilityId }, token);
  const plan = await create();
  await t.test("discovers the real domain and creates a validated plan without fetching records", async () => {
    const catalog = await api("/v1/catalog");
    assert.deepEqual(catalog.body.capabilities.map((c) => c.id), [capabilityId]);
    assert.equal(plan.status, 201);
    assert.equal(plan.body.planner.source, "model");
    assert.equal(demo.stats.sourceRequests, 0);
    assert.doesNotMatch(JSON.stringify(plan.body), /Teatro Comunale di Bolzano|802|fondazioneteatro/);
  });
  const query = (q, token) => api("/v1/data/query", {
    planId: plan.body.planId, actionId: "query-data", state: { filters: { q } },
  }, token);
  await t.test("reads all source sheets over the actual backend HTTP handler", async () => {
    const result = await query("");
    assert.equal(result.status, 200);
    assert.equal(result.body.rows.length, demo.files.length);
    assert.equal(demo.stats.sourceRequests, demo.files.length);
    assert.equal(demo.stats.sourceReads, demo.files.length);
  });
  await t.test("searches Bolzano and preserves its source measurements", async () => {
    const result = await query("BOLZANO");
    assert.equal(result.status, 200);
    assert.equal(result.body.rows.length, 1);
    const row = result.body.rows[0];
    assert.equal(row.codice, "GM-07");
    assert.equal(row.boccascenaLarghezzaMetri, 12);
    assert.equal(row.boccascenaAltezzaMetri, 7.5);
    assert.equal(row.palcoProfonditaMetri, 15.7);
    assert.equal(row.capienza, 802);
    assert.match(row.fonte, /fondazioneteatro\.bolzano\.it/);
    assert.equal(Object.keys(row).length, 8);
    assert.doesNotMatch(JSON.stringify(row), /foto|strutture|note|stimati/);
  });
  await t.test("supports code searches, empty results and genuinely missing measurements", async () => {
    assert.equal((await query("GM-07")).body.rows.length, 1);
    assert.deepEqual((await query("no-such-theatre-7f3a")).body.rows, []);
    const row = (await query("Udine")).body.rows[0];
    assert.equal(row.boccascenaLarghezzaMetri, null);
    assert.equal(row.boccascenaAltezzaMetri, null);
  });
  await t.test("rejects missing scope, unauthorized token, other tenant and session replay", async () => {
    const before = demo.stats.sourceRequests;
    assert.equal((await create("no-scope")).status, 404);
    assert.equal((await create("other-tenant")).status, 404);
    assert.equal((await create("invalid-token")).status, 401);
    assert.equal((await query("Bolzano", "other-tenant")).status, 404);
    assert.equal(demo.stats.sourceRequests, before);
    assert.equal((await fetch(`${demo.adapterUrl}/theatres`)).status, 401);
  });
  await t.test("the source wrapper exposes neither provider routes nor arbitrary files", async () => {
    for (const path of ["/.envlocal", "/server/server.mjs", "/api/generate-image", "/api/realtime/token"]) {
      assert.equal((await fetch(`${demo.sourceUrl}${path}`)).status, 403);
    }
    assert.equal((await fetch(`${demo.sourceUrl}/simulazione/teatri/bolzano.json`, { method: "POST" })).status, 403);
  });
  await t.test("record values and access token stay out of model and audit channels", () => {
    const serialized = provider.channel() + JSON.stringify(audit);
    for (const value of ["Teatro Comunale di Bolzano", "fondazioneteatro.bolzano.it", demo.accessToken]) {
      assert.equal(serialized.includes(value), false);
    }
    assert.ok(audit.some((event) => event.type === "query.executed" && event.rowCount === 1));
  });
  await t.test("does not change the source theatre sheets", async () => {
    for (const [file, original] of originals) {
      assert.equal(createHash("sha256").update(await readFile(join(root, "simulazione", "teatri", file))).digest("hex"), original);
    }
  });
});
