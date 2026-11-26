/**
 * @accsci/dsh-auto-retry — policy tests.
 *
 * The classification and backoff are the whole decision surface of the plugin,
 * so they are exercised directly, with a deterministic random source and no
 * timers.
 */
import assert from 'node:assert/strict'
import {
  BACKOFF_FACTOR,
  classifyFailure,
  computeDelay,
  isQuotaWording,
  policyKeyOf,
  resolveSettings,
} from '../lib/policy.js'

const SETTINGS = resolveSettings({ initialDelayMs: 2000, maxDelayMs: 60000 })

// --- classification --------------------------------------------------------
for (const code of ['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE', 'STREAM_CLOSED', 'MALFORMED_RESPONSE']) {
  assert.equal(classifyFailure({ code }, SETTINGS), 'retry', code + ' must retry')
}
assert.equal(classifyFailure({ code: 'HTTP_503' }, SETTINGS), 'retry')
assert.equal(classifyFailure({ code: 'HTTP_429' }, SETTINGS), 'retry')
assert.equal(classifyFailure({ code: 'HTTP_408' }, SETTINGS), 'retry')

for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'INVALID_REQUEST', 'MODEL_UNSUPPORTED', 'CONTENT_REFUSED']) {
  assert.equal(classifyFailure({ code }, SETTINGS), 'stop', code + ' must stop')
}
assert.equal(classifyFailure({ code: 'HTTP_402' }, SETTINGS), 'stop')
assert.equal(classifyFailure({ code: 'HTTP_401' }, SETTINGS), 'stop')
assert.equal(classifyFailure({ code: 'HTTP_413' }, SETTINGS), 'stop')

// Context overflow and image offload belong to the compaction plugins; an abort
// belongs to the loop. Taking them over would duplicate or break that recovery.
assert.equal(classifyFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }, SETTINGS), 'delegate')
assert.equal(classifyFailure({ code: 'IMAGE_OFFLOAD_REQUIRED' }, SETTINGS), 'delegate')
assert.equal(classifyFailure({ code: 'ABORTED' }, SETTINGS), 'delegate')

// Unknown failures keep the rest of the composition's behavior unless asked.
assert.equal(classifyFailure({ code: 'PI_AI_ERROR' }, SETTINGS), 'delegate')
assert.equal(classifyFailure({ code: 'UNKNOWN' }, SETTINGS), 'delegate')
assert.equal(classifyFailure(undefined, SETTINGS), 'delegate')
assert.equal(classifyFailure({ code: 'PI_AI_ERROR' }, resolveSettings({ retryUnknown: true })), 'retry')
assert.equal(classifyFailure({ code: 'HTTP_402' }, resolveSettings({ retryUnknown: true })), 'stop')

// Quota wording wins over a transient code: relays report a spent balance as a
// timeout or a 5xx often enough that the text must be the tiebreaker.
assert.equal(classifyFailure({ code: 'TIMEOUT', message: 'Request timed out.' }, SETTINGS), 'retry')
assert.equal(classifyFailure({ code: 'TIMEOUT', message: 'Insufficient quota for this account' }, SETTINGS), 'stop')
assert.equal(classifyFailure({ code: 'SERVER', message: 'insufficient_quota' }, SETTINGS), 'stop')
assert.equal(classifyFailure({ code: 'SERVER', message: '余额不足，请充值' }, SETTINGS), 'stop')
assert.equal(classifyFailure({ code: 'RATE_LIMIT', message: 'rate limit exceeded' }, SETTINGS), 'retry')
assert.equal(isQuotaWording('usage limit reached'), true)
assert.equal(isQuotaWording('rate limit exceeded'), false)
assert.equal(isQuotaWording(undefined), false)

// --- backoff ---------------------------------------------------------------
const exact = () => 0.5
assert.equal(computeDelay(1, SETTINGS, undefined, exact), 2000)
assert.equal(computeDelay(2, SETTINGS, undefined, exact), Math.round(2000 * BACKOFF_FACTOR))
assert.equal(computeDelay(40, SETTINGS, undefined, exact), 60000)
// A provider wait inside the ceiling replaces local backoff; one above it is
// ignored so a policy can never wait past its own cap.
assert.equal(computeDelay(1, SETTINGS, 1500, exact), 1500)
assert.equal(computeDelay(1, SETTINGS, 120000, exact), 2000)
// Symmetric jitter stays inside ±ratio of the grown delay.
const low = computeDelay(3, SETTINGS, undefined, () => 0)
const high = computeDelay(3, SETTINGS, undefined, () => 1)
const grown = 2000 * BACKOFF_FACTOR ** 2
assert.equal(low, Math.round(grown * 0.8))
assert.equal(high, Math.round(grown * 1.2))
assert.equal(computeDelay(1, { initialDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 }, undefined, exact), 100)

// --- settings --------------------------------------------------------------
assert.deepEqual(resolveSettings(undefined), {
  enabled: true,
  initialDelayMs: 2000,
  maxDelayMs: 60000,
  jitterRatio: 0.2,
  retryUnknown: false,
})
assert.equal(resolveSettings({ enabled: false }).enabled, false)
assert.equal(resolveSettings({ initialDelayMs: 5 }).initialDelayMs, 100)
assert.equal(resolveSettings({ maxDelayMs: 10 }).maxDelayMs, 2000)
assert.equal(resolveSettings({ initialDelayMs: 30000, maxDelayMs: 1000 }).maxDelayMs, 30000)
assert.equal(resolveSettings({ jitterRatio: 5 }).jitterRatio, 1)
assert.equal(resolveSettings({ retryUnknown: 'yes' }).retryUnknown, false)

// A behavior change opens a new retry chain; a no-op settings edit keeps it.
assert.equal(policyKeyOf(SETTINGS), policyKeyOf(resolveSettings({})))
assert.notEqual(policyKeyOf(SETTINGS), policyKeyOf(resolveSettings({ retryUnknown: true })))
assert.notEqual(policyKeyOf(SETTINGS), policyKeyOf(resolveSettings({ initialDelayMs: 3000 })))

console.log('auto-retry policy: ok')
