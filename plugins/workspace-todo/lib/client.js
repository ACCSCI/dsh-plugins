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

		const API_BASE = "/workspace-todo/api";
		const HEADER_SLOT = "conversation.session.header.utilities";
		const OVERLAY_SLOT = "shell.overlay";
		const FILTER_KEY = "dsh.workspace-todo.filter";
		const TOAST_MS = 1800;
		const SAVE_DEBOUNCE_MS = 350;

		/** Status order is the user's: 待办, 进行中, 已完成, 阻塞, 等待. */
		const STATUSES = [
			{ id: "todo", label: "待办" },
			{ id: "doing", label: "进行中" },
			{ id: "done", label: "已完成" },
			{ id: "blocked", label: "阻塞" },
			{ id: "waiting", label: "等待" },
		];
		const PRIORITIES = [
			{ id: "high", label: "高" },
			{ id: "medium", label: "中" },
			{ id: "low", label: "低" },
		];
		const PRIORITY_TOKENS = {
			high: "--dsw-alias-state-error-primary",
			medium: "--dsw-alias-state-warn-primary",
			low: "--dsw-alias-label-secondary",
		};

		const CSS = [
			".wst-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:transparent;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:11px;line-height:16px;cursor:pointer}",
			".wst-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}",
			'.wst-btn[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary,#4a9eff);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}',
			".wst-badge{min-width:15px;height:15px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-brand-primary,#4a9eff);color:#fff;font-size:10px;font-weight:600;line-height:15px;text-align:center}",
			".wst-panel{position:fixed;z-index:40;pointer-events:auto;display:flex;flex-direction:column;max-height:min(72vh,660px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:12px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 12px 32px rgba(0,0,0,.28);font-family:inherit;font-size:12px}",
			".wst-head{display:flex;align-items:center;gap:6px;padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}",
			".wst-title{font-size:13px;font-weight:600}",
			".wst-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-family:inherit;font-size:11px;text-align:left;cursor:pointer}",
			".wst-path:hover{color:var(--dsw-alias-label-primary,inherit)}",
			".wst-icon-btn{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-family:inherit;font-size:13px;line-height:16px;padding:2px 6px;cursor:pointer}",
			".wst-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary,inherit)}",
			".wst-add{display:flex;gap:6px;padding:10px 10px 6px}",
			".wst-input{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));color:inherit;font-family:inherit;font-size:12px}",
			".wst-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a9eff)}",
			".wst-add-btn{height:28px;padding:0 12px;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary,#4a9eff);color:#fff;font-family:inherit;font-size:12px;cursor:pointer}",
			".wst-add-btn:disabled{opacity:.4;cursor:not-allowed}",
			".wst-chips{display:flex;align-items:center;gap:4px;padding:0 10px 8px;font-size:11px;color:var(--dsw-alias-label-secondary,#888)}",
			".wst-chip{border:0;border-radius:10px;background:transparent;color:inherit;font-family:inherit;font-size:11px;padding:2px 8px;cursor:pointer}",
			".wst-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}",
			".wst-chip-on{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18));color:var(--dsw-alias-label-primary,inherit);font-weight:600}",
			".wst-grow{flex:1}",
			".wst-err{color:var(--dsw-alias-state-error-primary,#e5534b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}",
			".wst-list{flex:1;min-height:0;overflow:auto;margin:0;padding:0 6px 8px;list-style:none}",
			".wst-row{display:flex;gap:6px;padding:6px 4px;border-radius:8px}",
			".wst-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09))}",
			".wst-grip{padding-top:1px;color:var(--dsw-alias-label-secondary,#999);font-size:12px;line-height:18px;cursor:grab;user-select:none}",
			".wst-main{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}",
			".wst-line1{display:flex;align-items:center;gap:6px;min-width:0}",
			".wst-name{min-width:0;max-width:100%;overflow:hidden;border:0;background:transparent;color:inherit;font-family:inherit;font-size:12px;text-align:left;text-overflow:ellipsis;white-space:nowrap;padding:0;cursor:copy}",
			".wst-name:hover{text-decoration:underline}",
			".wst-done .wst-name{color:var(--dsw-alias-label-secondary,#888);text-decoration:line-through}",
			".wst-tag{flex:none;border:1px solid currentColor;border-radius:6px;color:var(--dsw-alias-label-secondary,#888);font-size:10px;line-height:14px;padding:0 5px}",
			".wst-overdue{color:var(--dsw-alias-state-error-primary,#e5534b)}",
			".wst-line2{display:flex;align-items:center;gap:4px;flex-wrap:wrap}",
			".wst-select,.wst-date{height:22px;max-width:104px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:6px;background:transparent;color:inherit;font-family:inherit;font-size:11px;padding:0 2px}",
			".wst-date{max-width:118px}",
			".wst-mini{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-family:inherit;font-size:11px;padding:1px 5px;cursor:pointer}",
			".wst-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary,inherit)}",
			".wst-del:hover{color:var(--dsw-alias-state-error-primary,#e5534b)}",
			".wst-detail{display:flex;flex-direction:column;gap:6px;margin-top:2px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}",
			".wst-notes{box-sizing:border-box;width:100%;min-height:48px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:6px;background:transparent;color:inherit;font-family:inherit;font-size:11px;resize:vertical}",
			".wst-sublist{display:flex;flex-direction:column;gap:4px}",
			".wst-sub{display:flex;align-items:center;gap:6px;font-size:11px}",
			".wst-sub input[type=checkbox]{margin:0}",
			".wst-sub-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".wst-sub-done{color:var(--dsw-alias-label-secondary,#888);text-decoration:line-through}",
			".wst-subadd{height:24px;font-size:11px}",
			".wst-foot{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));color:var(--dsw-alias-label-secondary,#888);font-size:11px}",
			".wst-toast{color:var(--dsw-alias-state-success-primary,#3fb950);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%}",
			".wst-empty{padding:22px 12px;color:var(--dsw-alias-label-secondary,#888);font-size:12px;text-align:center}",
		].join("");

		(function installStyles() {
			const tagId = "@dsh-external/workspace-todo/panel.css";
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
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

		function ChecklistIcon(props) {
			const size = props && props.size ? props.size : 14;
			return react.createElement(
				"svg",
				{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
				react.createElement("path", { d: "M2 4.2 3.4 5.6 6 3", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }),
				react.createElement("path", { d: "M2 11.2 3.4 12.6 6 10", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }),
				react.createElement("path", { d: "M8 4.5h6M8 11.5h6", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
			);
		}

		function closePanel() {
			flush();
			emit({ open: false });
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
			if (state.open === true && state.sessionId === sessionId) {
				closePanel();
				return;
			}
			emit({ open: true, sessionId, anchor: anchorFor(element), anchorElement: element ?? null });
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

			const tags = [
				priority !== null
					? react.createElement("span", { key: "priority", className: "wst-tag", style: { color: "var(" + PRIORITY_TOKENS[priority.id] + ")" }, title: "优先级" }, priority.label)
					: null,
				todo.due
					? react.createElement("span", { key: "due", className: "wst-tag" + (overdue ? " wst-overdue" : ""), title: overdue ? "已逾期" : "截止日期" }, (overdue ? "逾期 " : "") + todo.due)
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

			const line2 = react.createElement(
				"div",
				{ className: "wst-line2" },
				react.createElement(
					"select",
					{
						className: "wst-select", value: todo.status, title: "状态", "aria-label": "状态",
						onChange: (event) => patchTodo(todo.id, { status: event.target.value }),
					},
					STATUSES.map((entry) => react.createElement("option", { key: entry.id, value: entry.id }, entry.label)),
				),
				react.createElement(
					"select",
					{
						className: "wst-select", value: priority === null ? "" : priority.id, title: "优先级", "aria-label": "优先级",
						onChange: (event) => patchTodo(todo.id, { priority: event.target.value === "" ? null : event.target.value }),
					},
					react.createElement("option", { value: "" }, "优先级"),
					PRIORITIES.map((entry) => react.createElement("option", { key: entry.id, value: entry.id }, entry.label)),
				),
				react.createElement("input", {
					className: "wst-date", type: "date", value: todo.due ? todo.due : "", title: "截止日期", "aria-label": "截止日期",
					onChange: (event) => patchTodo(todo.id, { due: event.target.value === "" ? null : event.target.value }),
				}),
				react.createElement(
					"button",
					{
						type: "button", className: "wst-mini", title: "备注与子任务", "aria-expanded": props.expanded ? "true" : "false",
						onClick: props.onToggleDetail,
					},
					todo.notes !== "" || (todo.subtasks || []).length > 0 ? "备注 " + String((todo.notes !== "" ? 1 : 0) + (todo.subtasks || []).length) : "备注",
				),
				react.createElement("button", { type: "button", className: "wst-mini wst-del", title: "删除这条待办", "aria-label": "删除", onClick: () => removeTodo(todo.id) }, "删除"),
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
				{ className: "wst-row" + (done ? " wst-done" : ""), style, onDragOver, onDrop, onDragLeave },
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
				}, "⠿"),
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
					if (event.key === "Escape") closePanel();
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
				react.createElement("span", { className: "wst-title" }, "待办"),
				react.createElement("button", {
					type: "button", className: "wst-path", title: "点击复制工作目录：" + String(snapshot.dir || ""),
					onClick: () => copyText(snapshot.dir || ""),
				}, snapshot.dir || "（尚未绑定工作目录）"),
				react.createElement("button", {
					type: "button", className: "wst-icon-btn", title: "从磁盘重新载入", "aria-label": "从磁盘重新载入",
					onClick: () => void loadFor(snapshot.sessionId, snapshot.dir),
				}, "↻"),
				react.createElement("button", { type: "button", className: "wst-icon-btn", title: "关闭", "aria-label": "关闭", onClick: closePanel }, "×"),
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
				react.createElement("button", { type: "button", className: "wst-add-btn", disabled: draft.trim() === "", onClick: commitDraft }, "添加"),
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
				snapshot.error !== null ? react.createElement("span", { className: "wst-err", title: String(snapshot.error) }, String(snapshot.error)) : null,
			);

			const list = react.createElement(
				"ul",
				{ className: "wst-list" },
				visible.length === 0
					? react.createElement(
						"li",
						{ className: "wst-empty" },
						snapshot.loading ? "载入中…" : todos.length === 0 ? "还没有待办。输入内容后回车即可添加。" : "当前筛选下没有待办。",
					)
					: visible.map((todo) => react.createElement(TodoRow, {
						key: todo.id,
						todo,
						expanded: expanded[todo.id] === true,
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
				{ className: "wst-panel", style: panelStyle, ref: panelRef, role: "dialog", "aria-label": "工作区待办清单" },
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
