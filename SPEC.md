# dsh-peak-hours — FROZEN SPEC (Lead-owned; do not edit, raise a message instead)

Deliverable: a DSH plugin that adds a run-window switch button to the right of the composer
mode buttons, letting DSH run "always" or "idle-hours only"; in idle-only mode every DSH task
(including a task already running) is held at the next safe boundary when a peak window starts
and resumes automatically when an idle window starts.

Runtime under test: DSH desktop **0.2.0-rc.2** (Electron app). Node 24.12.0, pnpm 11.22.0.
Project root: `C:\Users\81521\.dsh\dsh-peak-hours`.

## 1. Time & phase rules (authoritative)

* Beijing time only, fixed **UTC+8**, no DST. Classify from `epochMs`:
  `d = new Date(epochMs + 8*3600_000)` and use the **UTC** getters of `d`.
* `dateKey = 'YYYY-MM-DD'` (Beijing), `minuteOfDay = hours*60 + minutes`, `weekday = d.getUTCDay()`
  (0=Sun … 6=Sat).
* `phase = 'peak'` iff `weekday ∈ 1..5` **and** `dateKey` is NOT a China statutory holiday
  **and** `minuteOfDay ∈ [540,720) ∪ [840,1080)`  (09:00–12:00, 14:00–18:00).
* Everything else is `'idle'` (weekends all day, holidays all day, 00:00–09:00, 12:00–14:00,
  18:00–24:00).
* `reason ∈ {'peak','off-hours','weekend','holiday'}` — first matching of: peak rule; else
  `holiday` if dateKey is a holiday; else `weekend` if weekday ∈ {0,6}; else `off-hours`.
  A Saturday that is a statutory holiday reports `holiday` (both are idle; label only).
* 调休上班的周末 (make-up workdays) stay **idle**: the rule above is complete, do not add them.
* Unknown holiday year (dataset has no entry for that year): the date is treated as a
  **non-holiday** (so a weekday in the windows is peak) and the state reports
  `holidayCoverage: 'unknown'` plus `unknownHolidayYear: <year>` so the UI can warn.

## 2. Frozen module layout & APIs

```
dsh-peak-hours/
  SPEC.md                     Lead
  package.json                Lead
  cordis.patch.yml            Lead
  README.md                   Lead
  lib/core/holidays.js        core-dev      holiday dataset + calendar
  lib/core/schedule.js        core-dev      classify / nextTransition
  lib/core/index.js           core-dev      re-exports (frozen names)
  lib/host/index.js           host-dev      cordis plugin apply() + gate wiring
  lib/host/gate.js            host-dev      Gate class (framework-free, testable)
  lib/host/state.js           host-dev      state snapshot builder
  lib/host/routes.js          host-dev      webServer route handlers (framework-free core)
  lib/host/clock.js           host-dev      clock + override
  lib/host/store.js           host-dev      mode persistence (JSON file)
  lib/client/index.js         client-dev    browser bundle (ModuleLoader wrapper)
  test/core/*.test.mjs        core-dev      node:test
  test/host/*.test.mjs        host-dev      node:test
  test/client/*.test.mjs      client-dev    node:test (pure helpers only)
  verify/**                   verifier      independent verification, read-only elsewhere
```

ESM everywhere (`"type": "module"`). No runtime npm dependencies. `@deepseek-ai/*` may appear
only in `peerDependencies` (never `dependencies`) — a hoisted copy shadows the app.asar runtime
and disables services.

### 2.1 `lib/core/schedule.js` (ESM, no I/O, no Date.now())

```js
export const BJ_OFFSET_MS = 8 * 3600 * 1000
export const PEAK_WINDOWS = Object.freeze([[540, 720], [840, 1080]]) // [startMin, endMin)
export function classify(epochMs, calendar = defaultCalendar)
  // -> { phase:'peak'|'idle', reason, dateKey, minuteOfDay, weekday,
  //      holiday: { dateKey, name } | null, holidayCoverage: 'known'|'unknown',
  //      unknownHolidayYear: number|null }
export function isPeak(epochMs, calendar = defaultCalendar) // -> boolean
export function nextTransition(epochMs, calendar = defaultCalendar)
  // -> { at: epochMs (strictly > epochMs), to: 'peak'|'idle' }
  // at is the exact millisecond the next phase begins.
export function phaseSegments(fromMs, toMs, calendar = defaultCalendar)
  // -> [{ from, to, phase, reason }] contiguous, covering [fromMs, toMs)
```
Clarification (Lead ruling, 2026-10-09): segments split **by phase only**; each segment's
`reason` is the reason of its first instant (so a 9-day National-Day idle stretch reports
`off-hours` even though `classify` returns `holiday` inside it). Verifier tests align to this.

`nextTransition` must be exact for every input, including inside a peak window, inside the lunch
break, inside a holiday, weekend rollovers and year rollovers (09:00 of the next non-holiday
weekday). Implement by *searching forward minute-by-minute or with a boundary table*, not by
hard-coding one case.

### 2.2 `lib/core/holidays.js` (ESM)

```js
export const HOLIDAY_YEARS = { 2025: {'2025-01-01':'元旦', ...}, 2026: {...}, 2027: {...} }
export const HOLIDAY_SOURCE = { 2025: '<official notice URL/title>', 2026: '...', ... }
export function createCalendar({ years, extra = {} } = {})
  // -> { holidayOn(dateKey) -> {dateKey,name}|undefined,
  //      coverage(dateKey) -> 'known'|'unknown',
  //      years: number[], source: object }
export const defaultCalendar
export function loadCalendarFile(path) // optional extras file, best-effort, never throws
```
Data must come from the official State Council holiday notices (one entry per holiday day that
is a statutory day off). Cross-check at least two independent sources and record the URLs in
`HOLIDAY_SOURCE`. `extra` overlays win over built-in.

### 2.3 Host state JSON contract — `GET /api/peak-hours/state`

```json
{ "ok": true,
  "state": {
    "mode": "always" | "idle-only",
    "phase": "peak" | "idle",
    "reason": "peak" | "off-hours" | "weekend" | "holiday",
    "now": 1760000000000,
    "nowText": "2026-10-09 18:08:06",
    "nextTransitionAt": 1760000000000,
    "nextTransitionText": "2026-10-12 09:00:00",
    "nextPhase": "peak" | "idle",
    "msUntilTransition": 1234,
    "paused": true,                 // true only when mode==='idle-only' && phase==='peak'
    "waitingTasks": 2,              // current gate waiters
    "holidayToday": null,           // { dateKey, name } | null
    "holidayCoverage": "known" | "unknown",
    "unknownHolidayYear": null,
    "timeZone": "Asia/Shanghai (UTC+8)",
    "peakWindows": ["09:00-12:00", "14:00-18:00"],
    "clockOverride": null,          // { offsetMs, expiresAt, ttlMs } | null
    "config": { "allowClockOverride": true }
  } }
```
`nowText` / `nextTransitionText` are Beijing-time strings `YYYY-MM-DD HH:mm:ss`.

* `POST /api/peak-hours/mode`  body `{ "mode": "always"|"idle-only" }` → same envelope.
* `POST /api/peak-hours/clock` body `{ "offsetMs": <int> | null, "ttlMs"?: <int> }` → same envelope.
  Only honored when the clock override is enabled (config `allowClockOverride`, default true on
  this machine; env `DSH_PEAK_HOURS_ALLOW_CLOCK=0` disables). Offset is added to real now.
  **A non-null offset MUST auto-expire**: `ttlMs` defaults to 600000 (10 min); at expiry the
  override clears itself, logs once, and the gate re-evaluates immediately. Without this a
  simulated peak can hold the very session that would clear it — a deadlock.
  `clockOverride` in state echoes `{ offsetMs, expiresAt, ttlMs }` or `null`.
* `GET /api/peak-hours/health` → `{ ok:true, plugin:'dsh-peak-hours', version }`.
* Errors: HTTP 4xx + `{ ok:false, error:'<message>' }`.

### 2.4 Host plugin surface (`lib/host/index.js`)

```js
export const name = 'peak-hours'
export const inject = ['timer', 'webServer']
export function apply(ctx, config = {}) { ... }
```
* Persist mode in `<DSH_HOME>/peak-hours-state.json` (DSH_HOME env, else `~/.dsh`).
  Corrupt/missing file → default `mode:'always'`, log once, never throw.
* Enforcement (all must be registered, each awaiting the gate and then delegating to `next()`):
  1. `agent/pre-step` waterfall — payload has `signal: AbortSignal`. **Primary gate.**
  2. one of `tools/pre-execute` / `llm/stream` — verify the real payload shape in the extracted
     runtime source and use whichever exposes an abort signal; if it exposes none, skip it and
     say so in the README rather than hanging on an unabortable wait.
  * The gate wait MUST reject/throw on abort (never swallow the abort), MUST NOT block when
    `mode === 'always'`, and MUST resume waiters on the exact transition boundary (one timer,
    re-armed after each transition; never busy-poll faster than 1 Hz).
  * Never throw out of a waterfall listener for a non-abort reason (would break a turn).
* `apply` must be idempotent/disposable: every registration goes through `ctx.effect(...)` or the
  disposer returned by `ctx.on(...)`.

### 2.5 Client half (`lib/client/index.js`)

Mandatory wrapper (the browser module loader format):

```js
window.__ModuleLoader__.load({
  id: 'dsh-peak-hours',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    // ... plugin code ...
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```
* `export const inject = ['slots', 'locale']` (client-side services).
* Mount into the **`conversation.input.left`** list slot — verified in the runtime: the composer
  tool row renders `[+] [div.modes: conversation.input.permission + conversation.input.plan]
  [conversation.input.left …]`, so an entry here sits immediately to the RIGHT of the mode
  buttons. Register with `id:'peak-hours'`, `order: 20`.
* UI: one compact pill button. Label + state dot:
  * `mode==='always'` → "全天运行" (neutral dot)
  * `mode==='idle-only' && !paused` → "空闲时段 · 运行中" (green dot)
  * `mode==='idle-only' && paused` → "空闲时段 · 已暂停" (amber dot)
  Click opens a small popover: two selectable options (全天运行 / 仅空闲时段), the current
  Beijing time, the next switch (`nextTransitionText` + live countdown), today's holiday name
  when present, the unknown-holiday-year warning when present, and a note when a clock override
  is active. Selecting an option POSTs the mode and re-renders from the response.
* Poll `GET /api/peak-hours/state` every 15 s and on `visibilitychange`; countdown ticks locally
  every second from `nextTransitionAt`. Plain same-origin `fetch`, 8 s timeout.
* `apply` must never throw (log and mount nothing instead) — a throwing plugin breaks the shell
  boot. Unhandled fetch errors show a muted "时段不可用" state, never an exception.
  (Lead ruling 2026-10-09 on finding F7: the implementation's "时段不可用" wording is adopted —
  it carries the same meaning plus the subject, and the tests assert `/不可用/`.)

## 3. Verification (verifier-owned, must be independent of the authors)

1. Holiday dataset cross-checked against ≥2 independent sources; list every date checked.
2. Boundary matrix at 1 s resolution: 08:59:59 / 09:00:00 / 11:59:59 / 12:00:00 / 13:59:59 /
   14:00:00 / 17:59:59 / 18:00:00 on (a) ordinary Wed, (b) Saturday, (c) Sunday, (d) statutory
   holiday weekday, (e) 2026-10-10 make-up workday Saturday (must be idle), plus a year rollover.
3. Property test: `nextTransition(t)` is strictly increasing in `t`, always lands on a phase
   change, and `classify(nextTransition(t).at - 1) !== classify(nextTransition(t).at)`.
4. Gate semantics with a fake clock (Lead ruling 2026-10-09, default `peakLeadMs = 0`):
   an idle-phase gate check (08:59:59, 12:00:00, 18:00:00…) is released immediately and registers
   no waiter; a peak-phase check (09:00:00.000, 17:59:59.999…) is held until the exact next idle
   boundary; a task released at 08:59:59 is held at its NEXT gate check once that check falls at
   or after 09:00:00.000 (this is the real "running task auto-pauses at peak" path);
   `mode==='always'` never holds; abort during a hold propagates.
5. Live runtime: entry loads in the running desktop profile, `/api/peak-hours/state` answers,
   the composer slot shows the new occupant (client Slots inspect), and a real pause→resume
   cycle is captured (state before/during/after with the clock override), then the override is
   cleared. Record raw evidence in `verify/EVIDENCE.md`.
6. Adversarial: corrupt state file, unknown holiday year, two rapid mode toggles, plugin dispose
   leaves no listener/timer behind (no leak), and no `@deepseek-ai/*` runtime dependency installed
   into the profile by this plugin.

## 3b. Verified integration facts (Lead, 2026-10-09, throwaway probe `dsh-peak-probe`)

* **Hot install works without restarting the app.** Copying the package into
  `C:\Users\81521\.dsh\profiles\desktop\node_modules\<pkg>` and appending an insert row to
  `profiles\desktop\cordis.patch.yml` reconciles the running Loader within ~5 s; the entry's
  host half applies and its `webServer` routes answer. Never restart the desktop app (it owns
  this session).
* **Loopback API routes need no auth token.** `GET /api/skill-hub/catalog` → 200 and
  `GET /api/peak-probe/ping` → 200 while `GET /` and unknown `/api/*` paths → 401. So
  `curl.exe -s http://127.0.0.1:19387/api/peak-hours/state` is a valid token-free E2E entry point.
* **The client half loads live too.** The probe's `dsh.client` bundle was discovered, served and
  applied with no page refresh; `Slots.listSubTree root=conversation.input.left` showed occupant
  `{ registrant:'mf', id:'peak-probe', order:999, active:true }`. The same query with
  `id:'peak-hours'` is the acceptance check for the real button.
* Probe artifacts were removed afterwards (patch file restored from a timestamped backup,
  package directory deleted, route back to 401).

## 9. Per-session run windows (2026-10-14) — supersedes the global mode

The mode is no longer one host-wide value. Every session carries its own choice, and a task is judged by the
choice of the session that owns it.

### 9.1 State file (v2)

`<DSH_HOME>/peak-hours-state.json`:

```json
{ "version": 2, "default": "always", "sessions": { "session-abc": "idle-only" } }
```

* `default` is the mode used by a session with no explicit choice.
* Migration from v1 `{ "mode": "..." }`: `default` becomes that mode, `sessions` starts empty, log once.
* A corrupt or unreadable file still falls back to `{ default: "always", sessions: {} }` and logs once.

### 9.2 Session resolution (host) — the only place a mode is decided

| Gate | Where the sessionId comes from |
| --- | --- |
| `agent/pre-step` | **`payload.agent?.session?.id ?? payload.agent?.id`**. The real dispatch injects `agent` into the payload (`dsh-agent/lib/types/dispatch.js:37-42`); the listener's `this` is an opaque dsh-scope carrier, **not** the Agent — measured with the real cordis runtime on 2026-10-14, `this.session` and `this.id` are both `undefined`. Falls back to `ctx.agents.currentInitiator()?.session?.id`. |
| `tools/pre-execute` | the payload **is** the ToolExecution: `exec.agent?.session?.id`, falling back to `ctx.agents.currentInitiator()?.session?.id` |

Official listeners on this event read the injected agent from the payload, never from `this`
(`dsh-agent/lib/index.js:193`, `dsh-agent/lib/types/model-selection.js:76`). Do not reintroduce a `this`-based
read: it fails silently and takes the whole per-session feature with it (Lead ruling 2026-10-14, after the
acceptance expert reproduced it).

* Resolution order: `sessions[sessionId]` → `default`.
* An unresolvable sessionId resolves to `default` — never "silently always allowed" and never "always held".
* A gate checks **only its own session's** mode: `always` in session A must never be held because session B is
  `idle-only`, and an `idle-only` session must be held even while another session runs freely.
* Waiters are recorded per session, so the state envelope can report both counts.

### 9.3 HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/peak-hours/state?session=<id>` | adds `sessionId`, `mode` (resolved), `defaultMode`, `modeSource: 'session' \| 'default'`, `waitingTasks` (this session), `waitingTasksTotal` |
| POST | `/api/peak-hours/mode` | body `{ mode, session?: '<id>', scope?: 'session' \| 'default' }` |
| POST | `/api/peak-hours/clock` | unchanged — it moves the clock, not a session's choice |
| GET | `/api/peak-hours/health` | unchanged |

* `scope: 'session'` (implied when `session` is present) writes `sessions[sessionId]`.
* `scope: 'default'` writes `default`.
* Neither `session` nor `scope` present → writes `default`, so the existing curl examples keep working.
* `mode: null` together with a usable `session` **clears** that session's override, so the session follows
  `default` again. Without this there is no way to hand a session back to the default, and verification scripts
  would have to leave synthetic sessions behind in the real state file (architect review P1-2, Lead ruling).
* No `waitingTasksScope` field is added: the presence of `?session=` is the discriminator, and
  `waitingTasksTotal` is the one unambiguous global field (architect P2-2, Lead ruling).
* Omitting `session` on GET → the envelope reports `default` as `mode` with `modeSource: 'default'`.
* `waitingTasks` is the **current session's** count when `?session=` is present, and the **host-wide** count
  when it is absent — so the existing session-less curl examples, README snippets and verification scripts keep
  working. `waitingTasksTotal` is always the host-wide number (Lead ruling 2026-10-14).

### 9.4 Client

* The composer control and the queue banner act on the **current session** (the `sessionId` slot prop). With no
  session they render nothing.
* The popover states the scope of a change — "仅此会话" for a session write, "所有未单独设置的会话" for a default
  write — and shows this session's resolved mode plus where it comes from.
* The banner counts only this session's waiting tasks.

### 9.5 Unchanged

* `lib/core/**` (phase math, holiday calendar) — untouched.
* The clock override stays host-wide.
* `apply()` keeps resolving to `undefined`; every registration stays effect-owned and disposable.

### 9.6 Bounded session table (Lead ruling 2026-10-14)

The session table is capped (500 entries) so a long-lived install cannot grow the file without bound. The
eviction policy is **LRU-by-set**: writing a session's mode refreshes its recency, and the least recently
written entry is dropped when the table is full. An evicted session falls back to `default`; each eviction is
logged once so the cause is diagnosable from the host log. No UI warning is required — the session that was
dropped reports `modeSource: 'default'`, which is exactly the truth.

### 9.3a Request validation and write fencing (Lead ruling 2026-10-14, after the security review)

`POST /mode` is an unauthenticated loopback write endpoint, so a malformed request must never widen its own
scope — a "this session only" intent silently becoming a "all sessions without their own entry" write is a
privilege escalation in miniature:

* `session`, when present, must be a non-empty string after trim, at most **128** characters → otherwise 400.
* `scope` accepts only `'session'` or `'default'`; any other value → 400 (never "fall back to default").
* `scope: 'session'` without a usable session → 400.
* `scope: 'default'` together with `session` → 400 (ambiguous: reject instead of guessing).
* Neither `session` nor `scope` → writes `default`, the documented backward-compatible form.
* Reject `__proto__`, `constructor` and `prototype` as session ids (400); store the table with a null prototype.

**Write fencing.** POST requests must carry `Content-Type: application/json`; anything else → 400. Measured
without it: a `text/plain` body is still parsed, and a request carrying `Origin: https://evil.example` is
processed — i.e. any page in the user's browser can reach the write path with a preflight-free "simple
request". The client already sends JSON; every curl example in the docs and in `tools/` must send the header.

**Clock lever.** `POST /clock` clamps `ttlMs` to 30 minutes (400 above). The override moves the clock for
*every* session, so an unbounded TTL turns a debugging aid into a host-wide lever that bypasses the per-session
isolation this section introduces. Production installs should set `DSH_PEAK_HOURS_ALLOW_CLOCK=0`.

**Default writes re-evaluate every default-resolving waiter.** Changing `default` must trigger a full gate
re-evaluation (not a session-filtered one); otherwise a session without its own entry stays held until the next
boundary even though the user just switched the default to `always`.

## 4. Rules

* Only write inside your own scope. Never edit another scope's files; send a message instead.
* Record evidence (command + raw output) for every claim; never claim a test passed without the
  raw result. `node --test` from the project root is the unit-test entry point.
* Report a blocker to the Lead immediately instead of working around a frozen contract.
