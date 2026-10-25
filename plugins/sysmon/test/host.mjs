/**
 * @accsci/dsh-sysmon — host half tests.
 *
 * Dependency-free: no DSH install, no network, no Powershell. The route handler
 * is driven over a shimmed `ctx` so the assertions cover the contract the Client
 * half actually polls instead of a re-implementation of it.
 *
 * The GPU sampler is switched off (`gpu: false`) in every activation: on Windows
 * the real sampler would spawn a PDH query against the machine running the test.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import { apply, readOptions } from '../lib/index.js'

const ROUTE = '/sysmon/stats'

/** Build the contexts `apply` asks for and record what it registers. */
function activate(config) {
  const routes = []
  const disposers = []
  const web = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    webServer: { register(route) { routes.push(route) } },
  }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback(web)
    },
  }
  apply(ctx, config)
  return {
    routes,
    dispose() {
      while (disposers.length > 0) disposers.pop()()
    },
  }
}

/** One request against the registered handler. */
function request(handler, method) {
  const seen = { status: 0, headers: {}, body: undefined }
  handler({ method }, {
    writeHead(status, headers) { seen.status = status; seen.headers = headers },
    end(body) { seen.body = body },
  })
  return seen
}

// --- row config ------------------------------------------------------------
assert.deepEqual(readOptions(undefined), { intervalMs: 2000, gpu: true })
assert.deepEqual(readOptions({}), { intervalMs: 2000, gpu: true })
assert.deepEqual(readOptions({ intervalMs: 100 }), { intervalMs: 500, gpu: true })
assert.deepEqual(readOptions({ intervalMs: 999999 }), { intervalMs: 60000, gpu: true })
assert.deepEqual(readOptions({ intervalMs: '1500' }), { intervalMs: 1500, gpu: true })
assert.deepEqual(readOptions({ intervalMs: 'nope' }), { intervalMs: 2000, gpu: true })
// Only the literal `false` opts out of the GPU sampler; a zero is not a disable.
assert.deepEqual(readOptions({ gpu: false }), { intervalMs: 2000, gpu: false })
assert.equal(readOptions({ gpu: 0 }).gpu, true)

// --- route contract --------------------------------------------------------
const live = activate({ intervalMs: 60000, gpu: false })
try {
  assert.equal(live.routes.length, 1)
  assert.equal(live.routes[0].kind, 'exact')
  assert.equal(live.routes[0].path, ROUTE)

  const get = request(live.routes[0].handler, 'GET')
  assert.equal(get.status, 200)
  assert.equal(get.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(get.headers['cache-control'], 'no-store')

  const body = JSON.parse(get.body)
  assert.equal(body.host.platform, process.platform)
  assert.equal(body.host.cores, os.cpus().length)
  assert.equal(body.mem.total, os.totalmem())
  assert.ok(body.mem.used >= 0 && body.mem.used <= body.mem.total)
  assert.ok(body.mem.pct >= 0 && body.mem.pct <= 100)
  assert.ok(body.ts > 0)
  // With the sampler off the snapshot must say "no reading", never a fake 0%.
  assert.equal(body.gpu.available, false)
  assert.equal(body.gpu.pct, null)
  assert.equal(body.gpu.detail, 'idle')
  assert.equal(body.cpu.cores, os.cpus().length)
  if (body.cpu.pct !== null) assert.ok(body.cpu.pct >= 0 && body.cpu.pct <= 100)
  assert.equal(Number(get.headers['content-length']), Buffer.byteLength(get.body))

  const head = request(live.routes[0].handler, 'HEAD')
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)

  const post = request(live.routes[0].handler, 'POST')
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
} finally {
  live.dispose()
}

console.log('sysmon host: ok')
