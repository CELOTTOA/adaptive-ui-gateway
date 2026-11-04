import test from "node:test";
import assert from "node:assert/strict";
import { renderPlan } from "@aug/ui-renderer/plan-renderer.js";

// Minimal DOM double: records structure and fails loudly on HTML-parsing sinks.
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.textContent = "";
    this.value = "";
    this.disabled = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  set innerHTML(_value) { throw new Error("innerHTML must not be used"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML must not be used"); }
}
const fakeDocument = { createElement: (tag) => new FakeElement(tag) };

function all(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children ?? []) all(child, predicate, found);
  return found;
}
const byTag = (node, tag) => all(node, (n) => n.tagName === tag.toUpperCase());
const text = (node) => [node.textContent, ...(node.children ?? []).map(text)].join("");

const plan = {
  schemaVersion: "aug.ui/0.1",
  viewId: "v",
  title: "Customer search",
  components: [
    { id: "title", type: "heading", text: "Customer search" },
    { id: "query", type: "text-input", label: "Name or city", bind: "filters.q" },
    { id: "search", type: "button", label: "Search", actionRef: "query-data" },
    { id: "results", type: "data-table", dataSourceId: "records", columns: [
      { key: "name", label: "Name" },
      { key: "amountDue", label: "Amount due" },
    ] },
    { id: "status", type: "status-message", text: "Ready" },
    { id: "evil", type: "script", text: "<img src=x onerror=alert(1)>" },
  ],
  actions: [{ id: "query-data", type: "query", dataSourceId: "records", args: { q: { stateRef: "filters.q" } } }],
  dataSources: [{ id: "records", capabilityId: "c", bindingPolicyId: "p", fields: ["name", "amountDue"] }],
};

function render(onAction = () => {}) {
  const root = new FakeElement("div");
  const view = renderPlan(root, plan, { onAction, document: fakeDocument });
  return { root, view };
}

test("renders supported components as text and ignores unknown types", () => {
  const { root } = render();
  assert.equal(byTag(root, "h2")[0].textContent, "Customer search");
  assert.deepEqual(byTag(root, "th").map((th) => th.textContent), ["Name", "Amount due"]);
  assert.equal(byTag(root, "button")[0].textContent, "Search");
  assert.doesNotMatch(text(root), /onerror|<img/);
});

test("reads input state through the plan bindings only", () => {
  const { root, view } = render();
  byTag(root, "input")[0].value = "CANARY";
  assert.deepEqual(view.readState(), { filters: { q: "CANARY" } });
});

test("buttons dispatch the plan action id", () => {
  const calls = [];
  const { root } = render((actionId) => calls.push(actionId));
  byTag(root, "button")[0].listeners.click();
  assert.deepEqual(calls, ["query-data"]);
});

test("rows show only plan columns, as text", () => {
  const { root, view } = render();
  view.showRows([
    { name: "<b>Aurora</b>", amountDue: 12.5, internalNotes: "SECRET", tenantId: "tenant-a" },
    { name: "Missing amount" },
  ]);
  const cells = byTag(root, "tbody")[0].children.map((tr) => tr.children.map((td) => td.textContent));
  assert.deepEqual(cells, [["<b>Aurora</b>", "12.5"], ["Missing amount", ""]]);
  assert.doesNotMatch(text(root), /SECRET|tenant-a/);
});

test("status and busy state are updated in place", () => {
  const { root, view } = render();
  view.setStatus("Loading…");
  view.setBusy(true);
  assert.equal(all(root, (n) => n.attributes.role === "status")[0].textContent, "Loading…");
  assert.equal(byTag(root, "button")[0].disabled, true);
  view.setBusy(false);
  assert.equal(byTag(root, "button")[0].disabled, false);
});
