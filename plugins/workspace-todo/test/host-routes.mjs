/**
 * Offline harness for the workspace-todo host half.
 *
 * Drives the real route handlers from `lib/index.js` against a shim that mirrors
 * the dsh filesystem contract (version tokens, FS_STALE_VERSION, recursive
 * parent creation). It proves the handler logic — paths, validation, conflict
 * mapping — without a running GUI; the live browser path still needs a real
 * click in the app.
 *
 * Run: node test/host-routes.mjs
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The module under test, imported through its own URL so any platform and cwd work. */
const moduleUrl = new URL('../lib/index.js', import.meta.url)

/* ------------------------------------------------------------------ */
/* a minimal ctx.fs over node:fs with the documented version semantics */
/* ------------------------------------------------------------------ */

function createFsShim() {
  const versionOf = (info) => `${String(info.mtimeMs)}-${String(info.size)}`
  const writes = []
  const fs = {
    /** Every write this plugin attempts, with the policy it claimed. */
    writes,
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      try {
        const info = await stat(target.targetKey)
        return {
          version: versionOf(info),
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      return await readFile(target.targetKey, 'utf8')
    },
    async writeText(target, content, expected, signal, sandboxPolicy) {
      writes.push({ path: target.targetKey, policy: sandboxPolicy ?? null })
      let existing
      try {
        existing = await stat(target.targetKey)
      } catch {
        existing = undefined
      }
      // dsh-fs-local rejects a non-regular target before touching the version guard.
      if (existing !== undefined && !existing.isFile()) {
        const error = new Error(`cannot write "${target.targetKey}": not a regular file`)
        error.code = 'FS_NOT_REGULAR_FILE'
        throw error
      }
      if (expected && expected.kind === 'createIfAbsent' && existing !== undefined) {
        const error = new Error(`cannot overwrite existing "${target.targetKey}" without reading it first`)
        error.code = 'FS_NOT_OBSERVED'
        throw error
      }
      if (expected && expected.kind === 'replaceIfVersion') {
        if (existing === undefined || versionOf(existing) !== expected.version) {
          const error = new Error('file changed since it was read')
          error.code = 'FS_STALE_VERSION'
          throw error
        }
      }
      await mkdir(join(target.targetKey, '..'), { recursive: true })
      // dsh-fs-local reports the replaced text as `before`; the plugin's backup net reads it.
      const before = existing !== undefined && existing.isFile() ? await readFile(target.targetKey, 'utf8') : null
      await writeFile(target.targetKey, content, 'utf8')
      const after = await stat(target.targetKey)
      return { operation: existing ? 'update' : 'create', version: versionOf(after), before, after: content }
    },
  }
  return fs
}

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  → ${detail}`}`)
}

function createResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
  const json = () => (res.body === '' ? null : JSON.parse(res.body))
  return { res, json }
}

function createRequest(method, url, body, headers) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: headers ?? { host: '127.0.0.1:19387' },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return req
    },
    destroy() {},
  }
  // Deliver the body on the next tick so the handler's listeners are attached.
  queueMicrotask(() => {
    if (body !== undefined) for (const handler of listeners.get('data') ?? []) handler(Buffer.from(body, 'utf8'))
    for (const handler of listeners.get('end') ?? []) handler()
  })
  return req
}

async function invoke(route, method, url, body, headers) {
  const { res, json } = createResponse()
  await route.handler(createRequest(method, url, body, headers), res)
  return { status: res.statusCode, payload: json() }
}

/* ------------------------------------------------------------------ */

const routes = new Map()
const host = {
  fs: createFsShim(),
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}
const ctx = {
  inject(names, callback) {
    for (const name of names) {
      if (host[name] === undefined) throw new Error(`harness: unknown service ${name}`)
    }
    callback(Object.assign({ effect: (fn) => fn() }, host))
  },
}

const plugin = await import(moduleUrl.href)
plugin.apply(ctx)

const STATE = '/workspace-todo/api/state'
const SAVE = '/workspace-todo/api/save'
check('exports name/inject', plugin.name === 'workspace-todo' && Array.isArray(plugin.inject), JSON.stringify(plugin.inject))
check('registers both routes', routes.has(STATE) && routes.has(SAVE))

const workdir = await mkdtemp(join(tmpdir(), 'workspace-todo-'))
const dir = workdir.replace(/\\/g, '/')
const file = join(workdir, '.dsh', 'todos.json')

try {
  const empty = await invoke(routes.get(STATE), 'GET', `${STATE}?dir=${encodeURIComponent(dir)}`)
  check('state: absent file reads as empty', empty.status === 200 && empty.payload.ok === true && Array.isArray(empty.payload.todos) && empty.payload.todos.length === 0 && empty.payload.exists === false, JSON.stringify(empty.payload))
  check('state: reports the file path', typeof empty.payload.file === 'string' && empty.payload.file.endsWith('.dsh/todos.json'), empty.payload.file)

  const badDir = await invoke(routes.get(STATE), 'GET', `${STATE}?dir=relative/path`)
  check('state: relative dir refused', badDir.status === 400 && badDir.payload.code === 'bad-directory', JSON.stringify(badDir.payload))

  const missing = await invoke(routes.get(STATE), 'GET', STATE)
  check('state: missing dir refused', missing.status === 400 && missing.payload.code === 'bad-directory', JSON.stringify(missing.payload))

  const saved = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({
    dir,
    version: null,
    todos: [
      { id: 'a', title: '写插件', status: 'doing', priority: 'high', due: '2026-01-31', notes: '备注', subtasks: [{ id: 's1', title: '子任务', done: true }] },
      { id: 'blank', title: '   ' },
      { id: 'b', title: '枚举与日期非法', status: 'nonsense', priority: 'nonsense', due: 'tomorrow' },
      { id: 'c', title: '第二条', status: 'done' },
    ],
  }))
  check('save: creates the file and the .dsh directory', saved.status === 200 && saved.payload.ok === true && saved.payload.operation === 'create', JSON.stringify(saved.payload))
  check('save: drops the blank row, keeps three', saved.payload.count === 3, String(saved.payload.count))

  const written = JSON.parse(await readFile(file, 'utf8'))
  const first = written.todos[0]
  check('file: absolute path inside the working directory', (await stat(file)).isFile())
  const claimed = host.fs.writes[0]
  check(
    'save: fences each write to the working directory it was asked about',
    claimed.policy !== null && claimed.policy.mode === 'workspace-write' && claimed.policy.workspaceRoot === dir && claimed.path.startsWith(dir),
    JSON.stringify(claimed),
  )
  check('file: format version + updatedAt', written.version === 1 && typeof written.updatedAt === 'string', JSON.stringify({ version: written.version, updatedAt: written.updatedAt }))
  check('file: normalized status/priority/due survive', first.status === 'doing' && first.priority === 'high' && first.due === '2026-01-31' && first.subtasks[0].done === true, JSON.stringify(first))
  check('file: invalid enum + date fall back', written.todos[1].status === 'todo' && written.todos[1].priority === null && written.todos[1].due === null, JSON.stringify(written.todos[1]))
  check('file: preserves the input order it accepted', written.todos[0].title === '写插件' && written.todos[1].title === '枚举与日期非法' && written.todos[2].title === '第二条', JSON.stringify(written.todos.map((todo) => todo.title)))

  const reloaded = await invoke(routes.get(STATE), 'GET', `${STATE}?dir=${encodeURIComponent(dir)}`)
  check('state: round-trips the saved list with a version token', reloaded.payload.todos.length === 3 && typeof reloaded.payload.version === 'string' && reloaded.payload.exists === true, JSON.stringify(reloaded.payload.version))

  const version = reloaded.payload.version
  const fresh = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, version, todos: [{ id: 'a', title: '改标题', status: 'done' }] }))
  check('save: accepts the version it just read', fresh.status === 200 && fresh.payload.operation === 'update', JSON.stringify(fresh.payload))

  const stale = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, version, todos: [] }))
  check('save: stale version reports a conflict', stale.status === 409 && stale.payload.code === 'conflict', JSON.stringify(stale.payload))

  const stillThere = JSON.parse(await readFile(file, 'utf8'))
  check('save: a refused write leaves the file untouched', stillThere.todos.length === 1 && stillThere.todos[0].title === '改标题', JSON.stringify(stillThere.todos))

  const guardedCreate = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, version: null, exists: false, todos: [{ id: 'z', title: '另一个窗口的清单' }] }))
  check('save: a guarded create is refused when the file already exists', guardedCreate.status === 409 && guardedCreate.payload.code === 'conflict', JSON.stringify(guardedCreate.payload))
  const untouched = JSON.parse(await readFile(file, 'utf8'))
  check('save: the refused guarded create changed nothing', untouched.todos.length === 1 && untouched.todos[0].title === '改标题', JSON.stringify(untouched.todos))

  const newDir = join(workdir, 'fresh').replace(/\\/g, '/')
  const guardedNew = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir: newDir, version: null, exists: false, todos: [{ id: 'n', title: '首次创建' }] }))
  check('save: a guarded create succeeds on a directory with no list yet', guardedNew.status === 200 && guardedNew.payload.operation === 'create', JSON.stringify(guardedNew.payload))

  const emptied = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, version: fresh.payload.version, todos: [] }))
  check('save: emptying a non-empty list keeps the replaced bytes', emptied.status === 200 && typeof emptied.payload.backupFile === 'string' && emptied.payload.backupFile.endsWith('.dsh/todos.json.bak'), JSON.stringify(emptied.payload))
  const backup = JSON.parse(await readFile(join(workdir, '.dsh', 'todos.json.bak'), 'utf8'))
  check('backup: holds exactly the rows the save replaced', backup.todos.length === 1 && backup.todos[0].title === '改标题', JSON.stringify(backup.todos))

  const emptiedAgain = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, version: emptied.payload.version, todos: [] }))
  check('save: emptying an already empty list writes no backup', emptiedAgain.status === 200 && emptiedAgain.payload.backupFile === undefined, JSON.stringify(emptiedAgain.payload))

  const wrongMethod = await invoke(routes.get(SAVE), 'GET', SAVE)
  check('save: rejects a non-POST method', wrongMethod.status === 405 && wrongMethod.payload.code === 'method-not-allowed', JSON.stringify(wrongMethod.payload))

  const brokenBody = await invoke(routes.get(SAVE), 'POST', SAVE, '{not json')
  check('save: malformed body is a 400, not a server error', brokenBody.status === 400 && brokenBody.payload.code === 'invalid-json', JSON.stringify(brokenBody.payload))

  const oversized = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, todos: [{ id: 'x', title: 'y'.repeat(17 * 1024 * 1024) }] }))
  check('save: an oversized body is refused with 413', oversized.status === 413 && oversized.payload.code === 'body-too-large', JSON.stringify(oversized.payload))

  const crossSite = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, todos: [] }), { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })
  check('save: a cross-site browser request is refused with 403', crossSite.status === 403 && crossSite.payload.code === 'forbidden', JSON.stringify(crossSite.payload))
  const foreignOrigin = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, todos: [] }), { host: '127.0.0.1:19387', origin: 'http://evil.example' })
  check('save: a foreign Origin is refused with 403', foreignOrigin.status === 403 && foreignOrigin.payload.code === 'forbidden', JSON.stringify(foreignOrigin.payload))
  const sameOrigin = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, todos: [] }), { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })
  check('save: the GUI origin still passes the fence', sameOrigin.status === 200 && sameOrigin.payload.ok === true, JSON.stringify(sameOrigin.payload))

  const stateFenced = await invoke(routes.get(STATE), 'GET', `${STATE}?dir=${encodeURIComponent(dir)}`, undefined, { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })
  check('state: the same fence covers the read route', stateFenced.status === 403, JSON.stringify(stateFenced.payload))

  const emptyList = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, todos: [] }))
  check('save: unconditional write without a version still works', emptyList.status === 200 && emptyList.payload.count === 0, JSON.stringify(emptyList.payload))

  const edited = await readFile(file, 'utf8')
  const handEdited = JSON.parse(edited)
  handEdited.todos = 'not-an-array'
  await writeFile(file, JSON.stringify(handEdited), 'utf8')
  const tolerant = await invoke(routes.get(STATE), 'GET', `${STATE}?dir=${encodeURIComponent(dir)}`)
  check('state: a hand-edited file with a broken todos field reads as empty', tolerant.status === 200 && Array.isArray(tolerant.payload.todos) && tolerant.payload.todos.length === 0, JSON.stringify(tolerant.payload))

  await rm(file, { force: true })
  await mkdir(file, { recursive: true })
  const directoryInPlaceOfFile = await invoke(routes.get(STATE), 'GET', `${STATE}?dir=${encodeURIComponent(dir)}`)
  check('state: a directory in the file slot maps to 409', directoryInPlaceOfFile.status === 409 && directoryInPlaceOfFile.payload.code === 'FS_NOT_REGULAR_FILE', JSON.stringify(directoryInPlaceOfFile.payload))
  const refusedWrite = await invoke(routes.get(SAVE), 'POST', SAVE, JSON.stringify({ dir, todos: [] }))
  check('save: writing over a directory maps to 409 too', refusedWrite.status === 409 && refusedWrite.payload.code === 'FS_NOT_REGULAR_FILE', JSON.stringify(refusedWrite.payload))
} finally {
  await rm(workdir, { recursive: true, force: true })
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
process.exit(failed.length === 0 ? 0 : 1)
