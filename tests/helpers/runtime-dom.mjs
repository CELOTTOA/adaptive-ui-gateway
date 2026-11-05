export class RuntimeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {};
    this.textContent = ""; this.value = ""; this.disabled = false; this.hidden = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  set innerHTML(_value) { throw new Error("HTML parsing is prohibited"); }
  insertAdjacentHTML() { throw new Error("HTML parsing is prohibited"); }
}
export const runtimeDocument = { createElement: (tag) => new RuntimeElement(tag) };
export function nodes(root, predicate) {
  return [ ...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => nodes(child, predicate)) ];
}
export const byTag = (root, tag) => nodes(root, (node) => node.tagName === tag.toUpperCase());
export const button = (root, label) => byTag(root, "button").find((node) => node.textContent === label);
export const text = (root) => [root.textContent, ...root.children.map(text)].join(" ");
