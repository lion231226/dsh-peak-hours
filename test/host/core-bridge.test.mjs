/**
 * Schedule-core bridge: the degraded fallback behaves like SPEC §1 for the
 * weekday/window rules, and `loadCore()` never throws while `lib/core` may or
 * may not be present.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { fallbackClassify, fallbackNextTransition, loadCore } from '../../lib/host/core-bridge.js'
import { bj } from './helpers.mjs'

const FRI = '2026-10-09'
const SAT = '2026-10-10'
const MON = '2026-10-12'

test('the fallback classifier follows the SPEC windows and weekday rule', () => {
  const cases = [
    [FRI, '00:00:00', 'idle', 'off-hours'],
    [FRI, '08:59:59', 'idle', 'off-hours'],
    [FRI, '09:00:00', 'peak', 'peak'],
    [FRI, '11:59:59', 'peak', 'peak'],
    [FRI, '12:00:00', 'idle', 'off-hours'],
    [FRI, '14:00:00', 'peak', 'peak'],
    [FRI, '17:59:59', 'peak', 'peak'],
    [FRI, '18:00:00', 'idle', 'off-hours'],
    [SAT, '10:00:00', 'idle', 'weekend'],
    ['2026-10-11', '10:00:00', 'idle', 'weekend'],
    [MON, '09:00:00', 'peak', 'peak'],
  ]
  for (const [dateKey, time, phase, reason] of cases) {
    const info = fallbackClassify(bj(dateKey, time))
    assert.equal(info.phase, phase, `${dateKey} ${time} phase`)
    assert.equal(info.reason, reason, `${dateKey} ${time} reason`)
  }
})

test('the fallback is honest about not knowing holidays', () => {
  const info = fallbackClassify(bj(FRI, '10:00:00'))
  assert.equal(info.holiday, null)
  assert.equal(info.holidayCoverage, 'unknown')
  assert.equal(info.unknownHolidayYear, 2026)
  assert.equal(info.dateKey, FRI)
  assert.equal(info.minuteOfDay, 600)
  assert.equal(info.weekday, 5)
})

test('the fallback transition search lands on the exact boundary', () => {
  assert.deepEqual(fallbackNextTransition(bj(FRI, '08:59:59')), { at: bj(FRI, '09:00:00'), to: 'peak' })
  assert.deepEqual(fallbackNextTransition(bj(FRI, '11:59:59')), { at: bj(FRI, '12:00:00'), to: 'idle' })
  assert.deepEqual(fallbackNextTransition(bj(FRI, '17:59:59')), { at: bj(FRI, '18:00:00'), to: 'idle' })
  assert.deepEqual(fallbackNextTransition(bj(FRI, '18:00:00')), { at: bj(MON, '09:00:00'), to: 'peak' })
  assert.deepEqual(fallbackNextTransition(bj(SAT, '10:00:00')), { at: bj(MON, '09:00:00'), to: 'peak' })
  // Strictly forward, and exactly on a phase change.
  for (const [dateKey, time] of [
    [FRI, '09:00:00'],
    [FRI, '12:30:00'],
    [SAT, '23:59:59'],
    [MON, '14:30:00'],
  ]) {
    const from = bj(dateKey, time)
    const next = fallbackNextTransition(from)
    assert.ok(next.at > from, 'the transition is strictly in the future')
    assert.notEqual(fallbackClassify(next.at).phase, fallbackClassify(from).phase)
    assert.equal(fallbackClassify(next.at - 1).phase, fallbackClassify(from).phase)
  }
})

test('loadCore never throws and always yields a usable pair', async () => {
  const warnings = []
  const core = await loadCore({ logger: { warn: (message) => warnings.push(String(message)) } })
  assert.ok(core.source === 'core' || core.source === 'fallback', `unexpected core source ${core.source}`)
  assert.equal(typeof core.classify, 'function')
  assert.equal(typeof core.nextTransition, 'function')

  const now = bj(FRI, '10:00:00')
  const info = core.classify(now)
  assert.ok(info.phase === 'peak' || info.phase === 'idle')
  assert.ok(['peak', 'off-hours', 'weekend', 'holiday'].includes(info.reason))
  const next = core.nextTransition(now)
  assert.ok(Number.isFinite(next.at) && next.at > now, 'the next transition is strictly in the future')
  assert.ok(next.to === 'peak' || next.to === 'idle')

  if (core.source === 'fallback') {
    assert.ok(warnings.length >= 1, 'the degraded path is announced')
    assert.match(warnings[0], /schedule core unavailable/)
  } else {
    assert.deepEqual(warnings, [])
  }
})

test('loadCore without a logger still works', async () => {
  const core = await loadCore()
  assert.equal(typeof core.classify, 'function')
})

test('when lib/core is present, the real core and the fallback agree on ordinary weekdays', async (t) => {
  let real
  try {
    real = await import('../../lib/core/index.js')
  } catch {
    t.skip('lib/core is not present yet')
    return
  }
  for (const time of ['08:59:59', '09:00:00', '11:59:59', '12:00:00', '14:00:00', '17:59:59', '18:00:00']) {
    const at = bj(FRI, time)
    assert.equal(
      real.classify(at).phase,
      fallbackClassify(at).phase,
      `core and fallback must agree at ${FRI} ${time} (a non-holiday Friday)`,
    )
  }
  for (const [dateKey, time] of [
    [FRI, '08:59:59'],
    [FRI, '11:00:00'],
    [FRI, '17:00:00'],
  ]) {
    const at = bj(dateKey, time)
    assert.deepEqual(real.nextTransition(at), fallbackNextTransition(at), `nextTransition at ${dateKey} ${time}`)
  }
})
