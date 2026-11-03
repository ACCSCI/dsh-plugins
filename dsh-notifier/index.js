/**
 * Task Notifier — Host half.
 *
 * Watches Session activity and serves a tiny long-poll feed that the Web page
 * fetches. The Client half owns all rendering (toast, chime, desktop notice),
 * so the Host only forwards facts: what happened, to which Session, and why.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FEED_PATH = '/plugins/dsh-notifier/feed'
const MAX_BUFFERED = 200
const ERROR_DEDUPE_MS = 8000
const MAX_WAIT_MS = 25000

// Local request trace: the Web page runs on the `dsh-app://` scheme in the
// desktop shell, so "does the fetch even arrive?" is not answerable from the
// server logs otherwise.
const TRACE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.debug')
let traceReady = false

function trace(kind, detail) {
  try {
    if (!traceReady) {
      mkdirSync(TRACE_DIR, { recursive: true })
      traceReady = true
    }
    appendFileSync(join(TRACE_DIR, 'host.log'), `${JSON.stringify({ ts: Date.now(), kind, ...detail })}\n`)
  } catch {
    /* tracing must never break delivery */
  }
}

/** Bounded event log plus the set of parked long-poll requests. */
function createFeed() {
  const events = []
  const waiters = new Set()
  let lastSeq = 0

  function wakeAll() {
    for (const wake of [...waiters]) {
      try {
        wake()
      } catch {
        /* a broken waiter must not break the others */
      }
    }
  }

  return {
    get lastSeq() {
      return lastSeq
    },
    push(fact) {
      lastSeq += 1
      const item = { seq: lastSeq, at: Date.now(), ...fact }
      events.push(item)
      if (events.length > MAX_BUFFERED) events.splice(0, events.length - MAX_BUFFERED)
      trace('push', { seq: item.seq, kind: item.kind, sessionId: String(item.sessionId) })
      wakeAll()
      return item
    },
    since(after) {
      return events.filter((event) => event.seq > after)
    },
    park(wake) {
      waiters.add(wake)
      return () => waiters.delete(wake)
    },
  }
}

function respond(res, status, body) {
  const text = JSON.stringify(body)
  trace('respond', { status, bytes: text.length })
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(res.__cors || {}),
  }
  try {
    if (typeof res.writeHead === 'function') {
      res.writeHead(status, headers)
      res.end(text)
      return
    }
  } catch {
    /* fall through to the plain form */
  }
  try {
    res.statusCode = status
    for (const [name, value] of Object.entries(headers)) res.setHeader?.(name, value)
    res.end(text)
  } catch {
    /* the peer is gone; nothing left to do */
  }
}

/** The desktop shell loads the page from `dsh-app://app`, a different origin. */
function applyCors(req, res) {
  const origin = req?.headers?.origin
  if (!origin) return
  if (!/^(dsh-app|app|file|devtools):\/\//i.test(String(origin))) return
  res.__cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
}

function serve(req, res, feed) {
  applyCors(req, res)

  let url
  try {
    url = new URL(req.url || FEED_PATH, 'http://127.0.0.1')
  } catch {
    respond(res, 400, { error: 'bad-url' })
    return
  }

  // Trace the cheap probe requests only: a parked long-poll would otherwise
  // write a log line every 20 seconds per open page.
  if (!(Number(url.searchParams.get('wait')) > 0)) {
    trace('request', {
      method: req?.method,
      url: req?.url,
      origin: req?.headers?.origin ?? null,
      referer: req?.headers?.referer ?? null,
      agent: String(req?.headers?.['user-agent'] ?? '').slice(0, 60),
    })
  }

  const after = Math.max(0, Number(url.searchParams.get('after')) || 0)

  // `tail=1` lets a freshly loaded page start from "now" without replaying
  // notifications it never had a chance to show.
  if (url.searchParams.get('tail') === '1') {
    respond(res, 200, { items: [], cursor: feed.lastSeq })
    return
  }

  const requestedWait = Number(url.searchParams.get('wait')) || 0
  const wait = Math.min(Math.max(0, requestedWait), MAX_WAIT_MS)

  if (wait === 0 || feed.since(after).length > 0) {
    respond(res, 200, { items: feed.since(after), cursor: feed.lastSeq })
    return
  }

  let settled = false
  let timer
  let unpark

  function finish() {
    if (settled) return
    settled = true
    clearTimeout(timer)
    unpark()
    respond(res, 200, { items: feed.since(after), cursor: feed.lastSeq })
  }

  timer = setTimeout(finish, wait)
  unpark = feed.park(finish)

  req.on?.('close', () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    unpark()
  })
}

function attachRoute(ctx, webServer, feed) {
  trace('route', { path: FEED_PATH })
  return ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: FEED_PATH,
      handler: (req, res) => serve(req, res, feed),
    }),
  )
}

function describe(summary) {
  if (!summary || typeof summary !== 'object') return undefined
  return {
    cwd: typeof summary.cwd === 'string' ? summary.cwd : undefined,
    origin: summary.origin,
    parentSessionId: summary.parentSessionId,
  }
}

/**
 * The authoritative names for a notification: the Session title (log-backed)
 * and the Workspace that owns it. Both are optional services, and either may be
 * unavailable for a disposed session, so callers merge whatever comes back.
 */
function describeNames(ctx, sessionId) {
  const names = {}
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    const workspaces = registry?.list?.() ?? []
    const owner = workspaces.find(
      (workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId),
    )
    if (owner?.title) names.workspaceTitle = owner.title
  } catch {
    /* registry not active */
  }
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    const session = sessions?.get?.(sessionId)
    if (session && typeof titles?.get === 'function') {
      const snapshot = titles.get(session)
      if (snapshot?.title) names.sessionTitle = snapshot.title
    }
  } catch {
    /* no title provider or the log has no eligible input yet */
  }
  return names
}

/**
 * Tail of the last assistant message, so a notification says what the task
 * actually produced instead of only that it finished.
 */
function lastAssistantText(session) {
  if (!session || typeof session.eventAt !== 'function') return undefined
  try {
    let seq = Number(session.seq) - 1
    const floor = Number(session.firstLiveSeq || 0)
    for (let scanned = 0; scanned < 400 && seq >= floor; scanned += 1, seq -= 1) {
      const event = session.eventAt(seq)
      if (!event || event.type !== 'assistant/message') continue
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) continue
      const text = blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) return text.slice(0, 220)
    }
  } catch {
    /* a torn-down or malformed log simply has no summary */
  }
  return undefined
}

export function apply(ctx) {
  const feed = createFeed()
  const meta = new Map()
  const erroredAt = new Map()

  // Session metadata is what turns an opaque id into something a person reads.
  ctx.on('api-session/added', (summary) => {
    if (!summary?.sessionId) return
    const info = describe(summary)
    if (info) meta.set(summary.sessionId, info)
  })

  ctx.on('api-session/error', (sessionId, message) => {
    if (!sessionId) return
    erroredAt.set(sessionId, Date.now())
    feed.push({
      kind: 'error',
      sessionId,
      message: String(message ?? '').slice(0, 400),
      ...(meta.get(sessionId) || {}),
      ...describeNames(ctx, sessionId),
    })
  })

  ctx.on('api-session/status', (sessionId, running) => {
    if (!sessionId || running) return
    // A turn that just failed should read as one failure, not failure + finish.
    if (Date.now() - (erroredAt.get(sessionId) || 0) < ERROR_DEDUPE_MS) return
    feed.push({
      kind: 'complete',
      sessionId,
      ...(meta.get(sessionId) || {}),
      ...describeNames(ctx, sessionId),
      summary: lastAssistantText(ctx.get('sessions')?.get?.(sessionId)),
    })
  })

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer) {
    attachRoute(ctx, webServer, feed)
    return
  }
  // The carrier may activate after this plugin; wait for the service instead of
  // silently keeping a feed nobody can read.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      const server = typeof scope.get === 'function' ? scope.get('webServer') : scope.webServer
      if (server) attachRoute(scope, server, feed)
    })
  }
}
