/**
 * Navigation error interstitial.
 *
 * The HTTPS-only case is the important one: it must explain what happened
 * and make continuing over plaintext a deliberate choice, not a reflex.
 */
const api = window.aether;
const params = new URLSearchParams(location.search);
const kind = params.get('kind') || 'network';
const url = params.get('url') || '';
const code = params.get('code') || '';
const description = params.get('description') || '';

const root = document.getElementById('root');

const COPY = {
  'https-only': {
    title: 'This site does not support a secure connection',
    body: 'Aether upgrades every page to HTTPS. This site answered only over plain HTTP, '
      + 'which means anyone on the network can read and modify what you send and receive.',
    danger: true,
    actions: [
      ['Go back', () => api.invoke('tabs.goBack', {}), 'btn btn-primary'],
      ['Continue insecurely, once', () => proceed(false), 'btn'],
      ['Always allow this site', () => proceed(true), 'btn'],
    ],
  },
  dns: {
    title: 'This site can’t be reached',
    body: 'The address could not be resolved. Check the spelling, or whether you are '
      + 'connected to the network.',
    actions: [['Try again', () => api.invoke('tabs.reload', {}), 'btn btn-primary']],
  },
  network: {
    title: 'This page did not load',
    body: 'The connection failed before the page could be delivered.',
    actions: [
      ['Try again', () => api.invoke('tabs.reload', {}), 'btn btn-primary'],
      ['Go back', () => api.invoke('tabs.goBack', {}), 'btn'],
    ],
  },
};

const copy = COPY[kind] || COPY.network;

const mark = el('div', `err-mark${copy.danger ? ' is-danger' : ''}`);
mark.appendChild(svg('M12 3l9 16H3zM12 9v5M12 17h.01'));

root.append(mark, el('h1', '', copy.title), el('p', '', copy.body));
if (url) root.appendChild(el('div', 'url', url));

const actions = el('div', 'err-actions');
for (const [label, handler, className] of copy.actions) {
  const button = el('button', className, label);
  button.addEventListener('click', handler);
  actions.appendChild(button);
}
root.appendChild(actions);

if (code) {
  root.appendChild(el('p', '', ''));
  root.appendChild(el('code', '', `${description || 'Error'} (${code})`));
}

function proceed(remember) {
  const target = url.replace(/^https:/, 'http:');
  api.invoke('privacy.allowInsecure', { url, remember })
    .catch(() => {})
    .finally(() => api.invoke('tabs.navigate', { url: target }));
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svg(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const node = document.createElementNS(ns, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.7');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  for (const segment of d.split('M').filter(Boolean)) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M' + segment);
    node.appendChild(path);
  }
  return node;
}
