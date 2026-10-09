import test from 'node:test'
import assert from 'node:assert/strict'

import { classify, nextTransition } from '../../lib/core/schedule.js'
import { BOUNDARY_TIMES, bj, fmt, referencePhase } from './_helpers.mjs'

const IDLE_OFF = ['idle', 'off-hours']
const PEAK = ['peak', 'peak']
const IDLE_WEEKEND = ['idle', 'weekend']
const IDLE_HOLIDAY = ['idle', 'holiday']

/**
 * SPEC.md §3.2 boundary matrix: the eight peak edges × ordinary Wednesday, Saturday, Sunday,
 * a statutory holiday on a weekday, and the make-up workdays that must stay idle.
 */
const SCENARIOS = [
  {
    name: 'ordinary Wednesday 2026-03-11',
    date: [2026, 3, 11],
    weekday: 3,
    expected: [IDLE_OFF, PEAK, PEAK, IDLE_OFF, IDLE_OFF, PEAK, PEAK, IDLE_OFF],
  },
  {
    name: 'Saturday 2026-03-14',
    date: [2026, 3, 14],
    weekday: 6,
    expected: Array(8).fill(IDLE_WEEKEND),
  },
  {
    name: 'Sunday 2026-03-15',
    date: [2026, 3, 15],
    weekday: 0,
    expected: Array(8).fill(IDLE_WEEKEND),
  },
  {
    // 国庆节 10/1-10/7; 10/5 is a Monday inside the block.
    name: 'statutory holiday weekday 2026-10-05',
    date: [2026, 10, 5],
    weekday: 1,
    expected: Array(8).fill(IDLE_HOLIDAY),
  },
  {
    // 调休上班周六: the notice sends 10/10 to work, SPEC.md §1 keeps it idle.
    name: 'make-up workday Saturday 2026-10-10',
    date: [2026, 10, 10],
    weekday: 6,
    expected: Array(8).fill(IDLE_WEEKEND),
  },
  {
    // 调休上班周日 (中秋): 9/20 is a workday per the notice, still idle here.
    name: 'make-up workday Sunday 2026-09-20',
    date: [2026, 9, 20],
    weekday: 0,
    expected: Array(8).fill(IDLE_WEEKEND),
  },
  {
    // Saturday inside 国庆节: idle either way, but the label must be `holiday`.
    name: 'holiday Saturday 2026-10-03',
    date: [2026, 10, 3],
    weekday: 6,
    expected: Array(8).fill(IDLE_HOLIDAY),
  },
]

for (const scenario of SCENARIOS) {
  test(`boundary matrix — ${scenario.name}`, () => {
    const [y, m, d] = scenario.date
    BOUNDARY_TIMES.forEach((time, index) => {
      const at = bj(y, m, d, time.hour, time.minute, time.second, time.ms)
      const out = classify(at)
      assert.equal(out.weekday, scenario.weekday, `${time.label} weekday`)
      assert.equal(out.dateKey, `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
      assert.deepEqual(
        [out.phase, out.reason],
        scenario.expected[index],
        `${scenario.name} @ ${time.label} (${fmt(at)})`,
      )
    })
  })
}

test('peak edges are exact to the millisecond on a workday', () => {
  const edges = [
    { at: bj(2026, 3, 11, 9, 0, 0), from: 'idle', to: 'peak' },
    { at: bj(2026, 3, 11, 12, 0, 0), from: 'peak', to: 'idle' },
    { at: bj(2026, 3, 11, 14, 0, 0), from: 'idle', to: 'peak' },
    { at: bj(2026, 3, 11, 18, 0, 0), from: 'peak', to: 'idle' },
  ]
  for (const edge of edges) {
    assert.equal(classify(edge.at - 1).phase, edge.from, `${fmt(edge.at - 1)}`)
    assert.equal(classify(edge.at).phase, edge.to, `${fmt(edge.at)}`)
    assert.equal(classify(edge.at + 1).phase, edge.to, `${fmt(edge.at + 1)}`)
    const transition = nextTransition(edge.at - 1)
    assert.equal(transition.at, edge.at)
    assert.equal(transition.to, edge.to)
  }
})

test('weekend and holiday days have no internal transition at all', () => {
  const days = [
    bj(2026, 3, 14, 0, 0, 0), // Saturday
    bj(2026, 3, 15, 0, 0, 0), // Sunday
    bj(2026, 10, 5, 0, 0, 0), // holiday Monday
    bj(2026, 10, 10, 0, 0, 0), // make-up workday Saturday
    bj(2026, 9, 20, 0, 0, 0), // make-up workday Sunday
  ]
  for (const midnight of days) {
    const transition = nextTransition(midnight)
    assert.ok(transition.at >= midnight + 86400000, `${fmt(midnight)} must stay idle all day`)
    for (const time of BOUNDARY_TIMES) {
      assert.equal(classify(midnight + (time.hour * 60 + time.minute) * 60000).phase, 'idle')
    }
  }
})

test('every minute of a short span matches the independent reference model', () => {
  const start = bj(2026, 3, 11, 0, 0, 0)
  for (let i = 0; i < 3 * 1440; i += 1) {
    const at = start + i * 60000
    assert.equal(classify(at).phase, referencePhase(at), fmt(at))
  }
})
