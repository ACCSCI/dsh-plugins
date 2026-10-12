/**
 * Offline smoke test for the workspace-todo client half.
 *
 * The browser shell seeds React, so this harness supplies a tiny React
 * substitute (function components + useState/useReducer/useRef/useEffect) and
 * expands the element tree the plugin returns. That executes the real render
 * paths — header button, floating panel, copy/status/add/reorder handlers — and
 * asserts the host calls they make, without a browser.
 *
 * Limits: no real DOM, no layout, no re-render scheduling (the harness
 * re-expands manually), and hooks are shared per component function, so
 * per-row state is not isolated. The live GUI click remains the real check.
 *
 * Run: node test/client-smoke.mjs
 */

import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

/* ------------------------------------------------------------------ */
/* a tiny React                                                       */
/* ------------------------------------------------------------------ */

const hookStore = new WeakMap()
let current = null
let slot = 0

const react = {
  createElement(type, props, ...children) {
    const flat = children.length <= 1 ? children[0] : children
    return { type, props: Object.assign({}, props, { children: flat }) }
  },
  useState(initial) {
    const store = hookStore.get(current)
    const index = slot++
    if (store.length <= index) store[index] = typeof initial === 'function' ? initial() : initial
    return [store[index], (value) => {
      store[index] = typeof value === 'function' ? value(store[index]) : value
    }]
  },
  useReducer(reducer, initial) {
    const store = hookStore.get(current)
    const index = slot++
    if (store.length <= index) store[index] = initial
    return [store[index], () => {}]
  },
  useRef(initial) {
    const store = hookStore.get(current)
    const index = slot++
    if (store.length <= index) store[index] = { current: initial }
    return store[index]
  },
  /** Effects run on every render: dep tracking is not modeled. */
  useEffect(effect) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  },
}
const cleanups = []

/* ------------------------------------------------------------------ */
/* module host                                                        */
/* ------------------------------------------------------------------ */

const requests = []
let statePayload = { ok: true, dir: null, file: null, version: null, exists: false, todos: [] }

const documentStub = {
  visibilityState: 'visible',
  listeners: new Map(),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {}, textContent: '', setAttribute() {}, appendChild() {}, remove() {}, select() {} }),
  addEventListener(type, handler) {
    this.listeners.set(type, handler)
  },
  removeEventListener(type) {
    this.listeners.delete(type)
  },
}

const windowStub = {
  innerWidth: 1440,
  innerHeight: 900,
  listeners: new Map(),
  localStorage: {
    values: new Map(),
    getItem(key) {
      return this.values.has(key) ? this.values.get(key) : null
    },
    setItem(key, value) {
      this.values.set(key, value)
    },
  },
  addEventListener(type, handler) {
    this.listeners.set(type, handler)
  },
  removeEventListener(type) {
    this.listeners.delete(type)
  },
}

let captured = null
windowStub.__ModuleLoader__ = { load(definition) { captured = definition } }

const clipboardStub = { writeText: async () => {} }

/** Save requests can be parked so the harness can edit while one is in flight. */
let holdSaves = false
const heldSaves = []
function releaseSaves() {
  for (const resolve of heldSaves.splice(0)) resolve()
}

/** Extra fields the next save response should carry (e.g. the host's backup report). */
let saveExtra = null

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

define('window', windowStub)
define('document', documentStub)
define('navigator', { clipboard: clipboardStub })
define('fetch', async (url, init) => {
  const target = String(url)
  requests.push({ url: target, init: init ?? {} })
  if (holdSaves && target.includes('/workspace-todo/api/save')) {
    await new Promise((resolve) => heldSaves.push(resolve))
  }
  const body = target.includes('/workspace-todo/api/save') && saveExtra !== null
    ? Object.assign({}, statePayload, saveExtra)
    : statePayload
  return {
    status: 200,
    async text() {
      return JSON.stringify(body)
    },
  }
})

/* ------------------------------------------------------------------ */
/* the shell's UI kit, stubbed                                        */
/* ------------------------------------------------------------------ */

const ICON_NAMES = [
  'IconChecklistOutline14', 'IconQueueOutline14', 'IconLoadingOutline16', 'IconCheckOutline16',
  'IconWarningOutline16', 'IconClockOutline16', 'IconChevronDownOutline14', 'IconAlarmClockOutline16',
  'IconListPenOutline16', 'IconTrashOutline16', 'IconRefreshOutline16', 'IconCloseOutline16',
  'IconPlusOutline16',
]

const uiStub = {}
for (const name of ICON_NAMES) {
  uiStub[name] = (props) => react.createElement('svg', {
    'data-icon': name,
    className: props ? props.className : undefined,
    style: props ? props.style : undefined,
    width: props ? props.size : undefined,
    height: props ? props.size : undefined,
  })
}

/**
 * Mirrors the contract the shipped plugins use: `anchor` plus `items`, `selectedId`,
 * `open`, `onClose`, and `onSelect`, with each item's `icon` rendered as given.
 */
uiStub.Menu = (props) => react.createElement(
  'div',
  { 'data-menu-state': props.open === true ? 'open' : 'closed' },
  props.anchor,
  props.open === true
    ? react.createElement(
      'div',
      { className: 'stub-menu' },
      (props.items ?? []).map((item) => react.createElement(
        'button',
        { key: item.id, type: 'button', 'data-menu-item': item.id, onClick: () => props.onSelect(item.id) },
        item.icon,
        item.label,
      )),
    )
    : null,
)

/* ------------------------------------------------------------------ */
/* load the bundle                                                    */
/* ------------------------------------------------------------------ */

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInThisContext(source, { filename: 'lib/client.js' })

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  → ${detail}`}`)
}

const bundle = captured.factory((specifier) => {
  if (specifier === 'react') return react
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return uiStub
  throw new Error(`harness: unexpected require(${specifier})`)
})
check('bundle registers the package id', captured.id === '@dsh-external/workspace-todo', captured.id)

const registrations = []
const ctx = {
  slots: {
    inject(key, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
bundle.apply(ctx)
check('apply registers two contributions', registrations.length === 2, String(registrations.length))
check('header button targets the session header utilities', registrations[0].options.name === 'conversation.session.header.utilities' && registrations[0].options.id === 'workspace-todo', JSON.stringify(registrations[0].options))
check('panel targets the frame overlay layer', registrations[1].options.name === 'shell.overlay' && registrations[1].options.id === 'workspace-todo-panel', JSON.stringify(registrations[1].options))
check('client inject list is [slots]', Array.isArray(bundle.inject) && bundle.inject.length === 1 && bundle.inject[0] === 'slots', JSON.stringify(bundle.inject))

/* ------------------------------------------------------------------ */
/* expand the returned element tree                                   */
/* ------------------------------------------------------------------ */

function expand(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) expand(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    const previous = current
    current = node.type
    slot = 0
    if (!hookStore.has(node.type)) hookStore.set(node.type, [])
    let rendered
    try {
      rendered = node.type(node.props)
    } finally {
      current = previous
    }
    expand(rendered, out)
    return out
  }
  out.push(node)
  expand(node.props ? node.props.children : null, out)
  return out
}

function renderButton() {
  return expand(react.createElement(registrations[0].component, { sessionId: 'S1', useSessions }))
}

function renderPanel() {
  return expand(react.createElement(registrations[1].component, {}))
}

function findByClass(nodes, className) {
  return nodes.find((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes(className))
}

function rowsOf(nodes) {
  return nodes.filter((node) => typeof node.props.className === 'string' && node.props.className.startsWith('wst-row'))
}

function textOf(nodes) {
  const collect = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (Array.isArray(node)) return node.map(collect).join('')
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    return collect(node.props ? node.props.children : null)
  }
  return nodes.map(collect).join(' ')
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const useSessions = (selector) => selector({ byId: { S1: { cwd: 'D:/work/example-project' } } })

/* ------------------------------------------------------------------ */
/* 1. empty state                                                     */
/* ------------------------------------------------------------------ */

const emptyTree = renderButton()
const emptyButton = findByClass(emptyTree, 'wst-btn')
check('header button renders as a real button', emptyButton !== undefined && emptyButton.type === 'button')
check('header button carries the trigger marker', emptyButton !== undefined && emptyButton.props['data-wst-trigger'] === '1')
check('header button is labelled', emptyButton !== undefined && emptyButton.props['aria-label'] === '待办清单')
check('no badge while the list is empty', findByClass(emptyTree, 'wst-badge') === undefined)
const stateCall = requests.find((entry) => entry.url.includes('/workspace-todo/api/state'))
check('mount reads the session working directory', stateCall !== undefined && stateCall.url.includes(encodeURIComponent('D:/work/example-project')), stateCall ? stateCall.url : 'no request')

/* ------------------------------------------------------------------ */
/* 2. open + reload a list that has content                           */
/* ------------------------------------------------------------------ */

statePayload = {
  ok: true,
  dir: 'D:/work/example-project',
  file: 'D:/work/example-project/.dsh/todos.json',
  version: 'v1',
  exists: true,
  todos: [
    { id: 't1', title: '写插件', status: 'doing', priority: 'high', due: '2000-01-01', notes: '备注', subtasks: [{ id: 's1', title: '子任务', done: false }] },
    { id: 't2', title: '已完成项', status: 'done', priority: null, due: null, notes: '', subtasks: [] },
  ],
}

const openedButton = findByClass(renderButton(), 'wst-btn')
openedButton.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 40, right: 1400 }) } })
await tick()
let panelTree = renderPanel()
const panel = findByClass(panelTree, 'wst-panel')
check('clicking the button renders the panel', panel !== undefined)
check('panel pins under the button', panel !== undefined && panel.props.style.top === 46 && panel.props.style.right === 40, panel ? JSON.stringify(panel.props.style) : 'absent')
check('panel shows the working directory', textOf(panelTree).includes('D:/work/example-project'), textOf([findByClass(panelTree, 'wst-path')]))
check('panel carries the dialog role', panel !== undefined && panel.props.role === 'dialog')

const reload = panelTree.find((node) => node.type === 'button' && node.props['aria-label'] === '从磁盘重新载入')
check('panel offers a reload control', reload !== undefined)
reload.props.onClick()
await tick()
panelTree = renderPanel()
check('reload fills the list', rowsOf(panelTree).length === 2, String(rowsOf(panelTree).length))
check('panel reports the file through the footer', textOf(panelTree).includes('已保存') || textOf(panelTree).includes('尚无'), textOf([findByClass(panelTree, 'wst-foot')]))
check('overdue date is flagged', textOf(panelTree).includes('逾期'))
check('subtask progress is shown', textOf(panelTree).includes('0/1'))
check('badge counts only the unfinished row', textOf([findByClass(renderButton(), 'wst-badge')]).trim() === '1', textOf([findByClass(renderButton(), 'wst-badge')]))

const chipOf = (nodes) => nodes.filter((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wst-chip'))
let chips = chipOf(panelTree)
check('three filter chips render', chips.length === 3, String(chips.length))
chips[2].props.onClick()
panelTree = renderPanel()
check('the done filter shows only the finished row', rowsOf(panelTree).length === 1 && textOf(panelTree).includes('已完成项'), `${String(rowsOf(panelTree).length)} ${textOf(panelTree).slice(0, 60)}`)
chipOf(panelTree)[0].props.onClick()
panelTree = renderPanel()
check('the all filter restores both rows', rowsOf(panelTree).length === 2, String(rowsOf(panelTree).length))

/* ------------------------------------------------------------------ */
/* 3. interactions                                                    */
/* ------------------------------------------------------------------ */

let clipboard = ''
clipboardStub.writeText = async (value) => {
  clipboard = value
}
panelTree.find((node) => typeof node.props.className === 'string' && node.props.className.includes('wst-name')).props.onClick()
await tick()
check('clicking a title copies its plain text', clipboard === '写插件', clipboard)

/** Drive one of the app-kit menus the way a user does: open the trigger, pick an item. */
const menuTrigger = (tree, label) => tree.find((node) => node.type === 'button' && node.props['aria-label'] === label)
const pickMenuItem = (tree, id) => {
  const item = tree.find((node) => node.type === 'button' && node.props['data-menu-item'] === id)
  if (item === undefined) throw new Error(`harness: menu item ${id} is not rendered`)
  item.props.onClick()
}

const statusPill = panelTree.find((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wst-status'))
check('the row status is a themed pill, not a native select', statusPill !== undefined && panelTree.every((node) => node.type !== 'select'))
check('the status pill carries the app status icon', panelTree.some((node) => node.props['data-icon'] === 'IconLoadingOutline16') && panelTree.some((node) => node.props['data-icon'] === 'IconCheckOutline16'))
check('the status pill is colored from the token palette', statusPill !== undefined && typeof statusPill.props.style.color === 'string' && statusPill.props.style.color.startsWith('var(--dsw-alias-'))

menuTrigger(panelTree, '状态').props.onClick()
panelTree = renderPanel()
const openStatusMenu = panelTree.find((node) => node.props['data-menu-state'] === 'open')
check('the status trigger opens the app menu', openStatusMenu !== undefined)
const statusItems = panelTree.filter((node) => typeof node.props['data-menu-item'] === 'string').map((node) => node.props['data-menu-item'])
check('the menu offers all five statuses', statusItems.length === 5 && statusItems.includes('blocked'), JSON.stringify(statusItems))
check('each status option carries its own icon', panelTree.filter((node) => typeof node.props['data-menu-item'] === 'string').every((node) => Array.isArray(node.props.children) && node.props.children[0] !== null))
pickMenuItem(panelTree, 'blocked')
panelTree = renderPanel()
check('choosing a status reaches the list', textOf(panelTree).includes('阻塞'))
const doingIconBefore = panelTree.filter((node) => node.props.className === 'wst-spin').length

menuTrigger(panelTree, '状态').props.onClick()
pickMenuItem(renderPanel(), 'doing')
panelTree = renderPanel()
const spinning = panelTree.filter((node) => node.props.className === 'wst-spin')
check('进行中 renders a spinning icon', spinning.length === 1, `${String(doingIconBefore)} -> ${String(spinning.length)}`)
check('the doing icon is the app loading glyph', spinning[0] !== undefined && spinning[0].props['data-icon'] === 'IconLoadingOutline16', spinning[0] ? String(spinning[0].props['data-icon']) : 'none')

menuTrigger(panelTree, '优先级').props.onClick()
panelTree = renderPanel()
check('the priority trigger opens the app menu too', panelTree.filter((node) => node.props['data-menu-item'] !== undefined).length >= 4)
pickMenuItem(panelTree, 'high')
panelTree = renderPanel()
const priorityPill = panelTree.find((node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes('wst-prio'))
check('priority shows a colored dot and label', priorityPill !== undefined && typeof priorityPill.props.style.color === 'string' && textOf([priorityPill]).includes('高'), textOf([priorityPill]))

const dueInput = panelTree.find((node) => node.type === 'input' && node.props['aria-label'] === '截止日期')
dueInput.props.onChange({ target: { value: '2030-05-06' } })
panelTree = renderPanel()
check('the due date is kept', panelTree.some((node) => node.props['aria-label'] === '截止日期' && node.props.value === '2030-05-06'))

const detailToggle = panelTree.find((node) => node.type === 'button' && node.props.title === '备注与子任务')
detailToggle.props.onClick()
panelTree = renderPanel()
const notes = panelTree.find((node) => node.type === 'textarea')
check('detail expands to notes and subtasks', notes !== undefined)
notes.props.onChange({ target: { value: '新的备注' } })
panelTree = renderPanel()
check('notes edit is kept', panelTree.some((node) => node.type === 'textarea' && node.props.value === '新的备注'))

const addInput = panelTree.find((node) => node.type === 'input' && node.props['aria-label'] === '新增待办')
check('add input renders', addInput !== undefined)
addInput.props.onChange({ target: { value: '新条目' } })
const filled = renderPanel().find((node) => node.type === 'input' && node.props['aria-label'] === '新增待办')
check('add input is controlled', filled.props.value === '新条目', String(filled.props.value))
filled.props.onKeyDown({ key: 'Enter', preventDefault() {}, currentTarget: { value: '新条目' } })
panelTree = renderPanel()
check('enter adds a row', rowsOf(panelTree).length === 3, String(rowsOf(panelTree).length))

const handle = panelTree.find((node) => typeof node.props.className === 'string' && node.props.className === 'wst-grip')
check('rows render a drag handle', handle !== undefined && handle.props.draggable === true)
const rows = rowsOf(panelTree)
handle.props.onDragStart({ dataTransfer: { setData() {}, effectAllowed: '' } })
rows[2].props.onDragOver({ preventDefault() {}, clientY: 10, dataTransfer: {}, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 20 }) } })
rows[2].props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => '' } })

await new Promise((resolve) => setTimeout(resolve, 500))
const saveCall = requests.filter((entry) => entry.url.includes('/workspace-todo/api/save')).pop()
check('edits reach the host save route', saveCall !== undefined)
const savedBody = saveCall ? JSON.parse(saveCall.init.body) : null
check('save carries the version token', savedBody !== null && savedBody.version === 'v1', JSON.stringify(savedBody && savedBody.version))
check('save declares whether the panel believes the file exists', savedBody !== null && savedBody.exists === true, JSON.stringify(savedBody && savedBody.exists))
check('save carries the reordered list', savedBody !== null && JSON.stringify(savedBody.todos.map((todo) => todo.title)) === JSON.stringify(['已完成项', '写插件', '新条目']), JSON.stringify(savedBody && savedBody.todos.map((todo) => todo.title)))
check('save keeps the status, priority and due date the menus set', savedBody !== null && savedBody.todos[1].status === 'doing' && savedBody.todos[1].priority === 'high' && savedBody.todos[1].due === '2030-05-06', JSON.stringify(savedBody && savedBody.todos[1]))
check('save keeps the edited notes', savedBody !== null && savedBody.todos[1].notes === '新的备注', JSON.stringify(savedBody && savedBody.todos[1].notes))
check('an ordinary edit is not sent with keepalive', saveCall !== undefined && saveCall.init.keepalive === undefined)

panelTree = renderPanel()
const foot = findByClass(panelTree, 'wst-foot')
check('footer reports the saved state', foot !== undefined && textOf([foot]).includes('已保存'), textOf([foot]))

const filtered = chipOf(panelTree)
filtered[1].props.onClick()
panelTree = renderPanel()
check('open filter keeps the unfinished rows', rowsOf(panelTree).length === 2, String(rowsOf(panelTree).length))

/* ------------------------------------------------------------------ */
/* 4. regressions: toggle, in-flight edit, workspace switch            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const renderButtonWith = (props) => expand(react.createElement(registrations[0].component, props))
const clickButton = (props) => {
  const button = findByClass(renderButtonWith(props), 'wst-btn')
  button.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 40, right: 1400 }) } })
  return button
}
const headerProps = { sessionId: 'S1', useSessions }

check('the button reports the open panel', findByClass(renderButtonWith(headerProps), 'wst-btn').props['aria-expanded'] === 'true')
clickButton(headerProps)
const closingPanel = findByClass(renderPanel(), 'wst-panel')
check('a second click starts the exit animation', closingPanel !== undefined && closingPanel.props['data-state'] === 'closing', closingPanel ? String(closingPanel.props['data-state']) : 'no panel')
await sleep(200)
check('the panel unmounts once the exit animation ends', renderPanel().length === 0, 'panel still rendered')
clickButton(headerProps)
check('a third click reopens it', findByClass(renderPanel(), 'wst-panel') !== undefined)
check('the reopened panel is in its open state', findByClass(renderPanel(), 'wst-panel').props['data-state'] === 'open')
check('the reopened button reports itself expanded', findByClass(renderButtonWith(headerProps), 'wst-btn').props['aria-expanded'] === 'true')

const typeNewTodo = (title) => {
  const tree = renderPanel()
  tree.find((node) => node.type === 'input' && node.props['aria-label'] === '新增待办').props.onChange({ target: { value: title } })
  renderPanel()
    .find((node) => node.type === 'input' && node.props['aria-label'] === '新增待办')
    .props.onKeyDown({ key: 'Enter', preventDefault() {}, currentTarget: { value: title } })
}

holdSaves = true
typeNewTodo('并发一')
await sleep(450)
check('the debounced save is in flight and parked', heldSaves.length === 1, String(heldSaves.length))

typeNewTodo('并发二')
releaseSaves()
await sleep(450)
check('the newer edit is queued behind the settled save', heldSaves.length === 1, String(heldSaves.length))
const midFoot = textOf([findByClass(renderPanel(), 'wst-foot')])

check('the panel never claims 已保存 while a newer edit is pending', midFoot.includes('已保存') === false, midFoot)

releaseSaves()
await sleep(80)
holdSaves = false
const saveBodies = requests.filter((entry) => entry.url.includes('/workspace-todo/api/save')).map((entry) => JSON.parse(entry.init.body))
const lastSave = saveBodies[saveBodies.length - 1]
const titles = lastSave.todos.map((todo) => todo.title)
check('the final save carries both concurrent edits', titles.includes('并发一') && titles.includes('并发二'), JSON.stringify(titles))
const settledFoot = textOf([findByClass(renderPanel(), 'wst-foot')])
check('the panel reports 已保存 once everything settled', settledFoot.includes('已保存'), settledFoot)

typeNewTodo('切换前')
const switchButton = findByClass(
  expand(react.createElement(registrations[0].component, {
    sessionId: 'S2',
    useSessions: (selector) => selector({ byId: { S2: { cwd: 'D:/work/other-project' } } }),
  })),
  'wst-btn',
)
check('the other workspace button renders', switchButton !== undefined)
await sleep(60)
const savesAfterSwitch = requests.filter((entry) => entry.url.includes('/workspace-todo/api/save')).map((entry) => JSON.parse(entry.init.body))
const outgoing = savesAfterSwitch[savesAfterSwitch.length - 1]
check('switching workspaces writes the outgoing list first', outgoing.dir === 'D:/work/example-project' && outgoing.todos.some((todo) => todo.title === '切换前'), JSON.stringify({ dir: outgoing.dir, titles: outgoing.todos.map((todo) => todo.title) }))
const lastState = requests.filter((entry) => entry.url.includes('/workspace-todo/api/state')).pop()
check('the newly addressed workspace is then loaded', decodeURIComponent(lastState.url).includes('D:/work/other-project'), lastState.url)

saveExtra = { backupFile: 'D:/work/example-project/.dsh/todos.json.bak' }
typeNewTodo('清空前的最后一条')
await sleep(450)
const backupNotice = textOf(renderPanel())
check('a save the host backed up reports the kept copy', backupNotice.includes('todos.json.bak'), backupNotice.slice(0, 90))
saveExtra = null

for (const cleanup of cleanups) cleanup()

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
process.exit(failed.length === 0 ? 0 : 1)
