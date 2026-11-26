/**
 * @accsci/dsh-auto-retry — client half smoke test.
 *
 * Runs the browser module in plain Node: a tiny React shim renders both
 * contributions, and a stubbed `fetch` drives the shared store. It proves the
 * module wrapper, the two slot registrations, and the rendered copy instead of
 * trusting that hand-written client code is syntactically fine.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.join(HERE, '..', 'lib', 'client.js')

// --- React shim ------------------------------------------------------------
function createElement(type, props, ...children) {
  const merged = { ...(props ?? {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}
const Fragment = Symbol('Fragment')
const React = {
  createElement,
  Fragment,
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useRef() { return { current: null } },
}

// --- host stubs ------------------------------------------------------------
const fetchCalls = []
const STATE = {
  ok: true,
  enabled: true,
  settings: { enabled: true, initialDelayMs: 2000, maxDelayMs: 60000, jitterRatio: 0.2, retryUnknown: false },
  active: { count: 0, nextInMs: null },
  last: null,
  stops: [],
}
globalThis.fetch = async (url, options = {}) => {
  const body = typeof options.body === 'string' ? options.body : undefined
  fetchCalls.push({ url, method: options.method ?? 'GET', body })
  if (body !== undefined) {
    const patch = JSON.parse(body)
    Object.assign(STATE, patch)
    Object.assign(STATE.settings, patch)
  }
  return { ok: true, status: 200, json: async () => ({ ...STATE }) }
}
const timers = []
globalThis.setInterval = (fn) => { timers.push(fn); return timers.length }
globalThis.clearInterval = () => {}

// --- module load -----------------------------------------------------------
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { loaded = definition },
  },
}
await import(pathToFileURL(MODULE).href)
assert.ok(loaded, 'the client module must register itself with the module loader')
assert.equal(loaded.id, '@accsci/dsh-auto-retry', 'the factory id must equal the package name')

const client = loaded.factory((specifier) => {
  assert.equal(specifier, 'react')
  return React
})
assert.deepEqual(client.inject, ['slots'])
assert.equal(typeof client.apply, 'function')

const registrations = []
const disposers = []
const ctx = {
  get() { return undefined },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  slots: {
    inject(name, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
client.apply(ctx)
assert.equal(registrations.length, 2)
const settingsRegistration = registrations.find(entry => entry.options.name === 'settings.section')
const pillRegistration = registrations.find(entry => entry.options.name === 'conversation.session.header.utilities')
assert.ok(settingsRegistration, 'the plugin must register a settings page')
assert.ok(pillRegistration, 'the plugin must register the Session-header switch')
assert.equal(settingsRegistration.options.id, 'auto-retry')
assert.equal(pillRegistration.options.id, 'auto-retry')
assert.equal(settingsRegistration.options.label(), 'Auto retry')
assert.equal(pillRegistration.options.label(), 'Auto retry')

/** Depth-first search for nodes of one type; function components are rendered inline. */
function find(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) find(child, predicate, found)
    return found
  }
  if (typeof node.type === 'function') {
    find(node.type(node.props ?? {}), predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  find(node.props?.children, predicate, found)
  return found
}

/** Concatenated text of a rendered tree, so copy can be asserted. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))
await tick()

// --- header switch ---------------------------------------------------------
let pill = pillRegistration.component({})
assert.equal(fetchCalls.at(-1).method === 'GET' || fetchCalls.some(call => call.method === 'GET'), true)
assert.match(textOf(pill), /Auto retry on/)
const button = find(pill, node => node.type === 'button')[0]
assert.ok(button, 'the switch must render a button')
assert.equal(button.props['aria-pressed'], true)
assert.match(button.props.className, /dar_pill/)

await button.props.onClick()
await tick()
const post = fetchCalls.find(call => call.method === 'POST')
assert.ok(post, 'clicking the switch must POST the new state')
assert.deepEqual(JSON.parse(post.body), { enabled: false })
assert.equal(post.url, '/auto-retry/api/state')

// Re-render reads the store again, so the pill reflects the saved value.
pill = pillRegistration.component({})
assert.match(textOf(pill), /Auto retry off/)
assert.equal(find(pill, node => node.type === 'button')[0].props['aria-pressed'], false)

// --- settings page ---------------------------------------------------------
const page = settingsRegistration.component({})
const text = textOf(page)
assert.match(text, /Auto retry/)
assert.match(text, /Enable auto retry/)
assert.match(text, /First wait/)
assert.match(text, /Longest wait/)
assert.match(text, /TIMEOUT/)
assert.match(text, /QUOTA/)
const switches = find(page, node => node.type === 'input' && node.props.type === 'checkbox')
assert.equal(switches.length, 2)
assert.equal(switches[0].props.checked, false, 'the enable switch follows the stored value')
const numbers = find(page, node => node.type === 'input' && node.props.type === 'number')
assert.equal(numbers.length, 2)
assert.equal(numbers[0].props.defaultValue, '2')
assert.equal(numbers[1].props.defaultValue, '60')

// A number field commits milliseconds to the Host on blur.
const event = { currentTarget: { value: '5', blur() {} } }
numbers[0].props.onBlur(event)
await tick()
const numberPost = fetchCalls.filter(call => call.method === 'POST').at(-1)
assert.deepEqual(JSON.parse(numberPost.body), { initialDelayMs: 5000 })

// Rejecting garbage restores the visible value instead of saving NaN.
const badEvent = { currentTarget: { value: '', blur() {} } }
numbers[0].props.onBlur(badEvent)
assert.equal(badEvent.currentTarget.value, '2')

// --- disposal --------------------------------------------------------------
for (const dispose of disposers) dispose()
console.log('auto-retry client: ok')
