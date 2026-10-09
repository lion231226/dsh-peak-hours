import test from 'node:test'
import assert from 'node:assert/strict'

import * as core from '../../lib/core/index.js'
import {
  BJ_OFFSET_MS,
  PEAK_WINDOWS,
  bjDateKey,
  bjMinuteOfDay,
  bjWeekday,
  classify,
  formatBeijing,
  isPeak,
  nextTransition,
  phaseSegments,
} from '../../lib/core/schedule.js'
import { createCalendar } from '../../lib/core/holidays.js'
import { bj, fmt } from './_helpers.mjs'

const CLASSIFY_FIELDS = [
  'phase',
  'reason',
  'dateKey',
  'minuteOfDay',
  'weekday',
  'holiday',
  'holidayCoverage',
  'unknownHolidayYear',
]

test('frozen constants', () => {
  assert.equal(BJ_OFFSET_MS, 28800000)
  assert.deepEqual(PEAK_WINDOWS, [
    [540, 720],
    [840, 1080],
  ])
  assert.equal(BJ_OFFSET_MS, 8 * 3600 * 1000)
})

test('index.js re-exports every frozen name', () => {
  for (const name of [
    'BJ_OFFSET_MS',
    'PEAK_WINDOWS',
    'classify',
    'isPeak',
    'nextTransition',
    'phaseSegments',
    'HOLIDAY_YEARS',
    'HOLIDAY_SOURCE',
    'createCalendar',
    'defaultCalendar',
    'loadCalendarFile',
  ]) {
    assert.ok(name in core, `lib/core/index.js must export ${name}`)
    assert.notEqual(core[name], undefined)
  }
  assert.equal(typeof core.classify, 'function')
  assert.equal(typeof core.loadCalendarFile, 'function')
})

test('classify returns exactly the frozen fields with the frozen types', () => {
  const cases = [
    bj(2026, 3, 11, 10, 0, 0), // ordinary Wednesday, peak
    bj(2026, 3, 14, 10, 0, 0), // Saturday
    bj(2026, 10, 5, 10, 0, 0), // holiday Monday
    bj(2027, 6, 2, 10, 0, 0), // uncovered year
  ]
  for (const at of cases) {
    const out = classify(at)
    assert.deepEqual(Object.keys(out).sort(), [...CLASSIFY_FIELDS].sort())
    assert.ok(out.phase === 'peak' || out.phase === 'idle')
    assert.ok(['peak', 'off-hours', 'weekend', 'holiday'].includes(out.reason))
    assert.match(out.dateKey, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(Number.isInteger(out.minuteOfDay) && out.minuteOfDay >= 0 && out.minuteOfDay < 1440)
    assert.ok(Number.isInteger(out.weekday) && out.weekday >= 0 && out.weekday <= 6)
    assert.ok(out.holiday === null || (typeof out.holiday.dateKey === 'string' && typeof out.holiday.name === 'string'))
    assert.ok(out.holidayCoverage === 'known' || out.holidayCoverage === 'unknown')
    assert.ok(out.unknownHolidayYear === null || Number.isInteger(out.unknownHolidayYear))
  }
})

test('classify reports the Beijing date/time fields', () => {
  const at = bj(2026, 3, 11, 14, 30, 45, 123)
  const out = classify(at)
  assert.equal(out.dateKey, '2026-03-11')
  assert.equal(out.minuteOfDay, 14 * 60 + 30)
  assert.equal(out.weekday, 3) // Wednesday
  assert.equal(out.phase, 'peak')
  assert.equal(out.holiday, null)
  assert.equal(out.holidayCoverage, 'known')
  assert.equal(out.unknownHolidayYear, null)

  const late = classify(bj(2026, 3, 11, 23, 59, 59, 999))
  assert.equal(late.dateKey, '2026-03-11')
  assert.equal(late.minuteOfDay, 1439)
  assert.equal(late.reason, 'off-hours')
})

test('bj* helpers agree with the classify fields and with formatBeijing', () => {
  const samples = [
    bj(2025, 1, 1, 0, 0, 0),
    bj(2026, 2, 17, 9, 0, 0),
    bj(2026, 10, 10, 18, 0, 0),
    bj(2027, 12, 31, 23, 59, 59),
  ]
  for (const at of samples) {
    const out = classify(at)
    assert.equal(bjDateKey(at), out.dateKey)
    assert.equal(bjMinuteOfDay(at), out.minuteOfDay)
    assert.equal(bjWeekday(at), out.weekday)
    assert.equal(formatBeijing(at).slice(0, 10), out.dateKey)
  }
  assert.equal(formatBeijing(bj(2026, 3, 11, 9, 5, 7)), '2026-03-11 09:05:07')
  assert.equal(formatBeijing(0), '1970-01-01 08:00:00')
  assert.equal(formatBeijing(Date.UTC(2026, 2, 11, 1, 0, 0)), '2026-03-11 09:00:00')
})

test('unknown calendar coverage never marks a day as holiday', () => {
  const at = bj(2031, 5, 7, 10, 0, 0) // Wednesday, far outside the dataset
  const out = classify(at)
  assert.equal(out.phase, 'peak')
  assert.equal(out.holiday, null)
  assert.equal(out.holidayCoverage, 'unknown')
  assert.equal(out.unknownHolidayYear, 2031)
})

test('isPeak matches classify().phase for a spread of instants', () => {
  for (let h = 0; h < 24; h += 1) {
    for (const day of [9, 10, 11, 12, 13, 14, 15]) {
      const at = bj(2026, 3, day, h, 30, 0)
      assert.equal(isPeak(at), classify(at).phase === 'peak', `2026-03-${day} ${h}:30`)
    }
  }
})

test('non-finite input is rejected loudly instead of producing garbage', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'nope']) {
    assert.throws(() => classify(bad), TypeError)
    assert.throws(() => nextTransition(bad), TypeError)
    assert.throws(() => isPeak(bad), TypeError)
    assert.throws(() => formatBeijing(bad), TypeError)
  }
  assert.throws(() => phaseSegments(0, NaN), TypeError)
  assert.throws(() => phaseSegments(NaN, 0), TypeError)
})

test('nextTransition bails out loudly on a calendar with no peak day at all', () => {
  // Every day of 2024-2044 marked as a holiday: no phase change can ever be found, so the scan
  // must stop with a clear error instead of spinning.
  const extra = {}
  for (let d = Date.UTC(2024, 0, 1); d < Date.UTC(2044, 0, 1); d += 86400000) {
    extra[new Date(d).toISOString().slice(0, 10)] = '永久假'
  }
  const calendar = createCalendar({ extra })
  assert.throws(() => nextTransition(bj(2026, 1, 5, 10, 0, 0), calendar), /no phase change within 10 years/)
  // A calendar with a single ordinary weekday still resolves.
  assert.equal(classify(bj(2026, 1, 5, 10, 0, 0), calendar).reason, 'holiday')
})

test('phaseSegments returns [] for an empty or inverted range', () => {
  assert.deepEqual(phaseSegments(bj(2026, 3, 11, 9, 0, 0), bj(2026, 3, 11, 9, 0, 0)), [])
  assert.deepEqual(phaseSegments(bj(2026, 3, 11, 12, 0, 0), bj(2026, 3, 11, 9, 0, 0)), [])
})

test('phaseSegments on one ordinary Wednesday', () => {
  const segments = phaseSegments(bj(2026, 3, 11, 0, 0, 0), bj(2026, 3, 12, 0, 0, 0))
  assert.deepEqual(
    segments.map((s) => [formatBeijing(s.from).slice(11), formatBeijing(s.to).slice(11), s.phase, s.reason]),
    [
      ['00:00:00', '09:00:00', 'idle', 'off-hours'],
      ['09:00:00', '12:00:00', 'peak', 'peak'],
      ['12:00:00', '14:00:00', 'idle', 'off-hours'],
      ['14:00:00', '18:00:00', 'peak', 'peak'],
      ['18:00:00', '00:00:00', 'idle', 'off-hours'],
    ],
  )
})

test('phaseSegments keeps partial first/last segments exact', () => {
  const from = bj(2026, 3, 11, 9, 30, 0, 500)
  const to = bj(2026, 3, 11, 12, 30, 0, 250)
  const segments = phaseSegments(from, to)
  assert.equal(segments[0].from, from)
  assert.equal(segments[0].phase, 'peak')
  assert.equal(fmt(segments[0].to), '2026-03-11 12:00:00.000')
  assert.equal(segments.at(-1).to, to)
  assert.equal(segments.at(-1).phase, 'idle')
  assert.equal(segments.at(-1).reason, 'off-hours')
  let cursor = from
  for (const segment of segments) {
    assert.equal(segment.from, cursor)
    assert.ok(segment.to > segment.from)
    cursor = segment.to
  }
  assert.equal(cursor, to)
})

test('index.js and schedule.js expose the same functions', () => {
  assert.equal(core.classify, classify)
  assert.equal(core.nextTransition, nextTransition)
  assert.equal(core.phaseSegments, phaseSegments)
  assert.equal(core.formatBeijing, formatBeijing)
})
