/**
 * Queue-banner tests (P9).
 *
 * The user asked for an explicit "queued, starts automatically at 12:00" notice
 * while the run window holds work — the spinner alone reads as a hang. These
 * tests pin the display matrix (mode/phase/snapshot validity), the two copy
 * branches, the countdown reuse, and that the wording never implies ownership of
 * the host's global waiter count.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundleExports } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { describeBanner, describePopover, translate, DICTS, formatBeijingClock, effectivePhase } = internals

/** Beijing wall clock -> epoch. */
const bj = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h - 8, mi, s)

const PEAK_NOW = bj(2026, 10, 12, 10, 0, 0)
const BOUNDARY = bj(2026, 10, 12, 12, 0, 0)

/** A SPEC 2.3 state describing a Monday 10:00 peak window. */
function state(overrides = {}) {
  return {
    mode: 'idle-only',
    phase: 'peak',
    reason: 'peak',
    now: PEAK_NOW,
    nowText: '2026-10-12 10:00:00',
    nextTransitionAt: BOUNDARY,
    nextTransitionText: '2026-10-12 12:00:00',
    nextPhase: 'idle',
    msUntilTransition: 7_200_000,
    paused: true,
    waitingTasks: 2,
    holidayToday: null,
    holidayCoverage: 'known',
    unknownHolidayYear: null,
    timeZone: 'Asia/Shanghai (UTC+8)',
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    clockOverride: null,
    config: { allowClockOverride: true },
    // SPEC 9.3 per-session fields, present on every v2 envelope.
    sessionId: 'session-abc',
    modeSource: 'session',
    defaultMode: 'always',
    waitingTasksTotal: 2,
    ...overrides,
  }
}

const snap = (stateValue, error = null) => ({ state: stateValue, fetchedAtMs: 1000, error })
const bannerFor = (stateValue, browserNowMs = 1000, error = null) =>
  describeBanner(describePopover(snap(stateValue, error), browserNowMs))

/** Render one banner's text through the dictionary (zh unless stated). */
function bannerText(banner, locale = 'zh') {
  return translate(DICTS, locale, banner.textKey, {
    count: banner.count,
    time: banner.time,
    countdown: banner.countdown,
  })
}

test('P9: the banner shows while idle-only holds work in a peak window', () => {
  const banner = bannerFor(state())
  assert.equal(banner.show, true)
  assert.equal(banner.waiting, true)
  assert.equal(banner.count, 2)
  assert.equal(banner.textKey, 'banner.waiting')
  assert.equal(banner.time, '2026-10-12 12:00:00')
  assert.equal(banner.countdown, '02:00:00')
})

test('P9: with nothing queued the banner invites instead of announcing a hold', () => {
  const banner = bannerFor(state({ waitingTasks: 0, paused: false, phase: 'peak' }))
  assert.equal(banner.show, true)
  assert.equal(banner.waiting, false)
  assert.equal(banner.count, 0)
  assert.equal(banner.textKey, 'banner.idle')
})

test('P9: the copy is exact, in both languages', () => {
  const waiting = bannerFor(state({ waitingTasks: 3 }))
  assert.equal(
    bannerText(waiting),
    '已暂停 · 高峰时段，3 个任务排队中，将在 2026-10-12 12:00:00 自动开始（还有 02:00:00）'
  )
  assert.equal(
    bannerText(waiting, 'en'),
    'Paused · peak hours: 3 queued, starting automatically at 2026-10-12 12:00:00 (in 02:00:00)'
  )
  const idle = bannerFor(state({ waitingTasks: 0 }))
  assert.equal(bannerText(idle), '高峰时段：现在提交的任务会在 2026-10-12 12:00:00 自动开始（还有 02:00:00）')
  assert.equal(bannerText(idle, 'en'), 'Peak hours: a task submitted now starts automatically at 2026-10-12 12:00:00 (in 02:00:00)')
})

test('P9: a single queued task reads naturally (Chinese has no plural form)', () => {
  assert.match(bannerText(bannerFor(state({ waitingTasks: 1 }))), /1 个任务排队中/)
  assert.match(bannerText(bannerFor(state({ waitingTasks: 12 }))), /12 个任务排队中/)
})

test('P9: the wording never claims the queue is yours', () => {
  const zh = translate(DICTS, 'zh', 'banner.waiting')
  const en = translate(DICTS, 'en', 'banner.waiting')
  assert.match(zh, /排队中/)
  assert.equal(/你的|您的/.test(zh), false, 'waitingTasks is a global gate count')
  assert.equal(/your/i.test(en), false)
})

test('P9: mode=always shows no banner', () => {
  const banner = bannerFor(state({ mode: 'always', paused: false, waitingTasks: 4 }))
  assert.equal(banner.show, false)
  assert.equal(banner.textKey, null)
})

test('P9: an idle phase shows no banner (weekend, holiday, lunch, off hours)', () => {
  for (const reason of ['off-hours', 'weekend', 'holiday']) {
    const banner = bannerFor(state({ phase: 'idle', reason, paused: false, waitingTasks: 4 }))
    assert.equal(banner.show, false, `${reason} must hide the banner`)
  }
})

test('P9: the banner leaves the moment the local phase flips at the boundary', () => {
  const before = bannerFor(state(), 1000)
  assert.equal(before.show, true)
  // 15 s later the snapshot is stale but the effective phase already advanced
  // (P1): the hold is over, so the notice must go.
  const after = bannerFor(state(), 1000 + 7_200_000)
  assert.equal(effectivePhase(state(), BOUNDARY).rolled, true, 'fixture sanity: the boundary has passed')
  assert.equal(after.show, false)
  assert.equal(after.textKey, null)
})

test('P9: no snapshot at all shows no banner', () => {
  assert.equal(describeBanner(describePopover(internals.EMPTY_SNAPSHOT, 0)).show, false)
  assert.equal(describeBanner(null).show, false)
  assert.equal(describeBanner(undefined).show, false)
})

test('P9: a failed poll hides the banner when there is no cache, and warns when there is', () => {
  const cold = describeBanner(describePopover({ state: null, fetchedAtMs: 0, error: 'HTTP 500' }, 0))
  assert.equal(cold.show, false, 'never claim a hold we cannot verify')
  const warm = bannerFor(state(), 1000, 'timeout')
  assert.equal(warm.show, true, 'a cached peak still explains why nothing runs')
  assert.equal(warm.countdown, '数据可能已过期', 'and it says the number may be stale')
  assert.equal(bannerText(warm).includes('数据可能已过期'), true)
})

test('P9: the countdown reuses the P2 sentinel and never goes negative', () => {
  const crossing = bannerFor(state({ nextTransitionAt: PEAK_NOW + 5000, msUntilTransition: 5000 }), 1000 + 8000)
  // Phase flipped, so it is hidden — but if a host reported the same phase with an
  // expired boundary the text must still avoid a minus sign.
  assert.equal(crossing.show, false)
  const expired = bannerFor(state({ nextPhase: 'peak', nextTransitionAt: PEAK_NOW + 5000, msUntilTransition: 5000 }), 1000 + 8000)
  assert.equal(expired.show, true, 'same-phase boundary: the window is still peak')
  assert.equal(expired.countdown, '正在刷新…')
  assert.equal(/-/.test(String(expired.countdown)), false)
})

test('P9: the switch time falls back to the raw timestamp when the host sends no text', () => {
  const banner = bannerFor(state({ nextTransitionText: null }))
  assert.equal(banner.time, formatBeijingClock(BOUNDARY))
  assert.equal(banner.time, '2026-10-12 12:00:00')
  const missing = bannerFor(state({ nextTransitionText: null, nextTransitionAt: null }))
  assert.equal(missing.time, '—')
})

test('P9: a boundary the refresh has not caught up with still names the right time', () => {
  // Snapshot says 11:59:50 peak, boundary 12:00:00 — one tick before it the banner
  // is still up and counts down the last seconds.
  const late = bannerFor(state({ now: bj(2026, 10, 12, 11, 59, 50), msUntilTransition: 10_000 }), 1000 + 5000)
  assert.equal(late.show, true)
  assert.equal(late.countdown, '00:00:05')
  assert.equal(late.time, '2026-10-12 12:00:00')
})
