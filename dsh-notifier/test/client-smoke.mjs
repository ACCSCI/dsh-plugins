// Smoke test: load the Client bundle outside the browser and exercise the
// notification centre paths that would otherwise crash a slot entry.
import { readFileSync } from 'node:fs'

const source = readFileSync('D:/Projects/dsh-plugins/dsh-notifier/client.js', 'utf8')

const storage = new Map()
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}

const now = Date.now()
storage.set(
  'dsh-notifier.log',
  JSON.stringify([
    {
      key: 's1:complete:1', kind: 'complete', cwd: '/mnt/d/Projects/dsh-plugins',
      workspaceTitle: 'dsh-plugins', sessionTitle: '通知插件原型', summary: '做好了通知中心,支持分组', message: '',
      at: now - 90000, sessionId: 'session-1', read: false,
    },
    {
      key: 's2:error:2', kind: 'error', cwd: '/mnt/d/Projects/other-repo',
      workspaceTitle: 'other-repo', sessionTitle: '修复构建', summary: '', message: 'boom',
      at: now - 600000, sessionId: 'session-2', read: false,
    },
  ]),
)

let spec
globalThis.window = {
  __ModuleLoader__: { load: (value) => { spec = value } },
  localStorage,
  sessionStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { origin: 'dsh-app://app' },
}
globalThis.localStorage = localStorage
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }
globalThis.fetch = async () => { throw new Error('no network in smoke test') }
globalThis.Element = class {}

const elements = []
const effects = []
const noop = () => {}
const ReactShim = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    const element = { type, props: props || {}, children }
    elements.push(element)
    return element
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, noop]
  },
  useEffect(fn) {
    effects.push(fn)
  },
  useRef(initial) {
    return { current: initial ?? null }
  },
}

new Function('window', source)(globalThis.window)
if (!spec || spec.id !== '@accsci/dsh-notifier') throw new Error(`bad module id: ${spec && spec.id}`)

const registered = []
const opened = []
const fakeLocale = { getLocale: () => ({ active: 'zh' }), register: () => () => {}, bind: () => (key) => `zh:${key}` }
const ctx = {
  get: (key) =>
    key === 'locale' ? fakeLocale : key === 'uiWorkspace' ? { openSession: (id) => opened.push(id) } : undefined,
  effect: (fn) => {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  slots: {
    inject: (key, callback) => {
      console.log('inject ->', key)
      callback()
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
}

const module_ = spec.factory((name) => {
  if (name === 'react') return ReactShim
  throw new Error(`unexpected import ${name}`)
})

module_.apply(ctx)
if (registered.length !== 2) throw new Error(`expected two registrations, got ${registered.length}`)
const overlayEntry = registered.find((entry) => entry.options.name === 'shell.overlay')
const bellEntry = registered.find((entry) => entry.options.name === 'conversation.session.header.utilities')
if (!overlayEntry) throw new Error('overlay slot registration missing')
if (!bellEntry) throw new Error('header bell registration missing')

function renderEntry(entry, label, slotProps) {
  elements.length = 0
  effects.length = 0
  const wrapper = entry.component(slotProps || {})
  if (!wrapper || typeof wrapper.type !== 'function') throw new Error(`${label}: not a component`)
  const tree = wrapper.type(wrapper.props)
  console.log(`${label}: nodes = ${elements.length}`)
  return { label, tree, elements: [...elements], effects: [...effects] }
}

function find(snapshot, predicate) {
  return snapshot.elements.find(predicate)
}

const expandedRows = new Set()
function expand(buffer, depth = 0) {
  if (depth > 4) return
  const pending = buffer.filter(
    (element) =>
      typeof element.type === 'function' && element.props && 'item' in element.props && !expandedRows.has(element),
  )
  if (!pending.length) return
  for (const element of pending) {
    expandedRows.add(element)
    element.type(element.props)
  }
  expand(buffer, depth + 1)
}

// --- bell ------------------------------------------------------------------

const bell = renderEntry(bellEntry, 'bell (2 unread)')
const bellButton = find(bell, (element) => element.props && element.props['data-dsh-notifier-bell'] !== undefined)
if (!bellButton) throw new Error('bell button missing')
const badge = find(
  bell,
  (element) => element.props && element.props.style && element.props.style.position === 'absolute',
)
if (!badge || badge.children[0] !== '2') throw new Error(`unread badge should read 2, got ${badge && badge.children[0]}`)

// --- overlay: panel closed --------------------------------------------------

const closed = renderEntry(overlayEntry, 'overlay (panel closed)')
if (closed.tree.type !== 'Fragment') throw new Error('overlay must render a fragment')
const panelElement = closed.elements.filter((element) => typeof element.type === 'function').pop()
if (typeof panelElement.type !== 'function') throw new Error('panel component not mounted in the overlay')
if (panelElement.type(panelElement.props) !== null) throw new Error('panel must render nothing while closed')

// --- open the panel ---------------------------------------------------------

bellButton.props.onClick()
elements.length = 0
const panelTree = panelElement.type(panelElement.props)
if (!panelTree) throw new Error('panel did not render after opening')
if (panelTree.props.role !== 'dialog') throw new Error('panel is not a dialog')
expand(elements)

const panelText = JSON.stringify(elements)
for (const needle of [
  '通知插件原型',
  '修复构建',
  'dsh-plugins',
  'other-repo',
  'boom',
  '做好了通知中心',
  'zh:clearAll',
  'zh:markAllRead',
]) {
  if (!panelText.includes(needle)) throw new Error(`panel missing text: ${needle}`)
}

const groupHeaders = elements.filter(
  (element) => element.props && String(element.props.className || '').includes('dsh-notifier-group'),
)
if (groupHeaders.length !== 2) throw new Error(`expected two workspace groups, got ${groupHeaders.length}`)

const switchButton = elements.find((element) => element.props && element.props.role === 'switch')
if (!switchButton) throw new Error('quiet-hours switch missing')
if (switchButton.props['aria-checked'] !== 'false') throw new Error('quiet hours should start off')
if (elements.some((element) => element.type === 'input' && element.props.type === 'time')) {
  throw new Error('time inputs must stay hidden while quiet hours are off')
}
switchButton.props.onClick()
elements.length = 0
panelElement.type(panelElement.props)
expand(elements)
const timeInputs = elements.filter((element) => element.type === 'input' && element.props.type === 'time')
if (timeInputs.length !== 2) throw new Error(`expected two time inputs after enabling, got ${timeInputs.length}`)

// --- mark one read ----------------------------------------------------------

let readButtons = elements.filter(
  (element) => element.props && String(element.props.className || '').includes('dsh-notifier-readbtn'),
)
if (readButtons.length !== 2) throw new Error(`expected two per-item read buttons, got ${readButtons.length}`)
readButtons[0].props.onClick({ stopPropagation: noop })
elements.length = 0
panelElement.type(panelElement.props)
expand(elements)
readButtons = elements.filter(
  (element) => element.props && String(element.props.className || '').includes('dsh-notifier-readbtn'),
)
if (readButtons.length !== 1) throw new Error(`expected one read button left, got ${readButtons.length}`)

const bellAfterOne = renderEntry(bellEntry, 'bell (1 unread)')
const oneBadge = find(
  bellAfterOne,
  (element) => element.props && element.props.style && element.props.style.position === 'absolute',
)
if (!oneBadge || oneBadge.children[0] !== '1') throw new Error('badge should drop to 1')

// --- visiting a Session marks it read ---------------------------------------

const visit = renderEntry(bellEntry, 'bell (visit session-2)', { sessionId: 'session-2' })
const visitEffect = visit.effects[visit.effects.length - 1]
if (typeof visitEffect !== 'function') throw new Error('auto-read effect missing')
visitEffect()

const bellAfterVisit = renderEntry(bellEntry, 'bell (all read after visit)')
if (find(bellAfterVisit, (element) => element.props && element.props.style && element.props.style.position === 'absolute')) {
  throw new Error('visiting a Session must mark its notifications read')
}

// --- click a row: jump to the Session and close -----------------------------

elements.length = 0
panelElement.type(panelElement.props)
expand(elements)
const rows = elements.filter((element) => element.props && element.props.role === 'button' && element.props.tabIndex === 0)
if (rows.length !== 2) throw new Error(`expected two notification rows, got ${rows.length}`)
rows[0].props.onClick()
if (opened.length !== 1 || opened[0] !== 'session-1') {
  throw new Error(`row click should open its Session, got ${JSON.stringify(opened)}`)
}
if (panelElement.type(panelElement.props) !== null) throw new Error('panel should close after opening a Session')

// --- clear all --------------------------------------------------------------

bellButton.props.onClick()
elements.length = 0
if (!panelElement.type(panelElement.props)) throw new Error('panel should reopen')
const clearButton = elements.find(
  (element) => element.type === 'button' && JSON.stringify(element.children) === '["zh:clearAll"]',
)
if (!clearButton) throw new Error('clear-all button missing')
clearButton.props.onClick()
elements.length = 0
const emptyPanel = panelElement.type(panelElement.props)
if (!JSON.stringify(emptyPanel).includes('zh:empty')) throw new Error('empty state missing after clearing')

// --- toasts -----------------------------------------------------------------

const toastSnapshot = renderEntry(overlayEntry, 'overlay (toasts)')
if (!find(toastSnapshot, (element) => element.props && element.props.role === 'status')) {
  throw new Error('toast stack missing')
}
if (opened.length !== 1) throw new Error('only the row click may navigate')

console.log('ALL CLIENT SMOKE CHECKS PASSED')
