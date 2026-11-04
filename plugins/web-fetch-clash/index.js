/**
 * dsh-web-fetch-clash — 自包含的 `web_fetch` 传输层插件（零依赖，只用 Node 内置模块）。
 *
 * 背景：内置 provider（`@deepseek-ai/dsh-web-fetch-http`）先用系统 DNS 解析目标，再把每个地址
 * 交给 ipaddr.js 判定，只有 `unicast` 放行。Clash Verge 在 TUN 模式下用 fake-IP 应答，域名都解析
 * 到 198.18.0.0/15 与 2001:2::/64，被判为 reserved，于是报
 * `URL hostname "..." resolves to a non-public IP address`，与网络是否通畅无关。
 *
 * 本插件的行为：
 *   1. 本地 Clash/mihomo 混合端口在监听 -> 请求交给代理（由代理解析域名，本地 DNS 不参与判定）。
 *   2. 代理不可用 -> 直连；直连时把 fake-IP 段视为「TUN 哨兵地址」放行（连接仍由 TUN 接管），
 *      其余非公网地址照旧拒绝，保留 SSRF 防护。
 *
 * 因此 TUN / 系统代理 / 都不开 / Clash 完全退出 四种状态都能抓网页。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PROVIDER_ID = 'clash';
const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)';

const DEFAULTS = {
  maxResponseBytes: 5e6,
  maxBodyChars: 1e5,
  timeoutMs: 3e4,
  maxRedirects: 5,
  userAgent: DEFAULT_USER_AGENT,
};

const VERGE_CONFIG = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev', 'config.yaml')
  : undefined;
const CANDIDATE_PORTS = [7897, 7890, 7891, 10801, 10808, 20171];
const PROBE_TTL_MS = 3000;

let cachedProxyPort;
let cachedAt = 0;

class WebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'WebError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ 代理探测 */

function readVergeMixedPort() {
  if (VERGE_CONFIG === undefined) return undefined;
  try {
    const match = /^mixed-port:\s*(\d+)\s*$/m.exec(fs.readFileSync(VERGE_CONFIG, 'utf8'));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function canConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

async function findProxyPort(options) {
  if (typeof options.proxyPort === 'number') return options.proxyPort;
  const now = Date.now();
  if (now - cachedAt < (options.probeTtlMs ?? PROBE_TTL_MS)) return cachedProxyPort;

  const ports = [];
  const detected = readVergeMixedPort();
  if (detected !== undefined) ports.push(detected);
  for (const port of options.ports ?? CANDIDATE_PORTS) if (!ports.includes(port)) ports.push(port);

  const timeout = options.probeTimeoutMs ?? 200;
  let found;
  for (const port of ports) {
    if (await canConnect('127.0.0.1', port, timeout)) {
      found = port;
      break;
    }
  }
  cachedProxyPort = found;
  cachedAt = now;
  return found;
}

/* ------------------------------------------------------------------ 地址分类 */

function ipv4ToInt(address) {
  const parts = address.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

/** Clash fake-IP 段：TUN 下这些地址是流量入口，不是真实的远端主机。 */
function isFakeIp(address, family) {
  if (family === 4) {
    const value = ipv4ToInt(address);
    return value >= ipv4ToInt('198.18.0.0') && value <= ipv4ToInt('198.19.255.255');
  }
  const lower = address.toLowerCase();
  return lower.startsWith('2001:2:') || lower.startsWith('2001:002:');
}

function isPublicAddress(address, family) {
  if (family === 4) {
    const value = ipv4ToInt(address);
    return !BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === (base & mask) >>> 0;
    });
  }
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return false;
  if (/^f[cd]/.test(lower)) return false; // fc00::/7
  if (/^fe[89ab]/.test(lower)) return false; // fe80::/10
  if (/^ff/.test(lower)) return false; // multicast
  return true;
}

/** 解析一次并分类：返回可连接的地址集合；非公网且非 fake-IP 的地址整体拒绝。 */
async function resolveTarget(hostname, signal) {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const literal = isIP(host);
  const resolved = literal === 0
    ? await withSignal(lookup(host, { all: true, order: 'verbatim' }), signal)
    : [{ address: host, family: literal }];
  if (resolved.length === 0) throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR');

  for (const entry of resolved) {
    if (!isFakeIp(entry.address, entry.family) && !isPublicAddress(entry.address, entry.family)) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL');
    }
  }
  return resolved;
}

function withSignal(promise, signal) {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/* ------------------------------------------------------------------ 传输层 */

/** https 走代理：CONNECT 隧道 + 在隧道上做 TLS（保留 Host / SNI 语义）。 */
class TunnelAgent extends https.Agent {
  constructor(proxyPort) {
    super({ keepAlive: false });
    this.proxyPort = proxyPort;
  }

  createConnection(options, callback) {
    const host = options.host;
    const port = options.port ?? 443;
    const raw = net.connect({ host: '127.0.0.1', port: this.proxyPort });
    let settled = false;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };
    raw.setNoDelay(true);
    raw.once('error', (error) => finish(error));
    raw.once('connect', () => {
      raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buffer.length > 16384) {
            raw.destroy();
            finish(new Error('proxy handshake header too large'));
          }
          return;
        }
        raw.removeListener('data', onData);
        const head = buffer.subarray(0, end).toString('latin1').split('\r\n')[0];
        if (!/^HTTP\/1\.[01] 2\d\d/.test(head)) {
          raw.destroy();
          finish(new Error(`proxy refused the tunnel: ${head}`));
          return;
        }
        const rest = buffer.subarray(end + 4);
        if (rest.length > 0) raw.unshift(rest);
        const secure = tls.connect({ socket: raw, servername: net.isIP(host) === 0 ? host : undefined });
        secure.once('error', (error) => finish(error));
        secure.once('secureConnect', () => finish(null, secure));
      };
      raw.on('data', onData);
    });
  }
}

function baseHeaders(url) {
  return {
    host: url.host,
    'user-agent': DEFAULT_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
    'accept-encoding': 'identity',
    connection: 'close',
  };
}

/**
 * 发一个 GET，返回 { status, headers, stream }。
 *
 * @param plan.route `proxy` 表示交给本地代理（由代理解析域名）；
 *               `direct` 表示连到已经校验过的固定地址（避免二次解析 / DNS 重绑定）。
 */
function sendRequest(url, plan, signal) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const headers = baseHeaders(url);
    const common = {
      method: 'GET',
      headers,
      ...(signal === undefined ? {} : { signal }),
    };

    let request;
    if (plan.route === 'proxy') {
      if (isHttps) {
        request = https.request(url, { ...common, agent: new TunnelAgent(plan.proxyPort) });
      } else {
        /* 明文 HTTP 走代理用绝对 URI。 */
        request = http.request({ ...common, host: '127.0.0.1', port: plan.proxyPort, path: url.href });
      }
    } else if (isHttps) {
      /* 固定地址连接，但 SNI / 证书校验仍用原主机名。 */
      request = https.request({
        ...common,
        host: plan.address,
        port: Number(url.port || 443),
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        agent: false,
      });
    } else {
      request = http.request({
        ...common,
        host: plan.address,
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        agent: false,
      });
    }

    request.once('error', reject);
    request.once('response', (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        stream: response,
        close: () => response.destroy(),
      });
    });
    request.end();
  });
}

/** 代理连接层面的失败（可以安全地回退到直连）。 */
function isTransportFailure(error) {
  const code = error?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH' || code === 'EPIPE' || /proxy refused the tunnel/.test(String(error?.message));
}

/**
 * 决定这一跳怎么走：
 * - 代理可用且目标是域名或公网字面量 -> 代理（本地 DNS 不参与判定，fake-IP 无从触发）。
 * - 否则做一次本地解析并校验：fake-IP 段放行（TUN 哨兵），其余非公网地址拒绝。
 */
async function planHop(url, proxyPort, signal) {
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const literal = isIP(host);

  if (proxyPort !== undefined) {
    if (literal !== 0 && !isPublicAddress(host, literal)) {
      throw new WebError(`URL hostname "${url.hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL');
    }
    return { route: 'proxy', proxyPort };
  }

  const addresses = await resolveTarget(url.hostname, signal);
  return { route: 'direct', address: addresses[0].address };
}

/* ------------------------------------------------------------------ 内容处理 */

function classifyContentType(contentType) {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text';
  return undefined;
}

function parseCharset(contentType) {
  return /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')?.[1]?.trim().toLowerCase();
}

function decoderForCharset(charset) {
  if (charset === undefined) return new TextDecoder('utf-8');
  try {
    return new TextDecoder(charset);
  } catch (error) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error });
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function sameOrigin(a, b) {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

/* ------------------------------------------------------------------ Provider */

export class ClashFetchProvider {
  id = PROVIDER_ID;

  constructor(limits = DEFAULTS, options = {}) {
    this.limits = limits;
    this.options = options;
  }

  available() {
    return true;
  }

  async fetch(request, signal) {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED');
    const timeout = AbortSignal.timeout(this.limits.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await this.followAndRead(validateUrl(request.url), combined);
    } catch (error) {
      throw translate(error, signal, timeout);
    }
  }

  async followAndRead(initialUrl, signal) {
    let current = initialUrl;
    let redirects = 0;
    for (;;) {
      const proxyPort = await findProxyPort(this.options);
      const plan = await planHop(current, proxyPort, signal);

      let response;
      try {
        response = await sendRequest(current, plan, signal);
      } catch (error) {
        /* 代理刚退出 / 端口刚失联：这一跳退回直连重试一次。 */
        if (plan.route !== 'proxy' || signal?.aborted || !isTransportFailure(error)) throw error;
        const directPlan = await planHop(current, undefined, signal);
        response = await sendRequest(current, directPlan, signal);
      }

      try {
        if (isRedirect(response.status)) {
          if (redirects >= this.limits.maxRedirects) {
            throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED');
          }
          const location = response.headers.location;
          if (location === undefined) {
            throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR');
          }
          let target;
          try {
            target = new URL(location, current);
          } catch (error) {
            throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error });
          }
          validateUrl(target.href);
          if (!sameOrigin(target, current)) {
            throw new WebError(
              `cross-origin redirect to ${target.origin} is not followed automatically; retry against that URL directly`,
              'WEB_REDIRECT_BLOCKED',
            );
          }
          current = target;
          redirects += 1;
          continue;
        }
        return await this.readBody(response, current, signal);
      } finally {
        response.close();
      }
    }
  }

  async readBody(response, finalUrl, signal) {
    const contentType = response.headers['content-type'];
    const kind = classifyContentType(contentType);
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE');
    }
    const decoder = decoderForCharset(parseCharset(contentType));

    const declared = response.headers['content-length'];
    if (declared !== undefined && Number(declared) > this.limits.maxResponseBytes) {
      throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE');
    }

    const chunks = [];
    let total = 0;
    let truncatedByBytes = false;
    try {
      for await (const chunk of response.stream) {
        const remaining = this.limits.maxResponseBytes - total;
        if (chunk.length >= remaining) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
          truncatedByBytes = true;
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
    } catch (error) {
      throw translate(error, signal, undefined);
    }

    const content = decoder.decode(Buffer.concat(chunks));
    const truncatedByChars = content.length > this.limits.maxBodyChars;
    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body: {
        kind,
        content: truncatedByChars ? content.slice(0, this.limits.maxBodyChars) : content,
      },
      truncated: truncatedByBytes || truncatedByChars,
    };
  }
}

function validateUrl(input) {
  if (input.length > 2048) throw new WebError('URL exceeds the maximum length of 2048', 'WEB_INVALID_URL');
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL');
  }
  return url;
}

function translate(error, signal, timeout) {
  if (error instanceof WebError) return error;
  if (timeout !== undefined && timeout.aborted) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error });
  if (signal?.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error });
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
}

/* ------------------------------------------------------------------ 插件入口 */

export const name = 'web-fetch-clash';
export const inject = ['web'];

export function apply(ctx, config) {
  const options = config ?? {};
  const limits = {
    maxResponseBytes: options.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
    maxBodyChars: options.maxBodyChars ?? DEFAULTS.maxBodyChars,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxRedirects: options.maxRedirects ?? DEFAULTS.maxRedirects,
    userAgent: options.userAgent ?? DEFAULTS.userAgent,
  };
  ctx.effect(function* () {
    const dispose = ctx.web.registerFetchProvider(new ClashFetchProvider(limits, options));
    yield () => dispose();
  }, 'web-fetch-clash.registerFetchProvider()');
}
