/**
 * @accsci/dsh-workspace-todo — host half.
 *
 * Owns one plain JSON file per working directory and exposes it to this
 * package's client half over two JSON routes:
 *
 *   GET  /workspace-todo/api/state?dir=<absolute directory>
 *   POST /workspace-todo/api/save   { dir, todos, version }
 *
 * The file is `<directory>/.dsh/todos.json`, so every Session opened on the
 * same working directory shares one list. The Agent receives no tool here: the
 * list is the user's own, maintained by hand in the Web GUI.
 *
 * Writes go through `ctx.fs.writeText`, which creates the parent directory and
 * publishes atomically; the version token it returns guards the next write, so
 * a second window that changed the file first is reported as a conflict instead
 * of being silently overwritten.
 */

export const name = 'workspace-todo'
export const inject = ['fs', 'webServer']

const ROUTE_STATE = '/workspace-todo/api/state'
const ROUTE_SAVE = '/workspace-todo/api/save'

/** Directory, inside the working directory, that holds the list. */
const FILE_RELATIVE = '.dsh/todos.json'
/** Previous content kept when a save empties a non-empty list, so an accident is recoverable by hand. */
const BACKUP_RELATIVE = '.dsh/todos.json.bak'
const FORMAT_VERSION = 1

const MAX_TODOS = 500
const MAX_SUBTASKS = 100
const MAX_TITLE = 2000
/** 500 rows × 10k notes stays below {@link MAX_BODY_BYTES}, so a list the panel can build is a list the route accepts. */
const MAX_NOTES = 10000
const MAX_ID = 120
const MAX_BODY_BYTES = 16 * 1024 * 1024

const STATUSES = new Set(['todo', 'doing', 'done', 'blocked', 'waiting'])
const PRIORITIES = new Set(['high', 'medium', 'low'])
const DUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function describe(error) {
  return error && error.message ? String(error.message) : String(error)
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Map a filesystem failure code onto the HTTP status the client can act on. */
function mapFsStatus(error, fallback) {
  const code = error && error.code
  if (code === 'FS_NOT_FOUND') return 404
  if (code === 'FS_NOT_REGULAR_FILE' || code === 'FS_NOT_OBSERVED' || code === 'FS_STALE_VERSION') return 409
  if (code === 'FS_NOT_TEXT' || code === 'FS_TOO_LARGE') return 415
  return fallback
}

/**
 * Plugin routes registered on the Web carrier sit outside the Connection's
 * signed-cookie fence, so the browser-driven hole is closed here: a cross-site
 * page may not read or write the list. A local process keeps access by design —
 * it could read the same plain file directly, so a Host fence would only buy
 * false confidence while breaking carriers that reach the Host through another
 * authority.
 */
function crossSiteRequest(req) {
  const headers = req.headers ?? {}
  if (headers['sec-fetch-site'] === 'cross-site') return true
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = typeof headers.host === 'string' ? headers.host : ''
  try {
    return host !== '' && new URL(origin).host !== host
  } catch {
    return true
  }
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function failure(res, status, code, message) {
  json(res, status, { ok: false, code, message })
}

/** An absolute local directory: a drive path, a UNC share, or a POSIX path. */
function isAbsoluteDirectory(dir) {
  return typeof dir === 'string'
    && dir.length > 0
    && dir.length <= 4096
    && /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(dir)
}

function todosPath(dir) {
  return dir.replace(/[\\/]+$/, '') + '/' + FILE_RELATIVE
}

function backupPath(dir) {
  return dir.replace(/[\\/]+$/, '') + '/' + BACKUP_RELATIVE
}

/** Rows in a stored list; -1 when the bytes are absent or not a readable list. */
function rowCountOf(content) {
  if (typeof content !== 'string' || content.trim() === '') return -1
  try {
    const parsed = JSON.parse(content)
    return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.todos) ? parsed.todos.length : -1
  } catch {
    return -1
  }
}

function text(value, limit) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? value.slice(0, limit) : value
}

function normalizeSubtask(raw, index) {
  if (raw === null || typeof raw !== 'object') return null
  const title = text(raw.title, MAX_TITLE).trim()
  if (title === '') return null
  const id = text(raw.id, MAX_ID).trim()
  const subtask = { id: id === '' ? 'subtask-' + String(index) : id, title, done: raw.done === true }
  if (typeof raw.createdAt === 'number') subtask.createdAt = raw.createdAt
  return subtask
}

function normalizeTodo(raw, index) {
  if (raw === null || typeof raw !== 'object') return null
  const title = text(raw.title, MAX_TITLE).trim()
  if (title === '') return null
  const id = text(raw.id, MAX_ID).trim()
  const todo = {
    id: id === '' ? 'todo-' + String(index) : id,
    title,
    status: STATUSES.has(raw.status) ? raw.status : 'todo',
    priority: PRIORITIES.has(raw.priority) ? raw.priority : null,
    due: typeof raw.due === 'string' && DUE_PATTERN.test(raw.due) ? raw.due : null,
    notes: text(raw.notes, MAX_NOTES),
    subtasks: Array.isArray(raw.subtasks)
      ? raw.subtasks.map(normalizeSubtask).filter((entry) => entry !== null).slice(0, MAX_SUBTASKS)
      : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  }
  if (typeof raw.updatedAt === 'number') todo.updatedAt = raw.updatedAt
  if (typeof raw.doneAt === 'number') todo.doneAt = raw.doneAt
  return todo
}

/** Keep only well-formed rows; a hand-edited file never breaks the panel. */
function normalizeList(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeTodo).filter((entry) => entry !== null).slice(0, MAX_TODOS)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(fail('body-too-large', '请求体超过 ' + String(MAX_BODY_BYTES) + ' 字节上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function queryDirectory(req) {
  try {
    return new URL(req.url ?? ROUTE_STATE, 'http://localhost').searchParams.get('dir')
  } catch {
    return null
  }
}

export function apply(ctx) {
  ctx.inject(['fs', 'webServer'], (host) => {
    const fs = host.fs
    const webServer = host.webServer

    async function readState(dir) {
      const target = await fs.resolve(todosPath(dir))
      const info = await fs.stat(target)
      if (info === undefined) {
        return { todos: [], version: null, exists: false, file: target.displayPath, updatedAt: null }
      }
      if (info.type !== 'file') {
        throw fail('FS_NOT_REGULAR_FILE', '目标不是普通文件：' + target.displayPath)
      }
      const raw = await fs.readText(target)
      let parsed = {}
      if (raw.trim() !== '') {
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw fail('FS_NOT_TEXT', '清单文件不是合法 JSON：' + target.displayPath)
        }
      }
      return {
        todos: normalizeList(parsed === null || typeof parsed !== 'object' ? [] : parsed.todos),
        version: String(info.version),
        exists: true,
        file: target.displayPath,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      }
    }

    /**
     * The guard for one save. A caller that read the list and found no file says
     * so with `exists: false`, which becomes a guarded create: if another window
     * created the file meanwhile the write is refused instead of silently
     * discarding that window's rows. A caller holding a version replaces under
     * that version. A request that states neither is an unconditional write —
     * the shape plain API callers and tests use.
     */
    function writeIntent(version, exists) {
      if (exists === false) return { kind: 'createIfAbsent' }
      if (typeof version === 'string' && version !== '') return { kind: 'replaceIfVersion', version }
      return undefined
    }

    async function saveState(dir, todos, version, exists) {
      const target = await fs.resolve(todosPath(dir))
      const payload = JSON.stringify(
        { version: FORMAT_VERSION, updatedAt: new Date().toISOString(), todos },
        null,
        2,
      ) + '\n'
      const expected = writeIntent(version, exists)
      /*
       * A GUI request carries no session, so the confining filesystem falls back
       * to its agentless workspace root — usually the home directory — and
       * refuses a working directory on another drive. The panel writes only
       * `<working directory>/.dsh/todos.json`, so the working directory itself
       * is the honest boundary: an explicit workspace-write policy keeps the
       * write fenced without claiming unfenced access.
       */
      const policy = { mode: 'workspace-write', workspaceRoot: dir }
      const outcome = await fs.writeText(target, payload, expected, undefined, policy)
      /*
       * Emptying a non-empty list is the one destructive edit a list panel can
       * make by accident (a stale window, a wrong click, a script). Keep the
       * bytes the write replaced — `before` comes back from the same call, so
       * this costs a second small write only on that transition, and a failed
       * backup never fails the save.
       */
      let backupFile = null
      if (todos.length === 0 && rowCountOf(outcome.before) > 0) {
        try {
          const backupTarget = await fs.resolve(backupPath(dir))
          await fs.writeText(backupTarget, outcome.before, undefined, undefined, policy)
          backupFile = backupTarget.displayPath
        } catch (error) {
          console.error('workspace-todo: keeping a backup failed', error)
        }
      }
      return Object.assign(
        { version: String(outcome.version), file: target.displayPath, operation: outcome.operation },
        backupFile === null ? {} : { backupFile },
      )
    }

    host.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_STATE,
      handler: async (req, res) => {
        if (crossSiteRequest(req)) {
          failure(res, 403, 'forbidden', '拒绝跨站请求')
          return
        }
        const dir = queryDirectory(req)
        if (!isAbsoluteDirectory(dir)) {
          failure(res, 400, 'bad-directory', '缺少或非法的 dir 参数（需要绝对路径）')
          return
        }
        try {
          json(res, 200, Object.assign({ ok: true, dir }, await readState(dir)))
        } catch (error) {
          failure(res, mapFsStatus(error, 500), error && error.code ? String(error.code) : 'read-failed', describe(error))
        }
      },
    }))

    host.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_SAVE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          failure(res, 405, 'method-not-allowed', '只接受 POST')
          return
        }
        if (crossSiteRequest(req)) {
          failure(res, 403, 'forbidden', '拒绝跨站请求')
          return
        }
        let body
        try {
          body = JSON.parse(await readBody(req))
        } catch (error) {
          if (error && error.code === 'body-too-large') {
            failure(res, 413, 'body-too-large', describe(error))
            return
          }
          failure(res, 400, 'invalid-json', '请求体不是合法 JSON')
          return
        }
        const dir = body === null || typeof body !== 'object' ? null : body.dir
        if (!isAbsoluteDirectory(dir)) {
          failure(res, 400, 'bad-directory', '缺少或非法的 dir 参数（需要绝对路径）')
          return
        }
        try {
          const todos = normalizeList(body.todos)
          const exists = typeof body.exists === 'boolean' ? body.exists : undefined
          const saved = await saveState(dir, todos, body.version, exists)
          json(res, 200, Object.assign({ ok: true, count: todos.length }, saved))
        } catch (error) {
          const code = error && error.code
          if (code === 'FS_STALE_VERSION') {
            failure(res, 409, 'conflict', '清单文件已被其它窗口或编辑器修改，请重新载入')
            return
          }
          if (code === 'FS_NOT_OBSERVED') {
            failure(res, 409, 'conflict', '清单文件已被其它窗口创建，请重新载入后再改')
            return
          }
          failure(res, mapFsStatus(error, 500), code ? String(code) : 'save-failed', describe(error))
        }
      },
    }))
  })
}
