/**
 * Host half of the system-monitor bundle.
 *
 * CPU and memory are read from the Host process itself (`node:os`), so they cost
 * nothing and need no subprocess. GPU utilization is only published through the
 * Windows performance counters, which require a native PDH caller: one small
 * PowerShell process keeps a single PDH query open and streams one line per
 * sample (see `gpu-sampler.ps1`).
 *
 * The Client half polls `GET /sysmon/stats`. That route is a plain `webServer`
 * route rather than a Remote endpoint, so the widget needs no generated codec
 * and no Remote contribution to mount.
 */
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(PACKAGE_DIR, 'gpu-sampler.ps1');

/** Route the Client half polls. Kept outside `/api`, which requires authentication. */
const ROUTE = '/sysmon/stats';

const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 60000;

/** Shells to try for the GPU sampler: the light 5.1 host first, PowerShell 7 second. */
const SHELLS = ['powershell.exe', 'pwsh'];

/** Give up restarting the sampler after this many crashes in one activation. */
const MAX_RESTARTS = 4;

/**
 * Sum the CPU time counters the kernel keeps per logical processor.
 * @returns {{ idle: number, total: number }} cumulative ticks.
 */
function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Normalize the bundle row config.
 *
 * Exported for the test suite: the clamp is the only part of the sampler that is
 * observable without spawning a sampler process.
 * @param {Record<string, unknown> | undefined} config - Loader row config.
 * @returns {{ intervalMs: number, gpu: boolean }} resolved options.
 */
export function readOptions(config) {
  const raw = config ?? {};
  const requested = Number(raw.intervalMs);
  const intervalMs = Number.isFinite(requested)
    ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, requested))
    : DEFAULT_INTERVAL_MS;
  return { intervalMs, gpu: raw.gpu !== false };
}

/**
 * Sampling state shared by the timer and the HTTP handler.
 * @param {{ intervalMs: number, gpu: boolean }} options - resolved row config.
 */
function createSampler(options) {
  const cores = os.cpus().length;
  let previous = cpuTotals();
  let running = false;
  let timer = null;

  const state = {
    ts: 0,
    host: { platform: process.platform, cores },
    cpu: { pct: null, cores },
    mem: { used: 0, total: os.totalmem(), pct: 0 },
    gpu: { pct: null, dedicatedMB: null, sharedMB: null, available: false, detail: 'idle' },
  };

  /** GPU child process bookkeeping. */
  let child = null;
  let shellIndex = 0;
  let restarts = 0;
  let restartTimer = null;
  let givingUp = false;

  function sampleCpu() {
    const now = cpuTotals();
    const total = now.total - previous.total;
    const idle = now.idle - previous.idle;
    previous = now;
    if (total <= 0) return;
    state.cpu.pct = Math.min(100, Math.max(0, 100 * (1 - idle / total)));
  }

  function sampleMemory() {
    const total = os.totalmem();
    const free = os.freemem();
    state.mem = {
      used: Math.max(0, total - free),
      total,
      pct: total > 0 ? Math.min(100, Math.max(0, ((total - free) / total) * 100)) : 0,
    };
  }

  function tick() {
    sampleCpu();
    sampleMemory();
    state.ts = Date.now();
  }

  /**
   * Consume one sampler line: `<percent>|<dedicated MB>|<shared MB>`, or `err|<reason>`.
   * @param {string} line - one trimmed stdout line.
   */
  function applyGpuLine(line) {
    if (line.length === 0) return;
    if (line.startsWith('err')) {
      state.gpu = { ...state.gpu, pct: null, available: false, detail: line };
      return;
    }
    const [rawPct, rawDedicated, rawShared] = line.split('|');
    const pct = Number(rawPct);
    if (!Number.isFinite(pct)) return;
    const dedicated = Number(rawDedicated);
    const shared = Number(rawShared);
    state.gpu = {
      pct: Math.min(100, Math.max(0, pct)),
      dedicatedMB: Number.isFinite(dedicated) ? dedicated : null,
      sharedMB: Number.isFinite(shared) ? shared : null,
      available: true,
      detail: 'ok',
    };
  }

  function scheduleRestart() {
    if (!running || givingUp) return;
    if (restarts >= MAX_RESTARTS) {
      givingUp = true;
      state.gpu = { ...state.gpu, pct: null, available: false, detail: 'sampler-stopped' };
      return;
    }
    restarts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launchGpu();
    }, 4000 * restarts);
    restartTimer.unref?.();
  }

  function launchGpu() {
    if (!running || child !== null || !options.gpu || process.platform !== 'win32') return;
    if (shellIndex >= SHELLS.length) {
      givingUp = true;
      state.gpu = { ...state.gpu, detail: 'no-powershell' };
      return;
    }

    const shell = SHELLS[shellIndex];
    const spawned = spawn(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let buffer = '';
    let settled = false;
    let sawSample = false;
    child = spawned;

    spawned.stdout.setEncoding('utf8');
    spawned.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (!trimmed.startsWith('err')) sawSample = true;
        applyGpuLine(trimmed);
      }
    });
    // A sampler that fails before reporting is retried on the other shell, so its
    // stderr is diagnostic only and never reaches the user's console.
    spawned.stderr.on('data', () => {});

    spawned.on('error', (error) => {
      if (settled) return;
      settled = true;
      child = null;
      if (error && error.code === 'ENOENT') {
        shellIndex += 1;
        launchGpu();
        return;
      }
      state.gpu = { ...state.gpu, available: false, detail: 'spawn-failed' };
      scheduleRestart();
    });

    spawned.on('exit', () => {
      if (settled) return;
      settled = true;
      child = null;
      if (!sawSample) shellIndex = Math.min(shellIndex + 1, SHELLS.length);
      state.gpu = { ...state.gpu, pct: null, available: false, detail: 'stopped' };
      scheduleRestart();
    });
  }

  function snapshot() {
    return {
      ts: state.ts,
      host: state.host,
      cpu: state.cpu,
      mem: state.mem,
      gpu: state.gpu,
    };
  }

  function start() {
    if (running) return;
    running = true;
    previous = cpuTotals();
    tick();
    timer = setInterval(tick, options.intervalMs);
    // The GPU sampler is the only part that costs anything, so it starts with the
    // first interested Client instead of at plugin activation.
    launchGpu();
  }

  function stop() {
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const runningChild = child;
    child = null;
    if (runningChild !== null) {
      try {
        runningChild.kill();
      } catch {
        // A child that already exited needs no cleanup.
      }
    }
  }

  /**
   * `webServer` route handler for the Client poll.
   * @param {import('node:http').IncomingMessage} request - incoming request.
   * @param {import('node:http').ServerResponse} response - response to fill.
   */
  function handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      response.end('method not allowed');
      return;
    }
    const body = JSON.stringify(snapshot());
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  return { start, stop, handle, snapshot };
}

/**
 * @param {import('cordis').Context} ctx - Host plugin context.
 * @param {{ intervalMs?: number, gpu?: boolean }} [config] - Loader row config.
 */
export function apply(ctx, config) {
  const options = readOptions(config);
  const sampler = createSampler(options);

  ctx.effect(() => {
    sampler.start();
    return () => sampler.stop();
  }, 'sysmon: sampler');

  ctx.inject(['webServer'], (webContext) => {
    webContext.effect(
      () => webContext.webServer.register({ kind: 'exact', path: ROUTE, handler: sampler.handle }),
      'sysmon: stats route',
    );
  });
}
