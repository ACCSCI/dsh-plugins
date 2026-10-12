/**
 * @dsh-external/workspace-todo — client half.
 *
 * A hand-maintained todo list bound to the Session's working directory: a
 * compact button in the Session header's right-aligned utilities plus the
 * floating panel it opens (rendered in the frame-wide overlay layer).
 *
 * The list itself lives in `<working directory>/.dsh/todos.json` and is read and
 * written through this package's host routes. Nothing here is model-facing.
 */

window.__ModuleLoader__.load({
	id: "@dsh-external/workspace-todo",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		/**
		 * The shell's own UI kit, seeded in the platform module table: the same
		 * menu, buttons, and icon set the shipped plugins render with, so the panel
		 * matches the app instead of imitating it.
		 */
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");

		const API_BASE = "/workspace-todo/api";
		const HEADER_SLOT = "conversation.session.header.utilities";
		const OVERLAY_SLOT = "shell.overlay";
		const FILTER_KEY = "dsh.workspace-todo.filter";
		const TOAST_MS = 1800;
		const SAVE_DEBOUNCE_MS = 350;
		const CLOSE_MS = 130;

		/** Status order is the user's: 待办, 进行中, 已完成, 阻塞, 等待. */
		const STATUSES = [
			{ id: "todo", label: "待办", Icon: ui.IconQueueOutline14, color: "--dsw-alias-label-secondary" },
			{ id: "doing", label: "进行中", Icon: ui.IconLoadingOutline16, color: "--dsw-alias-brand-primary", spin: true },
			{ id: "done", label: "已完成", Icon: ui.IconCheckOutline16, color: "--dsw-alias-state-success-primary" },
			{ id: "blocked", label: "阻塞", Icon: ui.IconWarningOutline16, color: "--dsw-alias-state-error-primary" },
			{ id: "waiting", label: "等待", Icon: ui.IconClockOutline16, color: "--dsw-alias-state-warn-primary" },
		];
		const PRIORITIES = [
			{ id: "high", label: "高", color: "--dsw-alias-state-error-primary" },
			{ id: "medium", label: "中", color: "--dsw-alias-state-warn-primary" },
			{ id: "low", label: "低", color: "--dsw-alias-label-secondary" },
		];

		const DEFAULT_STATUS = STATUSES[0];

		/** The descriptor for a stored id, falling back to 待办 for hand-edited files. */
		function statusOf(id) {
			return STATUSES.find((entry) => entry.id === id) || DEFAULT_STATUS;
		}

		function priorityOf(id) {
			return PRIORITIES.find((entry) => entry.id === id) || null;
		}

		/** One entry of the app's own status icon set, colored and (for 进行中) spinning. */
		function StatusIcon(props) {
			const status = statusOf(props.status);
			const Icon = status.Icon;
			if (typeof Icon !== "function") return null;
			return react.createElement(Icon, {
				size: props.size || 13,
				className: status.spin === true && props.animate !== false ? "wst-spin" : undefined,
				style: { color: "var(" + status.color + ")" },
			});
		}

		/**
		 * Panel stylesheet. Everything is expressed through the shell's own design
		 * tokens (`--dsw-alias-*`) so the panel matches the app in both themes; the
		 * only literal colors are fallbacks that keep it legible outside the shell.
		 */
		const CSS = `
.wst-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:transparent;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:11px;line-height:16px;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease}
.wst-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.wst-btn[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary,#4a9eff);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}
.wst-badge{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary,#4a9eff);color:#fff;font-size:10px;font-weight:600;line-height:16px;text-align:center}

.wst-panel{position:fixed;z-index:40;pointer-events:auto;display:flex;flex-direction:column;width:max-content;max-height:min(72vh,660px);overflow:hidden;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:14px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 16px 40px -12px rgba(0,0,0,.35),0 2px 8px -2px rgba(0,0,0,.18);font-family:inherit;font-size:12px;animation:wst-in .17s cubic-bezier(.2,.8,.2,1)}
.wst-panel[data-state="closing"]{animation:wst-out .13s ease forwards}
.wst-panel[data-state="open"] .wst-list{animation:wst-fade .2s ease}
.wst-head{display:flex;align-items:center;gap:7px;padding:10px 11px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}
.wst-title{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;letter-spacing:.01em}
.wst-count{color:var(--dsw-alias-label-secondary,#888);font-size:11px;font-weight:400}
.wst-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-family:inherit;font-size:11px;text-align:left;padding:2px 4px;cursor:copy;transition:background .14s ease,color .14s ease}
.wst-path:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,inherit)}
.wst-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-family:inherit;cursor:pointer;transition:background .14s ease,color .14s ease,transform .14s ease}
.wst-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary,inherit)}
.wst-icon-btn:active{transform:scale(.92)}

.wst-add{display:flex;gap:6px;padding:10px 11px 8px}
.wst-input{flex:1;min-width:0;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));color:inherit;font-family:inherit;font-size:12px;transition:border-color .14s ease,box-shadow .14s ease,background .14s ease}
.wst-input::placeholder{color:var(--dsw-alias-label-secondary,#999)}
.wst-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a9eff);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4a9eff) 22%,transparent)}
.wst-add-btn{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 11px;border:0;border-radius:9px;background:var(--dsw-alias-brand-primary,#4a9eff);color:#fff;font-family:inherit;font-size:12px;cursor:pointer;transition:opacity .14s ease,transform .14s ease}
.wst-add-btn:hover:not(:disabled){opacity:.9}
.wst-add-btn:active:not(:disabled){transform:scale(.97)}
.wst-add-btn:disabled{opacity:.4;cursor:not-allowed}

.wst-chips{display:flex;align-items:center;gap:4px;padding:0 11px 9px;font-size:11px;color:var(--dsw-alias-label-secondary,#888)}
.wst-chip{border:0;border-radius:999px;background:transparent;color:inherit;font-family:inherit;font-size:11px;padding:3px 9px;cursor:pointer;transition:background .14s ease,color .14s ease}
.wst-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.wst-chip-on{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.wst-grow{flex:1}
.wst-err{color:var(--dsw-alias-state-error-primary,#e5534b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}

.wst-list{flex:1;min-height:0;overflow:auto;margin:0;padding:0 7px 8px;list-style:none;scrollbar-gutter:stable}
.wst-row{display:flex;gap:6px;padding:7px 5px;border-radius:10px;transition:background .14s ease,box-shadow .14s ease}
.wst-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.wst-grip{display:inline-flex;align-items:center;padding-top:2px;color:var(--dsw-alias-label-secondary,#999);cursor:grab;user-select:none;opacity:.45;transition:opacity .14s ease}
.wst-row:hover .wst-grip{opacity:1}
.wst-grip:active{cursor:grabbing}
.wst-main{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px}
.wst-line1{display:flex;align-items:center;gap:6px;min-width:0}
.wst-name{min-width:0;max-width:100%;overflow:hidden;border:0;background:transparent;color:inherit;font-family:inherit;font-size:12px;text-align:left;text-overflow:ellipsis;white-space:nowrap;padding:0;border-radius:4px;cursor:copy;transition:color .14s ease}
.wst-name:hover{color:var(--dsw-alias-brand-primary,#4a9eff)}
.wst-row[data-done="true"] .wst-name{color:var(--dsw-alias-label-secondary,#888);text-decoration:line-through}
.wst-tag{flex:none;border:1px solid currentColor;border-radius:999px;color:var(--dsw-alias-label-secondary,#888);font-size:10px;line-height:15px;padding:0 6px;opacity:.9}
.wst-overdue{color:var(--dsw-alias-state-error-primary,#e5534b);opacity:1}
.wst-line2{display:flex;align-items:center;gap:5px;flex-wrap:wrap}

.wst-status{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px 0 5px;border:1px solid transparent;border-radius:999px;background:color-mix(in srgb,currentColor 11%,transparent);color:var(--dsw-alias-label-secondary,#888);font-family:inherit;font-size:11px;cursor:pointer;transition:background .14s ease,color .14s ease}
.wst-status:hover{background:color-mix(in srgb,currentColor 20%,transparent)}
.wst-status svg{flex:none}
.wst-prio{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.36));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-family:inherit;font-size:11px;cursor:pointer;transition:border-color .14s ease,background .14s ease}
.wst-prio:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.wst-prio-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.wst-date{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-size:11px;transition:border-color .14s ease,background .14s ease}
.wst-date:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.wst-date input{width:92px;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;padding:0;outline:none}
.wst-mini{display:inline-flex;align-items:center;gap:4px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-family:inherit;font-size:11px;padding:3px 7px;cursor:pointer;transition:background .14s ease,color .14s ease}
.wst-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary,inherit)}
.wst-del:hover{color:var(--dsw-alias-state-error-primary,#e5534b)}

.wst-detail{display:flex;flex-direction:column;gap:7px;margin-top:3px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));animation:wst-in .16s cubic-bezier(.2,.8,.2,1)}
.wst-notes{box-sizing:border-box;width:100%;min-height:50px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;background:transparent;color:inherit;font-family:inherit;font-size:11.5px;resize:vertical;transition:border-color .14s ease,box-shadow .14s ease}
.wst-notes:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a9eff);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4a9eff) 18%,transparent)}
.wst-sublist{display:flex;flex-direction:column;gap:5px}
.wst-sub{display:flex;align-items:center;gap:7px;font-size:11.5px}
.wst-sub input[type=checkbox]{margin:0;accent-color:var(--dsw-alias-brand-primary,#4a9eff)}
.wst-sub-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wst-sub-done{color:var(--dsw-alias-label-secondary,#888);text-decoration:line-through}
.wst-subadd{height:26px;font-size:11.5px}

.wst-foot{display:flex;align-items:center;gap:8px;padding:8px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,#888);font-size:11px}
.wst-toast{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-state-success-primary,#3fb950);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;animation:wst-fade .18s ease}
.wst-empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:26px 14px;color:var(--dsw-alias-label-secondary,#888);font-size:12px;text-align:center}
.wst-empty svg{opacity:.5}

.wst-spin{animation:wst-spin 1.05s linear infinite}
@keyframes wst-in{from{opacity:0;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:none}}
@keyframes wst-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-3px) scale(.99)}}
@keyframes wst-fade{from{opacity:0}to{opacity:1}}
@keyframes wst-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wst-panel,.wst-panel[data-state],.wst-detail,.wst-toast,.wst-list,.wst-spin{animation:none!important}.wst-btn,.wst-chip,.wst-icon-btn,.wst-row,.wst-status,.wst-prio,.wst-date,.wst-mini,.wst-input,.wst-name{transition:none!important}}
`;

		/** Content-hashed style tag id, so a hot-reloaded stylesheet replaces the old one. */
		function styleTagId(css) {
			let hash = 5381;
			for (let index = 0; index < css.length; index += 1) {
				hash = ((hash * 33) ^ css.charCodeAt(index)) >>> 0;
			}
			return "@dsh-external/workspace-todo/panel." + hash.toString(36) + ".css";
		}

		(function installStyles() {
			const tagId = styleTagId(CSS);
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			// Drop this plugin's earlier stylesheets so an updated panel never inherits stale rules.
			for (const stale of Array.from(document.querySelectorAll('style[data-plugin="@dsh-external/workspace-todo"]'))) {
				stale.remove();
			}
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/workspace-todo";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		})();

		function message(error) {
			return error && error.message ? String(error.message) : String(error);
		}

		/* ------------------------------------------------------------------ */
		/* shared store                                                        */
		/* ------------------------------------------------------------------ */

		function readFilter() {
			try {
				const value = window.localStorage.getItem(FILTER_KEY);
				return value === "open" || value === "done" ? value : "all";
			} catch {
				return "all";
			}
		}

		const state = {
			sessionId: null,
			dir: null,
			file: null,
			version: null,
			exists: false,
			todos: [],
			loading: false,
			error: null,
			conflict: false,
			saving: false,
			dirty: false,
			savedAt: 0,
			open: false,
			/** True while the exit animation runs, so the panel can still render its last frame. */
			closing: false,
			/** `<todo id>:<status|priority>` of the row menu that is open, or null. */
			openMenu: null,
			anchor: null,
			/** The header button the panel hangs from, re-measured on resize. */
			anchorElement: null,
			filter: readFilter(),
			toast: null,
		};
		const listeners = new Set();

		function emit(patch) {
			Object.assign(state, patch);
			for (const listener of Array.from(listeners)) {
				try {
					listener();
				} catch (error) {
					console.error("workspace-todo: listener failed", error);
				}
			}
		}

		function useStore() {
			const [, force] = react.useReducer((tick) => tick + 1, 0);
			react.useEffect(() => {
				const listener = () => force();
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			}, []);
			return state;
		}

		function openCountOf(todos) {
			return todos.filter((todo) => todo.status !== "done").length;
		}

		/* ------------------------------------------------------------------ */
		/* host routes                                                         */
		/* ------------------------------------------------------------------ */

		function hostBase() {
			const origin = globalThis.location?.origin;
			return origin !== undefined && origin !== "null" ? origin : "http://dsh.internal";
		}

		async function request(path, init) {
			const response = await fetch(new URL(API_BASE + path, hostBase()), init);
			const raw = await response.text();
			let payload = null;
			try {
				payload = raw === "" ? {} : JSON.parse(raw);
			} catch {
				throw new Error("服务端响应不是 JSON（HTTP " + String(response.status) + "）");
			}
			if (payload === null || typeof payload !== "object") {
				throw new Error("服务端响应异常（HTTP " + String(response.status) + "）");
			}
			if (payload.ok !== true) {
				const error = new Error(payload.message ? String(payload.message) : "HTTP " + String(response.status));
				error.code = payload.code;
				throw error;
			}
			return payload;
		}

		let loadToken = 0;

		async function loadFor(sessionId, dir) {
			if (!dir) {
				emit({
					sessionId: sessionId ?? null, dir: null, file: null, version: null,
					exists: false, todos: [], loading: false, error: null, dirty: false, conflict: false,
				});
				return;
			}
			/*
			 * Adopting another working directory replaces the list in the store, so
			 * an unsaved edit from the outgoing directory is written first — and a
			 * write that is still in flight is awaited so the snapshot starts from
			 * the version the server actually holds.
			 */
			if (dir !== state.dir && pending()) {
				if (saveTimer !== null) {
					clearTimeout(saveTimer);
					saveTimer = null;
				}
				await settleSave();
				if (pending()) await saveNow();
			}
			const token = ++loadToken;
			emit({ loading: true, error: null, conflict: false, sessionId: sessionId ?? null });
			try {
				const payload = await request("/state?dir=" + encodeURIComponent(dir));
				if (token !== loadToken) return;
				savedSeq = editSeq;
				emit({
					dir: typeof payload.dir === "string" ? payload.dir : dir,
					file: typeof payload.file === "string" ? payload.file : null,
					version: typeof payload.version === "string" ? payload.version : null,
					exists: payload.exists === true,
					todos: Array.isArray(payload.todos) ? payload.todos : [],
					loading: false, dirty: false, error: null, conflict: false, savedAt: Date.now(),
				});
			} catch (error) {
				if (token !== loadToken) return;
				emit({ loading: false, dir, todos: [], version: null, error: message(error) });
			}
		}

		let saveTimer = null;
		let saving = false;
		let queued = false;
		/**
		 * Every edit bumps `editSeq`; a settled save records the sequence it
		 * carried. `pending()` therefore stays exact when an edit lands while a
		 * save is in flight — a boolean flag would be cleared by the older
		 * response and quietly strand the newer edit.
		 */
		let editSeq = 0;
		let savedSeq = 0;

		function pending() {
			return editSeq !== savedSeq;
		}

		/** Wait for an in-flight write to settle so the next snapshot starts from a fresh version. */
		async function settleSave() {
			while (saving) await new Promise((resolve) => setTimeout(resolve, 30));
		}

		function scheduleSave() {
			editSeq += 1;
			emit({ dirty: true });
			if (saveTimer !== null) clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				saveTimer = null;
				void saveNow();
			}, SAVE_DEBOUNCE_MS);
		}

		function flush(keepalive) {
			if (saveTimer !== null) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
			if (pending()) void saveNow(keepalive === true ? { keepalive: true } : undefined);
		}

		/**
		 * `keepalive` survives page teardown, but the browser caps such a body at
		 * 64 KiB, so a long list must fall back to an ordinary request instead of
		 * failing outright.
		 */
		const KEEPALIVE_MAX_BYTES = 60000;

		async function saveNow(options) {
			if (saving) {
				queued = true;
				return;
			}
			const dir = state.dir;
			if (!dir) return;
			const seq = editSeq;
			const todos = state.todos;
			const version = state.version;
			/*
			 * `exists` travels with the write so the host can guard a list the panel
			 * believes is brand new: another window creating the file meanwhile is
			 * then a conflict instead of a silent overwrite of that window's rows.
			 */
			const body = JSON.stringify({ dir, todos, version, exists: state.exists });
			const init = { method: "POST", headers: { "content-type": "application/json" }, body };
			if (options !== undefined && options.keepalive === true && body.length <= KEEPALIVE_MAX_BYTES) {
				init.keepalive = true;
			}
			saving = true;
			emit({ saving: true });
			try {
				const payload = await request("/save", init);
				savedSeq = seq;
				emit({
					saving: false, dirty: pending(), conflict: false, error: null,
					version: typeof payload.version === "string" ? payload.version : state.version,
					file: typeof payload.file === "string" ? payload.file : state.file,
					exists: true, savedAt: Date.now(),
				});
				// The host keeps the replaced bytes when a save empties the list; say so.
				if (typeof payload.backupFile === "string" && payload.backupFile !== "") {
					toast("已清空，上一版留存为 " + payload.backupFile.split(/[\\/]/).pop());
				}
			} catch (error) {
				if (error && error.code === "conflict") {
					savedSeq = editSeq;
					emit({ saving: false, dirty: false, conflict: true, error: message(error) });
				} else {
					emit({ saving: false, error: "保存失败：" + message(error) });
				}
			} finally {
				saving = false;
				if (queued) {
					queued = false;
					void saveNow();
				}
			}
		}

		/* ------------------------------------------------------------------ */
		/* mutations                                                           */
		/* ------------------------------------------------------------------ */

		function uid(prefix) {
			return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
		}

		/**
		 * Rows are immutable values here: a mutator replaces the rows it changes
		 * instead of editing them, so one keystroke in a note costs a copy of the
		 * array rather than a deep copy of every row and subtask.
		 */
		function updateTodos(mutator) {
			const next = state.todos.slice();
			mutator(next);
			emit({ todos: next });
			scheduleSave();
		}

		function rowIndex(todos, id) {
			return todos.findIndex((entry) => entry.id === id);
		}

		function addTodo(title) {
			const now = Date.now();
			updateTodos((todos) => {
				todos.push({
					id: uid("todo"), title, status: "todo", priority: null, due: null,
					notes: "", subtasks: [], createdAt: now,
				});
			});
		}

		function patchTodo(id, patch) {
			updateTodos((todos) => {
				const index = rowIndex(todos, id);
				if (index < 0) return;
				const next = Object.assign({}, todos[index], patch, { updatedAt: Date.now() });
				if (patch.status === "done") next.doneAt = Date.now();
				else if (patch.status !== undefined) delete next.doneAt;
				todos[index] = next;
			});
		}

		function removeTodo(id) {
			updateTodos((todos) => {
				const index = rowIndex(todos, id);
				if (index >= 0) todos.splice(index, 1);
			});
		}

		/** Replace one row's subtask array, leaving every other row untouched. */
		function withSubtasks(todos, id, change) {
			const index = rowIndex(todos, id);
			if (index < 0) return;
			const row = todos[index];
			const subtasks = Array.isArray(row.subtasks) ? row.subtasks : [];
			const next = change(subtasks);
			if (next === subtasks) return;
			todos[index] = Object.assign({}, row, { subtasks: next });
		}

		function addSubtask(id, title) {
			updateTodos((todos) => {
				withSubtasks(todos, id, (subtasks) => subtasks.concat([{ id: uid("subtask"), title, done: false, createdAt: Date.now() }]));
			});
		}

		function patchSubtask(id, subtaskId, patch) {
			updateTodos((todos) => {
				withSubtasks(todos, id, (subtasks) => subtasks.map((entry) => (entry.id === subtaskId ? Object.assign({}, entry, patch) : entry)));
			});
		}

		function removeSubtask(id, subtaskId) {
			updateTodos((todos) => {
				withSubtasks(todos, id, (subtasks) => subtasks.filter((entry) => entry.id !== subtaskId));
			});
		}

		/** Move one todo beside another by id, so any active filter still reorders the real list. */
		function reorderTodos(dragId, targetId, after) {
			if (!dragId || dragId === targetId) return;
			updateTodos((todos) => {
				const from = rowIndex(todos, dragId);
				if (from < 0) return;
				const moved = todos.splice(from, 1)[0];
				let to = rowIndex(todos, targetId);
				if (to < 0) {
					todos.splice(from, 0, moved);
					return;
				}
				if (after) to += 1;
				todos.splice(to, 0, moved);
			});
		}

		function setFilter(value) {
			try {
				window.localStorage.setItem(FILTER_KEY, value);
			} catch {
				/* a blocked localStorage must not break the filter */
			}
			emit({ filter: value });
		}

		/* ------------------------------------------------------------------ */
		/* clipboard                                                           */
		/* ------------------------------------------------------------------ */

		let toastTimer = null;

		function toast(text) {
			if (toastTimer !== null) clearTimeout(toastTimer);
			emit({ toast: text });
			toastTimer = setTimeout(() => {
				toastTimer = null;
				emit({ toast: null });
			}, TOAST_MS);
		}

		function copyText(value) {
			const text = String(value ?? "");
			if (text === "") return;
			const done = () => toast("已复制：" + (text.length > 32 ? text.slice(0, 32) + "…" : text));
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
				return;
			}
			fallbackCopy(text, done);
		}

		function fallbackCopy(text, done) {
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand("copy");
				area.remove();
				if (ok) done();
				else toast("复制失败：浏览器拒绝了剪贴板写入");
			} catch (error) {
				toast("复制失败：" + message(error));
			}
		}

		/* ------------------------------------------------------------------ */
		/* helpers                                                             */
		/* ------------------------------------------------------------------ */

		function todayKey() {
			const now = new Date();
			const pad = (value) => (value < 10 ? "0" + String(value) : String(value));
			return String(now.getFullYear()) + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
		}

		function clockText(time) {
			try {
				return new Date(time).toLocaleTimeString();
			} catch {
				return "";
			}
		}

		/* ------------------------------------------------------------------ */
		/* components                                                          */
		/* ------------------------------------------------------------------ */

		const dragState = { id: null };

		/** The app's own checklist glyph for the header button and the panel title. */
		function ChecklistIcon(props) {
			const Icon = ui.IconChecklistOutline14;
			if (typeof Icon !== "function") return null;
			return react.createElement(Icon, { size: props && props.size ? props.size : 14 });
		}

		/** Six-dot drag handle, the grip every list UI of this shape uses. */
		function GripIcon() {
			const dots = [[5, 3], [5, 8], [11, 3], [11, 8], [5, 13], [11, 13]];
			return react.createElement(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true", focusable: "false" },
				dots.map(([cx, cy]) => react.createElement("circle", { key: String(cx) + "-" + String(cy), cx, cy, r: 1.15 })),
			);
		}

		let closeTimer = null;

		/** Close plays the exit animation first, so the panel never blinks out. */
		function closePanel() {
			flush();
			emit({ openMenu: null });
			if (state.closing === true) return;
			emit({ closing: true });
			closeTimer = setTimeout(() => {
				closeTimer = null;
				emit({ open: false, closing: false });
			}, CLOSE_MS);
		}

		function cancelClose() {
			if (closeTimer === null) return;
			clearTimeout(closeTimer);
			closeTimer = null;
		}

		/** Where the panel hangs: under its button, kept inside the viewport. */
		function anchorFor(element) {
			const fallback = { top: 64, right: 16 };
			if (!element || typeof element.getBoundingClientRect !== "function") return fallback;
			const rect = element.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.bottom === 0) return fallback;
			const viewportWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
			const viewportHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 720;
			const room = Math.min(660, Math.max(240, viewportHeight - 24));
			return {
				top: Math.max(8, Math.min(rect.bottom + 6, Math.max(8, viewportHeight - room - 8))),
				right: Math.max(8, viewportWidth - rect.right),
			};
		}

		function togglePanel(element, sessionId, dir) {
			if (state.open === true && state.sessionId === sessionId && state.closing !== true) {
				closePanel();
				return;
			}
			cancelClose();
			emit({ open: true, closing: false, openMenu: null, sessionId, anchor: anchorFor(element), anchorElement: element ?? null });
			if (state.dir !== dir) void loadFor(sessionId, dir);
		}

		/** The Session header's todo button: opens the panel and carries the open count. */
		function TodoHeaderButton(props) {
			const snapshot = useStore();
			const sessionId = props && props.sessionId ? props.sessionId : null;
			const dir = props.useSessions((session) => (session.byId ? session.byId[sessionId]?.cwd : undefined));

			react.useEffect(() => {
				if (dir === undefined || dir === null || dir === "") {
					if (state.dir !== null) void loadFor(sessionId, null);
					return;
				}
				if (state.sessionId !== sessionId || state.dir !== dir) void loadFor(sessionId, dir);
			}, [sessionId, dir]);

			react.useEffect(() => {
				const onFocus = () => {
					if (state.sessionId === sessionId && state.dir === dir && !pending() && !state.saving) {
						void loadFor(sessionId, dir);
					}
				};
				window.addEventListener("focus", onFocus);
				return () => window.removeEventListener("focus", onFocus);
			}, [sessionId, dir]);

			if (dir === undefined || dir === null || dir === "") return null;

			const openCount = openCountOf(snapshot.todos);
			const expanded = snapshot.open === true && snapshot.sessionId === sessionId;
			return react.createElement(
				"button",
				{
					type: "button",
					className: "wst-btn",
					"data-wst-trigger": "1",
					title: "待办清单 · " + dir,
					"aria-label": "待办清单",
					"aria-expanded": expanded ? "true" : "false",
					onClick: (event) => togglePanel(event.currentTarget, sessionId, dir),
				},
				react.createElement(ChecklistIcon, { size: 14 }),
				openCount > 0 ? react.createElement("span", { className: "wst-badge" }, String(openCount)) : null,
			);
		}

		function TodoRow(props) {
			const todo = props.todo;
			const [dropSide, setDropSide] = react.useState(null);
			const done = todo.status === "done";
			const overdue = todo.due !== null && todo.due !== undefined && !done && todo.due < todayKey();
			const doneSubtasks = (todo.subtasks || []).filter((entry) => entry.done).length;
			const priority = PRIORITIES.find((entry) => entry.id === todo.priority) || null;

			const onDragOver = (event) => {
				if (dragState.id === null || dragState.id === todo.id) return;
				const types = event.dataTransfer ? event.dataTransfer.types : undefined;
				if (types && typeof types.indexOf === "function" && types.indexOf("text/plain") === -1) return;
				event.preventDefault();
				if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
				const rect = event.currentTarget.getBoundingClientRect();
				setDropSide(event.clientY > rect.top + rect.height / 2 ? "after" : "before");
			};
			/** Rows contain children, so a dragleave that stays inside the row must not clear the marker. */
			const onDragLeave = (event) => {
				const next = event.relatedTarget;
				if (next && event.currentTarget && typeof event.currentTarget.contains === "function" && event.currentTarget.contains(next)) return;
				setDropSide(null);
			};
			const onDrop = (event) => {
				event.preventDefault();
				const source = dragState.id;
				const side = dropSide;
				dragState.id = null;
				setDropSide(null);
				if (source !== null) reorderTodos(source, todo.id, side === "after");
			};

			const style = dropSide === "before"
				? { boxShadow: "inset 0 2px 0 0 var(--dsw-alias-brand-primary,#4a9eff)" }
				: dropSide === "after"
					? { boxShadow: "inset 0 -2px 0 0 var(--dsw-alias-brand-primary,#4a9eff)" }
					: null;

			const status = statusOf(todo.status);
			const noteCount = (todo.subtasks || []).length + (todo.notes !== "" ? 1 : 0);
			const menuId = props.menuKey;
			const menuOpen = (name) => menuId === todo.id + ":" + name;
			const setMenu = (name, next) => props.onMenuChange(next ? todo.id + ":" + name : null);

			const tags = [
				todo.due && overdue
					? react.createElement("span", { key: "due", className: "wst-tag wst-overdue", title: "已逾期" }, "逾期 " + todo.due)
					: null,
				(todo.subtasks || []).length > 0
					? react.createElement("span", { key: "subtasks", className: "wst-tag", title: "子任务完成数" }, String(doneSubtasks) + "/" + String(todo.subtasks.length))
					: null,
			];

			const line1 = react.createElement(
				"div",
				{ className: "wst-line1" },
				react.createElement("button", { type: "button", className: "wst-name", title: "点击复制标题", onClick: () => copyText(todo.title) }, todo.title),
				tags,
			);

			/** One status/priority pill that opens the app's own menu. */
			const statusControl = react.createElement(ui.Menu, {
				open: menuOpen("status"),
				align: "start",
				dense: true,
				selection: "fill",
				onClose: () => setMenu("status", false),
				items: STATUSES.map((entry) => ({
					id: entry.id,
					label: entry.label,
					icon: typeof entry.Icon === "function"
						? react.createElement(entry.Icon, { size: 14, style: { color: "var(" + entry.color + ")" } })
						: null,
				})),
				selectedId: todo.status,
				onSelect: (id) => {
					setMenu("status", false);
					if (id !== todo.status) patchTodo(todo.id, { status: id });
				},
				anchor: react.createElement(
					"button",
					{
						type: "button", className: "wst-status", title: "状态：" + status.label, "aria-label": "状态",
						style: { color: "var(" + status.color + ")" }, "aria-haspopup": "menu", "aria-expanded": menuOpen("status"),
						onClick: () => setMenu("status", !menuOpen("status")),
					},
					react.createElement(StatusIcon, { status: todo.status, size: 13 }),
					react.createElement("span", null, status.label),
					react.createElement(ui.IconChevronDownOutline14, { size: 10 }),
				),
			});

			const priorityControl = react.createElement(ui.Menu, {
				open: menuOpen("priority"),
				align: "start",
				dense: true,
				selection: "fill",
				onClose: () => setMenu("priority", false),
				items: [
					{ id: "", label: "无优先级", icon: null },
					...PRIORITIES.map((entry) => ({
						id: entry.id,
						label: entry.label,
						icon: react.createElement("span", { className: "wst-prio-dot", style: { color: "var(" + entry.color + ")", background: "currentColor" } }),
					})),
				],
				selectedId: priority === null ? "" : priority.id,
				onSelect: (id) => {
					setMenu("priority", false);
					patchTodo(todo.id, { priority: id === "" ? null : id });
				},
				anchor: react.createElement(
					"button",
					{
						type: "button", className: "wst-prio", "aria-label": "优先级", "aria-haspopup": "menu", "aria-expanded": menuOpen("priority"),
						title: priority === null ? "优先级：无" : "优先级：" + priority.label,
						style: priority === null ? undefined : { color: "var(" + priority.color + ")" },
						onClick: () => setMenu("priority", !menuOpen("priority")),
					},
					react.createElement("span", { className: "wst-prio-dot" }),
					react.createElement("span", null, priority === null ? "优先级" : priority.label),
				),
			});

			const whenControl = react.createElement(
				"label",
				{ className: "wst-date" + (overdue ? " wst-overdue" : ""), title: overdue ? "已逾期" : "截止日期" },
				react.createElement(ui.IconAlarmClockOutline16, { size: 12 }),
				react.createElement("input", {
					type: "date", value: todo.due ? todo.due : "", "aria-label": "截止日期",
					onChange: (event) => patchTodo(todo.id, { due: event.target.value === "" ? null : event.target.value }),
				}),
			);

			const line2 = react.createElement(
				"div",
				{ className: "wst-line2" },
				statusControl,
				priorityControl,
				whenControl,
				react.createElement(
					"button",
					{
						type: "button", className: "wst-mini", title: "备注与子任务", "aria-expanded": props.expanded ? "true" : "false",
						onClick: props.onToggleDetail,
					},
					react.createElement(ui.IconListPenOutline16, { size: 12 }),
					react.createElement("span", null, noteCount > 0 ? "备注 " + String(noteCount) : "备注"),
				),
				react.createElement(
					"button",
					{
						type: "button", className: "wst-mini wst-del", title: "删除这条待办", "aria-label": "删除",
						onClick: () => removeTodo(todo.id),
					},
					react.createElement(ui.IconTrashOutline16, { size: 12 }),
				),
			);

			const detail = props.expanded
				? react.createElement(
					"div",
					{ className: "wst-detail" },
					react.createElement("textarea", {
						className: "wst-notes", value: todo.notes, placeholder: "备注…", "aria-label": "备注",
						onChange: (event) => patchTodo(todo.id, { notes: event.target.value }),
					}),
					(todo.subtasks || []).length > 0
						? react.createElement(
							"div",
							{ className: "wst-sublist" },
							todo.subtasks.map((subtask) => react.createElement(
								"div",
								{ key: subtask.id, className: "wst-sub" },
								react.createElement("input", {
									type: "checkbox", checked: subtask.done === true, "aria-label": "子任务完成",
									onChange: (event) => patchSubtask(todo.id, subtask.id, { done: event.target.checked }),
								}),
								react.createElement("span", { className: "wst-sub-name" + (subtask.done ? " wst-sub-done" : "") }, subtask.title),
								react.createElement("button", {
									type: "button", className: "wst-mini wst-del", title: "删除子任务", "aria-label": "删除子任务",
									onClick: () => removeSubtask(todo.id, subtask.id),
								}, "×"),
							)),
						)
						: null,
					react.createElement("input", {
						className: "wst-input wst-subadd", placeholder: "添加子任务，回车确认", "aria-label": "添加子任务",
						onKeyDown: (event) => {
							if (event.key !== "Enter") return;
							const value = String(event.currentTarget.value || "").trim();
							if (value === "") return;
							addSubtask(todo.id, value);
							event.currentTarget.value = "";
						},
					}),
				)
				: null;

			return react.createElement(
				"li",
				{ className: "wst-row", "data-done": done ? "true" : "false", style, onDragOver, onDrop, onDragLeave },
				react.createElement("span", {
					className: "wst-grip", draggable: true, title: "拖动排序", "aria-hidden": "true",
					onDragStart: (event) => {
						dragState.id = todo.id;
						try {
							event.dataTransfer.setData("text/plain", todo.id);
							event.dataTransfer.effectAllowed = "move";
						} catch {
							/* a browser without a dataTransfer still reorders through dragState */
						}
					},
					onDragEnd: () => {
						dragState.id = null;
						setDropSide(null);
					},
				}, react.createElement(GripIcon)),
				react.createElement("div", { className: "wst-main" }, line1, line2, detail),
			);
		}

		/** The floating panel, rendered in the frame-wide overlay layer. */
		function TodoPanel() {
			const snapshot = useStore();
			const panelRef = react.useRef(null);
			const [draft, setDraft] = react.useState("");
			const [expanded, setExpanded] = react.useState({});
			const open = snapshot.open === true;

			react.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					if (panelRef.current !== null && target instanceof Node && panelRef.current.contains(target)) return;
					if (target instanceof Element && target.closest("[data-wst-trigger]") !== null) return;
					closePanel();
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") {
						// A row menu owns the first Escape; the panel closes on the next one.
						if (state.openMenu !== null) {
							emit({ openMenu: null });
							return;
						}
						closePanel();
					}
				};
				const onResize = () => emit({ anchor: anchorFor(state.anchorElement) });
				document.addEventListener("mousedown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("resize", onResize);
				return () => {
					document.removeEventListener("mousedown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("resize", onResize);
				};
			}, [open]);

			react.useEffect(() => {
				const onHidden = () => {
					if (document.visibilityState === "hidden") flush(true);
				};
				const onUnload = () => flush(true);
				document.addEventListener("visibilitychange", onHidden);
				window.addEventListener("beforeunload", onUnload);
				return () => {
					document.removeEventListener("visibilitychange", onHidden);
					window.removeEventListener("beforeunload", onUnload);
				};
			}, []);

			/**
			 * Native controls inside the panel (the date picker) follow the panel's
			 * own surface instead of the OS preference, so they never render as a
			 * glaring light or black widget against a themed panel.
			 */
			react.useEffect(() => {
				const root = panelRef.current;
				if (root === null || typeof window.getComputedStyle !== "function") return;
				const background = window.getComputedStyle(root).backgroundColor || "";
				const parts = background.match(/[\d.]+/g);
				if (parts === null || parts.length < 3) return;
				const [r, g, b] = parts.slice(0, 3).map(Number);
				const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
				root.style.colorScheme = luminance < 0.5 ? "dark" : "light";
			});

			if (!open) return null;

			const todos = snapshot.todos;
			const openCount = openCountOf(todos);
			const doneCount = todos.length - openCount;
			const visible = todos.filter((todo) => (snapshot.filter === "open" ? todo.status !== "done" : snapshot.filter === "done" ? todo.status === "done" : true));
			const anchor = snapshot.anchor || { top: 64, right: 16 };
			const viewportWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
			const width = Math.min(440, Math.max(280, viewportWidth - 24));
			const panelStyle = {
				top: Math.max(8, anchor.top),
				right: Math.min(Math.max(8, anchor.right), Math.max(8, viewportWidth - width - 8)),
				width,
			};

			const commitDraft = () => {
				const value = draft.trim();
				if (value === "") return;
				addTodo(value);
				setDraft("");
			};

			const head = react.createElement(
				"div",
				{ className: "wst-head" },
				react.createElement(
					"span",
					{ className: "wst-title" },
					react.createElement(ChecklistIcon, { size: 14 }),
					"待办",
					react.createElement("span", { className: "wst-count" }, openCount > 0 ? "未完成 " + String(openCount) : "已清空"),
				),
				react.createElement("span", { className: "wst-grow" }),
				react.createElement("button", {
					type: "button", className: "wst-icon-btn", title: "从磁盘重新载入", "aria-label": "从磁盘重新载入",
					onClick: () => void loadFor(snapshot.sessionId, snapshot.dir),
				}, react.createElement(ui.IconRefreshOutline16, { size: 13 })),
				react.createElement("button", {
					type: "button", className: "wst-icon-btn", title: "关闭", "aria-label": "关闭", onClick: closePanel,
				}, react.createElement(ui.IconCloseOutline16, { size: 13 })),
			);

			const addRow = react.createElement(
				"div",
				{ className: "wst-add" },
				react.createElement("input", {
					className: "wst-input", value: draft, placeholder: "新增待办，回车添加", "aria-label": "新增待办", autoFocus: true,
					onChange: (event) => setDraft(event.target.value),
					onKeyDown: (event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						commitDraft();
					},
				}),
				react.createElement(
					"button",
					{ type: "button", className: "wst-add-btn", disabled: draft.trim() === "", onClick: commitDraft },
					react.createElement(ui.IconPlusOutline16, { size: 13 }),
					react.createElement("span", null, "添加"),
				),
			);

			const chip = (id, label, count) => react.createElement("button", {
				key: id, type: "button", className: "wst-chip" + (snapshot.filter === id ? " wst-chip-on" : ""),
				onClick: () => setFilter(id),
			}, label + " " + String(count));

			const chips = react.createElement(
				"div",
				{ className: "wst-chips" },
				chip("all", "全部", todos.length),
				chip("open", "未完成", openCount),
				chip("done", "已完成", doneCount),
				react.createElement("span", { className: "wst-grow" }),
				react.createElement("button", {
					type: "button", className: "wst-path", title: "点击复制工作目录：" + String(snapshot.dir || ""),
					onClick: () => copyText(snapshot.dir || ""),
				}, snapshot.dir || "（尚未绑定工作目录）"),
				snapshot.error !== null ? react.createElement("span", { className: "wst-err", title: String(snapshot.error) }, String(snapshot.error)) : null,
			);

			const list = react.createElement(
				"ul",
				{ className: "wst-list" },
				visible.length === 0
					? react.createElement(
						"li",
						{ className: "wst-empty" },
						react.createElement(ChecklistIcon, { size: 22 }),
						react.createElement(
							"span",
							null,
							snapshot.loading ? "载入中…" : todos.length === 0 ? "还没有待办。输入内容后回车即可添加。" : "当前筛选下没有待办。",
						),
					)
					: visible.map((todo) => react.createElement(TodoRow, {
						key: todo.id,
						todo,
						expanded: expanded[todo.id] === true,
						menuKey: snapshot.openMenu,
						onMenuChange: (key) => emit({ openMenu: key }),
						onToggleDetail: () => setExpanded(Object.assign({}, expanded, { [todo.id]: expanded[todo.id] !== true })),
					})),
			);

			let statusText = "";
			if (snapshot.saving) statusText = "保存中…";
			else if (snapshot.dirty) statusText = "待保存";
			else if (snapshot.conflict) statusText = "未写入";
			else if (snapshot.savedAt) statusText = "已保存 " + clockText(snapshot.savedAt);
			else if (snapshot.dir) statusText = "尚无清单文件";

			const foot = react.createElement(
				"div",
				{ className: "wst-foot" },
				react.createElement("span", null, statusText),
				react.createElement("span", { className: "wst-grow" }),
				snapshot.toast !== null ? react.createElement("span", { className: "wst-toast" }, snapshot.toast) : null,
				snapshot.conflict === true
					? react.createElement("button", {
						type: "button", className: "wst-mini", title: "放弃本地改动，读取磁盘上的版本",
						onClick: () => void loadFor(snapshot.sessionId, snapshot.dir),
					}, "重新载入")
					: null,
			);

			return react.createElement(
				"div",
				{
					className: "wst-panel", style: panelStyle, ref: panelRef, role: "dialog", "aria-label": "工作区待办清单",
					"data-state": snapshot.closing === true ? "closing" : "open",
				},
				head, addRow, chips, list, foot,
			);
		}

		/* ------------------------------------------------------------------ */
		/* plugin                                                              */
		/* ------------------------------------------------------------------ */

		function apply(ctx) {
			ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
				name: HEADER_SLOT,
				id: "workspace-todo",
				order: 10,
			}, TodoHeaderButton));
			ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
				name: OVERLAY_SLOT,
				id: "workspace-todo-panel",
				order: 40,
			}, TodoPanel));
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
