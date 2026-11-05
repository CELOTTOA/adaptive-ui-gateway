// The host bridge carries operation identifiers and origin enrollment only.
const runtimeForm = document.querySelector("#runtime-connect");
const runtimeToken = document.querySelector("#runtime-token");
const runtimeConnect = document.querySelector("#runtime-connect-button");
const runtimeStatus = document.querySelector("#runtime-connect-status");
const runtimeRoot = document.querySelector("#runtime-app");
const runtimeApp = new McpApps.App({ name: "aug-operation-runtime", version: "0.1.0" });
let runtimeRequest;
let operationRuntime;
let runtimeOriginRegistered = false;
let runtimeHostConnection;

function acceptRuntimeRequest(value) {
  if (value && (value.operationId === undefined || value.operationId === null || typeof value.operationId === "string")) {
    runtimeRequest = { operationId: value.operationId ?? undefined };
    runtimeForm.hidden = false;
    document.querySelector("#runtime-connection").hidden = false;
  }
}

runtimeApp.ontoolinput = (input) => acceptRuntimeRequest(input?.arguments);
runtimeApp.ontoolresult = (result) => {
  if (result?.isError) { runtimeStatus.textContent = "The gateway refused to open this operation."; return; }
  acceptRuntimeRequest(result?.structuredContent?.view);
};

runtimeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!runtimeToken.value || !runtimeRequest) return;
  const accessToken = runtimeToken.value;
  runtimeToken.value = "";
  runtimeConnect.disabled = true;
  operationRuntime?.dispose();
  try {
    if (!runtimeOriginRegistered && AUG_VIEW_ORIGIN_PATTERN.test(window.origin)) {
      await runtimeHostConnection;
      const registered = await runtimeApp.callServerTool({ name: "aug_register_view_origin", arguments: { origin: window.origin } });
      if (registered.isError) throw new Error("Origin refused");
      runtimeOriginRegistered = true;
    }
    operationRuntime = createOperationRuntime(runtimeRoot, { operationId: runtimeRequest.operationId,
      request: async (path, input, { signal }) => {
        const response = await fetch(`${AUG_GATEWAY_ORIGIN}${path}`, {
          method: "POST", signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
          headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const value = await response.json();
        if (!response.ok) { const error = new Error("Direct request refused"); error.code = value.code ?? "REQUEST_REFUSED"; throw error; }
        return value;
      },
    });
    const loaded = await operationRuntime.ready;
    if (loaded) document.querySelector("#runtime-connection").open = false;
    runtimeStatus.textContent = loaded ? "Inputs, confirmations and results travel directly between this view and AUG." : "Operations could not be loaded. Check the view message and reconnect.";
  } catch {
    runtimeStatus.textContent = "This view cannot connect to AUG. Check the gateway and the host network policy.";
  } finally { runtimeConnect.disabled = false; }
});

try { runtimeHostConnection = runtimeApp.connect(); await runtimeHostConnection; }
catch { runtimeStatus.textContent = "This view could not connect to its host."; }
