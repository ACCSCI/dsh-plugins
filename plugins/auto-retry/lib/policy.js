/**
 * Failure classification and backoff for @accsci/dsh-auto-retry.
 *
 * Pure functions only: no timers, no Host services, no Session access. The Host
 * half decides what to do with a `'retry' | 'stop' | 'delegate'` verdict, and the
 * test suite exercises this module directly.
 *
 * The three verdicts mean:
 *   - `retry`     — a transient provider failure; the plugin schedules its own
 *                   unbounded retry instead of letting the request fail.
 *   - `stop`      — a permanent condition (quota, credentials, a malformed
 *                   request). The turn fails exactly as it would without this
 *                   plugin, even when another policy would have retried.
 *   - `delegate`  — not ours: context overflow and image offload belong to the
 *                   compaction plugins, aborts belong to the loop, and unknown
 *                   failures keep whatever recovery the rest of the composition
 *                   provides (unless `retryUnknown` is on).
 */

/** Retry codes tried without an attempt limit. */
export const RETRYABLE_CODES = Object.freeze([
  'TIMEOUT',
  'TRANSPORT',
  'SERVER',
  'RATE_LIMIT',
  'EMPTY_RESPONSE',
  'STREAM_CLOSED',
  'MALFORMED_RESPONSE',
  'HTTP_408',
  'HTTP_425',
  'HTTP_429',
])

/** Permanent conditions that must fail immediately and never be retried. */
export const FATAL_CODES = Object.freeze([
  'ACCOUNT_QUOTA',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'AUTH',
  'CLIENT_UPGRADE_REQUIRED',
  'CONTENT_REFUSED',
  'INVALID_CONFIG',
  'INVALID_CREDENTIAL',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'MISSING_CREDENTIAL',
  'MODEL_UNSUPPORTED',
  'NO_CREDENTIAL_STORE',
  'QUOTA',
  'UNKNOWN_MODEL',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'UNSUPPORTED_REASONING_EFFORT',
  'HTTP_400',
  'HTTP_401',
  'HTTP_402',
  'HTTP_403',
  'HTTP_404',
  'HTTP_413',
  'HTTP_415',
  'HTTP_422',
])

/** Failures owned by the composition itself rather than by this plugin. */
export const DELEGATED_CODES = Object.freeze([
  'ABORTED',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
])

const RETRYABLE = new Set(RETRYABLE_CODES)
const FATAL = new Set(FATAL_CODES)
const DELEGATED = new Set(DELEGATED_CODES)

/** Exponential growth factor between consecutive waits. */
export const BACKOFF_FACTOR = 1.8

/** Default first wait, twice the core policy's 500 ms first wait. */
export const DEFAULT_INITIAL_DELAY_MS = 2000
/** Default ceiling for one wait. */
export const DEFAULT_MAX_DELAY_MS = 60000
/** Default symmetric jitter around every computed wait. */
export const DEFAULT_JITTER_RATIO = 0.2

const MIN_DELAY_MS = 100
const MAX_DELAY_MS = 600000

/**
 * Account-quota wording, for relays that report a spent balance as a generic
 * error or a 5xx. Kept in sync with the vocabulary providers actually use,
 * including the Chinese wording of local relays.
 */
const QUOTA_PATTERNS = Object.freeze([
  /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i,
  /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i,
  /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
  /余额不足|额度不足|额度已用|配额不足|配额已|欠费|用量上限/,
])

/**
 * Whether a provider message describes an exhausted account balance.
 * @param {unknown} message - provider failure text.
 * @returns {boolean} true when the message names quota, balance, or credit exhaustion.
 */
export function isQuotaWording(message) {
  if (typeof message !== 'string' || message === '') return false
  return QUOTA_PATTERNS.some(pattern => pattern.test(message))
}

/**
 * Normalize the Loader row config plus persisted overrides into one settings object.
 * @param {Record<string, unknown> | undefined} raw - merged config candidate.
 * @returns {{ enabled: boolean, initialDelayMs: number, maxDelayMs: number, jitterRatio: number, retryUnknown: boolean }} resolved settings.
 */
export function resolveSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const initial = numberInRange(source.initialDelayMs, DEFAULT_INITIAL_DELAY_MS, MIN_DELAY_MS, MAX_DELAY_MS)
  const max = numberInRange(source.maxDelayMs, DEFAULT_MAX_DELAY_MS, initial, MAX_DELAY_MS)
  return {
    enabled: source.enabled !== false,
    initialDelayMs: initial,
    maxDelayMs: max,
    jitterRatio: numberInRange(source.jitterRatio, DEFAULT_JITTER_RATIO, 0, 1),
    retryUnknown: source.retryUnknown === true,
  }
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Classify one failed model request.
 * @param {{ code?: string, message?: string } | undefined} failure - normalized failure facts.
 * @param {{ retryUnknown?: boolean }} settings - current policy.
 * @returns {'retry' | 'stop' | 'delegate'} what the Host half should do.
 */
export function classifyFailure(failure, settings = {}) {
  const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'UNKNOWN'
  const message = typeof failure?.message === 'string' ? failure.message : ''

  if (DELEGATED.has(code)) return 'delegate'
  // A spent balance reported under another code is still terminal: retrying it
  // only spends the user's time and burns the same failing request.
  if (isQuotaWording(message)) return 'stop'
  if (RETRYABLE.has(code)) return 'retry'
  if (/^HTTP_5\d\d$/.test(code)) return 'retry'
  if (FATAL.has(code)) return 'stop'
  if (/^HTTP_4\d\d$/.test(code)) return 'stop'
  return settings.retryUnknown === true ? 'retry' : 'delegate'
}

/**
 * Wait before retry number `attempt` (1 is the first scheduled retry).
 * A provider `Retry-After` inside the ceiling wins over local backoff; one above
 * the ceiling is ignored, because this policy never waits longer than its cap.
 * @param {number} attempt - one-based retry number within the current chain.
 * @param {{ initialDelayMs: number, maxDelayMs: number, jitterRatio: number }} settings - resolved policy.
 * @param {number | undefined} providerRetryAfterMs - provider-supplied wait, when known.
 * @param {() => number} random - zero-to-one sample used for symmetric jitter.
 * @returns {number} wait in whole milliseconds.
 */
export function computeDelay(attempt, settings, providerRetryAfterMs, random = Math.random) {
  const initial = Number.isFinite(settings.initialDelayMs) ? settings.initialDelayMs : DEFAULT_INITIAL_DELAY_MS
  const max = Number.isFinite(settings.maxDelayMs) ? settings.maxDelayMs : DEFAULT_MAX_DELAY_MS
  const ratio = Number.isFinite(settings.jitterRatio) ? settings.jitterRatio : DEFAULT_JITTER_RATIO
  if (Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0 && providerRetryAfterMs <= max) {
    return Math.max(1, Math.round(providerRetryAfterMs))
  }
  const exponent = Math.max(0, Math.min(attempt - 1, 64))
  const grown = Math.min(initial * BACKOFF_FACTOR ** exponent, max)
  const jitter = 1 - ratio + 2 * ratio * random()
  return Math.max(1, Math.round(Math.min(grown * jitter, max)))
}

/**
 * Stable identity for the retry chain a Session event belongs to.
 * @param {{ initialDelayMs: number, maxDelayMs: number, jitterRatio: number, retryUnknown: boolean }} settings - resolved policy.
 * @returns {string} a key that changes only when behavior changes.
 */
export function policyKeyOf(settings) {
  return JSON.stringify([
    'auto-retry',
    settings.initialDelayMs,
    settings.maxDelayMs,
    settings.jitterRatio,
    settings.retryUnknown,
  ])
}
