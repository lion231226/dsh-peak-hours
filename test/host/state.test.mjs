/**
 * State snapshot contract (SPEC §2.3) — the field set is frozen.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { PEAK_WINDOWS_TEXT, TIME_ZONE, buildState, stateEnvelope } from '../../lib/host/state.js'
import { bj, createFakeSchedule } from './helpers.mjs'

const FRI = '2026-10-09'
const SAT = '2026-10-10'
const schedule = createFakeSchedule({ holidays: ['2026-10-01'] })

/** Build a state at one instant. */
function stateAt(dateKey, time, overrides = {}) {
  const now = bj(dateKey, time)
  return buildState({
    mode: 'always',
    now,
    info: schedule.classify(now),
    next: schedule.nextTransition(now),
    ...overrides,
  })
}

test('the state object carries exactly the frozen SPEC §2.3 field set', () => {
  const state = stateAt(FRI, '09:30:00')
  assert.deepEqual(Object.keys(state).sort(), [
    'clockOverride',
    'config',
    'holidayCoverage',
    'holidayToday',
    'mode',
    'msUntilTransition',
    'nextPhase',
    'nextTransitionAt',
    'nextTransitionText',
    'now',
    'nowText',
    'paused',
    'peakWindows',
    'phase',
    'reason',
    'timeZone',
    'unknownHolidayYear',
    'waitingTasks',
  ])
  assert.deepEqual(Object.keys(state.config), ['allowClockOverride'])
})

test('peak state inside the morning window', () => {
  const now = bj(FRI, '09:30:00')
  const state = stateAt(FRI, '09:30:00', { mode: 'idle-only', waitingTasks: 2 })
  assert.equal(state.mode, 'idle-only')
  assert.equal(state.phase, 'peak')
  assert.equal(state.reason, 'peak')
  assert.equal(state.now, now)
  assert.equal(state.nowText, '2026-10-09 09:30:00')
  assert.equal(state.nextTransitionAt, bj(FRI, '12:00:00'))
  assert.equal(state.nextTransitionText, '2026-10-09 12:00:00')
  assert.equal(state.nextPhase, 'idle')
  assert.equal(state.msUntilTransition, 2.5 * 3600 * 1000)
  assert.equal(state.paused, true)
  assert.equal(state.waitingTasks, 2)
  assert.equal(state.holidayToday, null)
  assert.equal(state.holidayCoverage, 'known')
  assert.equal(state.unknownHolidayYear, null)
  assert.equal(state.timeZone, TIME_ZONE)
  assert.deepEqual(state.peakWindows, [...PEAK_WINDOWS_TEXT])
  assert.equal(state.clockOverride, null)
  assert.deepEqual(state.config, { allowClockOverride: true })
})

test('paused is true only for idle-only during peak', () => {
  assert.equal(stateAt(FRI, '09:30:00', { mode: 'idle-only' }).paused, true)
  assert.equal(stateAt(FRI, '09:30:00', { mode: 'always' }).paused, false)
  assert.equal(stateAt(FRI, '12:30:00', { mode: 'idle-only' }).paused, false)
  assert.equal(stateAt(SAT, '10:00:00', { mode: 'idle-only' }).paused, false)
})

test('idle reasons and the next peak transition', () => {
  const lunch = stateAt(FRI, '12:30:00')
  assert.equal(lunch.phase, 'idle')
  assert.equal(lunch.reason, 'off-hours')
  assert.equal(lunch.nextPhase, 'peak')
  assert.equal(lunch.nextTransitionText, '2026-10-09 14:00:00')

  const weekend = stateAt(SAT, '10:00:00')
  assert.equal(weekend.phase, 'idle')
  assert.equal(weekend.reason, 'weekend')
  assert.equal(weekend.nextTransitionText, '2026-10-12 09:00:00')

  const holiday = stateAt('2026-10-01', '10:00:00')
  assert.equal(holiday.phase, 'idle')
  assert.equal(holiday.reason, 'holiday')
  assert.deepEqual(holiday.holidayToday, { dateKey: '2026-10-01', name: 'fake holiday' })

  const evening = stateAt(FRI, '18:08:06')
  assert.equal(evening.phase, 'idle')
  assert.equal(evening.reason, 'off-hours')
  assert.equal(evening.nextTransitionText, '2026-10-12 09:00:00')
  assert.equal(evening.msUntilTransition, bj('2026-10-12', '09:00:00') - bj(FRI, '18:08:06'))
})

test('unknown holiday coverage is surfaced for the UI warning', () => {
  const now = bj(FRI, '09:30:00')
  const state = buildState({
    mode: 'always',
    now,
    info: {
      phase: 'peak',
      reason: 'peak',
      dateKey: '2026-10-09',
      minuteOfDay: 570,
      weekday: 5,
      holiday: null,
      holidayCoverage: 'unknown',
      unknownHolidayYear: 2026,
    },
    next: { at: bj(FRI, '12:00:00'), to: 'idle' },
  })
  assert.equal(state.holidayCoverage, 'unknown')
  assert.equal(state.unknownHolidayYear, 2026)
})

test('clockOverride echoes the TTL fields, or null', () => {
  const override = { offsetMs: -3_600_000, expiresAt: bj(FRI, '10:10:00'), ttlMs: 600_000 }
  const state = stateAt(FRI, '09:30:00', { clockOverride: override })
  assert.deepEqual(state.clockOverride, override)

  assert.equal(stateAt(FRI, '09:30:00', { clockOverride: null }).clockOverride, null)
  // A malformed override degrades to null instead of leaking junk to the client.
  assert.equal(stateAt(FRI, '09:30:00', { clockOverride: { offsetMs: 'x' } }).clockOverride, null)
  assert.equal(
    stateAt(FRI, '09:30:00', { clockOverride: { offsetMs: 0, expiresAt: 1, ttlMs: 2 } }).clockOverride.offsetMs,
    0,
    'an explicit zero offset is still a visible override',
  )
})

test('a broken core result degrades to a well-formed idle state', () => {
  const state = buildState({ mode: 'idle-only', now: bj(FRI, '09:30:00'), info: undefined, next: undefined })
  assert.equal(state.phase, 'idle')
  assert.equal(state.reason, 'off-hours')
  assert.equal(state.paused, false)
  assert.equal(state.nextTransitionAt, bj(FRI, '09:30:00'))
  assert.equal(state.msUntilTransition, 0)
  assert.equal(state.nextPhase, 'peak')
  assert.equal(state.mode, 'idle-only')
  assert.equal(buildState({ mode: 'nonsense', now: 0, info: null, next: null }).mode, 'always')
})

test('waitingTasks never leaks a negative or fractional count', () => {
  assert.equal(stateAt(FRI, '09:30:00', { waitingTasks: -2 }).waitingTasks, 0)
  assert.equal(stateAt(FRI, '09:30:00', { waitingTasks: 1.5 }).waitingTasks, 0)
  assert.equal(stateAt(FRI, '09:30:00', { waitingTasks: 4 }).waitingTasks, 4)
})

test('stateEnvelope wraps the state exactly once', () => {
  const state = stateAt(FRI, '09:30:00')
  const envelope = stateEnvelope(state)
  assert.deepEqual(Object.keys(envelope).sort(), ['ok', 'state'])
  assert.equal(envelope.ok, true)
  assert.equal(envelope.state, state)
})
