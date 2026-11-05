// AUG operation runtime. Fixed, dependency-free browser code; metadata and values are text.
// All transport, identity and host integration are injected. The backend validates full schemas.
export function runtimeCapabilities() {
  return { protocolVersions: ["aug/0.2"], profiles: ["aug.collection/0.1", "aug.json/0.1", "aug.text/0.1"],
    mediaTypes: ["application/json", "text/plain"], deliveryKinds: ["inline"] };
}

export function createOperationRuntime(root, {
  request, operationId, document: doc = globalThis.document,
  newRequestId = () => globalThis.crypto.randomUUID(), pollMs = 500, maxPolls = 40,
} = {}) {
  const element = (tag, text, className) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const json = (value) => JSON.stringify(value, null, 2);
  let disposed = false;
  let operations = [];
  let operation;
  let readInput;
  let active;
  let pendingRequest;
  let recovery;
  let controller = new AbortController();
  const timers = new Set();
  const shell = element("div", undefined, "aug-runtime");
  const pickerLabel = element("label", "Operation");
  const picker = element("select");
  picker.setAttribute("aria-label", "Operation");
  pickerLabel.append(picker);
  const title = element("h2");
  const description = element("p", undefined, "aug-description");
  const form = element("form");
  const fields = element("fieldset", undefined, "aug-fields");
  const legend = element("legend", "Inputs");
  const inputs = element("div", undefined, "aug-inputs");
  const inputMode = element("button", "Edit inputs as JSON", "aug-secondary aug-input-mode");
  inputMode.type = "button";
  let rawMode = false;
  fields.append(legend, inputMode, inputs);
  const submit = element("button", "Run operation", "aug-primary");
  submit.type = "submit";
  const retry = element("button", "Retry request", "aug-secondary");
  retry.type = "button";
  retry.hidden = true;
  const status = element("p", "Loading operations…", "aug-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const review = element("section", undefined, "aug-review");
  review.setAttribute("aria-label", "Review operation");
  review.hidden = true;
  const result = element("section", undefined, "aug-result");
  result.setAttribute("aria-label", "Result");
  result.hidden = true;
  form.append(fields, submit, retry);
  shell.append(pickerLabel, title, description, form, status, review, result);
  root.replaceChildren(shell);

  function setBusy(busy) {
    fields.disabled = busy;
    submit.disabled = busy;
    picker.disabled = busy;
    shell.setAttribute("aria-busy", String(busy));
  }

  function message(text, error = false) {
    if (disposed) return;
    status.textContent = text;
    status.className = error ? "aug-status aug-error" : "aug-status";
  }

  function safeError(error) {
    const known = {
      INVALID_INPUT: "Check the inputs against the operation requirements.",
      UNAUTHORIZED: "Access was denied. Reconnect with a valid access token.",
      OPERATION_NOT_FOUND: "This operation is no longer available.",
      INVOCATION_NOT_FOUND: "This invocation is no longer available.",
      OPERATION_VERSION_MISMATCH: "The operation has changed. Reconnect to load its current version.",
      IDEMPOTENCY_CONFLICT: "This request identifier already belongs to another request.",
      CONFIRMATION_EXPIRED: "The confirmation has expired. Review a new request before proceeding.",
      CONFIRMATION_DENIED: "The confirmation was refused.",
      NO_COMPATIBLE_REPRESENTATION: "This runtime cannot display an output offered by this operation.",
      UNSUPPORTED_PROTOCOL_VERSION: "This runtime does not support the backend protocol version.",
      TOO_MANY_INVOCATIONS: "The backend is busy. Retry this request later.",
      INVOCATION_RETIRED: "The saved result has expired. Its request identifier remains reserved; the operation was not repeated.",
      OPERATION_CONTRACT_CHANGED: "The operation contract has changed. Reconnect and verify the previous outcome before proceeding.",
      STATE_STORE_UNAVAILABLE: "The operation state is unavailable. Verify its outcome before starting another request.",
    };
    return Object.hasOwn(known, error?.code) ? known[error.code] : "The request could not be completed.";
  }

  async function call(path, input) {
    const value = await request(path, input, { signal: controller.signal });
    if (disposed) throw new Error("Runtime disposed");
    return value;
  }

  function buildInput(schema, key, required) {
    const label = element("label", typeof schema.title === "string" ? schema.title : key, "aug-field");
    let input;
    let read;
    const simple = !["$ref", "oneOf", "anyOf", "allOf", "if"].some((name) => Object.hasOwn(schema, name));
    if (simple && Array.isArray(schema.enum) && schema.enum.every((entry) => entry === null || ["string", "boolean", "number"].includes(typeof entry))) {
      input = element("select");
      const empty = element("option", "Choose a value");
      empty.value = "";
      input.append(empty);
      for (const value of schema.enum) {
        const option = element("option", value === null ? "null" : value);
        option.value = JSON.stringify(value);
        input.append(option);
      }
      read = () => input.value === "" ? undefined : JSON.parse(input.value);
    } else if (simple && schema.type === "boolean") {
      input = element("select");
      for (const [text, value] of [["Choose a value", ""], ["True", "true"], ["False", "false"]]) {
        const option = element("option", text); option.value = value; input.append(option);
      }
      read = () => input.value === "" ? undefined : input.value === "true";
    } else if (simple && ["string", "number", "integer"].includes(schema.type)) {
      input = element("input");
      input.type = schema.type === "string" ? "text" : "number";
      if (input.type === "number") {
        input.step = schema.type === "integer" ? "1" : "any";
        if (Number.isFinite(schema.minimum)) input.min = String(schema.minimum);
        if (Number.isFinite(schema.maximum)) input.max = String(schema.maximum);
      }
      if (Number.isSafeInteger(schema.maxLength) && schema.maxLength > 0) input.maxLength = schema.maxLength;
      read = () => {
        if (input.value === "") return schema.type === "string" && required ? "" : undefined;
        if (schema.type === "string") return input.value;
        const value = Number(input.value);
        if (!Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) throw new Error("Invalid number");
        return value;
      };
    } else {
      input = element("textarea");
      input.rows = 4;
      input.spellcheck = false;
      input.placeholder = schema.type === "array" ? "[]" : schema.type === "object" ? "{}" : "Enter a JSON value";
      read = () => input.value.trim() === "" ? undefined : JSON.parse(input.value);
    }
    input.required = required && !(simple && schema.type === "string" && !schema.enum && !(schema.minLength > 0));
    input.name = key;
    input.setAttribute("aria-label", typeof schema.title === "string" ? schema.title : key);
    label.append(input);
    if (typeof schema.description === "string") label.append(element("span", schema.description, "aug-field-help"));
    if (!required) label.append(element("span", "Optional", "aug-field-help"));
    return { label, input, read: () => {
      input.setCustomValidity?.("");
      try {
        const value = read();
        if (required && value === undefined) throw new Error("Required input");
        return value;
      } catch {
        input.setCustomValidity?.("Enter a valid value for this field.");
        input.reportValidity?.();
        throw new Error("Invalid input");
      }
    } };
  }

  function buildForm(schema, forceRaw = false, seed) {
    inputs.replaceChildren();
    const properties = isObject(schema.properties) ? Object.entries(schema.properties) : [];
    const complex = ["$ref", "oneOf", "anyOf", "allOf", "if", "patternProperties"].some((key) => Object.hasOwn(schema, key)) || schema.additionalProperties !== false;
    inputMode.hidden = complex;
    if (complex || forceRaw) {
      const editor = buildInput({ title: "Inputs as JSON", type: "object" }, "input", true);
      editor.input.value = json(seed ?? {});
      inputs.append(editor.label);
      return () => {
        const value = editor.read();
        if (!isObject(value)) throw new Error("Inputs must be an object");
        return value;
      };
    }
    const readers = properties.map(([key, value]) => {
      const field = buildInput(isObject(value) ? value : {}, key, schema.required?.includes(key) === true);
      if (seed && Object.hasOwn(seed, key)) field.input.value = field.input.tagName === "SELECT" ? JSON.stringify(seed[key]) :
        typeof seed[key] === "string" && field.input.tagName === "INPUT" ? seed[key] : JSON.stringify(seed[key]);
      inputs.append(field.label);
      return { key, read: field.read };
    });
    if (!readers.length) inputs.append(element("p", "This operation requires no inputs.", "aug-description"));
    return () => Object.fromEntries(readers.map(({ key, read }) => [key, read()]).filter(([, value]) => value !== undefined));
  }

  function choose() {
    if (disposed) return;
    operation = operations.find((entry) => entry.id === picker.value);
    active = undefined; pendingRequest = undefined; recovery = undefined;
    retry.hidden = true; review.hidden = true; result.hidden = true;
    if (!operation) return;
    title.textContent = operation.title;
    description.textContent = operation.description;
    submit.textContent = operation.confirmation === "explicit" ? "Review operation" : "Run operation";
    rawMode = false; inputMode.textContent = "Edit inputs as JSON";
    readInput = buildForm(operation.inputSchema);
    setBusy(false);
    message(operation.effect === "read" ? "Ready." : "This operation changes data and requires your confirmation.");
  }

  function showOutput(output) {
    const representation = output?.representation;
    if (output?.protocolVersion !== "aug/0.2" || output.audience !== "view" ||
      !representation?.audiences?.includes("view") || representation.delivery?.kind !== "inline" ||
      !runtimeCapabilities().profiles.includes(representation.profile)) throw new Error("Unsupported output");
    const value = representation.delivery.value;
    result.replaceChildren(element("h3", "Result"));
    if (representation.profile === "aug.collection/0.1") {
      if (representation.mediaType !== "application/json" || !Array.isArray(value?.columns) || !Array.isArray(value?.rows) ||
        value.columns.some((column) => typeof column.key !== "string") || new Set(value.columns.map((column) => column.key)).size !== value.columns.length ||
        value.rows.some((row) => !isObject(row) || Object.keys(row).length !== value.columns.length || value.columns.some(({ key }) => !Object.hasOwn(row, key)))) throw new Error("Invalid collection");
      const wrap = element("div", undefined, "aug-table-wrap");
      const table = element("table");
      table.append(element("caption", `${value.rows.length} row(s)`));
      const head = element("thead");
      const header = element("tr");
      const numeric = value.columns.map(({ key }) => value.rows.some((row) => typeof row[key] === "number") && value.rows.every((row) => row[key] === null || typeof row[key] === "number"));
      value.columns.forEach((column, index) => {
        const th = element("th", column.label ?? column.key, numeric[index] ? "aug-number" : undefined);
        th.scope = "col"; header.append(th);
      });
      head.append(header);
      const body = element("tbody");
      table.append(head, body); wrap.append(table); result.append(wrap);
      let shown = 0;
      const more = element("button", "Show more rows", "aug-secondary");
      more.type = "button";
      const range = element("p", undefined, "aug-description");
      function next() {
        const end = Math.min(shown + 50, value.rows.length);
        for (; shown < end; shown++) {
          const tr = element("tr");
          value.columns.forEach(({ key }, index) => {
            const cell = value.rows[shown][key];
            tr.append(element("td", cell === null ? "null" : typeof cell === "object" ? JSON.stringify(cell) : cell, numeric[index] ? "aug-number" : undefined));
          });
          body.append(tr);
        }
        range.textContent = value.rows.length ? `Showing 1–${shown} of ${value.rows.length}` : "No rows matched this request.";
        more.hidden = shown >= value.rows.length;
      }
      more.addEventListener("click", next);
      result.append(range, more); next();
    } else if (representation.profile === "aug.text/0.1") {
      if (representation.mediaType !== "text/plain" || typeof value !== "string") throw new Error("Invalid text output");
      result.append(element("pre", value));
    } else {
      if (representation.mediaType !== "application/json") throw new Error("Invalid JSON output");
      result.append(element("pre", json(value)));
    }
    result.hidden = false;
  }

  function receive(value) {
    if (value?.protocolVersion !== "aug/0.2" || typeof value.id !== "string" ||
      value.operationId !== operation.id || value.operationVersion !== operation.version ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      (active && (value.id !== active.id || value.revision < active.revision))) throw new Error("Invalid invocation state");
    if (!["running", "awaiting_confirmation", "succeeded", "failed", "expired", "indeterminate"].includes(value.state)) throw new Error("Invalid state");
    active = value;
    retry.hidden = true; recovery = undefined;
    if (value.state === "awaiting_confirmation") {
      if (typeof value.confirmation?.token !== "string" || !isObject(value.confirmation.input) || !Number.isFinite(value.confirmation.expiresAt)) throw new Error("Invalid confirmation");
      review.replaceChildren(element("h3", "Review operation"),
        element("p", `Confirm ${operation.title} using these saved inputs.`), element("pre", json(value.confirmation.input)));
      const confirm = element("button", "Confirm operation", "aug-primary");
      confirm.type = "button";
      confirm.addEventListener("click", () => {
        if (confirm.disabled || disposed) return;
        confirm.disabled = true;
        back.disabled = true;
        perform(() => call("/v1/aug/invocations/control", {
          protocolVersion: "aug/0.2", action: "confirm", invocationId: value.id, token: value.confirmation.token,
        }));
      });
      const back = element("button", "Back to inputs", "aug-secondary");
      back.type = "button";
      back.addEventListener("click", choose);
      review.append(confirm, back); review.hidden = false;
      setBusy(true);
      message("Review the saved inputs before confirming.");
    } else if (value.state === "running") {
      review.hidden = true;
      setBusy(true); message("Operation running…");
    } else if (value.state === "indeterminate") {
      review.hidden = true;
      recover(() => call("/v1/aug/invocations/control", { protocolVersion: "aug/0.2", action: "status", invocationId: value.id }),
        "Check status", "The execution outcome is unknown. Reconcile it in the backend before starting another request.");
    } else {
      review.hidden = true;
      if (value.state === "succeeded") { showOutput(value.output); message("Operation completed."); }
      else message(value.state === "expired" ? "The confirmation has expired." : "The operation failed. Verify its outcome before starting another request.", true);
      setBusy(false);
      pendingRequest = undefined;
    }
  }

  async function wait() {
    await new Promise((resolve) => {
      const timer = { id: undefined, resolve };
      timer.id = setTimeout(() => { timers.delete(timer); resolve(); }, pollMs);
      timers.add(timer);
    });
  }

  async function follow() {
    for (let attempt = 0; active?.state === "running" && !disposed; attempt++) {
      if (attempt >= maxPolls) {
        recover(() => call("/v1/aug/invocations/control", { protocolVersion: "aug/0.2", action: "status", invocationId: active.id }), "Check status", "The operation is still running. Check its status to continue.");
        return;
      }
      await wait();
      if (disposed) return;
      receive(await call("/v1/aug/invocations/control", { protocolVersion: "aug/0.2", action: "status", invocationId: active.id }));
    }
  }

  function recover(action, label, text) {
    recovery = action; retry.textContent = label; retry.hidden = false; retry.disabled = false;
    setBusy(true); message(text, true);
  }

  async function perform(action) {
    if (disposed) return;
    setBusy(true); retry.disabled = true;
    try {
      receive(await action());
      await follow();
    } catch (error) {
      if (disposed) return;
      if (error?.code) {
        // The server explicitly refused this request; keep any existing invocation for status recovery.
        if (active) recover(() => call("/v1/aug/invocations/control", { protocolVersion: "aug/0.2", action: "status", invocationId: active.id }), "Check status", safeError(error));
        else { setBusy(false); pendingRequest = undefined; message(safeError(error), true); }
      } else {
        const next = active ? () => call("/v1/aug/invocations/control", { protocolVersion: "aug/0.2", action: "status", invocationId: active.id }) : action;
        recover(next, active ? "Check status" : "Retry request", "The execution outcome could not be verified. Recover its state before starting another request.");
      }
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled || !operation || disposed) return;
    let input;
    try { input = readInput(); } catch { message("Check the input fields. Nested values must use valid JSON.", true); return; }
    try {
      pendingRequest = { protocolVersion: "aug/0.2", requestId: newRequestId(), operationId: operation.id,
        operationVersion: operation.version, input, runtime: runtimeCapabilities() };
    } catch { message("A secure request identifier could not be created.", true); return; }
    active = undefined; recovery = undefined; retry.hidden = true;
    result.hidden = true;
    perform(() => call("/v1/aug/invocations", pendingRequest));
  });
  retry.addEventListener("click", () => { if (!retry.disabled && recovery) perform(recovery); });
  inputMode.addEventListener("click", () => {
    if (fields.disabled || disposed) return;
    let seed;
    try { seed = readInput(); } catch { message("Complete or clear invalid inputs before changing input mode.", true); return; }
    rawMode = !rawMode;
    readInput = buildForm(operation.inputSchema, rawMode, seed);
    inputMode.textContent = rawMode ? "Use input fields" : "Edit inputs as JSON";
  });
  picker.addEventListener("change", choose);

  const ready = (async () => {
    setBusy(true);
    try {
      const catalog = await call("/v1/aug/operations", {});
      if (catalog?.protocolVersion !== "aug/0.2" || !Array.isArray(catalog.operations)) throw new Error("Invalid catalog");
      operations = catalog.operations.filter((entry) => entry?.protocolVersion === "aug/0.2" && typeof entry.id === "string" &&
        typeof entry.version === "string" && typeof entry.title === "string" && typeof entry.description === "string" &&
        isObject(entry.inputSchema) && entry.inputSchema.type === "object" && ["none", "explicit"].includes(entry.confirmation) &&
        ["read", "write", "destructive", "external_side_effect"].includes(entry.effect) && (entry.effect === "read" || entry.confirmation === "explicit") &&
        (!operationId || entry.id === operationId));
      picker.replaceChildren();
      for (const entry of operations) {
        const option = element("option", entry.title); option.value = entry.id; picker.append(option);
      }
      if (!operations.length) { title.textContent = "No operations available"; message("No authorized operation is available for this view."); return true; }
      picker.value = operations[0].id;
      choose();
      return true;
    } catch (error) { if (!disposed) message(safeError(error), true); return false; }
  })();

  return { ready, dispose() {
    disposed = true; controller.abort();
    for (const timer of timers) { clearTimeout(timer.id); timer.resolve(); }
    timers.clear(); root.replaceChildren();
  } };
}
