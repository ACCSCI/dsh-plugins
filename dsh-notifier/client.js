/* Task Notifier — Client half.
 *
 * The header bell opens a notification centre (unread badge, per-item read,
 * jump-to-session, clear all). Incoming events still float as toasts in the
 * frame overlay, and the list persists across reloads.
 */
window.__ModuleLoader__.load({
  id: '@accsci/dsh-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const FEED_PATH = '/plugins/dsh-notifier/feed'
    const NS = 'dsh-notifier'
    const LOG_KEY = 'dsh-notifier.log'
    const SETTINGS_KEY = 'dsh-notifier.settings'
    const LOG_MAX = 50
    const MAX_TOASTS = 3
    const TOAST_TTL = { complete: 6000, error: 14000 }
    const CATCH_UP_MS = 10 * 60 * 1000
    const CATCH_UP_MAX = 3

    const DICT = {
      en: {
        complete: 'Task finished',
        error: 'Task failed',
        subagent: 'subagent',
        unknown: 'Session',
        notifications: 'Notifications',
        empty: 'No notifications yet.',
        emptyHint: 'They appear when a task finishes or fails.',
        clearAll: 'Clear all',
        markAllRead: 'Mark all read',
        markRead: 'Mark read',
        unread: 'unread',
        enableDesktop: 'Enable desktop notifications',
        dnd: 'Quiet hours',
        muted: 'muted',
        dndFrom: 'Quiet from',
        dndTo: 'Quiet until',
        dndHint: 'recorded, no popup',
        testTitle: 'Test notification',
        testBody: 'If you can read this, the notifier is wired up.',
        offlineTitle: 'Notifier cannot reach the local service',
        justNow: 'just now',
        minutesAgo: 'min ago',
        dismiss: 'Dismiss',
        open: 'Open',
        clearConfirm: 'Clear all notifications?',
      },
      zh: {
        complete: '任务已完成',
        error: '任务出错',
        subagent: '子代理',
        unknown: '会话',
        notifications: '通知',
        empty: '还没有通知',
        emptyHint: '任务完成或出错时会出现在这里。',
        clearAll: '清空',
        markAllRead: '全部已读',
        markRead: '标记已读',
        unread: '条未读',
        enableDesktop: '开启桌面通知',
        dnd: '免打扰',
        muted: '静音中',
        dndFrom: '免打扰开始',
        dndTo: '免打扰结束',
        dndHint: '只记录不提醒',
        testTitle: '测试通知',
        testBody: '能看到这条,说明通知插件已经接好了。',
        offlineTitle: '通知插件连不上本地服务',
        justNow: '刚刚',
        minutesAgo: '分钟前',
        dismiss: '关闭',
        open: '打开',
        clearConfirm: '清空全部通知?',
      },
    }

    const CSS = `
@keyframes dsh-notifier-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
@keyframes dsh-notifier-pop {
  from { opacity: 0; transform: translateY(-4px) scale(0.99); }
  to { opacity: 1; transform: none; }
}
.dsh-notifier-card:hover { background: var(--dsw-alias-bg-layer-1); }
.dsh-notifier-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-notifier-group:hover { color: var(--dsw-alias-label-primary); }
.dsh-notifier-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-notifier-link:hover { text-decoration: underline; }
.dsh-notifier-x:hover { color: var(--dsw-alias-label-primary); }
.dsh-notifier-readbtn { opacity: 0; }
.dsh-notifier-row:hover .dsh-notifier-readbtn { opacity: 1; }
.dsh-notifier-list::-webkit-scrollbar { width: 8px; }
.dsh-notifier-list::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l1); border-radius: 8px;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-notifier-card, .dsh-notifier-panel { animation: none !important; }
}`

    // ---------------------------------------------------------------- store

    const store = {
      items: [],
      open: false,
      activeSessionId: null,
      settings: { dnd: false, dndFrom: '22:00', dndTo: '08:00' },
      listeners: new Set(),
    }

    function emit() {
      for (const listener of store.listeners) {
        try {
          listener()
        } catch {
          /* one broken subscriber must not stop the rest */
        }
      }
    }

    function subscribe(listener) {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }

    function loadLog() {
      try {
        const raw = window.localStorage.getItem(LOG_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter((item) => item && typeof item.key === 'string' && typeof item.at === 'number')
          .slice(0, LOG_MAX)
      } catch {
        return []
      }
    }

    function saveLog() {
      try {
        window.localStorage.setItem(LOG_KEY, JSON.stringify(store.items))
      } catch {
        /* storage full or unavailable: the list is still usable in memory */
      }
    }

    function addItem(item) {
      if (store.items.some((entry) => entry.key === item.key)) return
      store.items = [item, ...store.items].slice(0, LOG_MAX)
      saveLog()
      emit()
    }

    function markRead(key, read) {
      let changed = false
      store.items = store.items.map((item) => {
        if (item.key !== key || item.read === read) return item
        changed = true
        return { ...item, read }
      })
      if (changed) {
        saveLog()
        emit()
      }
    }

    /** Visiting a Session makes its notifications read: you just looked at it. */
    function markSessionRead(sessionId) {
      if (!sessionId) return
      let changed = false
      store.items = store.items.map((item) => {
        if (item.sessionId !== sessionId || item.read) return item
        changed = true
        return { ...item, read: true }
      })
      if (changed) {
        saveLog()
        emit()
      }
    }

    function setActiveSession(sessionId) {
      if (store.activeSessionId === (sessionId || null)) return
      store.activeSessionId = sessionId || null
      if (sessionId) markSessionRead(sessionId)
    }

    function markAllRead() {
      if (store.items.every((item) => item.read)) return
      store.items = store.items.map((item) => (item.read ? item : { ...item, read: true }))
      saveLog()
      emit()
    }

    function saveSettings() {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.settings))
      } catch {
        /* in-memory settings still work */
      }
    }

    function loadSettings() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? { ...store.settings, ...parsed } : { ...store.settings }
      } catch {
        return { ...store.settings }
      }
    }

    function updateSettings(patch) {
      store.settings = { ...store.settings, ...patch }
      saveSettings()
      emit()
    }

    function clearAll() {
      if (!store.items.length) return
      store.items = []
      saveLog()
      emit()
    }

    function setOpen(open) {
      if (store.open === open) return
      store.open = open
      emit()
    }

    function unreadCount() {
      return store.items.reduce((count, item) => count + (item.read ? 0 : 1), 0)
    }

    store.items = loadLog()
    store.settings = loadSettings()

    // -------------------------------------------------------------- helpers

    function baseName(path) {
      if (!path) return ''
      const parts = String(path).split(/[\\/]+/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : ''
    }

    /** The headline of a notification: its Session title, else its directory. */
    function sessionLabel(item, t) {
      if (item.label) return item.label
      const base = item.sessionTitle || baseName(item.cwd) || t('unknown')
      const sub = item.origin === 'subagent' || item.parentSessionId
      return sub ? `${base} · ${t('subagent')}` : base
    }

    /** What happened, prefixed by the owning Workspace when known. */
    function contextLabel(item, t) {
      const kind = t(item.kind === 'error' ? 'error' : 'complete')
      return item.workspaceTitle ? `${item.workspaceTitle} · ${kind}` : kind
    }

    function kindTitle(item, t) {
      return item.titleText || t(item.kind === 'error' ? 'error' : 'complete')
    }

    let audioContext = null

    /** Two short tones; "error" drops, "complete" rises. */
    function chime(kind) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) return
        if (!audioContext) audioContext = new Ctx()
        if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})
        const now = audioContext.currentTime + 0.02
        const notes = kind === 'error' ? [523.25, 392] : [659.25, 880]
        notes.forEach((frequency, index) => {
          const start = now + index * 0.13
          const osc = audioContext.createOscillator()
          const gain = audioContext.createGain()
          osc.type = 'sine'
          osc.frequency.setValueAtTime(frequency, start)
          gain.gain.setValueAtTime(0.0001, start)
          gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18)
          osc.connect(gain).connect(audioContext.destination)
          osc.start(start)
          osc.stop(start + 0.2)
        })
      } catch {
        /* autoplay policy or a missing audio device: stay silent */
      }
    }

    function desktopNotice(title, body, tag, onActivate) {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        const notice = new Notification(title, { body, tag, silent: true })
        notice.onclick = () => {
          // Clicking the desktop notice must land on the Session it describes.
          try {
            if (typeof onActivate === 'function') onActivate()
          } catch {
            /* the Session may be gone */
          }
          try {
            window.focus()
          } catch {
            /* nothing to focus */
          }
          try {
            notice.close()
          } catch {
            /* already dismissed */
          }
        }
      } catch {
        /* platform without the Notifications API */
      }
    }

    /** Minutes since midnight for an HH:MM value, or null when unusable. */
    function minutesOfClock(value) {
      const [hours, minutes] = String(value || '').split(':').map((part) => Number(part))
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
      return Math.min(23, Math.max(0, hours)) * 60 + Math.min(59, Math.max(0, minutes))
    }

    /** Whether the quiet window covers now; supports windows crossing midnight. */
    function isQuiet(settings, now = new Date()) {
      if (!settings || !settings.dnd) return false
      const from = minutesOfClock(settings.dndFrom)
      const to = minutesOfClock(settings.dndTo)
      if (from === null || to === null || from === to) return false
      const at = now.getHours() * 60 + now.getMinutes()
      return from < to ? at >= from && at < to : at >= from || at < to
    }

    /** Pull the stack back inside the viewport when the overlay layer does not
     *  share the page's coordinate space (scaled or inset frames). */
    function fitIntoView(element, pad = 12) {
      try {
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        const scale = element.offsetWidth ? rect.width / element.offsetWidth : 1
        let dx = 0
        let dy = 0
        if (rect.right > window.innerWidth - pad) dx = window.innerWidth - pad - rect.right
        if (rect.bottom > window.innerHeight - pad) dy = window.innerHeight - pad - rect.bottom
        if (rect.left < pad) dx = pad - rect.left
        if (rect.top < pad) dy = pad - rect.top
        element.style.transform = dx || dy ? `translate(${dx / (scale || 1)}px, ${dy / (scale || 1)}px)` : ''
      } catch {
        /* measurement is best effort */
      }
    }

    function timeLabel(at, t) {
      const diff = Date.now() - at
      if (diff < 60000) return t('justNow')
      if (diff < 3600000) return `${Math.floor(diff / 60000)} ${t('minutesAgo')}`
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function useStore() {
      const [, bump] = React.useState(0)
      React.useEffect(() => subscribe(() => bump((value) => value + 1)), [])
      return store
    }

    // ---------------------------------------------------------------- icons

    function BellIcon(props) {
      const size = props.size || 16
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        [
          h('path', { key: 'body', d: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }),
          h('path', { key: 'clapper', d: 'M13.7 21a2 2 0 0 1-3.4 0' }),
        ],
      )
    }

    // ------------------------------------------------------------ bell entry

    function BellButton(props) {
      const t = props.t
      const state = useStore()
      const unread = unreadCount()

      // Opening a Session is what "visiting" means: whatever it left unread is
      // now seen, including when the user arrives from somewhere other than a
      // notification.
      React.useEffect(() => {
        setActiveSession(props.sessionId)
        return () => {
          if (store.activeSessionId === props.sessionId) store.activeSessionId = null
        }
      }, [props.sessionId])

      return h(
        'button',
        {
          type: 'button',
          'data-dsh-notifier-bell': '',
          className: 'dsh-notifier-btn',
          title: t('notifications'),
          'aria-label': unread ? `${t('notifications')} (${unread})` : t('notifications'),
          'aria-expanded': state.open ? 'true' : 'false',
          onClick: () => setOpen(!store.open),
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: '1px solid transparent',
            borderRadius: 6,
            background: state.open ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: state.open ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
          },
        },
        [
          h(BellIcon, { key: 'icon', size: 16 }),
          unread
            ? h(
                'span',
                {
                  key: 'badge',
                  style: {
                    position: 'absolute',
                    top: 1,
                    right: 1,
                    minWidth: 14,
                    height: 14,
                    padding: '0 3px',
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 999,
                    background: 'var(--dsw-alias-state-error-primary)',
                    color: '#fff',
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: 1,
                  },
                },
                unread > 9 ? '9+' : String(unread),
              )
            : null,
        ],
      )
    }

    // ---------------------------------------------------------------- panel

    /** Group notifications by owning Workspace, newest group first. */
    function groupByWorkspace(items, t) {
      const groups = []
      const index = new Map()
      for (const item of items) {
        const key = item.workspaceTitle || baseName(item.cwd) || t('unknown')
        let group = index.get(key)
        if (!group) {
          group = { key, title: key, items: [] }
          index.set(key, group)
          groups.push(group)
        }
        group.items.push(item)
      }
      return groups
    }

    function NotificationRow(props) {
      const { item, t } = props
      const detail = item.message || item.summary
      return h(
        'div',
        {
          role: 'button',
          tabIndex: 0,
          className: 'dsh-notifier-row',
          onClick: () => props.onOpen(item),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') props.onOpen(item)
          },
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            padding: '8px 12px',
            cursor: item.sessionId ? 'pointer' : 'default',
            background: item.read ? 'transparent' : 'var(--dsw-alias-bg-layer-1)',
            borderLeft: item.read
              ? '3px solid transparent'
              : `3px solid ${
                  item.kind === 'error'
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-state-success-primary)'
                }`,
          },
        },
        [
          h('span', {
            key: 'dot',
            style: {
              width: 7,
              height: 7,
              marginTop: 6,
              borderRadius: 999,
              flex: 'none',
              background: item.read
                ? 'var(--dsw-alias-state-idle-primary)'
                : item.kind === 'error'
                  ? 'var(--dsw-alias-state-error-primary)'
                  : 'var(--dsw-alias-state-success-primary)',
            },
          }),
          h('div', { key: 'body', style: { flex: 1, minWidth: 0 } }, [
            h('div', { key: 'top', style: { display: 'flex', alignItems: 'baseline', gap: 6 } }, [
              h(
                'span',
                {
                  key: 'title',
                  style: {
                    fontSize: 12.5,
                    fontWeight: item.read ? 500 : 600,
                    color: 'var(--dsw-alias-label-primary)',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                sessionLabel(item, t),
              ),
              h(
                'span',
                { key: 'time', style: { fontSize: 11, flex: 'none', color: 'var(--dsw-alias-label-secondary)' } },
                timeLabel(item.at, t),
              ),
            ]),
            h(
              'div',
              {
                key: 'context',
                style: {
                  marginTop: 2,
                  fontSize: 11.5,
                  color: 'var(--dsw-alias-label-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              contextLabel(item, t),
            ),
            detail
              ? h(
                  'div',
                  {
                    key: 'detail',
                    style: {
                      marginTop: 2,
                      fontSize: 11.5,
                      color: 'var(--dsw-alias-label-secondary)',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    },
                  },
                  detail,
                )
              : null,
          ]),
          item.read
            ? null
            : h(
                'button',
                {
                  key: 'read',
                  type: 'button',
                  className: 'dsh-notifier-readbtn dsh-notifier-link',
                  title: t('markRead'),
                  'aria-label': t('markRead'),
                  onClick: (event) => {
                    event.stopPropagation()
                    props.onRead(item.key, true)
                  },
                  style: {
                    appearance: 'none',
                    border: 0,
                    margin: 0,
                    background: 'transparent',
                    font: 'inherit',
                    flex: 'none',
                    cursor: 'pointer',
                    fontSize: 11,
                    color: 'var(--dsw-alias-brand-primary)',
                    padding: '2px 4px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                  },
                },
                t('markRead'),
              ),
        ],
      )
    }

    function NotificationPanel(props) {
      const t = props.t
      const openSession = props.openSession
      const state = useStore()
      const panelRef = React.useRef(null)
      const [collapsed, setCollapsed] = React.useState(() => new Set())
      const [permission, setPermission] = React.useState(() => {
        try {
          return typeof Notification === 'undefined' ? 'denied' : Notification.permission
        } catch {
          return 'denied'
        }
      })

      React.useEffect(() => {
        if (!state.open) return
        const element = panelRef.current
        if (element) {
          const timer = setTimeout(() => fitIntoView(element), 0)
          const onResize = () => fitIntoView(element)
          window.addEventListener('resize', onResize)
          return () => {
            clearTimeout(timer)
            window.removeEventListener('resize', onResize)
          }
        }
      }, [state.open, state.items.length])

      React.useEffect(() => {
        if (!state.open) return
        const onPointer = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          if (panelRef.current && panelRef.current.contains(target)) return
          if (target.closest('[data-dsh-notifier-bell]')) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [state.open])

      if (!state.open) return null

      const items = state.items
      const unread = unreadCount()

      function openItem(item) {
        markRead(item.key, true)
        if (!item.sessionId) return
        try {
          openSession(item.sessionId)
        } catch {
          /* the Session may be gone */
        }
        setOpen(false)
      }

      function toggleGroup(key) {
        setCollapsed((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      function enableDesktop() {
        try {
          Notification.requestPermission()
            .then((next) => setPermission(next))
            .catch(() => {})
        } catch {
          setPermission('denied')
        }
      }

      const header = h(
        'div',
        {
          key: 'head',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
          },
        },
        [
          h(
            'span',
            { key: 'title', style: { fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 } },
            `${t('notifications')}${unread ? ` · ${unread} ${t('unread')}` : ''}`,
          ),
          items.length && unread
            ? h(
                'button',
                {
                  key: 'allread',
                  type: 'button',
                  className: 'dsh-notifier-link',
                  onClick: () => markAllRead(),
                  style: {
                    appearance: 'none', border: 0, margin: 0, padding: 0, background: 'transparent', font: 'inherit',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: 'var(--dsw-alias-brand-primary)',
                  },
                },
                t('markAllRead'),
              )
            : null,
          items.length
            ? h(
                'button',
                {
                  key: 'clear',
                  type: 'button',
                  className: 'dsh-notifier-link',
                  onClick: () => clearAll(),
                  style: {
                    appearance: 'none', border: 0, margin: 0, padding: 0, background: 'transparent', font: 'inherit',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                t('clearAll'),
              )
            : null,
        ],
      )

      const groups = groupByWorkspace(items, t)
      const rows = []
      for (const group of groups) {
        rows.push(
          h(
            'div',
            {
              key: `group:${group.key}`,
              className: 'dsh-notifier-group',
              title: group.title,
              onClick: () => toggleGroup(group.key),
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 12px 5px',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer',
                userSelect: 'none',
                position: 'sticky',
                top: 0,
                background: 'var(--dsw-alias-bg-overlay)',
                zIndex: 1,
              },
            },
            [
              h('span', { key: 'chev', style: { width: 10, flex: 'none' } }, collapsed.has(group.key) ? '\u25b8' : '\u25be'),
              h(
                'span',
                {
                  key: 'name',
                  style: {
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                group.title,
              ),
              h('span', { key: 'count', style: { flex: 'none' } }, String(group.items.length)),
            ],
          ),
        )
        if (collapsed.has(group.key)) continue
        for (const item of group.items) {
          rows.push(h(NotificationRow, { key: item.key, item, t, onOpen: openItem, onRead: markRead }))
        }
      }

      const body = items.length
        ? h(
            'div',
            {
              key: 'list',
              className: 'dsh-notifier-list',
              style: { overflowY: 'auto', maxHeight: 'min(58vh, 460px)', padding: '0 0 4px' },
            },
            rows,
          )
        : h(
            'div',
            {
              key: 'empty',
              style: {
                padding: '28px 16px',
                textAlign: 'center',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: 12,
              },
            },
            [
              h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 4 } }, t('empty')),
              h('div', { key: 'hint' }, t('emptyHint')),
            ],
          )

      const settings = state.settings
      const quiet = isQuiet(settings)
      const switchStyle = {
        appearance: 'none',
        border: 0,
        margin: 0,
        padding: 0,
        position: 'relative',
        width: 30,
        height: 17,
        flex: 'none',
        borderRadius: 999,
        cursor: 'pointer',
        background: settings.dnd
          ? 'var(--dsw-alias-brand-primary)'
          : 'var(--dsw-alias-border-l2)',
        transition: 'background 120ms ease',
      }
      const knobStyle = {
        position: 'absolute',
        top: 2,
        left: settings.dnd ? 15 : 2,
        width: 13,
        height: 13,
        borderRadius: 999,
        background: '#fff',
        transition: 'left 120ms ease',
      }
      const timeStyle = {
        width: 74,
        padding: '2px 4px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
      }

      const footer = h(
        'div',
        {
          key: 'footer',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 12px',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
          },
        },
        [
          h('div', { key: 'dnd', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h(
              'span',
              {
                key: 'label',
                style: { flex: 1, minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
              },
              t('dnd'),
            ),
            quiet
              ? h(
                  'span',
                  {
                    key: 'muted',
                    style: { fontSize: 11, flex: 'none', color: 'var(--dsw-alias-state-warn-primary)' },
                  },
                  t('muted'),
                )
              : null,
            h(
              'button',
              {
                key: 'switch',
                type: 'button',
                role: 'switch',
                'aria-checked': settings.dnd ? 'true' : 'false',
                'aria-label': t('dnd'),
                onClick: () => updateSettings({ dnd: !settings.dnd }),
                style: switchStyle,
              },
              h('span', { key: 'knob', style: knobStyle }),
            ),
          ]),
          settings.dnd
            ? h(
                'div',
                {
                  key: 'range',
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                [
                  h('input', {
                    key: 'from',
                    type: 'time',
                    value: settings.dndFrom,
                    'aria-label': t('dndFrom'),
                    onChange: (event) => updateSettings({ dndFrom: event.target.value }),
                    style: timeStyle,
                  }),
                  h('span', { key: 'dash' }, '\u2013'),
                  h('input', {
                    key: 'to',
                    type: 'time',
                    value: settings.dndTo,
                    'aria-label': t('dndTo'),
                    onChange: (event) => updateSettings({ dndTo: event.target.value }),
                    style: timeStyle,
                  }),
                  h('span', { key: 'hint', style: { flex: 1, minWidth: 0, fontSize: 11 } }, t('dndHint')),
                ],
              )
            : null,
          permission === 'default'
            ? h(
                'button',
                {
                  key: 'enable',
                  type: 'button',
                  className: 'dsh-notifier-link',
                  onClick: enableDesktop,
                  style: {
                    appearance: 'none',
                    border: 0,
                    margin: 0,
                    padding: 0,
                    alignSelf: 'flex-start',
                    background: 'transparent',
                    font: 'inherit',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: 'var(--dsw-alias-brand-primary)',
                  },
                },
                t('enableDesktop'),
              )
            : null,
        ],
      )

      return h(
        'div',
        {
          key: 'panel',
          ref: panelRef,
          className: 'dsh-notifier-panel',
          role: 'dialog',
          'aria-label': t('notifications'),
          style: {
            position: 'fixed',
            top: 56,
            right: 16,
            width: 360,
            maxWidth: 'calc(100vw - 24px)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-overlay)',
            color: 'var(--dsw-alias-label-primary)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 12,
            boxShadow: '0 18px 44px rgba(0, 0, 0, 0.24)',
            zIndex: 2147483000,
            overflow: 'hidden',
            pointerEvents: 'auto',
            animation: 'dsh-notifier-pop 140ms ease-out',
            font: '13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
          },
        },
        [header, body, footer],
      )
    }

    // -------------------------------------------------------------- overlay

    function Overlay(props) {
      const t = props.t
      const openSession = props.openSession
      const [toasts, setToasts] = React.useState([])
      const stackRef = React.useRef(null)

      function pushToast(item) {
        setToasts((prev) => {
          const deduped = prev.filter(
            (entry) => !(entry.sessionId && entry.sessionId === item.sessionId && entry.kind === item.kind && item.at - entry.at < 4000),
          )
          return [...deduped, item].slice(-MAX_TOASTS)
        })
      }

      React.useEffect(() => {
        let alive = true
        let cursor = 0
        let inFlight = null
        let offlineAt = 0
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

        function readSeen() {
          try {
            return Number(window.sessionStorage.getItem('dsh-notifier.seen')) || 0
          } catch {
            return 0
          }
        }

        function markSeen(seq) {
          if (!seq) return
          try {
            if (seq > readSeen()) window.sessionStorage.setItem('dsh-notifier.seen', String(seq))
          } catch {
            /* private mode: replay may repeat, which is harmless */
          }
        }

        function deliver(fact) {
          const kind = fact.kind === 'error' ? 'error' : 'complete'
          const key = `${fact.sessionId}:${kind}:${fact.seq}`
          markSeen(fact.seq)
          // The list persists, so an event already recorded must not chime again
          // after a reload or a re-poll.
          if (store.items.some((entry) => entry.key === key)) return
          const item = {
            key,
            kind,
            cwd: fact.cwd,
            origin: fact.origin,
            parentSessionId: fact.parentSessionId,
            workspaceTitle: fact.workspaceTitle,
            sessionTitle: fact.sessionTitle,
            message: kind === 'error' ? String(fact.message || '').trim() : '',
            summary: kind === 'complete' ? String(fact.summary || '').trim() : '',
            at: typeof fact.at === 'number' ? fact.at : Date.now(),
            sessionId: fact.sessionId,
            // Something that finishes in the Session already on screen has been
            // seen by definition.
            read: Boolean(fact.sessionId && store.activeSessionId === fact.sessionId),
          }

          const name = sessionLabel(item, t)
          const where = item.workspaceTitle ? `${item.workspaceTitle} / ${name}` : name
          const body = item.message || item.summary
          // Quiet hours record silently: the list still grows, nothing pops.
          if (!isQuiet(store.settings)) {
            chime(kind)
            desktopNotice(t(kind), body ? `${where} — ${body}` : where, fact.sessionId, () => {
              try {
                markRead(key, true)
              } catch {
                /* the entry may already be gone */
              }
              try {
                if (fact.sessionId) openSession(fact.sessionId)
              } catch {
                /* the Session may be gone */
              }
            })
            pushToast({ ...item, expiresAt: Date.now() + (TOAST_TTL[kind] || 6000) })
          }
          addItem(item)
        }

        function offline(error) {
          if (Date.now() - offlineAt < 30000) return
          offlineAt = Date.now()
          const origin = (() => {
            try {
              return window.location.origin
            } catch {
              return 'unknown'
            }
          })()
          pushToast({
            key: `offline:${Date.now()}`,
            kind: 'error',
            titleText: t('offlineTitle'),
            label: `${String((error && error.message) || error)} @ ${origin}`,
            message: FEED_PATH,
            at: Date.now(),
            expiresAt: Date.now() + 20000,
            sessionId: '',
          })
        }

        async function poll() {
          const diag = (() => {
            try {
              const boot = window.__DSH_BOOT__
              return encodeURIComponent(
                JSON.stringify({
                  origin: window.location.origin,
                  bootKeys: boot && typeof boot === 'object' ? Object.keys(boot).slice(0, 12) : null,
                }).slice(0, 600),
              )
            } catch {
              return 'x'
            }
          })()

          const candidates = (() => {
            const list = ['']
            try {
              const boot = window.__DSH_BOOT__
              const walk = (value, depth) => {
                if (depth > 4 || list.length >= 5 || value == null) return
                if (typeof value === 'string') {
                  const match = value.match(/https?:\/\/[^\s"'<>]+/)
                  if (match) {
                    try {
                      const origin = new URL(match[0]).origin
                      if (!list.includes(origin)) list.push(origin)
                    } catch {
                      /* not a URL */
                    }
                  }
                  return
                }
                if (typeof value === 'object') for (const inner of Object.values(value)) walk(inner, depth + 1)
              }
              walk(boot, 0)
            } catch {
              /* no boot payload */
            }
            if (!list.includes('http://127.0.0.1:1675')) list.push('http://127.0.0.1:1675')
            return list
          })()

          let base = ''
          let first = null
          let lastError = null
          for (const candidate of candidates) {
            try {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 4000)
              const response = await fetch(`${candidate}${FEED_PATH}?after=0&wait=0&diag=${diag}`, {
                cache: 'no-store',
                signal: controller.signal,
              })
              clearTimeout(timer)
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              first = await response.json()
              base = candidate
              break
            } catch (error) {
              lastError = error
            }
          }

          if (!first) {
            offline(lastError)
            if (!alive) return
            await sleep(5000)
            if (!alive) return
            return poll()
          }

          if (typeof first.cursor === 'number') cursor = first.cursor
          const cutoff = Date.now() - CATCH_UP_MS
          const seen = readSeen()
          const recent = (Array.isArray(first.items) ? first.items : [])
            .filter((fact) => fact.at >= cutoff && (fact.seq || 0) > seen)
            .slice(-CATCH_UP_MAX)
          for (const fact of recent) deliver(fact)

          let failures = 0
          while (alive) {
            try {
              inFlight = new AbortController()
              const response = await fetch(`${base}${FEED_PATH}?after=${cursor}&wait=20000`, {
                cache: 'no-store',
                signal: inFlight.signal,
              })
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              const data = await response.json()
              if (typeof data.cursor === 'number') cursor = Math.max(cursor, data.cursor)
              if (Array.isArray(data.items)) for (const fact of data.items) deliver(fact)
              inFlight = null
              failures = 0
            } catch (error) {
              inFlight = null
              if (!alive) return
              failures += 1
              offline(error)
              if (failures >= 3) {
                await sleep(2500)
                if (!alive) return
                return poll()
              }
              await sleep(2500)
            }
          }
        }

        function resumeAudio() {
          try {
            if (audioContext && audioContext.state === 'suspended') audioContext.resume().catch(() => {})
          } catch {
            /* ignore */
          }
        }

        const sweeper = setInterval(() => {
          const now = Date.now()
          setToasts((prev) => {
            const kept = prev.filter((item) => item.expiresAt > now)
            return kept.length === prev.length ? prev : kept
          })
        }, 500)

        document.addEventListener('pointerdown', resumeAudio)
        poll()

        return () => {
          alive = false
          clearInterval(sweeper)
          document.removeEventListener('pointerdown', resumeAudio)
          if (inFlight) {
            try {
              inFlight.abort()
            } catch {
              /* already settled */
            }
          }
        }
      }, [])

      React.useEffect(() => {
        const element = stackRef.current
        if (!element) return
        fitIntoView(element)
        const timer = setInterval(() => fitIntoView(element), 800)
        window.addEventListener('resize', fitIntoView.bind(null, element))
        return () => {
          clearInterval(timer)
          window.removeEventListener('resize', fitIntoView.bind(null, element))
        }
      }, [toasts.length])

      function dismiss(key) {
        setToasts((prev) => prev.filter((item) => item.key !== key))
      }

      function openToast(item) {
        markRead(item.key, true)
        if (item.sessionId) {
          try {
            openSession(item.sessionId)
          } catch {
            /* the Session may be gone */
          }
        }
        dismiss(item.key)
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CSS),
        h(
          'div',
          {
            key: 'stack',
            ref: stackRef,
            style: {
              position: 'fixed',
              right: 16,
              bottom: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              alignItems: 'flex-end',
              zIndex: 2147483000,
              pointerEvents: 'none',
            },
            role: 'status',
            'aria-live': 'polite',
          },
          toasts.map((item) =>
            h(
              'div',
              {
                key: item.key,
                className: 'dsh-notifier-card',
                onClick: () => openToast(item),
                style: {
                  pointerEvents: 'auto',
                  width: 320,
                  boxSizing: 'border-box',
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'var(--dsw-alias-bg-overlay)',
                  color: 'var(--dsw-alias-label-primary)',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderLeft:
                    item.kind === 'error'
                      ? '3px solid var(--dsw-alias-state-error-primary)'
                      : '3px solid var(--dsw-alias-state-success-primary)',
                  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.18)',
                  font: '13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
                  animation: 'dsh-notifier-in 160ms ease-out',
                  cursor: item.sessionId ? 'pointer' : 'default',
                },
                title: item.message || sessionLabel(item, t),
              },
              [
                h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
                  h('span', {
                    key: 'dot',
                    style: {
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      flex: 'none',
                      background:
                        item.kind === 'error'
                          ? 'var(--dsw-alias-state-error-primary)'
                          : 'var(--dsw-alias-state-success-primary)',
                    },
                  }),
                  h(
                    'span',
                    { key: 'title', style: { fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0 } },
                    kindTitle(item, t),
                  ),
                  h(
                    'button',
                    {
                      key: 'close',
                      className: 'dsh-notifier-x',
                      type: 'button',
                      'aria-label': t('dismiss'),
                      onClick: (event) => {
                        event.stopPropagation()
                        dismiss(item.key)
                      },
                      style: {
                        appearance: 'none', border: 0, margin: 0, padding: 0, background: 'transparent', font: 'inherit',
                        cursor: 'pointer',
                        color: 'var(--dsw-alias-label-secondary)',
                        fontSize: 15,
                        lineHeight: 1,
                        padding: '0 2px',
                      },
                    },
                    '\u00d7',
                  ),
                ]),
                h(
                  'div',
                  {
                    key: 'session',
                    style: {
                      marginTop: 3,
                      paddingLeft: 15,
                      color: 'var(--dsw-alias-label-secondary)',
                      fontSize: 12,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  sessionLabel(item, t),
                ),
                item.message || item.summary
                  ? h(
                      'div',
                      {
                        key: 'message',
                        style: {
                          marginTop: 4,
                          paddingLeft: 15,
                          color: 'var(--dsw-alias-label-secondary)',
                          fontSize: 12,
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        },
                      },
                      item.message || item.summary,
                    )
                  : null,
              ],
            ),
          ),
        ),
        h(NotificationPanel, { key: 'panel', t, openSession }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        let t = (key) => key

        if (locale) {
          let active = 'en'
          try {
            active = locale.getLocale?.().active || 'en'
          } catch {
            active = 'en'
          }
          const primary = String(active).toLowerCase().startsWith('zh') ? 'zh' : 'en'
          for (const code of ['en', 'zh']) {
            ctx.effect(() => locale.register(NS, code, DICT[code]))
          }
          if (primary !== 'en' && primary !== 'zh') {
            ctx.effect(() => locale.register(NS, primary, DICT.zh))
          }
          t = locale.bind(NS)
        }

        // Navigation is the one thing a Harness update can silently break: the
        // service may not exist yet when this plugin applies, and an early
        // capture would keep the miss forever. Resolve it per click, and record
        // the outcome where the Host trace can show it.
        const reportNavigation = (detail) => {
          try {
            const params = new URLSearchParams()
            params.set('after', '0')
            params.set('wait', '0')
            params.set('p', detail.ok ? 'open-ok' : 'open-fail')
            params.set('have', detail.have ? '1' : '0')
            if (detail.sessionId) params.set('sid', String(detail.sessionId).slice(0, 60))
            if (detail.error) params.set('err', String(detail.error).slice(0, 120))
            fetch(`${FEED_PATH}?${params.toString()}`, { cache: 'no-store' }).catch(() => {})
          } catch {
            /* diagnostics must never block navigation */
          }
        }

        const openSession = (sessionId) => {
          if (!sessionId) return
          let service = null
          try {
            service = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
          } catch {
            service = undefined
          }
          if (!service) service = uiWorkspace
          if (!service || typeof service.openSession !== 'function') {
            reportNavigation({ ok: false, have: false, sessionId, error: 'uiWorkspace missing' })
            return
          }
          try {
            service.openSession(sessionId)
            reportNavigation({ ok: true, have: true, sessionId })
          } catch (error) {
            reportNavigation({ ok: false, have: true, sessionId, error: (error && error.message) || error })
          }
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-notifier', order: 1000, label: 'Task Notifier' },
            () => h(Overlay, { t, openSession }),
          ),
        )

        // A real header control, not a floating shape: the frame's top-right
        // corner belongs to the window chrome.
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'dsh-notifier-bell',
              order: 40,
              label: 'Task Notifier',
            },
            (slotProps) => h(BellButton, { t, sessionId: slotProps && slotProps.sessionId }),
          ),
        )
      },
    }
  },
})