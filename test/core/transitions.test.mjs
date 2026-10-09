import test from 'node:test'
import assert from 'node:assert/strict'

import { classify, nextTransition } from '../../lib/core/schedule.js'
import { HOLIDAY_YEARS } from '../../lib/core/holidays.js'
import * as helpers from './_helpers.mjs'
import { bj, fmt } from './_helpers.mjs'

/**
 * `nextTransition` cases, each with the exact expected instant. Covers SPEC.md §3.4: the middle
 * of a holiday, the middle of a weekend, and the evening of a long holiday's last day.
 */
const CASES = [
  { name: 'before the morning window', from: bj(2026, 3, 11, 8, 0, 0), at: bj(2026, 3, 11, 9, 0, 0), to: 'peak' },
  { name: 'one ms before 09:00', from: bj(2026, 3, 11, 8, 59, 59, 999), at: bj(2026, 3, 11, 9, 0, 0), to: 'peak' },
  { name: 'exactly 09:00 (boundary is not "after" itself)', from: bj(2026, 3, 11, 9, 0, 0), at: bj(2026, 3, 11, 12, 0, 0), to: 'idle' },
  { name: 'one ms after 09:00', from: bj(2026, 3, 11, 9, 0, 0, 1), at: bj(2026, 3, 11, 12, 0, 0), to: 'idle' },
  { name: 'inside the morning window', from: bj(2026, 3, 11, 9, 30, 0), at: bj(2026, 3, 11, 12, 0, 0), to: 'idle' },
  { name: 'one ms before the lunch break', from: bj(2026, 3, 11, 11, 59, 59, 999), at: bj(2026, 3, 11, 12, 0, 0), to: 'idle' },
  { name: 'exactly 12:00 (lunch break)', from: bj(2026, 3, 11, 12, 0, 0), at: bj(2026, 3, 11, 14, 0, 0), to: 'peak' },
  { name: 'inside the lunch break', from: bj(2026, 3, 11, 12, 30, 0), at: bj(2026, 3, 11, 14, 0, 0), to: 'peak' },
  { name: 'one ms before the afternoon window', from: bj(2026, 3, 11, 13, 59, 59, 999), at: bj(2026, 3, 11, 14, 0, 0), to: 'peak' },
  { name: 'afternoon window starts', from: bj(2026, 3, 11, 14, 0, 0), at: bj(2026, 3, 11, 18, 0, 0), to: 'idle' },
  { name: 'one ms before the evening edge', from: bj(2026, 3, 11, 17, 59, 59, 999), at: bj(2026, 3, 11, 18, 0, 0), to: 'idle' },
  { name: 'evening rolls into the next workday morning', from: bj(2026, 3, 11, 18, 0, 0), at: bj(2026, 3, 12, 9, 0, 0), to: 'peak' },
  { name: 'late evening', from: bj(2026, 3, 11, 23, 59, 59, 999), at: bj(2026, 3, 12, 9, 0, 0), to: 'peak' },
  { name: 'Friday evening rolls over the weekend', from: bj(2026, 3, 13, 18, 0, 0), at: bj(2026, 3, 16, 9, 0, 0), to: 'peak' },
  { name: 'middle of a weekend (Saturday)', from: bj(2026, 3, 14, 10, 0, 0), at: bj(2026, 3, 16, 9, 0, 0), to: 'peak' },
  { name: 'middle of a weekend (Sunday noon)', from: bj(2026, 3, 15, 12, 0, 0), at: bj(2026, 3, 16, 9, 0, 0), to: 'peak' },
  { name: 'Sunday night', from: bj(2026, 3, 15, 23, 59, 0), at: bj(2026, 3, 16, 9, 0, 0), to: 'peak' },

  // 2026 国庆节 10/1 (Thu) - 10/7 (Wed)
  { name: '国庆节 first morning is idle like the rest of the holiday', from: bj(2026, 10, 1, 8, 0, 0), at: bj(2026, 10, 8, 9, 0, 0), to: 'peak' },
  { name: 'middle of a holiday (Monday of 国庆节)', from: bj(2026, 10, 5, 10, 0, 0), at: bj(2026, 10, 8, 9, 0, 0), to: 'peak' },
  { name: 'last day of a long holiday, evening', from: bj(2026, 10, 7, 18, 0, 0), at: bj(2026, 10, 8, 9, 0, 0), to: 'peak' },
  { name: 'last day of a long holiday, late night', from: bj(2026, 10, 7, 23, 59, 59, 999), at: bj(2026, 10, 8, 9, 0, 0), to: 'peak' },
  { name: 'last day of a long holiday, morning', from: bj(2026, 10, 7, 9, 0, 0), at: bj(2026, 10, 8, 9, 0, 0), to: 'peak' },

  // 2025 国庆节+中秋节 10/1 - 10/8 (the 8-day merged block)
  { name: '2025 merged holiday: eve of the block', from: bj(2025, 9, 30, 18, 0, 0), at: bj(2025, 10, 9, 9, 0, 0), to: 'peak' },
  { name: '2025 merged holiday: middle', from: bj(2025, 10, 5, 10, 0, 0), at: bj(2025, 10, 9, 9, 0, 0), to: 'peak' },
  { name: '2025 merged holiday: last evening', from: bj(2025, 10, 8, 18, 0, 0), at: bj(2025, 10, 9, 9, 0, 0), to: 'peak' },

  // 2026 春节 2/15 - 2/23 (9 days, preceded by the 2/14 make-up Saturday)
  { name: '2026 春节: middle of the block', from: bj(2026, 2, 18, 10, 0, 0), at: bj(2026, 2, 24, 9, 0, 0), to: 'peak' },
  { name: '2026 春节: eve (Friday) rolls through the make-up Saturday', from: bj(2026, 2, 13, 18, 0, 0), at: bj(2026, 2, 24, 9, 0, 0), to: 'peak' },
  { name: '2026 春节: make-up Saturday itself', from: bj(2026, 2, 14, 9, 0, 0), at: bj(2026, 2, 24, 9, 0, 0), to: 'peak' },
  { name: '2026 春节: last day evening', from: bj(2026, 2, 23, 18, 0, 0), at: bj(2026, 2, 24, 9, 0, 0), to: 'peak' },

  // 2026 中秋节 9/25 - 9/27, separate from 国庆节 10/1 - 10/7
  { name: '2026 中秋节: morning of the block', from: bj(2026, 9, 25, 9, 0, 0), at: bj(2026, 9, 28, 9, 0, 0), to: 'peak' },
  { name: '2026 中秋节: Sunday evening', from: bj(2026, 9, 27, 20, 0, 0), at: bj(2026, 9, 28, 9, 0, 0), to: 'peak' },
  { name: '2026 国庆节 and 中秋节 are separate blocks (9/28-9/30 are workdays)', from: bj(2026, 9, 28, 12, 0, 0), at: bj(2026, 9, 28, 14, 0, 0), to: 'peak' },

  // Make-up workdays
  { name: '2026-10-10 make-up Saturday stays idle', from: bj(2026, 10, 10, 9, 0, 0), at: bj(2026, 10, 12, 9, 0, 0), to: 'peak' },
  { name: '2026-10-10 make-up Saturday, inside the would-be window', from: bj(2026, 10, 10, 10, 30, 0), at: bj(2026, 10, 12, 9, 0, 0), to: 'peak' },
  { name: '2026-09-20 make-up Sunday stays idle', from: bj(2026, 9, 20, 10, 0, 0), at: bj(2026, 9, 21, 9, 0, 0), to: 'peak' },
  { name: 'weekend containing a make-up Sunday', from: bj(2026, 9, 18, 18, 0, 0), at: bj(2026, 9, 21, 9, 0, 0), to: 'peak' },
  { name: 'Monday after a make-up weekend is a normal workday', from: bj(2026, 9, 21, 12, 0, 0), at: bj(2026, 9, 21, 14, 0, 0), to: 'peak' },

  // Year rollover: 2025-12-31 (Wed) -> 元旦 2026-01-01..03 -> week-end 01-04 -> Monday 01-05
  { name: 'year rollover through 元旦', from: bj(2025, 12, 31, 18, 0, 0), at: bj(2026, 1, 5, 9, 0, 0), to: 'peak' },
  { name: '元旦 first day', from: bj(2026, 1, 1, 10, 0, 0), at: bj(2026, 1, 5, 9, 0, 0), to: 'peak' },
  { name: '元旦 Saturday', from: bj(2026, 1, 3, 12, 0, 0), at: bj(2026, 1, 5, 9, 0, 0), to: 'peak' },
  { name: '元旦 final weekend day', from: bj(2026, 1, 4, 20, 0, 0), at: bj(2026, 1, 5, 9, 0, 0), to: 'peak' },
  { name: '2025 last workday afternoon', from: bj(2025, 12, 31, 14, 30, 0), at: bj(2025, 12, 31, 18, 0, 0), to: 'idle' },

  // Uncovered years: a weekday window is peak, so transitions are ordinary
  { name: '2027 (no dataset) before the morning window', from: bj(2027, 3, 10, 8, 0, 0), at: bj(2027, 3, 10, 9, 0, 0), to: 'peak' },
  { name: '2027 (no dataset) at noon', from: bj(2027, 3, 10, 9, 30, 0), at: bj(2027, 3, 10, 12, 0, 0), to: 'idle' },
  { name: '2027-10-01 is treated as an ordinary Friday', from: bj(2027, 10, 1, 9, 30, 0), at: bj(2027, 10, 1, 12, 0, 0), to: 'idle' },
  { name: '2030 (no dataset) weekend', from: bj(2030, 6, 1, 10, 0, 0), at: bj(2030, 6, 3, 9, 0, 0), to: 'peak' },
]

test('nextTransition returns the exact next phase boundary', () => {
  for (const c of CASES) {
    const result = nextTransition(c.from)
    assert.equal(result.at, c.at, `${c.name}: from ${fmt(c.from)} got ${fmt(result.at)}`)
    assert.equal(result.to, c.to, `${c.name}: to`)
  }
})

test('every case satisfies the strict contract', () => {
  for (const c of CASES) {
    const before = classify(c.from)
    const result = nextTransition(c.from)
    assert.ok(result.at > c.from, `${c.name}: at must be strictly greater than the input`)
    assert.equal(result.at % 60000, 0, `${c.name}: at must be minute aligned`)
    assert.equal(classify(result.at).phase, result.to, `${c.name}: phase at `)
    assert.notEqual(classify(result.at - 1).phase, result.to, `${c.name}: phase just before`)
    assert.notEqual(result.to, before.phase, `${c.name}: the phase must actually change`)
    assert.ok(['peak', 'idle'].includes(result.to), `${c.name}: to must be a phase`)
  }
})

test('walking a year of transitions is strictly increasing and always flips the phase', () => {
  const { BJ, DAY, key } = helpers
  let cursor = bj(2026, 1, 1, 0, 0, 0)
  const end = bj(2027, 1, 1, 0, 0, 0)
  let count = 0
  let phase = classify(cursor).phase
  for (;;) {
    const next = nextTransition(cursor)
    if (next.at >= end) break
    assert.ok(next.at > cursor)
    assert.equal(next.to === 'peak' ? 'idle' : 'peak', phase)
    assert.equal(classify(next.at - 1).phase, phase)
    phase = next.to
    cursor = next.at
    count += 1
  }

  // Independent count: every 2026 workday contributes exactly its four window edges.
  let expected = 0
  for (let dayIndex = 0; dayIndex < 365; dayIndex += 1) {
    const at = bj(2026, 1, 1, 0, 0, 0) + dayIndex * DAY
    const weekday = new Date(at + BJ).getUTCDay()
    if (weekday >= 1 && weekday <= 5 && !HOLIDAY_YEARS[2026][key(at)]) expected += 4
  }
  assert.equal(count, expected)
  assert.ok(expected > 900, `sanity: 2026 has ${expected} phase changes`)
})
