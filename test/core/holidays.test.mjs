import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HOLIDAY_SOURCE,
  HOLIDAY_SOURCE_DETAIL,
  HOLIDAY_YEARS,
  builtInYears,
  createCalendar,
  defaultCalendar,
  loadCalendarFile,
} from '../../lib/core/holidays.js'
import { classify, nextTransition } from '../../lib/core/schedule.js'
import { EXPECTED_HOLIDAY_DAYS, EXPECTED_MAKEUP_WORKDAYS, bj, fmt } from './_helpers.mjs'

test('HOLIDAY_YEARS contains 2025 and 2026 only (2027 notice not published)', () => {
  assert.deepEqual(builtInYears(), [2025, 2026])
  assert.deepEqual(Object.keys(HOLIDAY_YEARS).map(Number).sort(), [2025, 2026])
})

for (const [year, expected] of Object.entries(EXPECTED_HOLIDAY_DAYS)) {
  test(`HOLIDAY_YEARS[${year}] lists exactly the official days off`, () => {
    const actual = Object.keys(HOLIDAY_YEARS[year]).sort()
    assert.deepEqual(actual, [...expected].sort())
    assert.equal(actual.length, expected.length)
  })

  test(`HOLIDAY_YEARS[${year}] keys are well formed, non-empty names, year matches`, () => {
    for (const [dateKey, name] of Object.entries(HOLIDAY_YEARS[year])) {
      assert.match(dateKey, /^\d{4}-\d{2}-\d{2}$/)
      assert.equal(Number(dateKey.slice(0, 4)), Number(year))
      assert.equal(typeof name, 'string')
      assert.ok(name.length > 0, `${dateKey} has an empty name`)
    }
  })
}

test('holiday names match the notices at the season-defining days', () => {
  const y = HOLIDAY_YEARS
  assert.equal(y[2025]['2025-01-01'], '元旦')
  assert.equal(y[2025]['2025-01-28'], '春节') // 农历除夕
  assert.equal(y[2025]['2025-02-04'], '春节') // 正月初七, last day of the block
  assert.equal(y[2025]['2025-04-04'], '清明节')
  assert.equal(y[2025]['2025-05-01'], '劳动节')
  assert.equal(y[2025]['2025-05-31'], '端午节')
  assert.equal(y[2025]['2025-10-01'], '国庆节')
  assert.equal(y[2025]['2025-10-06'], '中秋节') // 农历八月十五 inside the merged 10/1-10/8 block
  assert.equal(y[2026]['2026-01-03'], '元旦') // block extends onto a Saturday
  assert.equal(y[2026]['2026-02-15'], '春节') // 腊月二十八
  assert.equal(y[2026]['2026-02-23'], '春节') // 正月初七
  assert.equal(y[2026]['2026-04-06'], '清明节')
  assert.equal(y[2026]['2026-05-05'], '劳动节')
  assert.equal(y[2026]['2026-06-19'], '端午节')
  assert.equal(y[2026]['2026-09-25'], '中秋节')
  assert.equal(y[2026]['2026-10-07'], '国庆节') // last day of the 7-day block
})

test('day counts per holiday block match the notice wording', () => {
  const count = (year, name) => Object.values(HOLIDAY_YEARS[year]).filter((n) => n === name).length
  assert.equal(count(2025, '元旦'), 1)
  assert.equal(count(2025, '春节'), 8)
  assert.equal(count(2025, '清明节'), 3)
  assert.equal(count(2025, '劳动节'), 5)
  assert.equal(count(2025, '端午节'), 3)
  assert.equal(count(2025, '国庆节'), 7)
  assert.equal(count(2025, '中秋节'), 1)
  assert.equal(count(2026, '元旦'), 3)
  assert.equal(count(2026, '春节'), 9)
  assert.equal(count(2026, '清明节'), 3)
  assert.equal(count(2026, '劳动节'), 5)
  assert.equal(count(2026, '端午节'), 3)
  assert.equal(count(2026, '中秋节'), 3)
  assert.equal(count(2026, '国庆节'), 7)
})

test('make-up workdays are not in the holiday dataset but are idle', () => {
  for (const dateKey of EXPECTED_MAKEUP_WORKDAYS) {
    assert.equal(defaultCalendar.holidayOn(dateKey), undefined, `${dateKey} must not be a holiday day off`)
    const [y, m, d] = dateKey.split('-').map(Number)
    for (const hour of [9, 10, 14, 15]) {
      const at = bj(y, m, d, hour, 30, 0)
      assert.equal(classify(at).phase, 'idle', `${dateKey} ${hour}:30 must be idle`)
    }
  }
})

test('HOLIDAY_SOURCE records title + URL for every covered year', () => {
  assert.deepEqual(Object.keys(HOLIDAY_SOURCE).map(Number).sort(), [2025, 2026])
  for (const [year, source] of Object.entries(HOLIDAY_SOURCE)) {
    assert.equal(typeof source, 'string')
    assert.match(source, /国务院办公厅关于\d{4}年部分节假日安排的通知/)
    assert.match(source, /https?:\/\//)
    assert.ok(source.includes(String(year)))
  }
})

test('HOLIDAY_SOURCE_DETAIL carries >= 2 independent cross-checks per year, all distinct', () => {
  for (const [year, detail] of Object.entries(HOLIDAY_SOURCE_DETAIL)) {
    assert.equal(detail.year, Number(year))
    assert.match(detail.official.url, /^https?:\/\//)
    assert.ok(detail.crossChecks.length >= 2, `${year} needs at least two cross-check sources`)
    const urls = new Set([detail.official.url, ...detail.crossChecks.map((c) => c.url)])
    assert.equal(urls.size, detail.crossChecks.length + 1, `${year} source URLs must be distinct`)
    for (const check of detail.crossChecks) {
      assert.ok(check.title.length > 0)
      assert.match(check.url, /^https?:\/\//)
      assert.ok(check.publisher.length > 0)
    }
    assert.ok(detail.notice.length >= 6, `${year} keeps the verbatim notice clauses`)
  }
})

test('createCalendar() defaults: built-in years are known, anything else unknown', () => {
  const cal = createCalendar()
  assert.deepEqual(cal.years, [2025, 2026])
  assert.equal(cal.coverage('2025-06-01'), 'known')
  assert.equal(cal.coverage('2026-12-31'), 'known')
  assert.equal(cal.coverage('2027-01-01'), 'unknown')
  assert.equal(cal.coverage('2030-05-01'), 'unknown')
  assert.equal(cal.coverage('not-a-date'), 'unknown')
  assert.equal(cal.holidayOn('2027-01-01'), undefined)
  assert.deepEqual(cal.holidayOn('2026-10-01'), { dateKey: '2026-10-01', name: '国庆节' })
  assert.equal(cal.holidayOn('2026-10-08'), undefined) // 10/8 is a normal Thursday
  assert.equal(cal.holidayOn(12345), undefined)
})

test('explicit years gates both queries: uncovered years are unknown and give no data', () => {
  const cal = createCalendar({ years: [2027] })
  assert.deepEqual(cal.years, [2027])
  assert.equal(cal.coverage('2027-03-01'), 'known')
  assert.equal(cal.coverage('2026-03-01'), 'unknown')
  // Regression (F1): coverage 'unknown' must never come with an authoritative holiday name.
  assert.equal(cal.holidayOn('2026-01-01'), undefined)
  assert.equal(cal.holidayOn('2025-05-01'), undefined)
  assert.equal(cal.holidayOn('2027-03-01'), undefined) // covered year, but no dataset entry
})

test('regression (F1): no "unknown coverage + holiday reason" snapshot is reachable', () => {
  const cal = createCalendar({ years: [2026] })
  const laborDay = bj(2025, 5, 1, 10, 0, 0) // Thursday inside the would-be 劳动节 block
  const state = classify(laborDay, cal)
  assert.deepEqual(state, {
    phase: 'peak',
    reason: 'peak',
    dateKey: '2025-05-01',
    minuteOfDay: 600,
    weekday: 4,
    holiday: null,
    holidayCoverage: 'unknown',
    unknownHolidayYear: 2025,
  })
  assert.equal(nextTransition(bj(2025, 5, 1, 8, 0, 0), cal).at, bj(2025, 5, 1, 9, 0, 0))
  assert.equal(classify(bj(2025, 5, 1, 8, 0, 0), cal).reason, 'off-hours')
  // the same instant with the default calendar is a holiday
  assert.equal(classify(laborDay).reason, 'holiday')

  // The invariant holds across every dataset day of 2025/2026 under this restricted calendar.
  for (const year of [2025, 2026]) {
    for (const dateKey of Object.keys(HOLIDAY_YEARS[year])) {
      const withheld = cal.holidayOn(dateKey) === undefined
      const known = cal.coverage(dateKey) === 'known'
      assert.ok(!(known === false && withheld === false), `${dateKey} leaks data while unknown`)
    }
  }
})

test('extra is not gated by years and counts as known coverage', () => {
  const cal = createCalendar({ years: [2026], extra: { '2025-05-01': '公司假日', '2025-05-02': '公司假日' } })
  assert.deepEqual(cal.holidayOn('2025-05-01'), { dateKey: '2025-05-01', name: '公司假日' })
  assert.equal(cal.coverage('2025-05-01'), 'known')
  // Days the caller did not supply stay unknown in the same year.
  assert.equal(cal.coverage('2025-05-03'), 'unknown')
  assert.equal(cal.holidayOn('2025-05-03'), undefined)
  const state = classify(bj(2025, 5, 1, 10, 0, 0), cal)
  assert.equal(state.reason, 'holiday')
  assert.equal(state.holidayCoverage, 'known')
  assert.equal(state.unknownHolidayYear, null)
})

test('coverage() === unknown implies holidayOn() === undefined for every calendar shape', () => {
  const calendars = [
    createCalendar(),
    createCalendar({ years: [2026] }),
    createCalendar({ years: [2029] }),
    createCalendar({ extra: { '2025-01-02': '桥假', '2027-03-01': '自定' } }),
    createCalendar({ years: [2028], extra: { '2025-01-02': '桥假' } }),
  ]
  for (const cal of calendars) {
    for (let year = 2024; year <= 2030; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        for (const day of [1, 2, 3, 15, 28]) {
          const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          if (cal.coverage(dateKey) === 'unknown') {
            assert.equal(cal.holidayOn(dateKey), undefined, `${dateKey} under a restricted calendar`)
          }
        }
      }
    }
  }
})

test('extra overlays win over the built-in dataset', () => {
  const cal = createCalendar({ extra: { '2026-01-01': '公司元旦', '2026-03-11': '公司假日' } })
  assert.deepEqual(cal.holidayOn('2026-01-01'), { dateKey: '2026-01-01', name: '公司元旦' })
  assert.deepEqual(cal.holidayOn('2026-03-11'), { dateKey: '2026-03-11', name: '公司假日' })
  assert.equal(cal.coverage('2026-03-11'), 'known')
})

test('extra with a null value removes a built-in day', () => {
  const cal = createCalendar({ extra: { '2026-01-01': null } })
  assert.equal(cal.holidayOn('2026-01-01'), undefined)
  // 2026-01-01 is a Thursday: without the holiday entry the morning is peak again.
  assert.equal(classify(bj(2026, 1, 1, 10, 0, 0), cal).phase, 'peak')
  assert.equal(classify(bj(2026, 1, 1, 10, 0, 0)).phase, 'idle')
})

test('extra days for an uncovered year make that year known and beat the unknown-year rule', () => {
  const extra = { '2027-01-01': '元旦' }
  const cal = createCalendar({ extra })
  assert.deepEqual(cal.years, [2025, 2026, 2027])
  assert.equal(cal.coverage('2027-01-01'), 'known')
  assert.deepEqual(cal.holidayOn('2027-01-01'), { dateKey: '2027-01-01', name: '元旦' })

  const at = bj(2027, 1, 1, 10, 0, 0)
  const withExtra = classify(at, cal)
  assert.equal(withExtra.phase, 'idle')
  assert.equal(withExtra.reason, 'holiday')
  assert.equal(withExtra.holidayCoverage, 'known')
  assert.equal(withExtra.unknownHolidayYear, null)
  assert.equal(nextTransition(at, cal).at, bj(2027, 1, 4, 9, 0, 0))

  const withoutExtra = classify(at)
  assert.equal(withoutExtra.phase, 'peak')
  assert.equal(withoutExtra.holidayCoverage, 'unknown')
  assert.equal(withoutExtra.unknownHolidayYear, 2027)
})

test('extra accepts arrays, object values and wrapper objects', () => {
  const asArray = createCalendar({ extra: [{ dateKey: '2026-03-11', name: '团建' }] })
  assert.deepEqual(asArray.holidayOn('2026-03-11'), { dateKey: '2026-03-11', name: '团建' })

  const asObject = createCalendar({ extra: { '2026-03-12': { name: '年会', dateKey: '2026-03-12' } } })
  assert.deepEqual(asObject.holidayOn('2026-03-12'), { dateKey: '2026-03-12', name: '年会' })

  const wrapped = createCalendar({ extra: { years: [2027], holidays: { '2027-05-04': '青年节假' } } })
  assert.deepEqual(wrapped.years, [2025, 2026, 2027])
  assert.equal(wrapped.coverage('2027-05-04'), 'known')
  assert.deepEqual(wrapped.holidayOn('2027-05-04'), { dateKey: '2027-05-04', name: '青年节假' })

  const junk = createCalendar({ extra: { notADate: 'x', '2026-03-13': 42, '2026-03-14': '' } })
  assert.equal(junk.holidayOn('notADate'), undefined)
  assert.equal(junk.holidayOn('2026-03-13'), undefined)
  assert.equal(junk.holidayOn('2026-03-14'), undefined)
})

test('loadCalendarFile: valid file, BOM, wrapper form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-hours-cal-'))
  try {
    const flat = join(dir, 'flat.json')
    writeFileSync(flat, JSON.stringify({ '2027-01-01': '元旦', '2027-01-02': '元旦' }), 'utf8')
    const flatCal = loadCalendarFile(flat)
    assert.equal(flatCal.loadError, null)
    assert.equal(flatCal.sourceFile, flat)
    assert.deepEqual(flatCal.years, [2025, 2026, 2027])
    assert.deepEqual(flatCal.holidayOn('2027-01-02'), { dateKey: '2027-01-02', name: '元旦' })
    assert.equal(classify(bj(2027, 1, 2, 10, 0, 0), flatCal).phase, 'idle')
    // built-in days still resolve through a loaded calendar
    assert.deepEqual(flatCal.holidayOn('2026-10-01'), { dateKey: '2026-10-01', name: '国庆节' })

    const bom = join(dir, 'bom.json')
    writeFileSync(bom, `\uFEFF${JSON.stringify({ '2027-05-01': '劳动节' })}`, 'utf8')
    const bomCal = loadCalendarFile(bom)
    assert.equal(bomCal.loadError, null)
    assert.deepEqual(bomCal.holidayOn('2027-05-01'), { dateKey: '2027-05-01', name: '劳动节' })

    const wrapped = join(dir, 'wrapped.json')
    writeFileSync(wrapped, JSON.stringify({ years: [2027], holidays: { '2027-09-01': '自定假日' } }), 'utf8')
    const wrappedCal = loadCalendarFile(wrapped)
    assert.equal(wrappedCal.loadError, null)
    assert.equal(wrappedCal.coverage('2027-09-01'), 'known')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadCalendarFile never throws and reports why extras were skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-hours-cal-'))
  try {
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ not json', 'utf8')
    const brokenCal = loadCalendarFile(broken)
    assert.match(brokenCal.loadError, /invalid JSON/)
    assert.equal(brokenCal.holidayOn('2026-01-01').name, '元旦') // built-ins survive

    const empty = join(dir, 'empty.json')
    writeFileSync(empty, '{"years":[]}', 'utf8')
    const emptyCal = loadCalendarFile(empty)
    assert.equal(emptyCal.loadError, 'no holiday entries found')
    assert.equal(emptyCal.coverage('2026-01-01'), 'known')

    const missing = loadCalendarFile(join(dir, 'does-not-exist.json'))
    assert.match(missing.loadError, /cannot read file/)
    assert.deepEqual(missing.years, [2025, 2026])

    assert.equal(loadCalendarFile('').loadError, 'no path given')
    assert.equal(loadCalendarFile(null).loadError, 'no path given')
    assert.equal(loadCalendarFile(join(dir, 'nope', 'x.json')).loadError.startsWith('cannot read file'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultCalendar and createCalendar() agree', () => {
  assert.deepEqual(defaultCalendar.years, createCalendar().years)
  assert.deepEqual(defaultCalendar.holidayOn('2026-02-17'), createCalendar().holidayOn('2026-02-17'))
  assert.deepEqual(defaultCalendar.source, HOLIDAY_SOURCE)
})

test('2027 (uncovered year) fills the unknown-coverage contract', () => {
  const at = bj(2027, 10, 1, 10, 0, 0) // a Friday
  const state = classify(at)
  assert.equal(state.weekday, 5)
  assert.equal(state.phase, 'peak')
  assert.equal(state.reason, 'peak')
  assert.equal(state.holiday, null)
  assert.equal(state.holidayCoverage, 'unknown')
  assert.equal(state.unknownHolidayYear, 2027)
  assert.equal(fmt(nextTransition(bj(2027, 10, 1, 8, 0, 0)).at), '2027-10-01 09:00:00.000')
})
