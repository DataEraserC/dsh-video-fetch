// The settings page used to render blank.
//
// Two of the login card's `useEffect` calls sat *below* the
// `if (state === null) return …` early return. React counts hooks per render:
// the loading paint called 17, the loaded one called 19, and React tore the
// whole tree down with "change in the order of Hooks" — which the host shows as
// an empty panel rather than an error.
//
// The plugin has no React of its own (the host injects it through the module
// loader's `require`), so instead of rendering for real we drive the component
// with a recording stub and assert the one invariant React was enforcing:
// **every render must call the same hooks, in the same order.** That is
// checkable without a renderer, needs no devDependency, and fails the moment a
// hook drifts below a conditional return.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

/**
 * Load `lib/client.js` the way the host does, run its `apply`, and hand back a
 * handle for driving it.
 *
 * The component reads `React` once (`var React = require('react')`), so the
 * stub is a single mutable object whose per-render configuration is swapped
 * between renders rather than replaced.
 *
 * @returns {object} the captured registrations and a `setRender` hook.
 */
function loadClient() {
  const code = readFileSync(CLIENT, 'utf8')
  let captured = null

  const sandbox = { console, setInterval, clearInterval, confirm: () => true }
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.location = { protocol: 'https:' }
  sandbox.__ModuleLoader__ = { load: (module_) => { captured = module_ } }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: CLIENT })

  assert.ok(captured, 'client.js must register itself with the module loader')

  // ── the React stand-in ───────────────────────────────────────────────────
  const render_ = { values: {}, log: [] }
  const react = {
    useState(initial) {
      render_.log.push('useState')
      // Index among the useState calls only, so `values` is keyed by the
      // order of the state hooks rather than by raw position in the log.
      const slot = render_.log.filter((name) => name === 'useState').length - 1
      return [slot in render_.values ? render_.values[slot] : initial, () => {}]
    },
    useRef(initial) {
      render_.log.push('useRef')
      return { current: initial }
    },
    useCallback(fn) {
      render_.log.push('useCallback')
      return fn
    },
    useEffect() {
      render_.log.push('useEffect')
    },
    createElement(type, props, ...children) {
      // Real React hangs children off `props.children` as well, and the page's
      // `Card` renders its body by reading exactly that. Keeping them only in
      // `children` would make every card render empty and the assertions below
      // would be checking a skeleton.
      return { type, props: { ...(props ?? {}), children }, children }
    },
  }

  const components = []
  const injected = []
  const slots = {
    inject: (name, fn) => {
      injected.push(name)
      fn()
    },
    register: (spec, Component) => {
      components.push({ name: spec.name, Component })
      return Component
    },
  }

  const exports_ = captured.factory(() => react)
  exports_.apply({ get: (key) => (key === 'slots' ? slots : undefined) })

  return {
    components,
    injected,
    /** @param {object} next - `{ values, log }` for the next render. */
    setRender: (next) => {
      render_.values = next.values ?? {}
      render_.log = next.log
    },
  }
}

/**
 * Invoke every component in a returned element tree.
 *
 * `PluginCard` only *returns* `createElement(SettingsPage, null)`; the hooks
 * live inside `SettingsPage`, which a real renderer would call. This walks the
 * tree and calls each function-typed element so the page's own body runs.
 * @param {unknown} node - an element, an array of them, or a scalar.
 * @param {number} [depth] - recursion guard.
 * @returns {unknown} the expanded tree.
 */
function expand(node, depth = 0) {
  if (Array.isArray(node)) return node.map((child) => expand(child, depth))
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (depth > 64) return node
  if (typeof node.type === 'function') return expand(node.type(node.props), depth + 1)
  node.children = (node.children ?? []).map((child) => expand(child, depth + 1))
  return node
}

/**
 * Every string an expanded element tree carries.
 *
 * Walks `props` as well as `children`: the picker labels the page renders are
 * `props.options`, and a check that only saw `children` would pass against a
 * picker whose options had quietly gone empty.
 * @param {unknown} node - element, array, plain object, or scalar.
 * @param {string[]} [out] - accumulator.
 * @returns {string[]} the strings found.
 */
function strings(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) strings(child, out)
    return out
  }
  if (typeof node === 'function') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (node === null || node === undefined || typeof node !== 'object') return out

  if (typeof node.type !== 'undefined' && 'type' in node) {
    const props = node.props ?? {}
    for (const key of Object.keys(props)) {
      if (key === 'children') continue
      strings(props[key], out)
    }
  } else {
    for (const value of Object.values(node)) strings(value, out)
  }
  for (const child of node.children ?? []) strings(child, out)
  return out
}

test('client: the settings page calls the same hooks loading and loaded', () => {
  const { components, injected, setRender } = loadClient()

  assert.deepEqual(
    injected,
    ['plugins.row.config', 'settings.plugins.tab'],
    'the page must mount on both the Plugins page and the Settings tab',
  )
  const card = components.find((entry) => entry.name === 'plugins.row.config')
  assert.ok(card, 'the plugins.row.config slot must be registered')

  // What /video-fetch/state hands back once it resolves.
  const loaded = {
    settings: { crf: 28, downloadEngine: 'ytdlp' },
    fields: [{ key: 'crf', type: 'integer', label: { zh: 'CRF', en: 'CRF' } }],
    channels: [
      {
        channel: {
          id: 'bilibili',
          name: '哔哩哔哩',
          methods: [{ id: 'qr', label: '扫码登录', implemented: true }],
        },
        accounts: [{ id: 'a1', label: '主号' }],
        active: 'a1',
      },
    ],
    native: { available: true, error: '' },
  }

  const loadingLog = []
  setRender({ values: {}, log: loadingLog })
  const loading = expand(card.Component({ view: 'page' }))

  const loadedLog = []
  setRender({ values: { 0: loaded }, log: loadedLog })
  const loadedTree = expand(card.Component({ view: 'page' }))

  assert.deepEqual(
    loadedLog,
    loadingLog,
    'the loaded render must call exactly the hooks the loading render did — ' +
    'a hook sitting below the `state === null` early return runs on one and not ' +
    'the other, which React rejects and the user sees as a blank page',
  )
  assert.ok(loadingLog.length > 0, 'the component must actually use hooks')
  assert.ok(loadedLog.includes('useEffect'), 'the coherence effects must still exist')

  // Guard against a vacuous pass: the second render really did take the loaded
  // path, and the two renders really are different.
  const loadingText = strings(loading).join('\n')
  const loadedText = strings(loadedTree).join('\n')
  assert.notEqual(loadedText, loadingText, 'the two renders must differ')
  assert.match(loadedText, /哔哩哔哩/, 'the loaded render must label its channel')
  assert.match(loadedText, /扫码登录/, 'the loaded render must offer the channel’s methods')
  assert.match(loadedText, /主号/, 'the loaded render must list the channel’s accounts')
})
