/**
 * Client-bundle smoke test: executes the committed lib/client.js inside a
 * simulated Web-shell ModuleLoader (a `window.__ModuleLoader__.load` stub with
 * a frozen-table `require`), then activates the plugin's `apply()` against a
 * mock client context. Catches load-time and apply-time crashes — the failure
 * mode that previously took down the whole web app (an undefined helper in
 * `apply` threw ReferenceError during client activation).
 *
 * Run with: npm run smoke:client
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const bundlePath = new URL('../lib/client.js', import.meta.url);
const code = readFileSync(bundlePath, 'utf8');

// ---- minimal browser globals the bundle touches at apply time ----
const styleElement = { dataset: {}, textContent: '', remove() {} };
globalThis.document = {
  querySelector: () => null,
  createElement: () => styleElement,
  head: { append() {} },
};

// ---- the Web-shell ModuleLoader handshake ----
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const module = { exports: {} };
      const require = (name) => {
        if (name === 'react') return {};
        throw new Error(`unresolved require in client bundle: ${name}`);
      };
      loaded = { id, result: factory(require) };
    },
  },
};

// Execute the bundle (top-level runs window.__ModuleLoader__.load).
new Function('window', code)(globalThis.window);
assert.ok(loaded !== null, 'bundle called window.__ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-btw');
assert.deepEqual(Object.keys(loaded.result).sort(), ['apply', 'inject', 'name']);
assert.equal(loaded.result.name, 'dsh-btw');

// ---- activate apply() against a mock client context ----
const disposers = [];
const slots = {
  inject: (_key, cb) => { cb(); return () => {}; },
  register: (_opts, _component) => ({}),
};
const ctx = {
  get: (n) => (n === 'slots' ? slots : undefined),
  effect: (cb) => { const r = cb(); if (typeof r === 'function') disposers.push(r); return () => {}; },
  remote: { $mount: async () => () => {} },
  inject: (deps, cb) => {
    assert.deepEqual(deps, ['remote.btwPanel']);
    cb({
      remote: {
        btwPanel: {
          status: async () => ({ ok: true, value: null }),
          followup: async () => ({ ok: true, value: { ok: true } }),
          cancel: async () => ({ ok: true, value: { ok: true } }),
        },
      },
    });
    return () => {};
  },
  interval: () => () => {},
};

try {
  loaded.result.apply(ctx);
} catch (error) {
  console.error('client apply() crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
}
for (const disposer of disposers) {
  try { disposer(); } catch (error) { console.error('client disposer crashed:', error); process.exit(1); }
}

process.stdout.write('client bundle smoke: load + apply + teardown ok\n');
