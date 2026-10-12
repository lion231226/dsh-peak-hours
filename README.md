# dsh-peak-hours

A run-window switch for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

It adds a control to the right of the composer's mode buttons that chooses between **running always** and
**running only in off-peak hours**. In the second mode every dsh task — including one that is already
running — is paused when a peak-price window starts and resumed automatically when it ends.

Available in **English** (this file) and **[中文](README.zh.md)**.

[![中文文档](https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-README.zh.md-red)](README.zh.md)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## Run windows

Off-peak is the half-price window. Peak, in Beijing time (UTC+8), is:

| When | Phase |
| --- | --- |
| Monday–Friday, 09:00–12:00 and 14:00–18:00, excluding Chinese statutory holidays | peak |
| Everything else — 00:00–09:00, 12:00–14:00, 18:00–24:00, all weekend, all statutory holidays | idle |

Make-up workdays (weekends that are worked to offset a holiday) stay **idle**: the rule only looks at the
weekday and whether the date is a statutory holiday.

## Install

From the dsh CLI:

```sh
dsh plugin --profile web add github:lion231226/dsh-peak-hours
```

The plugin is pure JavaScript with no build step and no runtime dependencies, so a source install is enough.

For a desktop profile that is currently running, this repository also ships `install.ps1`, which copies the
package into `%DSH_HOME%\profiles\<profile>\node_modules\` and maintains one managed row in the profile's
`cordis.patch.yml`. It validates the patch file with js-yaml before writing (a malformed patch file stops the
Loader from reconciling the whole profile), waits for the plugin to answer, and re-activates the entry with a
fresh row id if a previous attempt left it failed. No restart is required.

> **Do not mix the two install paths.** `dsh plugin add` registers the package as a profile bundle, and the
> bundle layer then contributes the patch row from the package's own `cordis.patch.yml`. `install.ps1` writes
> that row by hand instead; running it against a profile that already has the bundle would leave two entries
> with the same id, and nothing downstream de-duplicates them (the patch applier pushes inserted rows as-is and
> the cordis Loader has no duplicate check). The script now refuses to run in that case.

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

## Using it

The button sits in the composer tool row, immediately to the right of the mode buttons (the permission and
plan selectors). It has three states:

| State | Label | Dot |
| --- | --- | --- |
| Run always | 全天运行 / Run always | neutral |
| Off-peak only, currently idle | 空闲时段 · 运行中 / Off-peak · running | green |
| Off-peak only, currently peak | 空闲时段 · 已暂停 / Off-peak · paused | amber |

Clicking it opens a panel with the two modes, the current Beijing time, the next switch and a per-second
countdown, today's holiday (when there is one), a warning when the holiday calendar has no data for the year,
and a note while a clock override is active.

While a peak window is in force, a banner above the composer card states that submitted tasks will start
automatically at the end of the window, with a live countdown.

## How the pause works

The host half hooks two waterfalls and only acts in `idle-only` mode:

1. **`agent/pre-step`** — before every model call. An abort during the wait is re-thrown, which is the control
   flow the agent loop already expects (`signal.throwIfAborted()` follows the waterfall).
2. **`tools/pre-execute`** — before every tool body is dispatched, covering a step that runs into a peak
   window. On abort it returns the runtime's designed `{ kind: 'cancel' }` instead of throwing, because a
   throwing listener is classified as a scheduler failure and fails the whole step.

The gate releases immediately when the phase is idle, and while a peak window is in force it registers a
waiter and arms a single timer at the exact next transition instant — no polling, no busy loop. When the timer
fires, the phase is re-evaluated and every waiter is released, so the work continues on its own.

`llm/stream` is deliberately not gated: it returns an `AsyncIterable` rather than a promise, and the agent loop
has a call path that bypasses it, so the primary gate already covers every model call.

Nothing is lost while waiting: messages and tool calls stay in the session log, no model request is made, and
the wait is abortable (pressing stop cancels it).

## HTTP API

Registered on the host's loopback web server; no GUI token is required on loopback.

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/api/peak-hours/health` | `{ ok, plugin, version }` |
| GET | `/api/peak-hours/state` | the state envelope below |
| POST | `/api/peak-hours/mode` | `{ "mode": "always" \| "idle-only" }` |
| POST | `/api/peak-hours/clock` | `{ "offsetMs": <int\|null>, "ttlMs"?: <int> }` |

```jsonc
{ "ok": true, "state": {
  "mode": "always", "phase": "idle", "reason": "off-hours",
  "now": 1791541815888, "nowText": "2026-10-09 18:30:15",
  "nextTransitionAt": 1791766800000, "nextTransitionText": "2026-10-12 09:00:00", "nextPhase": "peak",
  "msUntilTransition": 224984112, "paused": false, "waitingTasks": 0,
  "holidayToday": null, "holidayCoverage": "known", "unknownHolidayYear": null,
  "timeZone": "Asia/Shanghai (UTC+8)", "peakWindows": ["09:00-12:00", "14:00-18:00"],
  "clockOverride": null, "config": { "allowClockOverride": true } } }
```

`clockOverride` shifts the host's notion of "now" so a peak window can be simulated without waiting for one.
It always carries a TTL (10 minutes by default) and clears itself: without that, a session that is held by the
window it created has nothing left to release it. Set `DSH_PEAK_HOURS_ALLOW_CLOCK=0` to disable the endpoint.

## Holiday data

The built-in calendar lists every statutory day off in 2025 (28 days) and 2026 (33 days), taken from the
State Council holiday notices. Make-up workdays are not part of the set. Each entry keeps its source titles
and URLs in `HOLIDAY_SOURCE_DETAIL` inside `lib/core/holidays.js`.

The 2027 notice has not been published yet, so that year reports `holidayCoverage: "unknown"` with
`unknownHolidayYear: 2027` and treats the date as a non-holiday (a weekday inside a window is peak); the UI
surfaces the warning. Adding a year is one data entry.

Callers can overlay their own dates with `createCalendar({ extra: { '2027-01-01': '元旦' } })`; `extra` wins and
is not restricted by `years`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `allowClockOverride` | `true` | Whether `POST /api/peak-hours/clock` is accepted |
| `version` | from package.json | Version reported by `/health` |

The selected mode is persisted in `%DSH_HOME%\peak-hours-state.json` with serialized atomic writes; a corrupt
file falls back to `always` and logs once. Disposing the plugin releases every listener, timer and route.

## Known limits

* A model call that has already been issued is not interrupted; the task pauses at its next safe boundary.
* Background processes in a terminal, and background shells started as jobs, are not agent steps and are not
  gated.
* A message submitted during a peak window is not dropped — it waits and continues when the window ends.
* `waitingTasks` in the state envelope is the host-wide gate count, so it can include tasks from other sessions.

## Tests

```sh
node --test                          # author suites + the independent verification suite
node --test "test/**/*.test.mjs"     # author suites only
node --test "verify/**/*.test.mjs"   # independent verification only
node tools/smoke-host.mjs            # host half against a fake context, over real HTTP
node tools/show-monday.mjs           # print one day's phase segments
```

`test/` holds the author suites (core schedule, host gate/routes/store, client). `verify/` holds an
independent suite written against the same contracts: a day-by-day check of the holiday calendar against the
official notices, a boundary matrix at one-second resolution, property tests over the transition function,
gate semantics under a fake clock, adversarial cases, client bundle checks, and a harness that mounts the
plugin under the real cordis runtime. `verify/EVIDENCE.md` records each command with its raw output.

Node 24 rejects a directory argument for `node --test`, hence the glob patterns above.

### Field test (real clock, no simulation)

On Monday 2026-10-12, with the plugin in off-peak mode, a message submitted at 09:01:58 Beijing time — inside
the morning peak window — was held for 178 minutes. The session log for that run shows the message entering the
inbox at `09:01:58.530`, the turn opening two milliseconds later, then **no event of any kind** until
`step/start` at `12:00:03.051` — three seconds after the boundary at 12:00:00 — followed by the model request at
`12:00:03.054`. Nothing was dropped and no interval was skipped: the work simply waited for the window to end.

## License

MIT
