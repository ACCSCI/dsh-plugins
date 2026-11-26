/**
 * @accsci/dsh-auto-retry — host half tests.
 *
 * Dependency-free: no DSH install, no network. The recovery listener and the
 * state route are driven over a shimmed `ctx`, so the assertions cover the
 * contract the rest of DSH actually sees. Waits are shortened to their 100 ms
 * minimum; nothing here sleeps for the production backoff.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-retry-host-'))
const PREVIOUS_PROFILE = process.env.DSH_PROFILE_DIR

/**
 * Activate the plugin over a minimal context and record what it registers.
 * @param {Record<string, unknown>} config - Loader row config.
 * @param {string} profileDir - profile directory holding the state file.
 */
async function activate(config, profileDir) {
  process.env.DSH_PROFILE_DIR = profileDir
  const listeners = []
  const routes = []
  const effects = []
  const host = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const ctx = {
    logger: { warn() {} },
    on(name, listener, prepend) {
      listeners.push({ name, listener, prepend })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback(host)
    },
  }
  await apply(ctx, config ?? {})
  return {
    listeners,
    routes,
    route: routes[0],
    dispose() {
      while (effects.length > 0) effects.pop()()
    },
  }
}

function agentWithLog() {
  const events = []
  return {
    events,
    agent: {
      session: {
        append(type, data) {
          events.push({ type, data })
          return events.length
        },
      },
    },
  }
}

/**
 * Run one failed request through the listener.
 * @param {ReturnType<typeof activate>} live - activation under test.
 * @param {object} agent - fake agent whose session records events.
 * @param {object} failure - normalized failure facts.
 * @param {{ step?: number, signal?: AbortSignal }} [extra] - step and abort control.
 */
async function fail(live, agent, failure, extra = {}) {
  let nextCalls = 0
  const signal = extra.signal ?? new AbortController().signal
  const decision = await live.listeners[0].listener({
    agent,
    turn: 1,
    step: extra.step ?? 1,
    provider: 'opencode-go',
    failure,
    retryPolicy: undefined,
    signal,
  }, async () => {
    nextCalls += 1
    return { kind: 'retry' }
  })
  return { decision, nextCalls }
}

function makeResponse() {
  const seen = { status: 0, headers: {}, body: undefined }
  return {
    seen,
    setHeader(name, value) { seen.headers[name] = value },
    end(body) { seen.body = body },
    set statusCode(value) { seen.status = value },
    get statusCode() { return seen.status },
  }
}

async function call(live, method, { body, headers = {} } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.headers = { host: '127.0.0.1:3715', ...headers }
  const response = makeResponse()
  const pending = live.route.handler(request, response)
  if (body !== undefined) {
    request.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
  }
  request.emit('end')
  await pending
  const parsed = typeof response.seen.body === 'string' ? JSON.parse(response.seen.body) : null
  return { ...response.seen, json: parsed }
}

try {
  // --- recovery listener ---------------------------------------------------
  const profileA = path.join(ROOT, 'a')
  const live = await activate({ initialDelayMs: 100, maxDelayMs: 100 }, profileA)
  assert.equal(live.listeners.length, 1)
  assert.equal(live.listeners[0].name, 'agent/request-error')
  // Prepend is what lets this policy own the outcome before the core five-try
  // policy sees the failure.
  assert.equal(live.listeners[0].prepend, true)

  const timeout = agentWithLog()
  const first = await fail(live, timeout.agent, { code: 'TIMEOUT', message: 'Request timed out.' })
  assert.deepEqual(first.decision, { kind: 'retry' })
  assert.equal(first.nextCalls, 0)
  assert.equal(timeout.events.length, 2)
  const scheduled = timeout.events[0]
  assert.equal(scheduled.type, 'llm/retry')
  assert.equal(scheduled.data.mode, 'always')
  assert.equal(scheduled.data.retry, 1)
  assert.equal(scheduled.data.provider, 'opencode-go')
  assert.equal(scheduled.data.turn, 1)
  assert.equal(scheduled.data.step, 1)
  assert.equal(typeof scheduled.data.retryId, 'string')
  assert.ok(scheduled.data.retryId.length > 0)
  assert.equal(typeof scheduled.data.policyKey, 'string')
  assert.equal(scheduled.data.failure.code, 'TIMEOUT')
  assert.ok(scheduled.data.delayMs >= 80 && scheduled.data.delayMs <= 100)
  assert.equal(timeout.events[1].type, 'llm/retry-started')
  assert.equal(timeout.events[1].data.retry, 1)

  // A second failure in the same step continues the same chain: same id, next
  // attempt number, which is what Chat renders as one retry row.
  const second = await fail(live, timeout.agent, { code: 'SERVER' })
  assert.deepEqual(second.decision, { kind: 'retry' })
  assert.equal(timeout.events[2].data.retryId, scheduled.data.retryId)
  assert.equal(timeout.events[2].data.retry, 2)

  // A new step opens a new chain.
  const third = await fail(live, timeout.agent, { code: 'TIMEOUT' }, { step: 2 })
  assert.deepEqual(third.decision, { kind: 'retry' })
  assert.notEqual(timeout.events[4].data.retryId, scheduled.data.retryId)
  assert.equal(timeout.events[4].data.retry, 1)

  // Permanent conditions fail the turn instead of spending the same request
  // forever; nothing is appended because no retry is scheduled.
  const quota = agentWithLog()
  const stopped = await fail(live, quota.agent, { code: 'QUOTA', message: 'insufficient balance' })
  assert.equal(stopped.decision, undefined)
  assert.equal(stopped.nextCalls, 0)
  assert.equal(quota.events.length, 0)

  // Recovery owned elsewhere is delegated untouched.
  const overflow = agentWithLog()
  const delegated = await fail(live, overflow.agent, { code: 'CONTEXT_WINDOW_EXCEEDED' })
  assert.deepEqual(delegated.decision, { kind: 'retry' })
  assert.equal(delegated.nextCalls, 1)

  // Unknown failures keep the default behavior unless the switch says otherwise.
  const unknown = agentWithLog()
  const unknownResult = await fail(live, unknown.agent, { code: 'PI_AI_ERROR' })
  assert.equal(unknownResult.nextCalls, 1)

  // A switch flipped from the GUI takes effect immediately, without a restart.
  const settings = await call(live, 'POST', { body: { retryUnknown: true } })
  assert.equal(settings.status, 200)
  assert.equal(settings.json.settings.retryUnknown, true)
  const unknownRetried = agentWithLog()
  const unknownNow = await fail(live, unknownRetried.agent, { code: 'PI_AI_ERROR' })
  assert.deepEqual(unknownNow.decision, { kind: 'retry' })
  assert.equal(unknownRetried.events.length, 2)
  await call(live, 'POST', { body: { retryUnknown: false } })

  // Cancelling the turn while a wait is open leaves no started retry behind.
  const aborted = agentWithLog()
  const controller = new AbortController()
  const pending = fail(live, aborted.agent, { code: 'TIMEOUT' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  const cancelled = await pending
  assert.equal(cancelled.decision, undefined)
  assert.equal(aborted.events.filter(event => event.type === 'llm/retry').length, 1)
  assert.equal(aborted.events.filter(event => event.type === 'llm/retry-started').length, 0)

  live.dispose()

  // --- switch off ----------------------------------------------------------
  const profileB = path.join(ROOT, 'b')
  const off = await activate({ enabled: false, initialDelayMs: 100, maxDelayMs: 100 }, profileB)
  const disabledAgent = agentWithLog()
  const disabled = await fail(off, disabledAgent.agent, { code: 'TIMEOUT' })
  assert.deepEqual(disabled.decision, { kind: 'retry' })
  assert.equal(disabled.nextCalls, 1)
  assert.equal(disabledAgent.events.length, 0)
  off.dispose()

  // --- state route ---------------------------------------------------------
  const profileC = path.join(ROOT, 'c')
  const routesLive = await activate({ initialDelayMs: 100, maxDelayMs: 100 }, profileC)
  assert.equal(routesLive.routes.length, 1)
  assert.equal(routesLive.route.kind, 'exact')
  assert.equal(routesLive.route.path, '/auto-retry/api/state')

  const initial = await call(routesLive, 'GET')
  assert.equal(initial.status, 200)
  assert.equal(initial.json.ok, true)
  assert.equal(initial.json.enabled, true)
  assert.equal(initial.json.settings.initialDelayMs, 100)
  assert.deepEqual(initial.json.active, { count: 0, nextInMs: null })
  assert.equal(initial.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(initial.headers['cache-control'], 'no-store')

  const head = await call(routesLive, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)

  const toggled = await call(routesLive, 'POST', { body: { enabled: false, maxDelayMs: 30000 } })
  assert.equal(toggled.status, 200)
  assert.equal(toggled.json.enabled, false)
  assert.equal(toggled.json.persisted, true)
  assert.equal(toggled.json.settings.maxDelayMs, 30000)
  const persisted = JSON.parse(await fs.readFile(path.join(profileC, 'auto-retry.json'), 'utf8'))
  assert.equal(persisted.settings.enabled, false)
  assert.equal(persisted.settings.maxDelayMs, 30000)

  const afterToggle = await call(routesLive, 'GET')
  assert.equal(afterToggle.json.enabled, false)

  // Values are clamped to the policy bounds rather than rejected.
  const clamped = await call(routesLive, 'POST', { body: { initialDelayMs: 1, retryUnknown: 'yes' } })
  assert.equal(clamped.json.settings.initialDelayMs, 100)
  assert.equal(clamped.json.settings.retryUnknown, false)

  // Cross-site writes are refused, so a random page cannot flip the switch.
  const crossSite = await call(routesLive, 'POST', {
    body: { enabled: true },
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSite.status, 403)
  const stillOff = await call(routesLive, 'GET')
  assert.equal(stillOff.json.enabled, false)

  const badJson = await call(routesLive, 'POST', { body: '{ nope' })
  assert.equal(badJson.status, 400)
  const badShape = await call(routesLive, 'POST', { body: [] })
  assert.equal(badShape.status, 400)
  const wrongMethod = await call(routesLive, 'PUT')
  assert.equal(wrongMethod.status, 405)

  // A persisted value is read back at the next activation: the GUI switch
  // survives a restart without touching the Loader config.
  routesLive.dispose()
  const reopened = await activate({ enabled: true, initialDelayMs: 100, maxDelayMs: 100 }, profileC)
  const restored = await call(reopened, 'GET')
  assert.equal(restored.json.enabled, false)
  assert.equal(restored.json.settings.maxDelayMs, 30000)
  reopened.dispose()
} finally {
  if (PREVIOUS_PROFILE === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = PREVIOUS_PROFILE
  await fs.rm(ROOT, { recursive: true, force: true })
}

console.log('auto-retry host: ok')
