// MCP Apps host glue for the shared AUG plan renderer (renderPlan is inlined before this file).
// The host supplies only the view request; plans and records use the direct gateway channel.
const root = document.querySelector("#app");
const connection = document.querySelector("#direct-connection");
const tokenInput = document.querySelector("#gateway-token");
const connectButton = document.querySelector("#connect-gateway");
const connectionDetails = document.querySelector("#connection-details");
const connectionDiagnostics = document.querySelector("#connection-diagnostics");
let blockedConnection;
let hostConnection;
const session = {
  request: undefined,
  planId: undefined,
  view: undefined,
  accessToken: undefined,
  originRegistered: false,
};
const app = new McpApps.App({ name: "aug-search-view", version: "0.1.0" });

function diag(stage, detail = {}) {
  console.warn(`[AUG view] ${stage} ${JSON.stringify(detail)}`);
}
window.addEventListener("error", (event) => diag("error", { message: String(event.message).slice(0, 200) }));
window.addEventListener("unhandledrejection", (event) =>
  diag("unhandledrejection", { message: String(event.reason?.message ?? event.reason).slice(0, 200) }),
);
window.addEventListener("securitypolicyviolation", (event) => {
  if (event.effectiveDirective !== "connect-src") return;
  // Report origins only: a blocked URL may contain sensitive query parameters.
  try {
    blockedConnection = `connect-src blocked ${new URL(event.blockedURI).origin}`;
  } catch {
    blockedConnection = "connect-src blocked the request";
  }
});
diag("script-start");

function setStatus(message) {
  if (session.view) {
    session.view.setStatus(message);
  } else {
    const status = root.querySelector('[role="status"]');
    if (status) status.textContent = message;
  }
}

function viewRequest(value) {
  if (
    typeof value?.intent !== "string" ||
    typeof value?.capabilityId !== "string" ||
    !value.intent ||
    !value.capabilityId
  ) {
    return undefined;
  }
  return { intent: value.intent, capabilityId: value.capabilityId };
}

function showConnection() {
  connection.hidden = false;
  if (!session.view) {
    setStatus("Connect directly to AUG to create the interface. The token stays in this view.");
  }
}

async function directRequest(path, input) {
  if (!session.originRegistered && AUG_VIEW_ORIGIN_PATTERN.test(window.origin)) {
    await hostConnection;
    // Only origin metadata crosses the host bridge. Never send tokens, plans or records.
    const registered = await app.callServerTool({
      name: "aug_register_view_origin",
      arguments: { origin: window.origin },
    });
    if (registered.isError) {
      throw new Error("AUG could not register this view origin. Reopen the view after reconnecting AUG.");
    }
    session.originRegistered = true;
  }
  let response;
  try {
    response = await fetch(`${AUG_GATEWAY_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    const policyDetails = [];
    // Inspect supported policies only; older engines may not know these names.
    const supported = policy?.features?.() ?? [];
    for (const name of ["local-network", "loopback-network", "local-network-access"]) {
      if (supported.includes(name)) {
        policyDetails.push(`${name}: ${policy.allowsFeature(name) ? "delegated" : "not delegated (browser policy report)"}`);
      }
    }
    connectionDiagnostics.textContent = [
      `Gateway: ${AUG_GATEWAY_ORIGIN}`,
      `View origin: ${window.origin}`,
      `Secure context: ${window.isSecureContext}`,
      ...policyDetails,
      ...(blockedConnection ? [`CSP: ${blockedConnection}`] : []),
      "The browser could not complete the request. Check the gateway, exact CORS origin and host network policy.",
    ].join("\n");
    connectionDetails.hidden = false;
    throw new Error("This view cannot reach AUG. Open Connection details to diagnose the connection.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof result.error === "string" ? result.error : "Direct gateway request failed");
  }
  return result;
}

connection.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session.request) {
    setStatus("The host did not deliver a valid view request");
    return;
  }
  session.accessToken = tokenInput.value;
  if (!session.accessToken) return;
  connectButton.disabled = true;
  connectionDetails.hidden = true;
  blockedConnection = undefined;
  setStatus("Creating the interface through the direct AUG connection…");
  try {
    const created = await directRequest("/v1/plans", session.request);
    if (typeof created.planId !== "string" || !created.plan) {
      throw new Error("The gateway returned an invalid view response");
    }
    session.planId = created.planId;
    session.view = renderPlan(root, created.plan, { onAction: executeAction });
    connection.hidden = true;
    tokenInput.value = "";
    setStatus("Interface created through the direct AUG connection");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Direct gateway request failed");
  } finally {
    connectButton.disabled = false;
  }
});

async function executeAction(actionId) {
  const view = session.view;
  view.setBusy(true);
  view.setStatus("Loading authorized data through the direct AUG connection…");
  try {
    const result = await directRequest("/v1/data/query", {
      planId: session.planId,
      actionId,
      state: view.readState(),
    });
    if (!Array.isArray(result.rows)) {
      throw new Error("The gateway returned an invalid data response");
    }
    view.showRows(result.rows);
    view.setStatus(`${result.rows.length} authorized row(s)`);
  } catch (error) {
    view.setStatus(error instanceof Error ? error.message : "Query failed");
  } finally {
    view.setBusy(false);
  }
}

app.ontoolinput = (input) => {
  session.request = viewRequest(input?.arguments);
  diag("tool-input-received", { validRequest: Boolean(session.request) });
  if (session.request) {
    showConnection();
  }
};

app.ontoolresult = (result) => {
  const resultKeys = Object.keys(result ?? {});
  const metaKeys = Object.keys(result?._meta ?? {});
  diag("tool-result-received", {
    keys: resultKeys,
    metaKeys,
    isError: result?.isError === true,
  });
  if (result?.isError) {
    setStatus("The gateway refused to open this view");
    return;
  }
  session.request ??= viewRequest(result?.structuredContent?.view);
  if (!session.request) {
    const shape = [
      `result keys: ${resultKeys.join(", ") || "none"}`,
      `meta keys: ${metaKeys.join(", ") || "none"}`,
      "view request: missing",
    ].join("; ");
    setStatus(`The host did not deliver the view request (${shape})`);
    return;
  }
  showConnection();
};

try {
  hostConnection = app.connect();
  await hostConnection;
  const context = app.getHostContext?.() ?? {};
  diag("connected", {
    displayMode: context.displayMode,
    availableDisplayModes: context.availableDisplayModes,
    containerDimensions: context.containerDimensions,
    hostCapabilities: Object.keys(app.getHostCapabilities?.() ?? {}),
    height: document.documentElement.scrollHeight,
  });
} catch (error) {
  diag("connect-failed", { message: String(error?.message ?? error).slice(0, 200) });
}
