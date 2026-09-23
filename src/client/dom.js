/**
 * @file A minimal DOM builder.
 *
 * The command center re-renders panels from server state many times a second,
 * so this deliberately stays tiny: create elements, set text as text (never as
 * HTML, which is what keeps a camera name or a plate string out of the markup
 * as code), and attach events. No virtual DOM, no framework, no build-time
 * dependency.
 *
 * @module client/dom
 */

/**
 * Create an element.
 *
 * `text` is always assigned through `textContent`, so a value from the server
 * cannot become markup.
 * @param {string} tag
 * @param {object} [props]
 * @param {Array<Node|string|null|undefined|false>} [children]
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'html') element.innerHTML = String(value); // only for literals in this repo
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'disabled' || key === 'checked' || key === 'selected') {
      element[key] = Boolean(value);
    } else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

/**
 * Append children, flattening arrays and skipping empty values.
 * @param {HTMLElement} parent
 * @param {Array<Node|string|null|undefined|false>} children
 */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === '') continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * Empty a node.
 * @param {HTMLElement} node
 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * A labelled key/value row, the workhorse of the inspector panels.
 * @param {string} label @param {Node|string} value @param {string} [tone]
 * @returns {HTMLElement}
 */
export function row(label, value, tone = '') {
  return h('div', { class: `kv ${tone}` }, [
    h('span', { class: 'kv-label', text: label }),
    value instanceof Node ? value : h('span', { class: 'kv-value', text: value }),
  ]);
}

/**
 * A provenance badge. Every value that came from the engine carries one.
 * @param {object} token - From `modeToken()`.
 * @returns {HTMLElement}
 */
export function badge(token) {
  return h('span', {
    class: 'badge',
    style: { borderColor: token.color, color: token.color },
    title: token.source || token.label,
  }, [
    h('span', { class: 'badge-dot', style: { background: token.color } }),
    token.label,
  ]);
}

/**
 * A status chip carrying a glyph and a word, so meaning never rests on colour.
 * @param {{label:string,glyph:string,color:string}} token
 * @returns {HTMLElement}
 */
export function chip(token) {
  return h('span', {
    class: 'chip',
    style: { borderColor: token.color, color: token.color },
  }, [h('span', { class: 'chip-glyph', text: token.glyph }), token.label]);
}

/**
 * A panel section with a heading.
 * @param {string} title @param {Array<Node|string>} children @param {Node} [aside]
 * @returns {HTMLElement}
 */
export function section(title, children, aside = null) {
  return h('section', { class: 'panel-section' }, [
    h('header', { class: 'panel-heading' }, [
      h('h3', { text: title }),
      aside,
    ]),
    h('div', { class: 'panel-body' }, children),
  ]);
}

/**
 * Render an empty/error state that says which one it is.
 * @param {string} message @param {string} [tone]
 * @returns {HTMLElement}
 */
export function empty(message, tone = '') {
  return h('p', { class: `empty ${tone}`, text: message });
}

/**
 * Format a value or an explicit dash. Used wherever a missing reading must look
 * different from a zero reading.
 * @param {unknown} value @param {string} [suffix]
 * @returns {string}
 */
export function value(value, suffix = '') {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && !Number.isFinite(value)) return '—';
  return `${value}${suffix}`;
}
