// Fixed renderer for validated AUG UI Plans (aug.ui/0.1), shared by the standalone page
// and host adapters. It only creates elements and sets textContent: no HTML parsing,
// no model-generated code. Unknown component types are ignored.
export function renderPlan(root, plan, { onAction, document: doc = globalThis.document }) {
  const element = (tag, text) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const inputs = [];
  const buttons = [];
  let table;
  let tableHead;
  let tableColumns = [];
  let status;

  const section = element("section");
  section.setAttribute("aria-label", plan.title);
  const controls = element("div");
  controls.className = "aug-controls";
  let tableWrap;

  for (const component of plan.components) {
    if (component.type === "heading") {
      section.append(element("h2", component.text));
    } else if (component.type === "text-input") {
      const label = element("label", component.label);
      const input = doc.createElement("input");
      input.type = "text";
      input.maxLength = 200;
      label.append(input);
      controls.append(label);
      inputs.push({ input, key: component.bind.split(".")[1] });
    } else if (component.type === "button") {
      const button = element("button", component.label);
      button.type = "button";
      button.addEventListener("click", () => onAction(component.actionRef));
      controls.append(button);
      buttons.push(button);
    } else if (component.type === "data-table") {
      tableColumns = component.columns;
      tableWrap = element("div");
      tableWrap.className = "aug-table-wrap";
      table = doc.createElement("table");
      const head = doc.createElement("thead");
      tableHead = head;
      const headerRow = doc.createElement("tr");
      for (const column of component.columns) {
        const th = element("th", column.label);
        th.scope = "col";
        headerRow.append(th);
      }
      head.append(headerRow);
      table.append(head, doc.createElement("tbody"));
      tableWrap.append(table);
    } else if (component.type === "status-message") {
      status = element("p", component.text);
      status.setAttribute("role", "status");
    }
  }
  section.append(controls);
  if (tableWrap) section.append(tableWrap);
  if (status) section.append(status);
  root.replaceChildren(section);

  return {
    readState() {
      const filters = {};
      for (const { input, key } of inputs) filters[key] = input.value;
      return { filters };
    },
    showRows(rows) {
      if (!table) return;
      const body = doc.createElement("tbody");
      for (const row of rows) {
        const tr = doc.createElement("tr");
        for (const column of tableColumns) {
          const value = row[column.key];
          tr.append(element("td", value === undefined || value === null ? "" : value));
        }
        body.append(tr);
      }
      table.replaceChildren(tableHead, body);
    },
    setStatus(message) {
      if (status) status.textContent = String(message);
    },
    setBusy(busy) {
      for (const button of buttons) button.disabled = busy;
    },
  };
}
