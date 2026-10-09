/**
 * Boundary behaviour tests (Lead's UI defect brief: P1–P4).
 *
 * The user-visible bug: a snapshot taken at 11:59:50 (peak) was still on screen
 * at 12:00:05, so the popover claimed "高峰 · 工作时段" with a countdown of
 * `-00:00:05` while the host had already resumed every task. These tests pin the
 * local phase advance, the sentinel copy that replaces negative countdowns, the
 * adaptive poll cadence, and the clock-override copy.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundleExports } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { effectivePhase, pollIntervalMs, overrideExpiresIn, describePopover, deriveView, formatOffset, formatCountdown, translate, DICTS, POLL_MS, FAST_POLL_MS, FAST_POLL_WINDOW_MS } = internals

/** Beijing wall clock -> epoch. */
const bj = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h - 8, mi, s)

const PEAK_NOW = bj(2026, 10, 12, 11, 59, 50)
const BOUNDARY = bj(2026, 10, 12, 12, 0, 0)

/** The Lead's repro fixture: peak snapshot from 11:59:50, boundary at 12:00:00. */
function peakSnapshot(overrides = {}) {
  return {
    mode: 'idle-only',
    phase: 'peak',
    reason: 'peak',
    now: PEAK_NOW,
    nowText: '2026-10-12 11:59:50',
    nextTransitionAt: BOUNDARY,
    nextTransitionText: '2026-10-12 12:00:00',
    nextPhase: 'idle',
    msUntilTransition: 10000,
    paused: true,
    waitingTasks: 2,
    holidayToday: null,
    holidayCoverage: 'known',
    unknownHolidayYear: null,
    timeZone: 'Asia/Shanghai (UTC+8)',
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    clockOverride: null,
    config: { allowClockOverride: true },
    ...overrides,
  }
}

const snap = (state, error = null) => ({ state, fetchedAtMs: 1000, error })

/** `effectivePhase` results cross the vm realm boundary: compare a host copy. */
const phaseOf = (state, hostNow) => {
  const result = effectivePhase(state, hostNow)
  return { phase: result.phase, rolled: result.rolled }
}

test('effectivePhase keeps the snapshot phase before the boundary', () => {
  assert.deepEqual(phaseOf(peakSnapshot(), PEAK_NOW), { phase: 'peak', rolled: false })
  assert.deepEqual(phaseOf(peakSnapshot(), BOUNDARY - 1), { phase: 'peak', rolled: false })
})

test('effectivePhase advances to nextPhase the millisecond the boundary passes', () => {
  assert.deepEqual(phaseOf(peakSnapshot(), BOUNDARY), { phase: 'idle', rolled: true })
  assert.deepEqual(phaseOf(peakSnapshot(), BOUNDARY + 15000), { phase: 'idle', rolled: true })
})

test('effectivePhase only counts a real flip as an advance', () => {
  // The snapshot already describes the live window; only its countdown expired.
  assert.deepEqual(phaseOf(peakSnapshot({ phase: 'idle', reason: 'off-hours', nextPhase: 'idle' }), BOUNDARY + 5000), {
    phase: 'idle',
    rolled: false,
  })
})

test('effectivePhase refuses to guess without a usable boundary or next phase', () => {
  assert.deepEqual(phaseOf(peakSnapshot({ nextPhase: null }), BOUNDARY + 5000), { phase: 'peak', rolled: false })
  assert.deepEqual(phaseOf(peakSnapshot({ nextTransitionAt: null }), BOUNDARY + 5000), { phase: 'peak', rolled: false })
  assert.deepEqual(phaseOf(peakSnapshot({ nextTransitionAt: 'soon' }), BOUNDARY + 5000), { phase: 'peak', rolled: false })
  assert.deepEqual(phaseOf(null, BOUNDARY), { phase: null, rolled: false })
  assert.deepEqual(phaseOf(undefined, BOUNDARY), { phase: null, rolled: false })
})

test('P1: the crossed boundary flips the phase, drops the stale reason and hides the past switch time', () => {
  const model = describePopover(snap(peakSnapshot()), 1000 + 15000)
  assert.equal(model.phaseKey, 'phase.idle', 'the popover must show the phase actually in force')
  assert.equal(model.phaseRolled, true)
  assert.equal(model.reasonKey, null, 'the reason described the window that just ended')
  assert.equal(model.nextAtText, null, 'a scheduled time in the past is not a "next switch"')
  assert.equal(model.showWaiting, false, 'the host already resumed the queued tasks')
  assert.equal(model.view.rolled, true)
  assert.equal(model.view.stale, true)
})

test('P1: the pill leaves 已暂停 at the boundary even though the snapshot still says paused', () => {
  const before = describePopover(snap(peakSnapshot()), 1000)
  assert.equal(before.view.status, 'paused')
  assert.equal(before.view.paused, true)
  assert.equal(translate(DICTS, 'zh', before.view.labelKey), '空闲时段 · 已暂停')

  const after = describePopover(snap(peakSnapshot()), 1000 + 15000)
  assert.equal(after.view.status, 'running')
  assert.equal(after.view.paused, false)
  assert.equal(after.view.phase, 'idle')
  assert.equal(translate(DICTS, 'zh', after.view.labelKey), '空闲时段 · 运行中')
  assert.equal(after.view.dot, 'success')
})

test('P1: mode=always is unaffected by a boundary crossing', () => {
  const model = describePopover(snap(peakSnapshot({ mode: 'always', paused: false })), 1000 + 15000)
  assert.equal(model.view.status, 'always')
  assert.equal(model.view.paused, false)
  assert.equal(translate(DICTS, 'zh', model.view.labelKey), '全天运行')
})

test('P2: no countdown ever renders a negative sign', () => {
  for (const offset of [15000, 20000, 60000, 86_400_000]) {
    const model = describePopover(snap(peakSnapshot()), 1000 + offset)
    assert.equal(model.remaining < 0, true, `fixture must have passed the boundary (+${offset})`)
    assert.equal(model.countdown, '正在刷新…')
    assert.equal(model.countdownState, 'refreshing')
    assert.doesNotMatch(String(model.countdown), /-/)
  }
})

test('P2: the sentinel is localized and never blank', () => {
  const zh = describePopover(snap(peakSnapshot()), 1000 + 15000)
  assert.equal(zh.countdown, '正在刷新…')
  const en = describePopover(snap(peakSnapshot()), 1000 + 15000, (key) => translate(DICTS, 'en', key))
  assert.equal(en.countdown, 'Refreshing…')
})

test('P2: a live countdown is untouched just before the boundary', () => {
  const model = describePopover(snap(peakSnapshot()), 1000)
  assert.equal(model.remaining, 10000)
  assert.equal(model.countdown, '00:00:10')
  assert.equal(model.countdownState, 'live')
  const almost = describePopover(snap(peakSnapshot()), 1000 + 9999)
  assert.equal(almost.remaining, 1)
  assert.equal(almost.countdown, '00:00:00')
  assert.equal(almost.countdownState, 'live')
})

test('P2: a failed poll reports expired data instead of a number', () => {
  const withData = describePopover({ state: peakSnapshot(), fetchedAtMs: 1000, error: 'timeout' }, 1000)
  assert.equal(withData.countdown, '数据可能已过期')
  assert.equal(withData.countdownState, 'expired')
  assert.equal(withData.showWaiting, false, 'stale queue numbers must not be presented as live')
  const withoutData = describePopover({ state: null, fetchedAtMs: 0, error: 'timeout' }, 1000)
  assert.equal(withoutData.countdown, '数据可能已过期')
  assert.equal(withoutData.countdownState, 'expired')
})

test('P3: the poll cadence drops to 3 s only near or past a boundary', () => {
  assert.equal(FAST_POLL_MS, 3000)
  assert.equal(FAST_POLL_WINDOW_MS, 30000)
  assert.equal(pollIntervalMs(FAST_POLL_WINDOW_MS + 1), POLL_MS)
  assert.equal(pollIntervalMs(60_000), POLL_MS)
  assert.equal(pollIntervalMs(9 * 3600 * 1000), POLL_MS)
  assert.equal(pollIntervalMs(FAST_POLL_WINDOW_MS), FAST_POLL_MS)
  assert.equal(pollIntervalMs(29_999), FAST_POLL_MS)
  assert.equal(pollIntervalMs(0), FAST_POLL_MS)
  assert.equal(pollIntervalMs(-5000), FAST_POLL_MS, 'a passed boundary is the most urgent case')
  assert.equal(pollIntervalMs(null), POLL_MS, 'no data keeps the plain cadence')
  assert.equal(pollIntervalMs(undefined), POLL_MS)
})

test('P3: an outage keeps the plain cadence instead of a 3 s request storm', () => {
  assert.equal(pollIntervalMs(0, true), POLL_MS)
  assert.equal(pollIntervalMs(-5000, true), POLL_MS)
  assert.equal(pollIntervalMs(10_000, true), POLL_MS)
})

test('P3: the cadence follows the crossing snapshots end to end', () => {
  const before = describePopover(snap(peakSnapshot()), 1000)
  const after = describePopover(snap(peakSnapshot()), 1000 + 15000)
  const far = describePopover(snap(peakSnapshot({ nextTransitionAt: BOUNDARY + 9 * 3600 * 1000, nextTransitionText: '2026-10-12 21:00:00' })), 1000)
  assert.equal(pollIntervalMs(before.remaining), FAST_POLL_MS)
  assert.equal(pollIntervalMs(after.remaining), FAST_POLL_MS)
  assert.equal(pollIntervalMs(far.remaining), POLL_MS)
})

test('P4: the override line counts down to real time, never the offset size', () => {
  const state = peakSnapshot({ clockOverride: { offsetMs: 233_160_000, expiresAt: 1000 + 598_000, ttlMs: 600_000 } })
  const model = describePopover(snap(state), 1000)
  assert.equal(model.clockOverrideExpiresIn, 598_000)
  assert.equal(
    model.clockOverrideText,
    '演示模式：时间被临时偏移（模拟 2026-10-12 11:59:50），剩余 00:09:58 后自动恢复真实时间'
  )
  assert.doesNotMatch(model.clockOverrideText, /2d 16h 46m/, 'the offset magnitude must not appear any more')
})

test('P4: the countdown shrinks with the browser clock and clamps at zero', () => {
  const state = peakSnapshot({ clockOverride: { offsetMs: 1000, expiresAt: 1000 + 120_000, ttlMs: 120_000 } })
  assert.equal(describePopover(snap(state), 1000).clockOverrideExpiresIn, 120_000)
  assert.equal(describePopover(snap(state), 61_000).clockOverrideExpiresIn, 60_000)
  assert.equal(describePopover(snap(state), 121_000).clockOverrideExpiresIn, 0)
  assert.equal(describePopover(snap(state), 999_999).clockOverrideExpiresIn, 0)
  assert.match(describePopover(snap(state), 121_000).clockOverrideText, /剩余 00:00:00 后自动恢复真实时间/)
})

test('P4: a missing expiry degrades to the plain sentence', () => {
  const bare = peakSnapshot({ clockOverride: { offsetMs: 7_200_000 } })
  const model = describePopover(snap(bare), 1000)
  assert.equal(model.clockOverrideExpiresIn, null)
  assert.equal(model.clockOverrideText, '演示模式：时间被临时偏移')
  assert.equal(describePopover({ state: peakSnapshot(), fetchedAtMs: 1000, error: null }, 1000).clockOverrideText, null)
})

test('P4: a TTL-only override rebuilds the deadline from the snapshot real time', () => {
  // state.now is host time (the offset is already applied), so state.now - offsetMs
  // is the real time the snapshot was taken; + ttlMs is the real deadline.
  const state = peakSnapshot({ clockOverride: { offsetMs: 7_200_000, expiresAt: null, ttlMs: 600_000 }, now: 1000 + 7_200_000 })
  assert.equal(overrideExpiresIn(state, 1000), 600_000)
  assert.equal(overrideExpiresIn(state, 301_000), 300_000)
  // An unusable anchor can only clamp to zero, never report a negative "left".
  assert.equal(overrideExpiresIn({ ...state, now: 1 }, 1000), 0)
})

test('P4: without an expiry or usable TTL the deadline is unknown', () => {
  assert.equal(overrideExpiresIn(peakSnapshot(), 1000), null, 'no override at all')
  assert.equal(overrideExpiresIn(peakSnapshot({ clockOverride: { offsetMs: 7_200_000 } }), 1000), null, 'expiry and TTL both absent')
  assert.equal(overrideExpiresIn(peakSnapshot({ clockOverride: { offsetMs: 7_200_000, expiresAt: null, ttlMs: 0 } }), 1000), null, 'a zero TTL is not a deadline')
  assert.equal(overrideExpiresIn(peakSnapshot({ clockOverride: { offsetMs: 7_200_000, expiresAt: 'soon', ttlMs: 'later' } }), 1000), null, 'garbage is not a deadline')
  assert.equal(overrideExpiresIn(peakSnapshot({ clockOverride: { offsetMs: 1000, expiresAt: 2000 } }), null), null, 'no browser clock, no answer')
})

test('P4: the override copy is localized', () => {
  const state = peakSnapshot({ clockOverride: { offsetMs: 1000, expiresAt: 1000 + 60_000, ttlMs: 60_000 } })
  const en = describePopover(snap(state), 1000, (key, params) => translate(DICTS, 'en', key, params))
  assert.equal(en.clockOverrideText, 'Demo mode: the clock is temporarily offset (simulating 2026-10-12 11:59:50); real time resumes in 00:01:00')
})

test('formatOffset stays correct across magnitudes (unchanged by P4)', () => {
  assert.equal(formatOffset(0), '0')
  assert.equal(formatOffset(null), '0')
  assert.equal(formatOffset(1000), '+1s')
  assert.equal(formatOffset(-1_800_000), '-30m')
  assert.equal(formatOffset(3_600_000), '+1h')
  assert.equal(formatOffset(223_080_000), '+2d 13h 58m', "the Lead's repro constant")
  assert.equal(formatOffset(233_160_000), '+2d 16h 46m', "the user screenshot's constant")
  assert.equal(formatOffset(90_000_000), '+1d 1h')
  assert.equal(formatOffset(10_368_000_000), '+120d')
  assert.equal(formatOffset(-223_080_000), '-2d 13h 58m')
})

test('formatCountdown itself keeps its documented negative form; the popover never uses it', () => {
  assert.equal(formatCountdown(-5000), '-00:00:05')
  assert.equal(formatCountdown(86_400_000), '1d 00:00:00')
  const model = describePopover(snap(peakSnapshot()), 1000 + 15000)
  assert.equal(model.remaining, -5000)
  assert.equal(model.countdown, '正在刷新…')
})

test('P1/P2: deriveView marks the rolled snapshot stale but still available', () => {
  const rolled = deriveView(snap(peakSnapshot()), 1000 + 15000)
  assert.equal(rolled.available, true)
  assert.equal(rolled.stale, true)
  assert.equal(rolled.rolled, true)
  assert.equal(rolled.phase, 'idle')
  const fresh = deriveView(snap(peakSnapshot()), 1000)
  assert.equal(fresh.available, true)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.rolled, false)
})

test('P5: the idle-only description states the holiday and weekend rules', () => {
  const desc = translate(DICTS, 'zh', 'option.idleOnly.desc')
  assert.match(desc, /法定节假日除外/)
  assert.match(desc, /周末与法定节假日全天运行/)
  assert.match(desc, /09:00-12:00/)
  assert.match(desc, /14:00-18:00/)
  assert.equal(translate(DICTS, 'zh', 'option.always.desc'), '任何时间都执行任务')
  assert.match(translate(DICTS, 'en', 'option.idleOnly.desc'), /statutory holidays excepted/)
})
