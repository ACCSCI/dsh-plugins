window.__ModuleLoader__.load({
  id: '@accsci/dsh-auto-retry',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Host route registered by this package's Host half. */
    const ENDPOINT = '/auto-retry/api/state';
    /** Status poll cadence; the request is tiny and only runs while visible. */
    const POLL_MS = 3000;
    /** Locale namespace owned by this package. */
    const NS = 'auto-retry';

    /**
     * One shared view of the Host switch, used by both the header pill and the
     * settings page so a flip in either place moves the other immediately.
     */
    function createStore() {
      let state = { status: 'loading', data: null, error: null, saving: false, saveError: null };
      const listeners = new Set();
      let timer = null;
      let inflight = false;

      function publish(next) {
        state = next;
        for (const listener of listeners) {
          try {
            listener();
          } catch (error) {
            globalThis.console?.error('[auto-retry] subscriber failed', error);
          }
        }
      }

      function describeError(error) {
        return String((error && error.message) || error || 'unknown error');
      }

      async function refresh() {
        if (inflight) return;
        inflight = true;
        try {
          const response = await fetch(ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          publish({ ...state, status: 'ready', data, error: null });
        } catch (error) {
          publish({ ...state, status: state.data === null ? 'unavailable' : 'stale', error: describeError(error) });
        } finally {
          inflight = false;
        }
      }

      async function update(patch) {
        publish({ ...state, saving: true, saveError: null });
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(patch),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) throw new Error((data && data.message) || 'HTTP ' + response.status);
          publish({
            ...state,
            status: 'ready',
            data,
            error: null,
            saving: false,
            saveError: data && data.persisted === false ? 'unsaved' : null,
          });
          return true;
        } catch (error) {
          publish({ ...state, saving: false, saveError: describeError(error) });
          return false;
        }
      }

      function onVisibility() {
        if (globalThis.document?.visibilityState === 'visible') void refresh();
      }

      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        start() {
          if (timer !== null) return;
          void refresh();
          timer = globalThis.setInterval(() => {
            if (globalThis.document?.visibilityState !== 'hidden') void refresh();
          }, POLL_MS);
          globalThis.document?.addEventListener('visibilitychange', onVisibility);
        },
        stop() {
          if (timer !== null) {
            globalThis.clearInterval(timer);
            timer = null;
          }
          globalThis.document?.removeEventListener('visibilitychange', onVisibility);
        },
        refresh,
        update,
      };
    }

    function useStore(store) {
      const [snapshot, setSnapshot] = React.useState(store.get);
      React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), [store]);
      return snapshot;
    }

    /** Seconds for a millisecond value, rounded to one decimal for the display. */
    function seconds(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
      return Math.round((ms / 1000) * 10) / 10;
    }

    const PILL_STYLES = `
.dar_pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:13px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:color .15s ease,border-color .15s ease,background-color .15s ease}
.dar_pill:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dar_pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dar_pill[data-enabled="true"]{color:var(--dsw-alias-label-primary)}
.dar_pill[data-enabled="true"] .dar_dot{background:var(--dsw-alias-brand-primary)}
.dar_pill[data-pending="true"]{cursor:progress;opacity:.7}
.dar_pill[data-state="unavailable"]{opacity:.55}
.dar_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dar_pill[data-active="true"] .dar_dot{background:var(--dsw-alias-state-warn-primary);animation:dar_pulse 1.4s ease-in-out infinite}
.dar_count{color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
@keyframes dar_pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dar_pill[data-active="true"] .dar_dot{animation:none}}
`;

    const PAGE_STYLES = `
.dar_page{display:flex;flex-direction:column;gap:18px;max-width:640px}
.dar_heading{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dar_intro{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dar_card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
.dar_row{display:flex;align-items:flex-start;gap:14px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
.dar_row + .dar_row{border-top:1px solid var(--dsw-alias-border-l1)}
.dar_copy{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.dar_label{font-size:13px;color:var(--dsw-alias-label-primary)}
.dar_hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dar_control{flex:none;display:flex;align-items:center;gap:8px;padding-top:1px}
.dar_switch{appearance:none;position:relative;width:34px;height:20px;margin:0;border-radius:10px;flex:none;cursor:pointer;
  background:var(--dsw-alias-border-l2);transition:background-color .15s ease}
.dar_switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-bg-base);transition:transform .15s ease}
.dar_switch:checked{background:var(--dsw-alias-brand-primary)}
.dar_switch:checked::after{transform:translateX(14px)}
.dar_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dar_number{width:74px;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;
  font-variant-numeric:tabular-nums;text-align:right}
.dar_number:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dar_unit{font-size:12px;color:var(--dsw-alias-label-secondary);width:18px}
.dar_note{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-height:18px}
.dar_note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dar_note[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dar_list{margin:0;padding:10px 14px 12px;display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.5;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dar_list b{font-weight:600;color:var(--dsw-alias-label-primary)}
.dar_codes{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.7;
  word-break:break-word;color:var(--dsw-alias-label-secondary)}
`;

    /**
     * Register both faces.
     * @param {import('cordis').Context} ctx - browser plugin context.
     */
    return {
      inject: ['slots'],

      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        let t = null;
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, {
            en: {
              'nav': 'Auto retry',
              'pill.on': 'Auto retry on',
              'pill.off': 'Auto retry off',
              'pill.active': '{count} retrying',
              'pill.title.on': 'Transient provider failures are retried until they succeed. Click to turn off.',
              'pill.title.off': 'Model requests fail after the built-in retries. Click to retry transient provider failures until they succeed.',
              'pill.saving': 'Saving…',
              'pill.failed': 'Could not save the switch',
              'title': 'Auto retry',
              'intro': 'When a provider fails for a temporary reason — a timeout, a dropped stream, a rate limit, a 5xx — retry the model request until it succeeds. Permanent failures stop immediately: an exhausted balance, rejected credentials, or a malformed request is never retried.',
              'enable.label': 'Enable auto retry',
              'enable.hint': 'On: transient failures retry without an attempt limit. Off: the built-in five-attempt policy only.',
              'initial.label': 'First wait',
              'initial.hint': 'How long to wait before the first retry. Later waits grow from here, with ±20% jitter.',
              'max.label': 'Longest wait',
              'max.hint': 'Upper bound for one wait. A provider Retry-After above this is ignored.',
              'unknown.label': 'Also retry unknown failures',
              'unknown.hint': 'Failures this plugin cannot classify. Off by default, because a permanently broken request would be repeated forever.',
              'unit.seconds': 's',
              'codes.retried': 'Retried:',
              'codes.stopped': 'Stopped at once:',
              'codes.note': 'Context overflow, image offload, and your own Stop keep the behavior the rest of the app already provides.',
              'status.idle': 'No retry is waiting right now.',
              'status.active': '{count} retry waiting · next in {seconds}s',
              'status.loading': 'Reading the switch from the Host…',
              'status.unavailable': 'The Host is not answering; the switch shown here may be stale.',
              'status.saved': 'Saved.',
              'status.saving': 'Saving…',
              'status.unsaved': 'Changed, but the Host could not save it. It applies until this DSH restarts.',
              'status.failed': 'Could not save: {message}',
              'last.retry': 'Last retry: {code} (attempt {retry}), waiting {seconds}s.',
              'last.stop': 'Last stop: {code} —{message}',
            },
            zh: {
              'nav': '自动重试',
              'pill.on': '自动重试 开',
              'pill.off': '自动重试 关',
              'pill.active': '{count} 个重试进行中',
              'pill.title.on': '供应商临时故障会自动重试到成功。点击关闭。',
              'pill.title.off': '模型请求只走内置重试。点击开启：临时故障会一直重试到成功。',
              'pill.saving': '保存中…',
              'pill.failed': '开关保存失败',
              'title': '自动重试',
              'intro': '供应商因为临时原因失败时——超时、连接中断、限流、5xx——把这次模型请求重试到成功。永久性问题立即停止：余额/额度耗尽、鉴权失败、请求本身非法，都不会重试。',
              'enable.label': '启用自动重试',
              'enable.hint': '开：临时故障不限次数重试。关：只保留内置的 5 次策略。',
              'initial.label': '首次等待',
              'initial.hint': '第一次重试前等多久。之后的等待从这里指数增长，带 ±20% 抖动。',
              'max.label': '最长等待',
              'max.hint': '单次等待的上限。供应商给出的 Retry-After 超过它时按本地退避处理。',
              'unknown.label': '未知失败也重试',
              'unknown.hint': '插件无法归类的失败。默认关闭：真正坏掉的请求会被反复重发。',
              'unit.seconds': '秒',
              'codes.retried': '会重试：',
              'codes.stopped': '会立即停止：',
              'codes.note': '上下文超限、图片卸载，以及你手动点停止，仍按应用原本的机制处理。',
              'status.idle': '当前没有等待中的重试。',
              'status.active': '{count} 个重试在等待 · 下一次在 {seconds}s 后',
              'status.loading': '正在从宿主读取开关…',
              'status.unavailable': '宿主没有响应，这里显示的开关可能已过期。',
              'status.saved': '已保存。',
              'status.saving': '保存中…',
              'status.unsaved': '已生效，但宿主没能写入文件；重启 DSH 后会恢复成上次保存的值。',
              'status.failed': '保存失败：{message}',
              'last.retry': '最近一次重试：{code}（第 {retry} 次），等待 {seconds} 秒。',
              'last.stop': '最近一次停止：{code} ——{message}',
            },
          }), 'auto-retry: locale dictionaries');
          t = locale.bind(NS);
        }

        /** Translate one key, falling back to the supplied English text. */
        function translate(key, values, fallback) {
          if (t === null) return fallback;
          const text = t(key, values);
          return text === key ? fallback : text;
        }

        const store = createStore();
        ctx.effect(() => {
          store.start();
          return () => store.stop();
        }, 'auto-retry: status feed');

        function RetryPill() {
          const snapshot = useStore(store);
          const data = snapshot.data;
          const enabled = data?.enabled === true;
          const active = data?.active?.count ?? 0;
          const pending = snapshot.saving;
          const title = pending
            ? translate('pill.saving', undefined, 'Saving…')
            : snapshot.saveError === 'unsaved'
              ? translate('pill.failed', undefined, 'Could not save the switch')
              : translate(enabled ? 'pill.title.on' : 'pill.title.off', undefined, enabled
                ? 'Transient provider failures are retried until they succeed. Click to turn off.'
                : 'Transient failures are not retried. Click to enable.');
          const label = pending
            ? translate('pill.saving', undefined, 'Saving…')
            : translate(enabled ? 'pill.on' : 'pill.off', undefined, enabled ? 'Auto retry on' : 'Auto retry off');

          return h(
            React.Fragment,
            null,
            h('style', null, PILL_STYLES),
            h(
              'button',
              {
                type: 'button',
                className: 'dar_pill',
                'data-enabled': enabled ? 'true' : 'false',
                'data-active': active > 0 ? 'true' : 'false',
                'data-pending': pending ? 'true' : 'false',
                'data-state': snapshot.status,
                'aria-pressed': enabled,
                'aria-label': title,
                title,
                disabled: pending || data === null,
                onClick: () => { void store.update({ enabled: !enabled }); },
              },
              h('span', { className: 'dar_dot' }),
              h('span', null, label),
              active > 0
                ? h('span', { className: 'dar_count' }, translate('pill.active', { count: active }, active + ' retrying'))
                : null,
            ),
          );
        }

        /** A number field that commits on blur or Enter, so typing is never overwritten by a poll. */
        function NumberField(props) {
          const commit = (event) => {
            const parsed = Number(event.currentTarget.value);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              event.currentTarget.value = String(props.value);
              return;
            }
            props.onCommit(parsed);
          };
          return h('input', {
            className: 'dar_number',
            type: 'number',
            min: props.min,
            max: props.max,
            step: props.step,
            defaultValue: String(props.value),
            'aria-label': props.label,
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            },
          });
        }

        function AutoRetrySettings() {
          const snapshot = useStore(store);
          const data = snapshot.data;
          const settings = data?.settings ?? {};
          const enabled = data?.enabled === true;
          const initialSeconds = seconds(settings.initialDelayMs ?? 2000) ?? 2;
          const maxSeconds = seconds(settings.maxDelayMs ?? 60000) ?? 60;
          const active = data?.active?.count ?? 0;

          let noteTone = 'muted';
          let noteText = translate('status.loading', undefined, 'Reading the switch from the Host…');
          if (snapshot.saving) {
            noteText = translate('status.saving', undefined, 'Saving…');
          } else if (snapshot.saveError !== null && snapshot.saveError !== 'unsaved') {
            noteTone = 'error';
            noteText = translate('status.failed', { message: snapshot.saveError }, 'Could not save: ' + snapshot.saveError);
          } else if (snapshot.saveError === 'unsaved') {
            noteTone = 'error';
            noteText = translate('status.unsaved', undefined, 'Applied, but the Host could not save it.');
          } else if (snapshot.status === 'unavailable') {
            noteTone = 'error';
            noteText = translate('status.unavailable', undefined, 'The Host is not answering.');
          } else if (data !== null) {
            noteTone = 'ok';
            noteText = translate('status.saved', undefined, 'Saved.');
          }

          const activity = active > 0
            ? translate(
              'status.active',
              { count: active, seconds: Math.max(1, Math.round((data?.active?.nextInMs ?? 0) / 1000)) },
              active + ' retry waiting',
            )
            : translate('status.idle', undefined, 'No retry is waiting right now.');

          const last = data?.last;
          let lastLine = null;
          if (last !== null && last !== undefined) {
            if (last.decision === 'stop') {
              lastLine = translate(
                'last.stop',
                { code: last.code, message: last.message ? ' ' + last.message : '' },
                'Last stop: ' + last.code,
              );
            } else {
              lastLine = translate(
                'last.retry',
                { code: last.code, retry: last.retry, seconds: seconds(last.delayMs) ?? 0 },
                'Last retry: ' + last.code + ' (attempt ' + last.retry + ')',
              );
            }
          }

          return h(
            React.Fragment,
            null,
            h('style', null, PAGE_STYLES),
            h(
              'section',
              { className: 'dar_page', 'aria-label': translate('nav', undefined, 'Auto retry') },
              h('h2', { className: 'dar_heading' }, translate('title', undefined, 'Auto retry')),
              h('p', { className: 'dar_intro' }, translate('intro', undefined, 'Retry transient provider failures until they succeed.')),
              h(
                'div',
                { className: 'dar_card' },
                h(
                  'div',
                  { className: 'dar_row' },
                  h(
                    'div',
                    { className: 'dar_copy' },
                    h('span', { className: 'dar_label' }, translate('enable.label', undefined, 'Enable auto retry')),
                    h('span', { className: 'dar_hint' }, translate('enable.hint', undefined, '')),
                  ),
                  h(
                    'div',
                    { className: 'dar_control' },
                    h('input', {
                      className: 'dar_switch',
                      type: 'checkbox',
                      role: 'switch',
                      checked: enabled,
                      disabled: data === null || snapshot.saving,
                      'aria-label': translate('enable.label', undefined, 'Enable auto retry'),
                      onChange: (event) => { void store.update({ enabled: event.currentTarget.checked }); },
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'dar_row' },
                  h(
                    'div',
                    { className: 'dar_copy' },
                    h('span', { className: 'dar_label' }, translate('initial.label', undefined, 'First wait')),
                    h('span', { className: 'dar_hint' }, translate('initial.hint', undefined, '')),
                  ),
                  h(
                    'div',
                    { className: 'dar_control' },
                    h(NumberField, {
                      key: 'initial-' + initialSeconds,
                      value: initialSeconds,
                      min: 0.2,
                      max: 600,
                      step: 0.5,
                      label: translate('initial.label', undefined, 'First wait'),
                      onCommit: (value) => { void store.update({ initialDelayMs: Math.round(value * 1000) }); },
                    }),
                    h('span', { className: 'dar_unit' }, translate('unit.seconds', undefined, 's')),
                  ),
                ),
                h(
                  'div',
                  { className: 'dar_row' },
                  h(
                    'div',
                    { className: 'dar_copy' },
                    h('span', { className: 'dar_label' }, translate('max.label', undefined, 'Longest wait')),
                    h('span', { className: 'dar_hint' }, translate('max.hint', undefined, '')),
                  ),
                  h(
                    'div',
                    { className: 'dar_control' },
                    h(NumberField, {
                      key: 'max-' + maxSeconds,
                      value: maxSeconds,
                      min: 1,
                      max: 600,
                      step: 1,
                      label: translate('max.label', undefined, 'Longest wait'),
                      onCommit: (value) => { void store.update({ maxDelayMs: Math.round(value * 1000) }); },
                    }),
                    h('span', { className: 'dar_unit' }, translate('unit.seconds', undefined, 's')),
                  ),
                ),
                h(
                  'div',
                  { className: 'dar_row' },
                  h(
                    'div',
                    { className: 'dar_copy' },
                    h('span', { className: 'dar_label' }, translate('unknown.label', undefined, 'Also retry unknown failures')),
                    h('span', { className: 'dar_hint' }, translate('unknown.hint', undefined, '')),
                  ),
                  h(
                    'div',
                    { className: 'dar_control' },
                    h('input', {
                      className: 'dar_switch',
                      type: 'checkbox',
                      role: 'switch',
                      checked: settings.retryUnknown === true,
                      disabled: data === null || snapshot.saving,
                      'aria-label': translate('unknown.label', undefined, 'Also retry unknown failures'),
                      onChange: (event) => { void store.update({ retryUnknown: event.currentTarget.checked }); },
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'dar_list' },
                  h('span', null, h('b', null, translate('codes.retried', undefined, 'Retried:')), ' TIMEOUT · TRANSPORT · SERVER · RATE_LIMIT · EMPTY_RESPONSE · STREAM_CLOSED · MALFORMED_RESPONSE · HTTP 429/5xx'),
                  h('span', null, h('b', null, translate('codes.stopped', undefined, 'Stopped at once:')), ' QUOTA · ACCOUNT_QUOTA · AUTH · INVALID_CREDENTIAL · INVALID_REQUEST · MODEL_UNSUPPORTED · HTTP 402/403'),
                  h('span', { className: 'dar_codes' }, translate('codes.note', undefined, '')),
                ),
              ),
              h(
                'div',
                { className: 'dar_note', 'data-tone': noteTone, role: 'status', 'aria-live': 'polite' },
                noteText,
              ),
              h('div', { className: 'dar_note' }, activity),
              lastLine === null ? null : h('div', { className: 'dar_note' }, lastLine),
            ),
          );
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'auto-retry',
          order: 60,
          label: () => translate('nav', undefined, 'Auto retry'),
        }, AutoRetrySettings));

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'auto-retry',
          order: 40,
          label: () => translate('pill.on', undefined, 'Auto retry'),
        }, RetryPill));
      },
    };
  },
});
