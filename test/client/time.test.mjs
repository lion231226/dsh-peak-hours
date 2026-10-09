/**
 * Pure time tests: Beijing wall-clock formatting, countdown formatting
 * (including >24 h and cross-day), and the local countdown extrapolation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundleExports } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { formatBeijingClock, formatCountdown, formatOffset, remainingMs, estimateHostNow, BJ_OFFSET_MS } = internals

test('the Beijing offset is a fixed UTC+8', () => {
  assert.equal(BJ_OFFSET_MS, 28_800_000)
})

test('formatBeijingClock renders UTC+8 wall clock', () => {
  // 2026-10-09T10:08:06Z  ==  2026-10-09 18:08:06 in Beijing.
  assert.equal(formatBeijingClock(Date.UTC(2026, 9, 9, 10, 8, 6)), '2026-10-09 18:08:06')
  assert.equal(formatBeijingClock(0), '1970-01-01 08:00:00')
})

test('formatBeijingClock crosses the date at UTC 16:00', () => {
  assert.equal(formatBeijingClock(Date.UTC(2026, 9, 9, 15, 59, 59)), '2026-10-09 23:59:59')
  assert.equal(formatBeijingClock(Date.UTC(2026, 9, 9, 16, 0, 0)), '2026-10-10 00:00:00')
})

test('formatBeijingClock pads every field and rejects garbage', () => {
  assert.equal(formatBeijingClock(Date.UTC(2026, 0, 2, 1, 2, 3) - BJ_OFFSET_MS), '2026-01-02 01:02:03')
  for (const bad of [NaN, Infinity, undefined, null, 'nope']) assert.equal(formatBeijingClock(bad), '—')
})

test('formatCountdown truncates toward zero below a second', () => {
  assert.equal(formatCountdown(0), '00:00:00')
  assert.equal(formatCountdown(1), '00:00:00')
  assert.equal(formatCountdown(999), '00:00:00')
  assert.equal(formatCountdown(1000), '00:00:01')
  assert.equal(formatCountdown(1999), '00:00:01')
})

test('formatCountdown renders hours/minutes/seconds', () => {
  assert.equal(formatCountdown(3_661_000), '01:01:01')
  assert.equal(formatCountdown(59_000), '00:00:59')
  assert.equal(formatCountdown(3_600_000), '01:00:00')
  assert.equal(formatCountdown(86_399_000), '23:59:59')
})

test('formatCountdown keeps counting across days instead of wrapping at 24 h', () => {
  assert.equal(formatCountdown(86_400_000), '1d 00:00:00')
  assert.equal(formatCountdown(90_061_000), '1d 01:01:01')
  assert.equal(formatCountdown(3 * 86_400_000), '3d 00:00:00')
  assert.equal(formatCountdown(172_800_000 + 3_723_000), '2d 01:02:03')
})

test('formatCountdown marks an already-passed boundary', () => {
  assert.equal(formatCountdown(-1), '-00:00:00')
  assert.equal(formatCountdown(-5000), '-00:00:05')
  assert.equal(formatCountdown(-90_000_000), '-1d 01:00:00')
})

test('formatCountdown rejects non-finite input', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x']) assert.equal(formatCountdown(bad), '—')
})

test('formatOffset is compact and signed', () => {
  assert.equal(formatOffset(0), '0')
  assert.equal(formatOffset(null), '0')
  assert.equal(formatOffset(3_600_000), '+1h')
  assert.equal(formatOffset(-1_800_000), '-30m')
  assert.equal(formatOffset(7_200_000), '+2h')
  assert.equal(formatOffset(90_000_000), '+1d 1h')
  assert.equal(formatOffset(45_000), '+45s')
})

test('remainingMs extrapolates locally from the host clock anchor', () => {
  const snapshot = {
    state: { now: 1_760_000_000_000, nextTransitionAt: 1_760_003_600_000, msUntilTransition: 3_600_000 },
    fetchedAtMs: 1000,
    error: null,
  }
  assert.equal(remainingMs(snapshot, 1000), 3_600_000)
  assert.equal(remainingMs(snapshot, 61_000), 3_540_000)
  assert.equal(remainingMs(snapshot, 3_601_000), 0)
  assert.equal(remainingMs(snapshot, 3_602_000), -1000)
})

test('remainingMs stays correct under a host clock override', () => {
  // The host clock runs two hours ahead of the browser's; the offset is constant,
  // so anchoring on state.now keeps the countdown exact.
  const snapshot = {
    state: { now: 1_760_000_000_000 + 7_200_000, nextTransitionAt: 1_760_000_000_000 + 7_200_000 + 600_000 },
    fetchedAtMs: 5_000,
    error: null,
  }
  assert.equal(remainingMs(snapshot, 5_000), 600_000)
  assert.equal(remainingMs(snapshot, 305_000), 300_000)
})

test('remainingMs falls back to msUntilTransition and otherwise reports null', () => {
  assert.equal(remainingMs({ state: { msUntilTransition: 42_000 }, fetchedAtMs: 1000 }, 1000), 42_000)
  assert.equal(remainingMs({ state: { now: 1 }, fetchedAtMs: 1000 }, 1000), null)
  assert.equal(remainingMs({ state: null, fetchedAtMs: 0 }, 1000), null)
  assert.equal(remainingMs(null, 1000), null)
})

test('estimateHostNow tracks the host clock, not the browser clock', () => {
  const snapshot = { state: { now: 1_760_000_000_000 + 7_200_000 }, fetchedAtMs: 1000, error: null }
  assert.equal(estimateHostNow(snapshot, 1000), 1_760_000_000_000 + 7_200_000)
  assert.equal(estimateHostNow(snapshot, 6000), 1_760_000_000_000 + 7_200_000 + 5000)
  assert.equal(estimateHostNow({ state: null, fetchedAtMs: 0 }, 1234), 1234)
})

test('a countdown crossing midnight is still a plain duration', () => {
  // 23:30 Beijing -> 09:00 Beijing next day = 9 h 30 m.
  const from = Date.UTC(2026, 9, 9, 15, 30, 0)
  const to = Date.UTC(2026, 9, 10, 1, 0, 0)
  assert.equal(formatCountdown(to - from), '09:30:00')
  assert.equal(formatBeijingClock(from), '2026-10-09 23:30:00')
  assert.equal(formatBeijingClock(to), '2026-10-10 09:00:00')
})
