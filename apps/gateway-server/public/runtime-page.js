import { createOperationRuntime } from "/operation-runtime.js";

const form = document.querySelector("#runtime-connect");
const token = document.querySelector("#runtime-token");
const connect = document.querySelector("#runtime-connect-button");
const status = document.querySelector("#runtime-connect-status");
const root = document.querySelector("#runtime-app");
let runtime;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!token.value) return;
  runtime?.dispose();
  const accessToken = token.value;
  token.value = "";
  connect.disabled = true;
  status.textContent = "Connecting…";
  runtime = createOperationRuntime(root, { request: async (path, input, { signal }) => {
    let response;
    try {
      response = await fetch(path, {
        method: "POST", signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch { throw new Error("Gateway connection failed"); }
    const value = await response.json();
    if (!response.ok) { const error = new Error("Gateway request refused"); error.code = value.code ?? "REQUEST_REFUSED"; throw error; }
    return value;
  } });
  const loaded = await runtime.ready;
  if (loaded) document.querySelector("#runtime-connection").open = false;
  connect.disabled = false;
  status.textContent = loaded ? "Results and inputs stay in this view." : "Operations could not be loaded. Check the view message and reconnect.";
});
