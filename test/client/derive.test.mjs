/**
 * Pure derivation tests: state → (label, dot colour, paused), plus the popover's
 * structured model. No React, no DOM.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundleExports } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { deriveView, describePopover, translate, DICTS } = internals

/** A SPEC 2.3 state object with overridable fields. */
function state(overrides = {}) {
  return {
    mode: 'always',
    phase: 'idle',
    reason: 'off-hours',
    now: 1_760_000_000_000,
    nowText: '2026-10-09 18:08:06',
    nextTransitionAt: 1_760_003_600_000,
    nextTransitionText: '2026-10-12 09:00:00',
    nextPhase: 'peak',
    msUntilTransition: 3_600_000,
    paused: false,
    waitingTasks: 0,
    holidayToday: null,
    holidayCoverage: 'known',
    unknownHolidayYear: null,
    timeZone: 'Asia/Shanghai (UTC+8)',
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    clockOverride: null,
    config: { allowClockOverride: true },
    // SPEC 9.3 per-session fields: a v2 envelope always carries them, and the
    // client reads an envelope without them as an old, read-only host.
    sessionId: 'session-abc',
    modeSource: 'session',
    defaultMode: 'always',
    waitingTasksTotal: 0,
    ...overrides,
  }
}

test('mode=always derives the neutral "全天运行" pill', () => {
  const view = deriveView({ state: state(), fetchedAtMs: 1000, error: null })
  assert.equal(view.status, 'always')
  assert.equal(translate(DICTS, 'zh', view.labelKey), '全天运行')
  assert.equal(view.dot, 'neutral')
  assert.equal(view.paused, false)
  assert.equal(view.available, true)
  assert.equal(view.mode, 'always')
})

test('idle-only and running derives the green "空闲时段 · 运行中" pill', () => {
  const view = deriveView({ state: state({ mode: 'idle-only', paused: false, phase: 'idle' }), fetchedAtMs: 1000, error: null })
  assert.equal(view.status, 'running')
  assert.equal(translate(DICTS, 'zh', view.labelKey), '空闲时段 · 运行中')
  assert.equal(view.dot, 'success')
  assert.equal(view.dotColor, internals.DOT_COLOR.success)
  assert.equal(view.paused, false)
})

test('idle-only and paused derives the amber "空闲时段 · 已暂停" pill', () => {
  const view = deriveView({ state: state({ mode: 'idle-only', paused: true, phase: 'peak' }), fetchedAtMs: 1000, error: null })
  assert.equal(view.status, 'paused')
  assert.equal(translate(DICTS, 'zh', view.labelKey), '空闲时段 · 已暂停')
  assert.equal(view.dot, 'warn')
  assert.equal(view.dotColor, internals.DOT_COLOR.warn)
  assert.equal(view.paused, true)
})

test('the three SPEC labels are exact, in both languages', () => {
  assert.equal(translate(DICTS, 'zh', 'button.always'), '全天运行')
  assert.equal(translate(DICTS, 'zh', 'button.running'), '空闲时段 · 运行中')
  assert.equal(translate(DICTS, 'zh', 'button.paused'), '空闲时段 · 已暂停')
  assert.equal(translate(DICTS, 'en', 'button.always'), 'Always on')
  assert.equal(translate(DICTS, 'en', 'button.running'), 'Idle hours · running')
  assert.equal(translate(DICTS, 'en', 'button.paused'), 'Idle hours · paused')
})

test('dot colours are registered theme steps with opaque fallbacks, never raw hex', () => {
  for (const token of Object.values(internals.DOT_COLOR)) {
    // P7: a bare var() would invalidate the declaration and paint nothing.
    assert.match(token, /^var\(--dsw-[a-z0-9-]+, #[0-9a-f]{6}\)$/)
    assert.equal(internals.THEME_TOKENS.allowed.includes(token.slice(4, token.indexOf(','))), true)
  }
})

test('a failed poll degrades to the muted unavailable pill', () => {
  const view = deriveView({ state: null, fetchedAtMs: 0, error: 'HTTP 500' })
  assert.equal(view.status, 'unavailable')
  assert.equal(translate(DICTS, 'zh', view.labelKey), '时段不可用')
  assert.equal(view.dot, 'muted')
  assert.equal(view.available, false)
  assert.equal(view.paused, false)
})

test('a failed poll after a good one keeps the last mode but still reads unavailable', () => {
  const view = deriveView({ state: state({ mode: 'idle-only', paused: true }), fetchedAtMs: 1000, error: 'timeout' })
  assert.equal(view.status, 'unavailable')
  assert.equal(view.available, false)
  assert.equal(view.stale, true, 'the popover needs to know its numbers are stale')
  assert.equal(view.mode, 'idle-only')
})

test('before the first response the pill reads as loading', () => {
  const view = deriveView(internals.EMPTY_SNAPSHOT)
  assert.equal(view.status, 'loading')
  assert.equal(view.dot, 'muted')
  assert.equal(view.available, false)
})

test('an unknown mode string is treated as always (fail-open, never blocks)', () => {
  const view = deriveView({ state: state({ mode: 'nonsense' }), fetchedAtMs: 1000, error: null })
  assert.equal(view.mode, 'always')
  assert.equal(view.status, 'always')
})

test('paused follows the effective phase, not the snapshot flag alone', () => {
  // SPEC 2.3 guarantees `paused === (mode==='idle-only' && phase==='peak')`, so a
  // fixture whose flag contradicts its phase is host-inconsistent: the phase wins
  // (P1) — that is exactly how the pill leaves "已暂停" at the boundary.
  assert.equal(deriveView({ state: state({ mode: 'always', paused: true, phase: 'peak' }), fetchedAtMs: 1, error: null }).paused, false)
  assert.equal(deriveView({ state: state({ mode: 'idle-only', paused: false, phase: 'peak' }), fetchedAtMs: 1, error: null }).paused, true)
  assert.equal(deriveView({ state: state({ mode: 'idle-only', paused: 'yes', phase: 'peak' }), fetchedAtMs: 1, error: null }).paused, true)
  assert.equal(deriveView({ state: state({ mode: 'idle-only', paused: true, phase: 'idle' }), fetchedAtMs: 1, error: null }).paused, false)
})

test('describePopover renders the SPEC state into the popover model', () => {
  const snapshot = { state: state({ mode: 'idle-only', paused: true, phase: 'peak', reason: 'peak', waitingTasks: 2 }), fetchedAtMs: 1000, error: null }
  const model = describePopover(snapshot, 1000)
  assert.equal(model.view.status, 'paused')
  assert.equal(model.countdown, '01:00:00')
  assert.equal(model.phaseKey, 'phase.peak')
  assert.equal(model.reasonKey, 'reason.peak')
  assert.equal(model.nextPhaseKey, 'phase.peak')
  assert.equal(model.waitingTasks, 2)
  assert.deepEqual(model.peakWindows, ['09:00-12:00', '14:00-18:00'])
  assert.equal(model.clockOffsetMs, null)
  assert.equal(model.unknownHolidayYear, null)
  assert.equal(model.holiday, null)
})

test('describePopover surfaces today\'s holiday, the unknown year, and a clock override', () => {
  const snapshot = {
    state: state({
      holidayToday: { dateKey: '2026-10-01', name: '国庆节' },
      holidayCoverage: 'unknown',
      unknownHolidayYear: 2028,
      clockOverride: { offsetMs: 7_200_000 },
    }),
    fetchedAtMs: 1000,
    error: null,
  }
  const model = describePopover(snapshot, 1000)
  assert.deepEqual(model.holiday, { dateKey: '2026-10-01', name: '国庆节' })
  assert.equal(model.unknownHolidayYear, 2028)
  assert.equal(model.clockOffsetMs, 7_200_000)
  assert.equal(internals.formatOffset(model.clockOffsetMs), '+2h')
})

test('describePopover ignores an unrecognized reason instead of leaking a raw key', () => {
  const model = describePopover({ state: state({ reason: 'lunch' }), fetchedAtMs: 1000, error: null }, 1000)
  assert.equal(model.reasonKey, null)
})

test('describePopover survives a null/garbage snapshot', () => {
  for (const snapshot of [internals.EMPTY_SNAPSHOT, null, undefined, { state: null, fetchedAtMs: 0, error: null }]) {
    const model = describePopover(snapshot, 0)
    assert.equal(model.state, null)
    assert.equal(model.countdown, null)
    assert.equal(model.countdownState, 'unknown')
    assert.equal(model.waitingTasks, 0)
    assert.equal(model.showWaiting, false)
  }
  // A failed poll with no data at all still explains itself instead of showing a
  // blank or a number (P2).
  const failed = describePopover({ state: null, fetchedAtMs: 0, error: 'HTTP 500' }, 0)
  assert.equal(failed.countdown, '数据可能已过期')
  assert.equal(failed.countdownState, 'expired')
})

test('readState only accepts an ok envelope with an object state', () => {
  assert.equal(internals.readState({ ok: true, state: { mode: 'always' } }).mode, 'always')
  assert.equal(internals.readState({ ok: false, error: 'nope' }), null)
  assert.equal(internals.readState({ ok: true, state: null }), null)
  assert.equal(internals.readState({ ok: true }), null)
  assert.equal(internals.readState(null), null)
  assert.equal(internals.readState('boom'), null)
})
