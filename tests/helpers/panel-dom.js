// Seule la frontière DOM est simulée : le rendu et les gestionnaires du panneau
// s'exécutent réellement.
import assert from 'node:assert/strict';

export const tick = () => new Promise((resolve) => setImmediate(resolve));
export const settle = async (tours = 10) => { for (let i = 0; i < tours; i += 1) await tick(); };

export function documentTest() {
  const document = {
    createElement(tagName) {
      let text = '';
      const handlers = new Map();
      const attributes = new Map();
      const node = {
        tagName, ownerDocument: document, children: [], style: {},
        disabled: false, checked: false, hidden: false, className: '', value: '',
        set innerHTML(_) { assert.fail('innerHTML est interdit dans le panneau'); },
        set outerHTML(_) { assert.fail('outerHTML est interdit dans le panneau'); },
        insertAdjacentHTML() { assert.fail('insertAdjacentHTML est interdit dans le panneau'); },
        get textContent() { return text + this.children.map((child) => child.textContent).join(''); },
        set textContent(next) { text = String(next); this.children = []; },
        append(...nodes) {
          for (const child of nodes) {
            if (typeof child === 'string') this.children.push({ tagName: '#text', textContent: child, children: [] });
            else this.children.push(child);
          }
        },
        replaceChildren(...nodes) { this.children = []; text = ''; this.append(...nodes); },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        addEventListener(name, fn) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
        // Appelle les gestionnaires même désactivé : les gardes doivent tenir seules.
        async fire(name) {
          await Promise.all((handlers.get(name) ?? []).map((fn) => fn({ preventDefault() {} })));
        },
        querySelector(selector) {
          return all(this).slice(1).find((child) => `#${child.id}` === selector) ?? null;
        },
      };
      return node;
    },
    createElementNS(_namespace, tagName) { return document.createElement(tagName); },
  };
  return document;
}

export const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
export const byTag = (node, tag) => all(node).filter((child) => child.tagName === tag);
export const buttons = (node) => byTag(node, 'button');
export const buttonNamed = (node, label) => buttons(node).find((child) => child.textContent === label);
export const links = (node) => byTag(node, 'a');
// Visible : ni l'élément ni un de ses ancêtres n'est masqué.
export function visible(root, node) {
  const path = (current) => {
    if (current === node) return [current];
    for (const child of current.children ?? []) {
      const found = path(child);
      if (found) return [current, ...found];
    }
    return null;
  };
  const chain = path(root);
  return Boolean(chain) && chain.every((current) => !current.hidden);
}
