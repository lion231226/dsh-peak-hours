/**
 * Clock + TTL-bounded override (SPEC §2.3 + Lead's safety addendum).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CLOCK_TTL_MS,
  allowClockOverrideFromEnv,
  createClock,
  formatBeijing,
  normalizeOffsetMs,
  normalizeTtlMs,
} from '../../lib/host/clock.js'
import { bj, createFakeTimers, flush } from './helpers.mjs'

const FRI = '2026-10-09'

test('formatBeijing renders Beijing wall-clock text regardless of the host time zone', () => {
  assert.equal(formatBeijing(bj(FRI, '18:08:06')), '2026-10-09 18:08:06')
  assert.equal(formatBeijing(bj(FRI, '00:00:00')), '2026-10-09 00:00:00')
  assert.equal(formatBeijing(bj(FRI, '09:00:00')), '2026-10-09 09:00:00')
  assert.equal(formatBeijing(bj('2026-01-05', '23:59:59')), '2026-01-05 23:59:59')
})

test('normalizeOffsetMs accepts only integers or an explicit clear', () => {
  assert.equal(normalizeOffsetMs(null), null)
  assert.equal(normalizeOffsetMs(undefined), null)
  assert.equal(normalizeOffsetMs(0), 0)
  assert.equal(normalizeOffsetMs(-3_600_000), -3_600_000)
  assert.equal(normalizeOffsetMs(1.5), null)
  assert.equal(normalizeOffsetMs('1000'), null)
  assert.equal(normalizeOffsetMs(Number.NaN), null)
})

test('normalizeTtlMs defaults, validates, and rejects non-positive values', () => {
  assert.equal(normalizeTtlMs(undefined), DEFAULT_CLOCK_TTL_MS)
  assert.equal(normalizeTtlMs(null), DEFAULT_CLOCK_TTL_MS)
  assert.equal(normalizeTtlMs(1000), 1000)
  assert.equal(normalizeTtlMs(0), null)
  assert.equal(normalizeTtlMs(-5), null)
  assert.equal(normalizeTtlMs(1.5), null)
  assert.equal(normalizeTtlMs('1000'), null)
})

test('allowClockOverrideFromEnv disables only on DSH_PEAK_HOURS_ALLOW_CLOCK=0', () => {
  assert.equal(allowClockOverrideFromEnv({}), true)
  assert.equal(allowClockOverrideFromEnv({ DSH_PEAK_HOURS_ALLOW_CLOCK: '1' }), true)
  assert.equal(allowClockOverrideFromEnv({ DSH_PEAK_HOURS_ALLOW_CLOCK: '0' }), false)
  assert.equal(allowClockOverrideFromEnv(undefined), true)
})

test('the clock applies and clears its offset', () => {
  const timers = createFakeTimers(bj(FRI, '10:00:00'))
  const clock = createClock({ readNow: () => timers.now(), schedule: timers.schedule })
  assert.equal(clock.offsetMs, null)
  assert.equal(clock.now(), bj(FRI, '10:00:00'))
  assert.equal(clock.override, null)

  clock.setOffsetMs(3_600_000, { ttlMs: 60_000 })
  assert.equal(clock.now(), bj(FRI, '11:00:00'))
  assert.deepEqual(clock.override, { offsetMs: 3_600_000, expiresAt: bj(FRI, '10:01:00'), ttlMs: 60_000 })

  clock.setOffsetMs(null)
  assert.equal(clock.offsetMs, null)
  assert.equal(clock.now(), bj(FRI, '10:00:00'))
  assert.equal(clock.override, null)
  assert.equal(timers.liveTimerCount, 0, 'clearing cancels the TTL timer')
})

test('the override expires by itself, clears, and reports once', async () => {
  const timers = createFakeTimers(bj(FRI, '10:00:00'))
  const expiries = []
  const clock = createClock({
    readNow: () => timers.now(),
    schedule: timers.schedule,
    onExpire: (event) => expiries.push(event),
  })
  clock.setOffsetMs(-7_200_000, { ttlMs: 5000 })
  assert.equal(clock.now(), bj(FRI, '08:00:00'))
  assert.equal(timers.liveTimerCount, 1)
  assert.deepEqual(clock.override, { offsetMs: -7_200_000, expiresAt: bj(FRI, '10:00:05'), ttlMs: 5000 })

  timers.advanceTo(bj(FRI, '10:00:04'))
  await flush()
  assert.equal(clock.offsetMs, -7_200_000, 'still active before the TTL')

  timers.advanceTo(bj(FRI, '10:00:05'))
  await flush()
  assert.equal(clock.offsetMs, null, 'TTL clears the override by itself')
  assert.equal(clock.override, null)
  assert.equal(clock.now(), bj(FRI, '10:00:05'))
  assert.deepEqual(expiries, [{ reason: 'ttl' }])
  assert.equal(timers.liveTimerCount, 0)
})

test('re-setting the override re-arms the TTL and clearing cancels it', () => {
  const timers = createFakeTimers(bj(FRI, '10:00:00'))
  const clock = createClock({ readNow: () => timers.now(), schedule: timers.schedule })
  clock.setOffsetMs(1000, { ttlMs: 60_000 })
  const first = timers.liveTimers[0]
  clock.setOffsetMs(2000, { ttlMs: 30_000 })
  assert.equal(timers.liveTimerCount, 1, 'never more than one TTL timer')
  assert.notEqual(timers.liveTimers[0], first)
  assert.equal(clock.override.ttlMs, 30_000)
  clock.setOffsetMs(null)
  assert.equal(timers.liveTimerCount, 0)
})

test('an invalid TTL is rejected before any state changes', () => {
  const timers = createFakeTimers(bj(FRI, '10:00:00'))
  const clock = createClock({ readNow: () => timers.now(), schedule: timers.schedule })
  assert.throws(() => clock.setOffsetMs(1000, { ttlMs: 0 }), RangeError)
  assert.equal(clock.offsetMs, null)
  assert.equal(timers.liveTimerCount, 0)
})

test('dispose clears the override and its timer', () => {
  const timers = createFakeTimers(bj(FRI, '10:00:00'))
  const clock = createClock({ readNow: () => timers.now(), schedule: timers.schedule })
  clock.setOffsetMs(1000, { ttlMs: 60_000 })
  clock.dispose()
  assert.equal(clock.offsetMs, null)
  assert.equal(clock.override, null)
  assert.equal(timers.liveTimerCount, 0)
})
