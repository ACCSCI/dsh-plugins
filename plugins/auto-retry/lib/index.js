/**
 * @accsci/dsh-auto-retry — host half.
 *
 * The core `dsh-llm-retry` policy retries a bounded set of transient failures
 * five times. This plugin sits in front of that waterfall and — while its switch
 * is on — turns a transient provider failure into an unbounded retry chain,
 * while a permanent one (quota, credentials, a malformed request) fails the turn
 * immediately instead of feeding a request that cannot succeed.
 *
 * One JSON state file per profile holds the switch and the two delay bounds; the
 * Client half edits it over the JSON routes below.
 *
 *   GET  /auto-retry/api/state
 *   POST /auto-retry/api/state   { enabled?, initialDelayMs?, maxDelayMs?, retryUnknown? }
 *
 * Every scheduled retry is made durable before its wait: an `llm/retry` event is
 * appended (which is also what Chat renders as the retry row, with `∞` as the
 * attempt ceiling), then `llm/retry-started` once the wait completes. The turn
 * keeps the same durable history and reruns the failed step, so the model never
 * sees the retry itself.
 */
import { randomUUID } from 'node:crypto';
import {
  classifyFailure,
  computeDelay,
  policyKeyOf,
  resolveSettings,
} from './policy.js';
import { readState, stateFilePath, writeState } from './store.js';

export const name = 'auto-retry';

/** Route shared by the read and the write endpoint. */
const ROUTE = '/auto-retry/api/state';
/** Largest request body this route accepts. */
const MAX_BODY_BYTES = 64 * 1024;
/** How many finished chains are remembered for the status line. */
const MAX_REMEMBERED_STOPS = 20;

function describe(error) {
  return error && error.message ? String(error.message) : String(error);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

/**
 * Plugin routes sit outside the Connection's signed-cookie fence; close the
 * browser-driven hole the same way the other plugins in this repository do.
 * @param {import('node:http').IncomingMessage} request - candidate request.
 * @returns {boolean} true when the request is cross-site and must be refused.
 */
function crossSiteRequest(request) {
  const headers = request.headers ?? {};
  if (headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  const host = typeof headers.host === 'string' ? headers.host : '';
  try {
    return host !== '' && new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Resolve after `delayMs`, or early when either signal aborts.
 * @param {number} delayMs - wait length.
 * @param {AbortSignal} signal - fused turn and plugin-lifetime signal.
 * @returns {Promise<boolean>} true when the full wait elapsed.
 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fuse the turn's abort signal with the plugin lifetime.
 * @param {AbortSignal} signal - the turn's signal.
 * @param {AbortSignal} lifetime - the plugin's disposal signal.
 * @returns {AbortSignal} a signal aborted when either source aborts.
 */
function fuse(signal, lifetime) {
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, lifetime])
    : signal;
}

/**
 * Mount the switch, the recovery listener, and the JSON routes.
 * @param {import('cordis').Context} ctx - Host plugin context.
 * @param {{ enabled?: boolean, initialDelayMs?: number, maxDelayMs?: number, retryUnknown?: boolean }} [config] - Loader row defaults.
 */
export async function apply(ctx, config) {
  const file = stateFilePath();
  // Declarative row defaults first, then whatever the GUI persisted.
  let settings = resolveSettings({ ...config, ...await readState(file) });

  /** Retry chains, one per agent + turn + step, so numbering survives across attempts. */
  const chains = new WeakMap();
  /** Waits currently in flight, for the status line the Client polls. */
  const active = new Map();
  const stops = [];
  let last = null;

  const lifetime = new AbortController();

  function chainFor(agent, turn, step) {
    let byTurn = chains.get(agent);
    if (byTurn === undefined) {
      byTurn = new Map();
      chains.set(agent, byTurn);
    }
    const prefix = `${turn}:`;
    for (const key of byTurn.keys()) {
      if (!key.startsWith(prefix)) byTurn.delete(key);
    }
    const key = `${turn}:${step}`;
    let chain = byTurn.get(key);
    if (chain === undefined) {
      chain = { retryId: randomUUID(), retry: 0 };
      byTurn.set(key, chain);
    }
    return chain;
  }

  function remember(entry) {
    last = entry;
    stops.push(entry);
    if (stops.length > MAX_REMEMBERED_STOPS) stops.shift();
  }

  function snapshot() {
    const now = Date.now();
    let nextInMs = null;
    for (const entry of active.values()) {
      const remaining = Math.max(0, entry.until - now);
      if (nextInMs === null || remaining < nextInMs) nextInMs = remaining;
    }
    return {
      ok: true,
      enabled: settings.enabled,
      settings: { ...settings },
      active: { count: active.size, nextInMs },
      last,
      stops: stops.slice(-5),
    };
  }

  /**
   * The recovery listener: first in the waterfall, so its verdict owns the
   * outcome while the switch is on.
   */
  async function recover(payload, next) {
    const current = settings;
    if (!current.enabled) return next();

    const { agent, turn, step, provider, failure, signal } = payload;
    const verdict = classifyFailure(failure, current);
    if (verdict === 'delegate') return next();
    if (verdict === 'stop') {
      remember({
        decision: 'stop',
        at: Date.now(),
        provider,
        code: typeof failure?.code === 'string' ? failure.code : 'UNKNOWN',
        message: typeof failure?.message === 'string' ? failure.message.slice(0, 300) : '',
        retry: 0,
        delayMs: 0,
      });
      return undefined;
    }
    if (signal.aborted || lifetime.signal.aborted) return undefined;

    const chain = chainFor(agent, turn, step);
    const attempt = chain.retry + 1;
    const delayMs = computeDelay(attempt, current, failure?.providerRetryAfterMs);
    const policyKey = policyKeyOf(current);

    try {
      agent.session.append('llm/retry', {
        retryId: chain.retryId,
        turn,
        step,
        provider,
        mode: 'always',
        policyKey,
        retry: attempt,
        delayMs,
        failure,
      });
    } catch (error) {
      ctx.logger?.warn?.('auto-retry: recording the retry failed, delegating instead: %o', error);
      return next();
    }
    chain.retry = attempt;
    remember({
      decision: 'retry',
      at: Date.now(),
      provider,
      code: typeof failure?.code === 'string' ? failure.code : 'UNKNOWN',
      message: typeof failure?.message === 'string' ? failure.message.slice(0, 300) : '',
      retry: attempt,
      delayMs,
    });

    const wait = { provider, retry: attempt, startedAt: Date.now(), until: Date.now() + delayMs };
    active.set(chain.retryId, wait);
    let elapsed;
    try {
      elapsed = await cancellableDelay(delayMs, fuse(signal, lifetime.signal));
    } finally {
      active.delete(chain.retryId);
    }
    if (!elapsed) return undefined;

    try {
      agent.session.append('llm/retry-started', {
        retryId: chain.retryId,
        turn,
        step,
        retry: attempt,
      });
    } catch (error) {
      ctx.logger?.warn?.('auto-retry: recording the retry start failed, delegating instead: %o', error);
      return next();
    }
    return { kind: 'retry' };
  }

  // `true` prepends: a listener registered later (the core policy) must not get
  // the first say while this plugin owns recovery.
  ctx.on('agent/request-error', (payload, next) => recover(payload, next), true);

  ctx.effect(() => () => {
    lifetime.abort(new Error('auto-retry plugin disposed'));
    active.clear();
  }, 'auto-retry: cancel in-flight waits');

  ctx.inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (request, response) => {
        if (crossSiteRequest(request)) {
          json(response, 403, { ok: false, code: 'forbidden', message: 'cross-site request refused' });
          return;
        }
        if (request.method === 'GET' || request.method === 'HEAD') {
          const body = snapshot();
          if (request.method === 'HEAD') {
            response.statusCode = 200;
            response.end();
            return;
          }
          json(response, 200, body);
          return;
        }
        if (request.method !== 'POST') {
          response.setHeader('allow', 'GET, HEAD, POST');
          json(response, 405, { ok: false, code: 'method-not-allowed', message: 'GET or POST only' });
          return;
        }
        let body;
        try {
          const raw = await readBody(request);
          body = raw.trim() === '' ? {} : JSON.parse(raw);
        } catch (error) {
          json(response, 400, { ok: false, code: 'invalid-json', message: describe(error) });
          return;
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          json(response, 400, { ok: false, code: 'invalid-body', message: 'expected a JSON object' });
          return;
        }
        const candidate = { ...settings };
        if (typeof body.enabled === 'boolean') candidate.enabled = body.enabled;
        if (body.initialDelayMs !== undefined) candidate.initialDelayMs = body.initialDelayMs;
        if (body.maxDelayMs !== undefined) candidate.maxDelayMs = body.maxDelayMs;
        if (typeof body.retryUnknown === 'boolean') candidate.retryUnknown = body.retryUnknown;
        const next = resolveSettings(candidate);
        settings = next;
        let persisted = true;
        try {
          await writeState(file, next);
        } catch (error) {
          persisted = false;
          ctx.logger?.warn?.('auto-retry: saving the switch failed: %o', error);
        }
        json(response, 200, { ...snapshot(), persisted, file });
      },
    }), 'auto-retry: state route');
  });
}
