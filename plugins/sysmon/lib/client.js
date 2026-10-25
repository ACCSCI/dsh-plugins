window.__ModuleLoader__.load({
  id: '@accsci/dsh-sysmon',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Host route registered by this package's Host half. */
    const ENDPOINT = '/sysmon/stats';
    const POLL_MS = 2000;

    /**
     * One polling feed shared by every dock cell, so several open Sessions and a
     * remount never multiply the request rate.
     * @param {string} endpoint - Host route returning the metrics snapshot.
     * @param {number} intervalMs - poll cadence.
     */
    function createFeed(endpoint, intervalMs) {
      let state = { status: 'idle', data: null, error: null };
      const listeners = new Set();
      let timer = null;
      let inflight = false;

      function publish(next) {
        state = next;
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            globalThis.console?.error('[sysmon] subscriber failed', error);
          }
        }
      }

      async function poll() {
        if (inflight) return;
        if (globalThis.document?.visibilityState === 'hidden') return;
        inflight = true;
        try {
          const response = await fetch(endpoint, { cache: 'no-store', headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          publish({ status: 'ready', data, error: null });
        } catch (error) {
          // A single failed poll keeps the last reading on screen; only a feed that
          // never produced one reports "unavailable".
          publish({
            status: state.data === null ? 'unavailable' : 'stale',
            data: state.data,
            error: String((error && error.message) || error),
          });
        } finally {
          inflight = false;
        }
      }

      function onVisibility() {
        if (globalThis.document?.visibilityState === 'visible') void poll();
      }

      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        start() {
          if (timer !== null) return;
          void poll();
          timer = globalThis.setInterval(() => void poll(), intervalMs);
          globalThis.document?.addEventListener('visibilitychange', onVisibility);
        },
        stop() {
          if (timer !== null) {
            globalThis.clearInterval(timer);
            timer = null;
          }
          globalThis.document?.removeEventListener('visibilitychange', onVisibility);
        },
      };
    }

    /** Severity tone for one percentage reading. */
    function toneOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'idle';
      if (value >= 90) return 'hot';
      if (value >= 75) return 'warn';
      return 'ok';
    }

    function percentText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return Math.round(value) + '%';
    }

    function gigabytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
      return (bytes / 1073741824).toFixed(1);
    }

    const STYLES = `
.dsysmon_root{display:flex;align-items:center;gap:10px;line-height:1;color:var(--dsw-alias-label-secondary);user-select:none}
.dsysmon_metric{display:flex;flex-direction:column;gap:3px;min-width:56px;cursor:default}
.dsysmon_row{display:flex;align-items:baseline;justify-content:space-between;gap:6px}
.dsysmon_label{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);opacity:.8}
.dsysmon_value{font-size:12px;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsysmon_value[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dsysmon_value[data-tone="hot"]{color:var(--dsw-alias-state-error-primary)}
.dsysmon_value[data-tone="idle"]{color:var(--dsw-alias-label-secondary)}
.dsysmon_track{position:relative;height:2px;border-radius:1px;background:var(--dsw-alias-border-l1);overflow:hidden}
.dsysmon_fill{position:absolute;top:0;bottom:0;left:0;border-radius:1px;background:var(--dsw-alias-brand-primary);transition:width .45s ease}
.dsysmon_fill[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}
.dsysmon_fill[data-tone="hot"]{background:var(--dsw-alias-state-error-primary)}
.dsysmon_fill[data-tone="idle"]{background:var(--dsw-alias-state-idle-primary);opacity:.6}
.dsysmon_root[data-state="unavailable"] .dsysmon_value,.dsysmon_root[data-state="unavailable"] .dsysmon_label{opacity:.45}
@media (prefers-reduced-motion:reduce){.dsysmon_fill{transition:none}}
`;

    function Metric(props) {
      const width = typeof props.pct === 'number' && Number.isFinite(props.pct)
        ? Math.max(2, Math.min(100, props.pct)) + '%'
        : '0%';
      return h(
        'div',
        { className: 'dsysmon_metric', title: props.title || undefined },
        h(
          'div',
          { className: 'dsysmon_row' },
          h('span', { className: 'dsysmon_label' }, props.label),
          h('span', { className: 'dsysmon_value', 'data-tone': props.tone }, props.text),
        ),
        h(
          'div',
          { className: 'dsysmon_track' },
          h('div', { className: 'dsysmon_fill', 'data-tone': props.tone, style: { width } }),
        ),
      );
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        // Locale is optional: without it the widget still reads correctly through
        // the English fallbacks below.
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        let t = null;
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(
            () => locale.register('sysmon', {
              en: {
                'group.label': 'System resource usage',
                'tip.cpu': 'CPU {pct}% · {cores} logical processors',
                'tip.mem': 'Memory {used} / {total} GB used ({pct}%)',
                'tip.gpu': 'GPU {pct}% · {dedicated} MB dedicated memory',
                'tip.gpu.plain': 'GPU {pct}%',
                'tip.gpu.unavailable': 'GPU reading unavailable',
                'state.offline': 'No reading from the Host yet',
              },
              zh: {
                'group.label': '系统资源占用',
                'tip.cpu': 'CPU {pct}% · {cores} 个逻辑处理器',
                'tip.mem': '内存已用 {used} / {total} GB（{pct}%）',
                'tip.gpu': 'GPU {pct}% · 专用显存 {dedicated} MB',
                'tip.gpu.plain': 'GPU {pct}%',
                'tip.gpu.unavailable': '暂时无法读取 GPU 占用',
                'state.offline': '尚未收到宿主的读数',
              },
            }),
            'sysmon: locale dictionary',
          );
          t = locale.bind('sysmon');
        }

        /** Translate one key, falling back to English when no dictionary is bound. */
        function translate(key, values, fallback) {
          if (t === null) return fallback;
          const text = t(key, values);
          return text === key ? fallback : text;
        }

        const feed = createFeed(ENDPOINT, POLL_MS);

        function Widget() {
          const [snapshot, setSnapshot] = React.useState(feed.get);
          React.useEffect(() => feed.subscribe(() => setSnapshot(feed.get())), []);

          const data = snapshot.data;
          const cpu = data?.cpu?.pct ?? null;
          const memPct = data?.mem?.pct ?? null;
          const gpuPct = data?.gpu?.available ? data.gpu.pct : null;
          const cores = data?.host?.cores ?? null;

          const cpuTitle = cpu === null
            ? undefined
            : translate('tip.cpu', { pct: Math.round(cpu), cores: cores ?? '—' }, 'CPU ' + Math.round(cpu) + '%');
          const memTitle = memPct === null || !data
            ? undefined
            : translate(
              'tip.mem',
              {
                used: gigabytes(data.mem.used),
                total: gigabytes(data.mem.total),
                pct: Math.round(memPct),
              },
              'Memory ' + gigabytes(data.mem.used) + ' / ' + gigabytes(data.mem.total) + ' GB',
            );
          let gpuTitle;
          if (gpuPct === null) {
            gpuTitle = translate('tip.gpu.unavailable', undefined, 'GPU reading unavailable');
          } else if (typeof data.gpu.dedicatedMB === 'number' && data.gpu.dedicatedMB > 0) {
            gpuTitle = translate(
              'tip.gpu',
              { pct: Math.round(gpuPct), dedicated: Math.round(data.gpu.dedicatedMB) },
              'GPU ' + Math.round(gpuPct) + '%',
            );
          } else {
            gpuTitle = translate('tip.gpu.plain', { pct: Math.round(gpuPct) }, 'GPU ' + Math.round(gpuPct) + '%');
          }

          return h(
            React.Fragment,
            null,
            h('style', { key: 'style' }, STYLES),
            h(
              'div',
              {
                key: 'root',
                className: 'dsysmon_root',
                role: 'group',
                'data-state': snapshot.status,
                'aria-label': translate('group.label', undefined, 'System resource usage'),
                title: snapshot.status === 'unavailable'
                  ? translate('state.offline', undefined, 'No reading from the Host yet')
                  : undefined,
              },
              h(Metric, { label: 'CPU', text: percentText(cpu), pct: cpu, tone: toneOf(cpu), title: cpuTitle }),
              h(Metric, { label: 'MEM', text: percentText(memPct), pct: memPct, tone: toneOf(memPct), title: memTitle }),
              h(Metric, { label: 'GPU', text: percentText(gpuPct), pct: gpuPct, tone: toneOf(gpuPct), title: gpuTitle }),
            ),
          );
        }

        ctx.effect(() => {
          feed.start();
          return () => feed.stop();
        }, 'sysmon: feed');

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'sysmon', order: 2, label: 'System usage' },
          Widget,
        ));
      },
    };
  },
});
