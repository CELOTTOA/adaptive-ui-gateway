import { renderPlan } from "/plan-renderer.js";

const session = { planId: undefined, view: undefined };
const tokenInput = document.querySelector("#token");
const setupStatus = document.querySelector("#setup-status");
const app = document.querySelector("#app");

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokenInput.value}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

async function executeAction(actionId) {
  const view = session.view;
  view.setBusy(true);
  view.setStatus("Loading authorized data…");
  try {
    const result = await request("/v1/data/query", {
      method: "POST",
      body: JSON.stringify({ planId: session.planId, actionId, state: view.readState() }),
    });
    view.showRows(result.rows);
    view.setStatus(`${result.rows.length} authorized row(s) returned`);
  } catch (error) {
    view.setStatus(error.message);
  } finally {
    view.setBusy(false);
  }
}

document.querySelector("#load-plan").addEventListener("click", async () => {
  setupStatus.textContent = "Creating a validated UI Plan…";
  try {
    const catalog = await request("/v1/catalog");
    if (catalog.capabilities.length !== 1) {
      throw new Error("This demo requires exactly one authorized search capability");
    }
    const capability = catalog.capabilities[0];
    const result = await request("/v1/plans", {
      method: "POST",
      body: JSON.stringify({
        intent: capability.title,
        capabilityId: capability.id,
      }),
    });
    session.planId = result.planId;
    session.view = renderPlan(app, result.plan, { onAction: executeAction });
    setupStatus.textContent = `Protected UI Plan validated and rendered (planner: ${result.planner?.source ?? "unknown"})`;
  } catch (error) {
    app.replaceChildren();
    setupStatus.textContent = error.message;
  }
});
