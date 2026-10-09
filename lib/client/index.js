/**
 * dsh-peak-hours — browser half.
 *
 * Mounts one compact pill into the composer tool row's `conversation.input.left`
 * list slot. The runtime renders that row as
 * `[＋] [div.modes: conversation.input.permission + conversation.input.plan] [conversation.input.left …]`
 * (see `_recon/src/dsh-client-ui-conversation/lib/client.js:17492-17525`), so the
 * pill sits immediately right of the mode buttons.
 *
 * Contract (SPEC.md 2.5, frozen):
 *   GET  /api/peak-hours/state  polled every 15 s and on `visibilitychange`
 *   POST /api/peak-hours/mode   body `{ mode }`
 * Plain same-origin `fetch` with an 8 s AbortController timeout; every failure
 * degrades to a muted "unavailable" state and NEVER throws (a throwing plugin
 * breaks the shell boot).
 *
 * Zero npm dependencies, no build step: the only imports are the shell seed
 * modules `react` and `react/jsx-runtime`.
 */
window.__ModuleLoader__.load({
	id: "dsh-peak-hours",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;

		//#region constants
		/** Dictionary namespace owned by this plugin. */
		const NS = "dsh-peak-hours";
		/** Composer list slot: right of `conversation.input.permission` / `.plan`. */
		const SLOT = "conversation.input.left";
		/** Stable list-cell identity (a `list` slot requires `id`). */
		const SLOT_ID = "peak-hours";
		/** List-slot order within the cell. */
		const SLOT_ORDER = 20;
		/**
		 * Full-width banner slot above the composer card: the runtime renders
		 * `composerStack = [hero, heroWorkspaceRow, conversation.input.dock, inputBar]`
		 * (`_recon/src/dsh-client-ui-conversation/lib/client.js:16301-16312`), so a
		 * list entry here sits directly above the input card. `order: 30` places it
		 * after the official `todo` (0) and `queue` (20) docks, i.e. closest to the
		 * card.
		 */
		const DOCK = "conversation.input.dock";
		const DOCK_ID = "peak-hours";
		const DOCK_ORDER = 30;
		/** Host routes (SPEC 2.3). */
		const API_STATE = "/api/peak-hours/state";
		const API_MODE = "/api/peak-hours/mode";
		/** Poll cadence, request timeout, and the popover's local countdown tick. */
		const POLL_MS = 15000;
		/**
		 * Fast cadence while a phase boundary is imminent or just passed: the
		 * snapshot is then the only thing still lagging behind (SPEC 2.5 keeps the
		 * plain cadence otherwise).
		 */
		const FAST_POLL_MS = 3000;
		const FAST_POLL_WINDOW_MS = 30000;
		const REQUEST_TIMEOUT_MS = 8000;
		const TICK_MS = 1000;
		/** Beijing time is a fixed UTC+8 offset with no DST (SPEC 1). */
		const BJ_OFFSET_MS = 8 * 3600 * 1000;
		/** The only two modes the host accepts. */
		const MODE_ALWAYS = "always";
		const MODE_IDLE_ONLY = "idle-only";
		/** Reasons the host may report (SPEC 1); anything else is not localized. */
		const KNOWN_REASONS = ["peak", "off-hours", "weekend", "holiday"];
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"button.always": "全天运行",
			"button.running": "空闲时段 · 运行中",
			"button.paused": "空闲时段 · 已暂停",
			"button.unavailable": "时段不可用",
			"button.loading": "时段读取中",
			"button.aria": "运行时段：{label}，点击设置",
			"button.title": "运行时段：高峰时段自动暂停，空闲时段自动继续",
			"popover.title": "运行时段",
			"option.always": "全天运行",
			"option.always.desc": "任何时间都执行任务",
			"option.idleOnly": "仅空闲时段",
			"option.idleOnly.desc": "工作日 09:00-12:00、14:00-18:00（法定节假日除外）暂停任务；周末与法定节假日全天运行",
			"row.now": "当前北京时间",
			"row.next": "下次切换",
			"row.nextValue": "{at} · 进入{phase}",
			"row.holiday": "今日节假日",
			"row.waiting": "排队任务",
			"row.waitingValue": "{count} 个",
			"row.peakWindows": "高峰时段",
			"row.phase": "当前时段",
			"countdown.refreshing": "正在刷新…",
			"countdown.expired": "数据可能已过期",
			"phase.peak": "高峰",
			"phase.idle": "空闲",
			"reason.peak": "工作时段",
			"reason.off-hours": "非工作时段",
			"reason.weekend": "周末",
			"reason.holiday": "节假日",
			"warning.unknownYear": "{year} 年节假日数据缺失，该年工作日一律按非节假日判定。",
			"warning.clockOverrideTtl": "演示模式：时间被临时偏移（模拟 {at}），剩余 {ttl} 后自动恢复真实时间",
			"warning.clockOverridePlain": "演示模式：时间被临时偏移",
			"error.action": "切换失败：{message}",
			"error.unavailable": "宿主接口不可用",
			"state.stale": "显示的是最后一次成功读取的数据",
			"banner.waiting": "已暂停 · 高峰时段，{count} 个任务排队中，将在 {time} 自动开始（还有 {countdown}）",
			"banner.idle": "高峰时段：现在提交的任务会在 {time} 自动开始（还有 {countdown}）",
			"banner.aria": "运行时段提示"
		};
		/** English dictionary, key-complete against `zh`. */
		const en = {
			"button.always": "Always on",
			"button.running": "Idle hours · running",
			"button.paused": "Idle hours · paused",
			"button.unavailable": "Hours unavailable",
			"button.loading": "Reading hours",
			"button.aria": "Run window: {label}. Click to change.",
			"button.title": "Run window: pause during peak hours, resume during idle hours",
			"popover.title": "Run window",
			"option.always": "Always on",
			"option.always.desc": "Tasks run at any time",
			"option.idleOnly": "Idle hours only",
			"option.idleOnly.desc": "Tasks pause on workdays 09:00-12:00 and 14:00-18:00 (statutory holidays excepted); weekends and statutory holidays run all day",
			"row.now": "Beijing time",
			"row.next": "Next switch",
			"row.nextValue": "{at} · to {phase}",
			"row.holiday": "Holiday today",
			"row.waiting": "Queued tasks",
			"row.waitingValue": "{count}",
			"row.peakWindows": "Peak hours",
			"row.phase": "Current phase",
			"countdown.refreshing": "Refreshing…",
			"countdown.expired": "Data may be out of date",
			"phase.peak": "peak",
			"phase.idle": "idle",
			"reason.peak": "working hours",
			"reason.off-hours": "off hours",
			"reason.weekend": "weekend",
			"reason.holiday": "holiday",
			"warning.unknownYear": "No holiday data for {year}; its workdays are treated as non-holidays.",
			"warning.clockOverrideTtl": "Demo mode: the clock is temporarily offset (simulating {at}); real time resumes in {ttl}",
			"warning.clockOverridePlain": "Demo mode: the clock is temporarily offset",
			"error.action": "Switch failed: {message}",
			"error.unavailable": "Host API unavailable",
			"state.stale": "Showing the last successful reading",
			"banner.waiting": "Paused · peak hours: {count} queued, starting automatically at {time} (in {countdown})",
			"banner.idle": "Peak hours: a task submitted now starts automatically at {time} (in {countdown})",
			"banner.aria": "Run window notice"
		};
		/** Shipped dictionaries, keyed by BCP 47 tag. */
		const DICTS = { zh, en };
		/** CJK-first stack; `en` inherits the shell font. */
		const ZH_FONT =
			'"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", system-ui, sans-serif';
		//#endregion

		//#region pure helpers
		/** Lower-case a locale tag; non-strings become `""`. */
		function normalizeLocale(localeId) {
			return typeof localeId === "string" ? localeId.trim().toLowerCase() : "";
		}

		/**
		 * Resolve the dictionary for an active locale: exact tag, then primary
		 * subtag, then English (the loader's own fallback terminal).
		 * @param dicts - `{ zh, en }` style dictionary map.
		 * @param localeId - active locale tag, e.g. `zh`, `zh-CN`, `en-US`.
		 * @returns the matching dictionary; English when nothing matches.
		 */
		function resolveDictionary(dicts, localeId) {
			const tag = normalizeLocale(localeId);
			if (tag === "") return dicts.en;
			if (dicts[tag] !== undefined) return dicts[tag];
			const primary = tag.split("-")[0];
			if (dicts[primary] !== undefined) return dicts[primary];
			return dicts.en;
		}

		/** Whether a locale tag is Chinese (any region). */
		function isChinese(localeId) {
			return normalizeLocale(localeId).split("-")[0] === "zh";
		}

		/** Font stack for a locale tag: CJK-first for Chinese, else `inherit`. */
		function fontFamilyFor(localeId) {
			return isChinese(localeId) ? ZH_FONT : "inherit";
		}

		/**
		 * Dictionary lookup with `{name}` interpolation, mirroring
		 * `ctx.locale.bind(ns)`: unknown keys fall back to the key itself.
		 * @param dicts - `{ zh, en }` style dictionary map.
		 * @param localeId - active locale tag.
		 * @param key - dictionary key.
		 * @param params - optional `{name: value}` interpolation map.
		 * @returns the localized, interpolated string.
		 */
		function translate(dicts, localeId, key, params) {
			const dict = resolveDictionary(dicts, localeId);
			const fallback = DICTS.en[key];
			const template = dict[key] !== undefined ? dict[key] : fallback !== undefined ? fallback : key;
			if (params === undefined || params === null) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}

		/**
		 * Infer which shipped language the bound `t` is rendering, by comparing the
		 * resolved copy of the first key whose translations differ. This keeps the
		 * font stack in step with the shell language without reading the locale
		 * service (the slot contract only guarantees `t`).
		 * @param t - bound lookup, `(key) => string`.
		 * @param dicts - `{ zh, en }` style dictionary map.
		 * @returns `'zh'`, `'en'`, or `''` when neither matches.
		 */
		function detectRenderedLocale(t, dicts) {
			if (typeof t !== "function") return "";
			for (const key of Object.keys(dicts.zh)) {
				const zhText = dicts.zh[key];
				const enText = dicts.en[key];
				if (zhText === enText) continue;
				const rendered = t(key);
				if (rendered === zhText) return "zh";
				if (rendered === enText) return "en";
			}
			return "";
		}

		/**
		 * Strict finite-number coercion: `null`, `''`, booleans and objects are
		 * "missing", not zero. The host JSON contract uses `null` for "no value"
		 * (`unknownHolidayYear`, `clockOverride`), and `Number(null) === 0` would
		 * silently turn those into 1970-01-01 and a bogus "+0" override.
		 * @param value - any candidate.
		 * @returns the finite number, or null.
		 */
		function toFiniteNumber(value) {
			if (typeof value === "number") return Number.isFinite(value) ? value : null;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				return Number.isFinite(parsed) ? parsed : null;
			}
			return null;
		}

		/** Zero-pad a number to two digits. */
		function pad2(value) {
			return String(value).padStart(2, "0");
		}

		/** Normalize any host value to one of the two modes (unknown -> always). */
		function normalizeMode(mode) {
			return mode === MODE_IDLE_ONLY ? MODE_IDLE_ONLY : MODE_ALWAYS;
		}

		/**
		 * Beijing wall-clock text `YYYY-MM-DD HH:mm:ss` for an epoch millisecond.
		 * @param epochMs - epoch milliseconds (any clock: real or overridden).
		 * @returns the fixed-UTC+8 rendering, or `—` for a non-finite input.
		 */
		function formatBeijingClock(epochMs) {
			const value = toFiniteNumber(epochMs);
			if (value === null) return "—";
			const date = new Date(value + BJ_OFFSET_MS);
			return (
				`${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}` +
				` ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
			);
		}

		/**
		 * Countdown text: `HH:MM:SS` below one day, `Nd HH:MM:SS` at or above it,
		 * with a leading `-` once the boundary has passed. Durations truncate
		 * toward zero so the display never rounds a boundary forward.
		 * @param ms - milliseconds remaining.
		 * @returns the formatted countdown, or `—` for a non-finite input.
		 */
		function formatCountdown(ms) {
			const value = toFiniteNumber(ms);
			if (value === null) return "—";
			const sign = value < 0 ? "-" : "";
			let total = Math.floor(Math.abs(value) / 1000);
			const days = Math.floor(total / 86400);
			total -= days * 86400;
			const hours = Math.floor(total / 3600);
			total -= hours * 3600;
			const minutes = Math.floor(total / 60);
			const seconds = total - minutes * 60;
			const clock = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
			return sign + (days > 0 ? `${days}d ${clock}` : clock);
		}

		/**
		 * Compact signed duration for an offset: `+1h`, `-30m`, `0`. The format is
		 * correct, but the magnitude of a clock override tells a user nothing, so
		 * the popover no longer renders it (P4) — it stays as a pure helper for
		 * tests and diagnostics only.
		 * @param ms - offset in milliseconds.
		 * @returns the formatted offset.
		 */
		function formatOffset(ms) {
			const value = toFiniteNumber(ms);
			if (value === null || value === 0) return "0";
			const sign = value < 0 ? "-" : "+";
			let total = Math.floor(Math.abs(value) / 1000);
			const days = Math.floor(total / 86400);
			total -= days * 86400;
			const hours = Math.floor(total / 3600);
			total -= hours * 3600;
			const minutes = Math.floor(total / 60);
			const seconds = total - minutes * 60;
			const parts = [];
			if (days > 0) parts.push(`${days}d`);
			if (hours > 0) parts.push(`${hours}h`);
			if (minutes > 0) parts.push(`${minutes}m`);
			if (parts.length === 0) parts.push(`${seconds}s`);
			return sign + parts.join(" ");
		}

		/** Extract the state object from a `{ ok, state }` envelope, else null. */
		function readState(payload) {
			if (payload === null || typeof payload !== "object" || payload.ok !== true) return null;
			const state = payload.state;
			return state !== null && typeof state === "object" ? state : null;
		}

		/** An empty polling snapshot: no data, no failure, never fetched. */
		const EMPTY_SNAPSHOT = { state: null, fetchedAtMs: 0, error: null };

		/**
		 * Theme custom properties this plugin may reference. Verified against the
		 * running shell's own light-theme block in `dsh-client-ui-theme`:
		 * `--dsw-alias-bg-layer-1` is `bluish-00` (#fff), while
		 * `--dsw-alias-bg-overlay` is `bluish-150` (#e9ecf2) — a grey that turned
		 * the popover into a grey card, so the card uses the layer-1 surface the
		 * official menu also uses. Every reference carries an opaque fallback equal
		 * to that token's light-theme value, so a renamed token degrades to the
		 * same look instead of to nothing. Radius and elevation are real tokens too
		 * (radius-lg = 16px, elevation-panel = a 0.5px stroke ring). A structural
		 * test polices the whole allow-list.
		 */
		const TOKEN = {
			surface: "var(--dsw-alias-bg-layer-1, #ffffff)",
			raised: "var(--dsw-alias-interactive-bg-hover, #f2f3f5)",
			border: "var(--dsw-alias-border-l1, #e5e6eb)",
			hairline: "var(--dsw-alias-border-l2, #e5e6eb)",
			ring: "var(--dsw-alias-border-l3, #e0e0e0)",
			// The banner strip. The light theme defines layer-2 as the same white as
			// layer-1, so the 1px border — not the fill — is what separates it from
			// the transcript; the fallback keeps it visible if the token disappears.
			layer2: "var(--dsw-alias-bg-layer-2, #f5f6f7)",
			text: "var(--dsw-alias-label-primary, #0f1115)",
			secondary: "var(--dsw-alias-label-secondary, #61666b)",
			tertiary: "var(--dsw-alias-label-tertiary, #81858c)",
			caption: "var(--dsw-alias-label-caption, #adb2b8)",
			dimmed: "var(--dsw-alias-label-dimmed, #e1e5ee)",
			brand: "var(--dsw-alias-brand-primary, #0f1115)",
			success: "var(--dsw-alias-state-success-primary, #22c55e)",
			warn: "var(--dsw-alias-state-warn-primary, #f59e0b)",
			idle: "var(--dsw-alias-state-idle-primary, #d4d4d4)",
			error: "var(--dsw-alias-state-error-primary, #ec1313)",
			radiusCard: "var(--dsw-radius-lg, 16px)",
			radiusRow: "var(--dsw-radius-md, 12px)",
			radiusPill: "var(--dsw-radius-sm, 8px)",
			elevation: "var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.12))"
		};

		/** Theme alias steps backing the state dot (all in the allowed set). */
		const DOT_COLOR = {
			neutral: TOKEN.idle,
			success: TOKEN.success,
			warn: TOKEN.warn,
			// Not `label-dimmed` (#e1e5ee): a 6 px dot in that step is invisible on
			// the white card. Caption keeps the muted intent while staying visible.
			muted: TOKEN.caption
		};

		/**
		 * Advance the snapshot's phase locally across a known boundary.
		 *
		 * The client has no holiday calendar, so it extrapolates exactly ONE
		 * transition — the one the host already scheduled at `nextTransitionAt` —
		 * and refuses to guess further: once `hostNow >= nextTransitionAt` the
		 * snapshot's `phase`/`reason`/`paused` describe the window that just ended,
		 * and `nextPhase` is the phase actually in force. Everything derived from
		 * this reports `rolled: true`, which drives the "refreshing" copy and the
		 * immediate refresh rather than another prediction.
		 *
		 * @param state - the host state object.
		 * @param hostNow - host-clock epoch millisecond at render time.
		 * @returns `{ phase: 'peak'|'idle', rolled: boolean }`; `phase` is null when
		 *   the snapshot carries no usable phase.
		 */
		function effectivePhase(state, hostNow) {
			if (state === null || typeof state !== "object") return { phase: null, rolled: false };
			const snapshotPhase = state.phase === "peak" ? "peak" : state.phase === "idle" ? "idle" : null;
			const at = toFiniteNumber(state.nextTransitionAt);
			const now = toFiniteNumber(hostNow);
			const nextPhase = state.nextPhase === "peak" ? "peak" : state.nextPhase === "idle" ? "idle" : null;
			// Only a real flip is an advance. When the scheduled boundary has passed
			// but `nextPhase` equals the snapshot's own phase, the snapshot already
			// describes the live window (its reason included) and only its countdown
			// is expired — that case is handled by the countdown sentinel, not here.
			if (at !== null && now !== null && now >= at && snapshotPhase !== null && nextPhase !== null && nextPhase !== snapshotPhase) {
				return { phase: nextPhase, rolled: true };
			}
			return { phase: snapshotPhase, rolled: false };
		}

		/**
		 * Poll cadence for the current snapshot: fast while a boundary is imminent
		 * or just passed, plain otherwise. A failed poll keeps the plain cadence —
		 * an outage must not turn into a 3 s request storm (P3, SPEC 2.5).
		 * @param remaining - milliseconds until the next boundary, or null.
		 * @param failed - whether the last request failed.
		 * @returns the interval in milliseconds.
		 */
		function pollIntervalMs(remaining, failed) {
			if (failed === true) return POLL_MS;
			const value = toFiniteNumber(remaining);
			if (value === null) return POLL_MS;
			return value <= FAST_POLL_WINDOW_MS ? FAST_POLL_MS : POLL_MS;
		}

		/**
		 * Milliseconds left in the demo clock override, in *browser* (real) time.
		 * `expiresAt` is the host's real-clock deadline; when the host omitted it,
		 * the deadline is rebuilt from `state.now - offsetMs + ttlMs` (the moment
		 * the snapshot was taken, in real time, plus the requested TTL).
		 * @param state - the host state object.
		 * @param browserNowMs - the browser's `Date.now()` at render time.
		 * @returns remaining milliseconds (never negative), or null when unknown.
		 */
		function overrideExpiresIn(state, browserNowMs) {
			if (state === null || typeof state !== "object" || !state.clockOverride) return null;
			const now = toFiniteNumber(browserNowMs);
			if (now === null) return null;
			const expiresAt = toFiniteNumber(state.clockOverride.expiresAt);
			if (expiresAt !== null) return Math.max(0, expiresAt - now);
			const offsetMs = toFiniteNumber(state.clockOverride.offsetMs);
			const ttlMs = toFiniteNumber(state.clockOverride.ttlMs);
			const hostNow = toFiniteNumber(state.now);
			if (offsetMs === null || ttlMs === null || hostNow === null || ttlMs <= 0) return null;
			return Math.max(0, hostNow - offsetMs + ttlMs - now);
		}

		/**
		 * Derive the pill's presentation from one polling snapshot.
		 *
		 * A failed request always wins: the pill goes muted and reads
		 * "unavailable" (SPEC 2.5), while any last-good state stays available to
		 * the popover for context. `paused` follows the *effective* phase, not the
		 * snapshot flag, so the pill leaves "已暂停" the second the boundary passes
		 * even though the snapshot still describes the peak window (P1).
		 *
		 * @param snapshot - `{ state, fetchedAtMs, error }`.
		 * @param browserNowMs - the browser's `Date.now()` at render time; omitted
		 *   means "as of fetch", which never rolls the phase.
		 * @returns `{ status, labelKey, dot, dotColor, paused, mode, phase, rolled,
		 *   available, stale }`.
		 */
		function deriveView(snapshot, browserNowMs) {
			const state = snapshot && typeof snapshot.state === "object" && snapshot.state !== null ? snapshot.state : null;
			const hostNow = state === null ? null : estimateHostNow(snapshot, browserNowMs);
			const rolled = state === null ? false : effectivePhase(state, hostNow).rolled;
			const phase = state === null ? null : effectivePhase(state, hostNow).phase;			const mode = state === null ? null : normalizeMode(state.mode);
			const paused = mode === MODE_IDLE_ONLY && phase === "peak";
			const base = { paused, mode, phase, rolled, stale: rolled };
			if (snapshot && snapshot.error) {
				return Object.assign(base, {
					status: "unavailable",
					labelKey: "button.unavailable",
					dot: "muted",
					dotColor: DOT_COLOR.muted,
					available: false,
					stale: true
				});
			}
			if (state === null) {
				return Object.assign(base, {
					status: "loading",
					labelKey: "button.loading",
					dot: "muted",
					dotColor: DOT_COLOR.muted,
					available: false,
					stale: false
				});
			}
			if (mode === MODE_ALWAYS) {
				return Object.assign(base, {
					status: "always",
					labelKey: "button.always",
					dot: "neutral",
					dotColor: DOT_COLOR.neutral,
					available: true
				});
			}
			return Object.assign(base, {
				status: paused ? "paused" : "running",
				labelKey: paused ? "button.paused" : "button.running",
				dot: paused ? "warn" : "success",
				dotColor: DOT_COLOR[paused ? "warn" : "success"],
				available: true
			});
		}

		/**
		 * Host-clock "now" extrapolated from the last successful poll, so the
		 * display stays correct under a host clock override without extra requests.
		 * @param snapshot - `{ state, fetchedAtMs, error }`.
		 * @param browserNowMs - the browser's `Date.now()` at render time; omitted
		 *   falls back to the snapshot's own `now` (deterministic "as of fetch").
		 * @returns the estimated host epoch millisecond.
		 */
		function estimateHostNow(snapshot, browserNowMs) {
			const state = snapshot ? snapshot.state : null;
			const realNow = toFiniteNumber(browserNowMs);
			if (state && Number.isFinite(state.now) && snapshot.fetchedAtMs > 0 && realNow !== null) {
				return state.now + (realNow - snapshot.fetchedAtMs);
			}
			if (state && Number.isFinite(state.now)) return state.now;
			return realNow === null ? Date.now() : realNow;
		}

		/**
		 * Milliseconds until the next phase boundary, extrapolated locally from the
		 * last poll (`state.now` anchors the host clock, so an override is handled).
		 * @param snapshot - `{ state, fetchedAtMs, error }`.
		 * @param browserNowMs - the browser's `Date.now()` at render time.
		 * @returns remaining milliseconds, or null when the host reported none.
		 */
		function remainingMs(snapshot, browserNowMs) {
			const state = snapshot ? snapshot.state : null;
			if (!state || !Number.isFinite(browserNowMs) || !(snapshot.fetchedAtMs > 0)) return null;
			let base = null;
			if (Number.isFinite(state.nextTransitionAt) && Number.isFinite(state.now)) base = state.nextTransitionAt - state.now;
			else if (Number.isFinite(state.msUntilTransition)) base = state.msUntilTransition;
			if (base === null) return null;
			return base - (browserNowMs - snapshot.fetchedAtMs);
		}

		/**
		 * Structured popover model. Pure apart from the optional translator: the
		 * component only renders what comes back.
		 * @param snapshot - `{ state, fetchedAtMs, error }`.
		 * @param browserNowMs - the browser's `Date.now()` at render time.
		 * @param t - optional bound dictionary lookup, used for the two sentinel
		 *   countdown strings; omitted means Simplified Chinese.
		 * @returns `{ view, state, hostNow, remaining, countdown, countdownState,
		 *   phase, phaseKey, phaseRolled, reasonKey, nextPhaseKey, nextAtText,
		 *   holiday, unknownHolidayYear, clockOffsetMs, clockOverrideText,
		 *   clockOverrideExpiresIn, waitingTasks, showWaiting, peakWindows }`.
		 */
		function describePopover(snapshot, browserNowMs, t) {
			const tt = typeof t === "function" ? t : (key, params) => translate(DICTS, "zh", key, params);
			const state = snapshot && typeof snapshot.state === "object" && snapshot.state !== null ? snapshot.state : null;
			const view = deriveView(snapshot, browserNowMs);
			if (state === null) {
				return {
					view,
					state: null,
					hostNow: null,
					remaining: null,
					countdown: Boolean(snapshot && snapshot.error) ? tt("countdown.expired") : null,
					countdownState: snapshot && snapshot.error ? "expired" : "unknown",
					phase: null,
					phaseKey: null,
					phaseRolled: false,
					reasonKey: null,
					nextPhaseKey: null,
					nextAtText: null,
					holiday: null,
					unknownHolidayYear: null,
					clockOffsetMs: null,
					clockOverrideText: null,
					clockOverrideExpiresIn: null,
					waitingTasks: 0,
					showWaiting: false,
					peakWindows: []
				};
			}
			const remaining = remainingMs(snapshot, browserNowMs);
			const offset = state.clockOverride ? toFiniteNumber(state.clockOverride.offsetMs) : null;
			const unknownYear = state.holidayCoverage === "unknown" ? toFiniteNumber(state.unknownHolidayYear) : null;
			const waiting = toFiniteNumber(state.waitingTasks);
			const failed = Boolean(snapshot && snapshot.error);
			const rolled = view.rolled === true;
			const phase = view.phase === null ? "idle" : view.phase;
			const expiresIn = overrideExpiresIn(state, browserNowMs);
			let countdownState = "live";
			if (failed) countdownState = "expired";
			else if (rolled || (remaining !== null && remaining <= 0)) countdownState = "refreshing";
			let countdown = null;
			if (countdownState === "expired") countdown = tt("countdown.expired");
			else if (countdownState === "refreshing") countdown = tt("countdown.refreshing");
			else if (remaining !== null) countdown = formatCountdown(remaining);
			let clockOverrideText = null;
			if (state.clockOverride) {
				const at = formatBeijingClock(estimateHostNow(snapshot, browserNowMs));
				clockOverrideText = expiresIn === null ? tt("warning.clockOverridePlain") : tt("warning.clockOverrideTtl", { at, ttl: formatCountdown(expiresIn) });
			}
			const nextAtText = typeof state.nextTransitionText === "string" && state.nextTransitionText !== "" ? state.nextTransitionText : null;
			return {
				view,
				state,
				hostNow: estimateHostNow(snapshot, browserNowMs),
				remaining,
				countdown,
				countdownState,
				phase,
				phaseKey: `phase.${phase}`,
				phaseRolled: rolled,
				reasonKey: rolled || KNOWN_REASONS.indexOf(state.reason) === -1 ? null : `reason.${state.reason}`,
				nextPhaseKey: state.nextPhase === "idle" ? "phase.idle" : "phase.peak",
				// A boundary that already passed makes the scheduled time useless, and
				// with it every number the stale snapshot still carries (P1/P2).
				nextAtText: rolled ? null : nextAtText,
				holiday: state.holidayToday && typeof state.holidayToday === "object" ? state.holidayToday : null,
				unknownHolidayYear: unknownYear,
				clockOffsetMs: offset,
				clockOverrideText,
				clockOverrideExpiresIn: expiresIn,
				waitingTasks: waiting === null ? 0 : waiting,
				// Stale numbers must not be presented as live queue state.
				showWaiting: !failed && !rolled && waiting !== null && waiting > 0 && (remaining === null || remaining > 0),
				peakWindows: Array.isArray(state.peakWindows) ? state.peakWindows.filter((item) => typeof item === "string") : []
			};
		}

		/**
		 * Structured banner model for the composer dock entry.
		 *
		 * The banner answers "why is nothing happening?" the moment a task is held,
		 * so it shows exactly while the run window is doing the holding: mode
		 * `idle-only` and the *effective* phase `peak` (P1 — a boundary the snapshot
		 * has not caught up with yet already flips it away). Everything else renders
		 * nothing at all rather than an empty box.
		 *
		 * `waitingTasks` is the host's global gate waiter count and may include
		 * other sessions, so the copy says "queued" and never claims ownership.
		 *
		 * @param model - a {@link describePopover} model.
		 * @returns `{ show, waiting, count, textKey, time, countdown }`; `textKey`
		 *   and the two interpolated strings are null while hidden.
		 */
		function describeBanner(model) {
			const hidden = { show: false, waiting: false, count: 0, textKey: null, time: null, countdown: null };
			if (!model || model.state === null || model.view.mode !== MODE_IDLE_ONLY || model.view.phase !== "peak") return hidden;
			const count = toFiniteNumber(model.waitingTasks);
			const waiting = count !== null && count > 0;
			// A just-passed boundary has no meaningful "next at" (P2 keeps that case in
			// the idle phase, where this banner is hidden), but a host that omits the
			// text still gets a readable time.
			const time = model.nextAtText !== null ? model.nextAtText : formatBeijingClock(toFiniteNumber(model.state.nextTransitionAt));
			return {
				show: true,
				waiting,
				count: waiting ? count : 0,
				textKey: waiting ? "banner.waiting" : "banner.idle",
				time,
				countdown: model.countdown
			};
		}

		/** Human-readable cause for a rejected/aborted request (never throws). */
		function describeFetchError(error) {
			if (error && error.name === "AbortError") return "timeout";
			if (error && typeof error.message === "string" && error.message !== "") return error.message;
			return "network error";
		}

		/**
		 * One same-origin JSON request with an AbortController timeout. Never
		 * rejects: transport, timeout, and HTTP failures all resolve to a result.
		 * @param fetchImpl - `fetch`-compatible function, or null when unavailable.
		 * @param url - same-origin request URL.
		 * @param options - `{ method, body }`; a body implies the JSON content type.
		 * @param timeoutMs - abort deadline in milliseconds.
		 * @returns `{ ok: true, payload } | { ok: false, error }`.
		 */
		async function requestJson(fetchImpl, url, options, timeoutMs) {
			if (typeof fetchImpl !== "function") return { ok: false, error: "fetch unavailable" };
			let timer = null;
			let controller = null;
			if (typeof AbortController === "function") {
				controller = new AbortController();
				timer = setTimeout(() => {
					try {
						controller.abort();
					} catch (error) {
						/* An already-settled request needs no abort. */
					}
				}, timeoutMs);
			}
			const init = { method: options && options.method ? options.method : "GET", credentials: "same-origin" };
			if (controller !== null) init.signal = controller.signal;
			if (options && options.body !== undefined) {
				init.headers = { "content-type": "application/json" };
				init.body = JSON.stringify(options.body);
			}
			try {
				const response = await fetchImpl(url, init);
				if (response === null || typeof response !== "object" || typeof response.ok !== "boolean") {
					return { ok: false, error: "invalid response" };
				}
				if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
				const payload = await response.json();
				return { ok: true, payload };
			} catch (error) {
				return { ok: false, error: describeFetchError(error) };
			} finally {
				if (timer !== null) clearTimeout(timer);
			}
		}

		/**
		 * Poll the host state route.
		 * @param fetchImpl - `fetch`-compatible function.
		 * @param timeoutMs - abort deadline.
		 * @returns `{ state | null, error | null }`; never rejects.
		 */
		async function loadState(fetchImpl, timeoutMs) {
			const result = await requestJson(fetchImpl, API_STATE, null, timeoutMs === undefined ? REQUEST_TIMEOUT_MS : timeoutMs);
			if (!result.ok) return { state: null, error: result.error };
			const state = readState(result.payload);
			if (state === null) return { state: null, error: "state payload missing" };
			return { state, error: null };
		}

		/**
		 * Select a run window on the host.
		 * @param fetchImpl - `fetch`-compatible function.
		 * @param mode - `always` | `idle-only` (anything else normalizes to `always`).
		 * @param timeoutMs - abort deadline.
		 * @returns `{ state | null, error | null }`; never rejects.
		 */
		async function pushMode(fetchImpl, mode, timeoutMs) {
			const body = { mode: normalizeMode(mode) };
			const result = await requestJson(fetchImpl, API_MODE, { method: "POST", body }, timeoutMs === undefined ? REQUEST_TIMEOUT_MS : timeoutMs);
			if (!result.ok) return { state: null, error: result.error };
			const state = readState(result.payload);
			if (state === null) return { state: null, error: "state payload missing" };
			return { state, error: null };
		}

		/** A `fetch` bound to the global object (detached `fetch` breaks in Chromium). */
		function globalFetch() {
			if (typeof globalThis.fetch !== "function") return null;
			return (url, init) => globalThis.fetch(url, init);
		}
		//#endregion

		//#region shared store
		/**
		 * The browser half's single polling store.
		 *
		 * The pill (`conversation.input.left`) and the queue banner
		 * (`conversation.input.dock`) are two separate slot occupants of the same
		 * session view. Without a shared source each would run its own 15 s poll and
		 * its own 1 Hz tick — doubling the request rate and letting the two surfaces
		 * disagree for a second at a time. The store owns both timers, starts them
		 * lazily for the first subscriber, stops them with the last, and publishes
		 * `{ state, fetchedAtMs, error, nowMs }`: exactly the snapshot
		 * {@link describePopover} consumes, plus the locally ticking clock.
		 */
		function createStore() {
			const listeners = new Set();
			let current = EMPTY_SNAPSHOT;
			let nowMs = Date.now();
			let pollTimer = null;
			let pollMs = null;
			let tickTimer = null;
			let visibilityHandler = null;
			let inFlight = false;
			let nudgedFor = null;
			let stopped = true;

			/** The published value; a fresh object per change, stable between them. */
			const published = () => ({ state: current.state, fetchedAtMs: current.fetchedAtMs, error: current.error, nowMs });

			const notify = () => {
				const value = published();
				for (const listener of [...listeners]) {
					try {
						listener(value);
					} catch (error) {
						console.warn(`[${NS}] subscriber failed:`, error);
					}
				}
			};

			/** Refresh one poll cadence step (P3): 3 s near or past a boundary. */
			const cadence = () => pollIntervalMs(remainingMs(current, nowMs), Boolean(current.error));

			const armPoll = () => {
				if (stopped) return;
				const next = cadence();
				if (pollTimer !== null && next === pollMs) return;
				if (pollTimer !== null) clearInterval(pollTimer);
				pollMs = next;
				pollTimer = setInterval(() => {
					void refresh();
				}, next);
			};

			/**
			 * Ask for one extra snapshot once a boundary has passed locally (P1/P2).
			 * Keyed on the boundary itself, so a host that keeps answering with a
			 * stale window cannot turn this into a request loop; the ordinary poll
			 * cadence keeps retrying either way.
			 */
			const maybeNudge = () => {
				const state = current.state;
				if (state === null) return;
				const remaining = remainingMs(current, nowMs);
				const rolled = effectivePhase(state, estimateHostNow(current, nowMs)).rolled;
				if (!rolled && !(remaining !== null && remaining <= 0)) {
					nudgedFor = null;
					return;
				}
				const key = String(toFiniteNumber(state.nextTransitionAt));
				if (nudgedFor === key) return;
				nudgedFor = key;
				void refresh();
			};

			const tick = () => {
				nowMs = Date.now();
				notify();
				armPoll();
				maybeNudge();
			};

			const apply = (result) => {
				if (result && result.state !== null && result.state !== undefined) {
					current = { state: result.state, fetchedAtMs: Date.now(), error: null };
				} else {
					current = { state: current.state, fetchedAtMs: current.fetchedAtMs, error: (result && result.error) || "unavailable" };
				}
				nowMs = Date.now();
				notify();
				armPoll();
			};

			/** One poll. Overlapping calls fold into the request already running. */
			function refresh() {
				if (stopped || inFlight) return;
				inFlight = true;
				const settle = (result) => {
					inFlight = false;
					if (stopped) return;
					apply(result);
				};
				const pending = loadState(globalFetch(), REQUEST_TIMEOUT_MS);
				void pending.then(settle, () => settle({ state: null, error: "unavailable" }));
			}

			const start = () => {
				if (!stopped) return;
				stopped = false;
				nowMs = Date.now();
				if (tickTimer === null) tickTimer = setInterval(tick, TICK_MS);
				if (visibilityHandler === null && typeof document !== "undefined" && typeof document.addEventListener === "function") {
					visibilityHandler = () => {
						if (document.visibilityState === "visible") refresh();
					};
					document.addEventListener("visibilitychange", visibilityHandler);
				}
				armPoll();
				refresh();
			};

			const stop = () => {
				if (stopped) return;
				stopped = true;
				if (tickTimer !== null) clearInterval(tickTimer);
				tickTimer = null;
				if (pollTimer !== null) clearInterval(pollTimer);
				pollTimer = null;
				pollMs = null;
				if (visibilityHandler !== null && typeof document !== "undefined" && typeof document.removeEventListener === "function") {
					document.removeEventListener("visibilitychange", visibilityHandler);
				}
				visibilityHandler = null;
			};

			return {
				start,
				stop,
				refresh,
				/** Fold a result produced elsewhere (the mode POST) into the store. */
				accept: apply,
				published,
				subscribe(listener) {
					listeners.add(listener);
					start();
					return () => {
						listeners.delete(listener);
						if (listeners.size === 0) stop();
					};
				}
			};
		}

		/** The one store instance; `apply` stops it when the plugin unloads. */
		const store = createStore();

		/** Subscribe a component to the shared store. */
		function usePublished(target) {
			const [value, setValue] = react.useState(() => target.published());
			react.useEffect(() => target.subscribe(setValue), [target]);
			return value;
		}
		//#endregion

		//#region styles
		/**
		 * Inline styles only (no CSS build step). Layout mirrors the official
		 * composer controls (`PermissionSelect.module.css`'s `.trigger`,
		 * `Menu.module.css`'s `.list` / `.item` / `.separator`), and the type scale
		 * follows the official title/description split seen in the theme package:
		 * a value is `label-primary`, its explanation `label-tertiary`, and the
		 * field name next to a value `label-tertiary` as well. Colours all come
		 * from {@link TOKEN} — never a bare custom property.
		 */
		const STYLE = {
			root: { position: "relative", display: "inline-flex", flex: "none" },
			button: {
				boxSizing: "border-box",
				borderRadius: TOKEN.radiusPill,
				minWidth: "0",
				maxWidth: "220px",
				height: "28px",
				color: TOKEN.secondary,
				cursor: "pointer",
				background: "transparent",
				border: "none",
				alignItems: "center",
				gap: "6px",
				padding: "0 8px",
				fontSize: "13px",
				fontWeight: 500,
				lineHeight: "20px",
				display: "inline-flex",
				whiteSpace: "nowrap"
			},
			buttonHover: { background: TOKEN.raised },
			buttonOpen: { background: TOKEN.raised },
			buttonUnavailable: { color: TOKEN.dimmed },
			dot: { width: "6px", height: "6px", borderRadius: "999px", flex: "none", display: "inline-block" },
			label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0" },
			popover: {
				position: "absolute",
				bottom: "calc(100% + 6px)",
				left: "0",
				zIndex: 100,
				boxSizing: "border-box",
				width: "300px",
				maxWidth: "calc(100vw - 32px)",
				padding: "4px",
				borderRadius: TOKEN.radiusCard,
				background: TOKEN.surface,
				border: `1px solid ${TOKEN.border}`,
				boxShadow: TOKEN.elevation,
				color: TOKEN.text,
				display: "flex",
				flexDirection: "column",
				textAlign: "left",
				whiteSpace: "normal",
				fontSize: "13px",
				lineHeight: "20px"
			},
			option: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				width: "100%",
				minHeight: "34px",
				padding: "6px 8px",
				border: "none",
				borderRadius: TOKEN.radiusRow,
				background: "transparent",
				cursor: "pointer",
				font: "inherit",
				fontSize: "13px",
				lineHeight: "20px",
				color: TOKEN.text,
				textAlign: "left"
			},
			optionHover: { background: TOKEN.raised },
			optionDisabled: { opacity: 0.4, cursor: "not-allowed" },
			optionText: { display: "flex", flexDirection: "column", gap: "0", minWidth: "0", flex: "1" },
			optionDesc: { color: TOKEN.tertiary, fontSize: "12px", lineHeight: "18px" },
			radio: { flex: "none", width: "14px", height: "14px", borderRadius: "999px", boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "center" },
			radioOff: { border: `1.5px solid ${TOKEN.ring}`, background: "transparent" },
			radioOn: { border: `1.5px solid ${TOKEN.brand}`, background: "transparent" },
			radioDot: { width: "6px", height: "6px", borderRadius: "999px", background: TOKEN.brand },
			// The card's own title: primary text, one step up from the rows.
			sectionLabel: { padding: "6px 8px 4px", fontSize: "13px", lineHeight: "20px", fontWeight: 500, color: TOKEN.text },
			separator: { height: "0.5px", margin: "3px 2px", background: TOKEN.hairline, flex: "none" },
			row: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", padding: "3px 8px" },
			// Field names: tertiary, the same step the official descriptions use; no
			// opacity washing — the token itself carries the hierarchy.
			rowLabel: { color: TOKEN.tertiary, fontSize: "12px", lineHeight: "18px", flex: "none" },
			rowValue: { color: TOKEN.text, fontSize: "12px", lineHeight: "18px", fontVariantNumeric: "tabular-nums", textAlign: "right", minWidth: "0" },
			warning: {
				margin: "4px 2px 2px",
				padding: "6px 8px",
				borderRadius: TOKEN.radiusPill,
				background: TOKEN.raised,
				color: TOKEN.warn,
				fontSize: "11px",
				lineHeight: "16px"
			},
			error: { margin: "4px 2px 2px", padding: "6px 8px", color: TOKEN.error, fontSize: "11px", lineHeight: "16px" },
			footnote: { padding: "2px 8px", color: TOKEN.caption, fontSize: "11px", lineHeight: "16px" },
			/**
			 * The composer-dock banner: a full-width notice strip. `composerStack`
			 * already spaces its children by `--dsh-composer-stack-gap` (6 px), so it
			 * carries no outer margin of its own.
			 */
			banner: {
				boxSizing: "border-box",
				width: "100%",
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "6px 10px",
				borderRadius: TOKEN.radiusRow,
				background: TOKEN.layer2,
				border: `1px solid ${TOKEN.border}`,
				color: TOKEN.secondary,
				fontSize: "12px",
				lineHeight: "18px",
				whiteSpace: "normal"
			},
			bannerDot: { width: "6px", height: "6px", borderRadius: "999px", background: TOKEN.warn, flex: "none" },
			bannerText: { flex: "1", minWidth: "0" }
		};
		/**
		 * The complete theme surface this plugin is allowed to reference: every
		 * alias the running shell defines in its light-theme block (`_recon/theme-tokens.txt`,
		 * 101 names, cross-checked against the extracted
		 * `dsh-client-ui-theme` runtime) plus the radius and elevation families
		 * that block also defines. Exposed for the tests that police the rule
		 * "no unregistered token, no bare var()".
		 */
		const ALIAS_TOKENS = [
			"bg-base",
			"bg-document-preview",
			"bg-document-selection",
			"bg-layer-1",
			"bg-layer-2",
			"bg-layer-3",
			"bg-mask-1",
			"bg-mask-2",
			"bg-mask-3",
			"bg-mask-drop",
			"bg-mask-photo",
			"bg-module-platform",
			"bg-multi-select",
			"bg-overlay",
			"bg-skeleton",
			"border-inverted",
			"border-inverted2",
			"border-l1",
			"border-l2",
			"border-l2-darkmode-thin",
			"border-l3",
			"border-l4",
			"brand-primary",
			"brand-primary-invert",
			"brand-primary-new-colorprimary-new-color",
			"brand-text",
			"button-contrast-fill",
			"button-elevated-fill",
			"button-floating-fill",
			"button-floating-hover",
			"button-ghost-active-border",
			"button-ghost-active-fill",
			"button-ghost-active-hover",
			"button-info-fill",
			"button-info-hover",
			"button-primary-dimmed",
			"button-primary-fill",
			"button-primary-hover",
			"button-tool-bar-fill",
			"button-tool-bar-fill-invisible",
			"button-tool-bar-hover",
			"code-diff-added",
			"code-diff-deleted",
			"file-diff-added-bg",
			"file-diff-added-gutter",
			"file-diff-added-marker",
			"file-diff-deleted-bg",
			"file-diff-deleted-gutter",
			"file-diff-deleted-marker",
			"interactive-bg-active",
			"interactive-bg-hover",
			"interactive-bg-hover-accent",
			"interactive-bg-hover-danger",
			"interactive-bg-hover-solid",
			"label-caption",
			"label-deep-diving",
			"label-deep-diving-shimmer",
			"label-dimmed",
			"label-document-preview",
			"label-primary",
			"label-primary-bluish",
			"label-primary-dimmed",
			"label-primary-foreground",
			"label-primary-inverted",
			"label-secondary",
			"label-shimmer",
			"label-tertiary",
			"link",
			"markdown-citation",
			"markdown-code-block",
			"markdown-code-block-banner",
			"markdown-code-segment-selected",
			"markdown-code-segment-unselected",
			"markdown-inline-code",
			"markdown-placeholder",
			"markdown-tag",
			"menu-group-header-fill",
			"menu-icon",
			"scrollbar-bg-l1",
			"scrollbar-bg-l2",
			"scrollbar-hover-l1",
			"scrollbar-hover-l2",
			"state-business-primary",
			"state-business-tertiary",
			"state-error-primary",
			"state-error-secondary",
			"state-idle-primary",
			"state-success-primary",
			"state-success-secondary",
			"state-success-tertiary",
			"state-warn-label",
			"state-warn-primary",
			"state-warn-secondary",
			"state-warn-tertiary",
			"switch-thumb",
			"toast-bg",
			"toast-label",
			"tooltip-bg",
			"tooltip-key-bg",
			"turn-trigger-bg",
			"turn-trigger-bg-hover"
		];
		const DIMENSION_TOKENS = [
			"--dsw-radius-xs",
			"--dsw-radius-sm",
			"--dsw-radius-md",
			"--dsw-radius-lg",
			"--dsw-radius-xl",
			"--dsw-radius-panel",
			"--dsw-elevation-panel",
			"--dsw-elevation-soft",
			"--dsw-elevation-prominent",
			"--dsw-elevation-stroke",
			"--dsw-elevation-stroke-color"
		];
		/** Exposed to the tests that police the token allow-list. */
		const THEME_TOKENS = Object.freeze({
			alias: Object.freeze(ALIAS_TOKENS.map((name) => `--dsw-alias-${name}`)),
			dimension: Object.freeze(DIMENSION_TOKENS.slice()),
			allowed: Object.freeze([...ALIAS_TOKENS.map((name) => `--dsw-alias-${name}`), ...DIMENSION_TOKENS]),
			style: STYLE
		});
		//#endregion

		//#region components
		/** One radio marker: a business-coloured dot inside its ring when selected. */
		function RadioMark({ selected }) {
			const style = Object.assign({}, STYLE.radio, selected ? STYLE.radioOn : STYLE.radioOff);
			if (!selected) return jsx("span", { style, "aria-hidden": "true" });
			return jsx("span", { style, "aria-hidden": "true", children: jsx("span", { style: STYLE.radioDot }) });
		}

		/** One selectable run-window row. */
		function ModeOption({ t, mode, labelKey, descKey, active, disabled, onSelect }) {
			const [hover, setHover] = react.useState(false);
			const selected = active === mode;
			let style = STYLE.option;
			if (hover && !disabled) style = Object.assign({}, style, STYLE.optionHover);
			if (disabled) style = Object.assign({}, style, STYLE.optionDisabled);
			return jsx("button", {
				type: "button",
				role: "radio",
				"aria-checked": selected,
				"data-mode": mode,
				"data-selected": selected ? "true" : "false",
				disabled,
				style,
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				onClick: () => onSelect(mode),
				children: jsxs(jsxRuntime.Fragment, {
					children: [
						jsx(RadioMark, { selected }, "mark"),
						jsxs(
							"span",
							{
								style: STYLE.optionText,
								children: [
									jsx("span", { children: t(labelKey) }, "label"),
									jsx("span", { style: STYLE.optionDesc, children: t(descKey) }, "desc")
								]
							},
							"text"
						)
					]
				})
			});
		}

		/** Label/value line of the popover's read-only detail block. */
		function DetailRow({ label, value }) {
			return jsxs("div", {
				style: STYLE.row,
				children: [
					jsx("span", { style: STYLE.rowLabel, children: label }, "label"),
					jsx("span", { style: STYLE.rowValue, children: value }, "value")
				]
			});
		}

		/**
		 * The popover card. Pure presentation: every value arrives precomputed
		 * from {@link describePopover}, every side effect is a callback.
		 */
		function Popover({ t, model, busy, actionError, onSelect }) {
			const children = [];
			children.push(jsx("div", { style: STYLE.sectionLabel, children: t("popover.title") }, "title"));
			const mode = model.view.mode;
			const disabled = busy || !model.view.available || mode === null;
			children.push(
				jsx(
					ModeOption,
					{ t, mode: MODE_ALWAYS, labelKey: "option.always", descKey: "option.always.desc", active: mode, disabled, onSelect },
					"always"
				)
			);
			children.push(
				jsx(
					ModeOption,
					{ t, mode: MODE_IDLE_ONLY, labelKey: "option.idleOnly", descKey: "option.idleOnly.desc", active: mode, disabled, onSelect },
					"idle"
				)
			);
			children.push(jsx("div", { style: STYLE.separator }, "sep"));
			if (model.state === null) {
				children.push(jsx(DetailRow, { label: t("row.now"), value: t("button.unavailable") }, "now"));
			} else {
				children.push(
					jsx(
						DetailRow,
						{
							label: t("row.now"),
							value: model.hostNow === null ? model.state.nowText || "—" : formatBeijingClock(model.hostNow)
						},
						"now"
					)
				);
				const phaseText = t(model.phaseKey);
				const reasonText = model.reasonKey === null ? "" : ` · ${t(model.reasonKey)}`;
				children.push(jsx(DetailRow, { label: t("row.phase"), value: `${phaseText}${reasonText}` }, "phase"));
				// A boundary that already passed has no meaningful "next at" — the
				// row then carries only the refreshing sentinel (P1/P2).
				const hasNextText = model.nextAtText !== null;
				if (hasNextText || model.countdown !== null) {
					const suffix = model.countdown === null ? "" : hasNextText ? `  (${model.countdown})` : model.countdown;
					const value = hasNextText
						? `${t("row.nextValue", { at: model.nextAtText, phase: t(model.nextPhaseKey) })}${suffix}`
						: suffix;
					children.push(jsx(DetailRow, { label: t("row.next"), value }, "next"));
				}
				if (model.holiday !== null && typeof model.holiday.name === "string") {
					children.push(jsx(DetailRow, { label: t("row.holiday"), value: model.holiday.name }, "holiday"));
				}
				if (model.showWaiting) {
					children.push(jsx(DetailRow, { label: t("row.waiting"), value: t("row.waitingValue", { count: model.waitingTasks }) }, "waiting"));
				}
				if (model.peakWindows.length > 0) {
					children.push(jsx(DetailRow, { label: t("row.peakWindows"), value: model.peakWindows.join(" / ") }, "windows"));
				}
			}
			if (model.unknownHolidayYear !== null) {
				children.push(
					jsx("div", { style: STYLE.warning, children: t("warning.unknownYear", { year: model.unknownHolidayYear }) }, "unknown-year")
				);
			}
			if (model.clockOverrideText !== null) {
				children.push(jsx("div", { style: STYLE.warning, children: model.clockOverrideText }, "clock"));
			}
			if (actionError !== null && actionError !== undefined && actionError !== "") {
				children.push(jsx("div", { style: STYLE.error, children: t("error.action", { message: actionError }) }, "error"));
			}
			if (model.view.stale || model.countdownState !== "live") {
				children.push(jsx("div", { style: STYLE.footnote, children: t("state.stale") }, "stale"));
			}
			return jsxs("div", {
				role: "dialog",
				"aria-label": t("popover.title"),
				"data-peak-hours": "popover",
				style: STYLE.popover,
				onClick: (event) => event.stopPropagation(),
				children
			});
		}

		/**
		 * Full-width notice above the composer card, mounted in
		 * `conversation.input.dock`. Shows only while the run window is actually
		 * holding work (idle-only + peak) and renders nothing otherwise, so it never
		 * reserves space in normal operation.
		 *
		 * It deliberately does NOT touch `conversation.chat.node`: that keyed slot's
		 * official `turn-process` occupant (`_recon/src/dsh-client-ui-chat/lib/client.js:12398`
		 * declares the slot, `:6844-6848` registers the view) would have to be
		 * re-implemented to take its cell, and the shipped process indicator (step
		 * counts, folding, tool summaries) would be lost on every upstream change.
		 * Saying "queued, starts at {time}" next to the input carries the same
		 * information without shadowing official UI.
		 *
		 * @param props - slot kit props; `t` is bound by the `locale` register option.
		 */
		function PeakHoursBanner(props) {
			const t =
				typeof props.t === "function"
					? props.t
					: (key, params) => translate(DICTS, "zh", key, params);
			const renderedLocale = detectRenderedLocale(t, DICTS);
			const published = usePublished(store);
			const model = describePopover(published, published.nowMs, t);
			const banner = describeBanner(model);
			if (!banner.show) return null;
			const text = t(banner.textKey, { count: banner.count, time: banner.time, countdown: banner.countdown === null ? "—" : banner.countdown });
			const style = Object.assign({}, STYLE.banner);
			const fontFamily = fontFamilyFor(renderedLocale);
			if (fontFamily !== "inherit") style.fontFamily = fontFamily;
			return jsxs("div", {
				role: "status",
				"aria-label": t("banner.aria"),
				"data-peak-hours": "banner",
				"data-banner": banner.waiting ? "waiting" : "idle",
				"data-count": String(banner.count),
				style,
				children: [
					jsx("span", { style: STYLE.bannerDot, "aria-hidden": "true" }, "dot"),
					jsx("span", { style: STYLE.bannerText, children: text }, "text")
				]
			});
		}

		/**
		 * The composer control: a compact pill plus its popover. Polls the host,
		 * ticks the countdown locally, and never lets a failure escape.
		 * @param props - slot kit props; `t` is bound by the `locale` register option.
		 */
		function PeakHoursControl(props) {
			const t =
				typeof props.t === "function"
					? props.t
					: (key, params) => translate(DICTS, "zh", key, params);
			const renderedLocale = detectRenderedLocale(t, DICTS);
			const fontFamily = fontFamilyFor(renderedLocale);
			// State and clock come from the shared store; only UI state is local.
			const published = usePublished(store);
			const [open, setOpen] = react.useState(false);
			const [hover, setHover] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [actionError, setActionError] = react.useState(null);
			const rootRef = react.useRef(null);
			const aliveRef = react.useRef(true);

			const model = describePopover(published, published.nowMs, t);

			react.useEffect(() => {
				// Re-arm on every effect run: React 18 StrictMode replays mount
				// (body → cleanup → body), and a flag only ever cleared in cleanup
				// would latch to false and silently drop every async result.
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
				};
			}, []);

			// Refresh on open so the popover never shows a stale window.
			react.useEffect(() => {
				if (!open) return undefined;
				store.refresh();
				return undefined;
			}, [open]);

			// Click-outside / Escape close. Both listeners are removed on cleanup.
			react.useEffect(() => {
				if (!open) return undefined;
				if (typeof document === "undefined" || typeof document.addEventListener !== "function") return undefined;
				const onPointerDown = (event) => {
					const node = rootRef.current;
					const target = event ? event.target : null;
					if (node !== null && node !== undefined && target && typeof node.contains === "function" && node.contains(target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event && event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			const onSelect = react.useCallback(
				(mode) => {
					if (busy) return;
					setBusy(true);
					setActionError(null);
					const pending = pushMode(globalFetch(), mode, REQUEST_TIMEOUT_MS);
					const settle = (result) => {
						if (!aliveRef.current) return;
						setBusy(false);
						if (result && result.state !== null && result.state !== undefined) {
							store.accept(result);
							setActionError(null);
						} else {
							setActionError((result && result.error) || "unavailable");
						}
					};
					void pending.then(settle, () => settle({ state: null, error: "unavailable" }));
				},
				[busy]
			);

			const view = model.view;
			const label = t(view.labelKey);
			let buttonStyle = STYLE.button;
			if (view.available === false) buttonStyle = Object.assign({}, buttonStyle, STYLE.buttonUnavailable);
			if (hover) buttonStyle = Object.assign({}, buttonStyle, STYLE.buttonHover);
			if (open) buttonStyle = Object.assign({}, buttonStyle, STYLE.buttonOpen);
			if (fontFamily !== "inherit") buttonStyle = Object.assign({}, buttonStyle, { fontFamily });

			return jsxs("div", {
				ref: rootRef,
				"data-peak-hours": "control",
				"data-status": view.status,
				"data-mode": view.mode === null ? "" : view.mode,
				"data-paused": view.paused ? "true" : "false",
				"data-phase": view.phase === null ? "" : view.phase,
				"data-rolled": view.rolled ? "true" : "false",
				style: STYLE.root,
				children: [
					jsxs(
						"button",
						{
							type: "button",
							"aria-haspopup": "dialog",
							"aria-expanded": open,
							"aria-label": t("button.aria", { label }),
							title: t("button.title"),
							style: buttonStyle,
							onMouseEnter: () => setHover(true),
							onMouseLeave: () => setHover(false),
							onClick: () => {
								setActionError(null);
								setOpen((previous) => !previous);
							},
							children: [
								jsx("span", { style: Object.assign({}, STYLE.dot, { background: view.dotColor }), "data-dot": view.dot }, "dot"),
								jsx("span", { style: STYLE.label, children: label }, "label")
							]
						},
						"trigger"
					),
					open
						? jsx(Popover, { t, model, busy, actionError, onSelect }, "popover")
						: null
				]
			});
		}
		//#endregion

		//#region plugin
		/** Client-side services this plugin consumes (SPEC 2.5). */
		const inject = ["slots", "locale"];

		/** Run one mount step; a failure is logged, never thrown. */
		function guard(label, run) {
			try {
				return run();
			} catch (error) {
				console.warn(`[${NS}] ${label} failed:`, error);
				return undefined;
			}
		}

		/**
		 * Mount the composer control and the queue banner. Every registration is
		 * effect-wrapped and every failure is contained: a throwing plugin would
		 * break shell boot.
		 * @param ctx - client root context carrying `slots` and `locale`.
		 */
		function apply(ctx) {
			if (ctx === null || ctx === undefined) return;
			guard("store teardown", () => {
				if (typeof ctx.effect !== "function") return;
				ctx.effect(() => () => store.stop(), `${NS}: shared poller`);
			});
			guard("dictionaries", () => {
				if (!ctx.locale || typeof ctx.locale.register !== "function") return;
				ctx.effect(() => ctx.locale.register(NS, DICTS), `${NS}: dictionaries`);
			});
			guard("composer control", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") return;
				ctx.effect(
					() =>
						ctx.slots.inject(SLOT, () =>
							ctx.slots.register(
								{
									name: SLOT,
									id: SLOT_ID,
									order: SLOT_ORDER,
									locale: NS
								},
								PeakHoursControl
							)
						),
					`${NS}: composer control`
				);
			});
			guard("queue banner", () => {
				if (!ctx.slots || typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") return;
				ctx.effect(
					() =>
						ctx.slots.inject(DOCK, () =>
							ctx.slots.register(
								{
									name: DOCK,
									id: DOCK_ID,
									order: DOCK_ORDER,
									locale: NS
								},
								PeakHoursBanner
							)
						),
					`${NS}: queue banner`
				);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** Pure helpers, exposed for `node:test` (no React rendering required). */
		exports.__internals = {
			NS,
			SLOT,
			SLOT_ID,
			SLOT_ORDER,
			DOCK,
			DOCK_ID,
			DOCK_ORDER,
			API_STATE,
			API_MODE,
			POLL_MS,
			FAST_POLL_MS,
			FAST_POLL_WINDOW_MS,
			REQUEST_TIMEOUT_MS,
			THEME_TOKENS,
			TOKEN,
			BJ_OFFSET_MS,
			DICTS,
			PeakHoursControl,
			PeakHoursBanner,
			createStore,
			store,
			usePublished,
			describeBanner,
			apply,
			inject,
			normalizeLocale,
			resolveDictionary,
			isChinese,
			fontFamilyFor,
			translate,
			detectRenderedLocale,
			toFiniteNumber,
			pad2,
			normalizeMode,
			formatBeijingClock,
			formatCountdown,
			formatOffset,
			readState,
			effectivePhase,
			pollIntervalMs,
			overrideExpiresIn,
			deriveView,
			estimateHostNow,
			remainingMs,
			describePopover,
			describeFetchError,
			requestJson,
			loadState,
			pushMode,
			EMPTY_SNAPSHOT,
			DOT_COLOR
		};
		return module.exports;
	}
});
