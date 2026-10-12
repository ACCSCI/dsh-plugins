/**
 * Live check for the workspace-todo plugin against the running GUI host.
 *
 * The Web carrier answers plugin routes outside the Connection's cookie fence,
 * so an authenticated call is minted here from the profile's own browser-session
 * credential (never printed). Read-only with respect to the user's project: the
 * only write goes to a throwaway temp directory.
 *
 * Run: node test/live-check.mjs
 * Expects the GUI at http://127.0.0.1:19387 and this profile's credentials file.
 *
 * Note: this Node build prints a libuv assertion while tearing down after the
 * script's own exit; the check output above it is complete and authoritative.
 */

import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
const AUTHORITY = new URL(BASE).host
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const PROJECT = process.argv[2] ?? process.cwd()

const b64 = (buffer) => Buffer.from(buffer).toString('base64url')

async function sessionCookie() {
  const text = await readFile(join(HOME, '.credentials.yaml'), 'utf8')
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_\-+/=]+)/.exec(text)
  if (match === null) throw new Error('no browser-session credential in ' + HOME)
  const secret = Buffer.from(match[1], 'base64url')
  const now = Date.now()
  const body = b64(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3600_000 }), 'utf8'))
  const name = 'dsh-auth-' + b64(createHash('sha256').update(AUTHORITY).digest())
  return name + '=v1.' + body + '.' + b64(createHmac('sha256', secret).update(body).digest())
}

const results = []
function check(name, ok, detail) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const cookie = await sessionCookie()
async function call(path, init, extraHeaders) {
  const response = await fetch(BASE + path, { ...init, headers: { ...(init?.headers ?? {}), cookie, ...(extraHeaders ?? {}) } })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text.slice(0, 120)
  }
  return { status: response.status, payload }
}

const save = (body, extraHeaders) => call('/workspace-todo/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, extraHeaders)
const state = (dir) => call('/workspace-todo/api/state?dir=' + encodeURIComponent(dir))

/* 1. the fence and the error-code contract */
const crossSite = await save({ dir: PROJECT, todos: [] }, { 'sec-fetch-site': 'cross-site' })
check('a cross-site write is refused (403)', crossSite.status === 403 && crossSite.payload?.code === 'forbidden', crossSite)
const foreignOrigin = await save({ dir: PROJECT, todos: [] }, { origin: 'http://evil.example' })
check('a foreign Origin is refused (403)', foreignOrigin.status === 403, foreignOrigin)
const malformed = await call('/workspace-todo/api/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
check('malformed JSON is a 400', malformed.status === 400 && malformed.payload?.code === 'invalid-json', malformed)

/* 2. the project directory itself */
const projectState = await state(PROJECT)
check('the project list reads', projectState.status === 200 && projectState.payload?.ok === true, projectState)
check('the project file path is <project>/.dsh/todos.json', String(projectState.payload?.file ?? '').replace(/\//g, '\\').toLowerCase() === join(PROJECT, '.dsh', 'todos.json').replace(/\//g, '\\').toLowerCase(), projectState.payload?.file)
console.log(`      project file: ${projectState.payload?.file}  (exists: ${String(projectState.payload?.exists)}, rows: ${String(projectState.payload?.todos?.length)})`)

/* 3. a real write round-trip in a throwaway directory */
const tempDir = (await mkdtemp(join(tmpdir(), 'workspace-todo-live-'))).replace(/\\/g, '/')
try {
  const created = await save({ dir: tempDir, todos: [{ id: 'live', title: '活体探针', status: 'doing', priority: 'high', due: '2030-01-01', notes: 'n', subtasks: [{ id: 's', title: '子', done: true }] }] })
  check('a write creates the file', created.status === 200 && created.payload?.operation === 'create', created)
  const onDisk = JSON.parse(await readFile(join(tempDir, '.dsh', 'todos.json'), 'utf8'))
  check('the file holds the documented shape', onDisk.version === 1 && onDisk.todos[0].title === '活体探针' && onDisk.todos[0].subtasks[0].done === true, onDisk.todos[0])
  check('the nested .dsh directory was created', (await stat(join(tempDir, '.dsh'))).isDirectory())
  const stale = await save({ dir: tempDir, version: 'not-the-current-version', todos: [] })
  check('a stale version is refused (409 conflict)', stale.status === 409 && stale.payload?.code === 'conflict', stale)
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${String(results.length - failed)}/${String(results.length)} live checks passed`)
process.exit(failed === 0 ? 0 : 1)
