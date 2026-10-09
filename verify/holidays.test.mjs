// verify/holidays.test.mjs — verifier-owned cross-check of lib/core/holidays.js against the
// official State Council notices. Expectations come from verify/lib/oracle.mjs (hand-transcribed
// by the verifier from verify/raw/*.txt), never from the implementation itself.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  H2025, H2026, MAKEUP_2025, MAKEUP_2026, HOLIDAY_SET, KNOWN_YEARS, rawSourceText, bjEpoch,
} from './lib/oracle.mjs'

let hol = null, loadErr = null
try { hol = await import('../lib/core/holidays.js') } catch (e) { loadErr = e }
const missing = hol ? false : `lib/core/holidays.js unavailable: ${loadErr?.message}`

test('subject module present (lib/core/holidays.js)', () => {
  assert.ok(hol, missing)
})

test('notice corpus actually downloaded (evidence present)', () => {
  const g2026 = rawSourceText('2026-gov-gongbao')
  const g2025 = rawSourceText('2025-gov-gongbao')
  assert.match(g2026, /国办发明电〔2025〕7号/)
  assert.match(g2025, /国办发明电〔2024〕12号/)
  // verbatim anchors used for the transcription
  assert.match(g2026, /一、元旦：\s*1月1日（周四）至3日（周六）放假调休，共3天。1月4日（周日）上班/)
  assert.match(g2026, /七、国庆节：\s*10月1日（周四）至7日（周三）放假调休，共7天。9月20日（周日）、10月10日（周六）上班/)
  assert.match(g2025, /二、春节：\s*1月28日（农历除夕、周二）至2月4日（农历正月初七、周二）放假调休，共8天。1月26日（周日）、2月8日（周六）上班/)
  assert.match(g2025, /六、国庆节、中秋节：\s*10月1日（周三）至8日（周三）放假调休，共8天。9月28日（周日）、10月11日（周六）上班/)
})

test('HOLIDAY_YEARS covers exactly the years with an official notice (2025, 2026)', { skip: missing }, () => {
  const years = Object.keys(hol.HOLIDAY_YEARS).map(Number).sort((a, b) => a - b)
  assert.deepEqual(years, [2025, 2026],
    'Only 2025 and 2026 have an official 部分节假日安排 notice as of 2026-10-09; ' +
    'a 2027 entry cannot be sourced from an official notice (see verify/EVIDENCE.md §1.4).')
})

for (const [year, want, label] of [
  [2025, H2025, '国办发明电〔2024〕12号'],
  [2026, H2026, '国办发明电〔2025〕7号'],
]) {
  test(`HOLIDAY_YEARS[${year}] equals the ${want.length} days transcribed from ${label}`, { skip: missing }, () => {
    const table = hol.HOLIDAY_YEARS[year]
    assert.ok(table, `HOLIDAY_YEARS[${year}] missing`)
    const got = Object.keys(table).sort()
    const exp = [...want].sort()
    const extra = got.filter((d) => !exp.includes(d))
    const absent = exp.filter((d) => !got.includes(d))
    assert.deepEqual({ extra, absent, count: got.length }, { extra: [], absent: [], count: exp.length })
    for (const d of want) {
      assert.equal(typeof table[d], 'string')
      assert.ok(table[d].length > 0, `${d} name must be a non-empty string`)
    }
  })
}

test('make-up workdays (调休上班) are NOT in the holiday set', { skip: missing }, () => {
  const bad = []
  for (const d of [...MAKEUP_2025, ...MAKEUP_2026]) {
    const y = Number(d.slice(0, 4))
    if (hol.HOLIDAY_YEARS[y]?.[d] !== undefined) bad.push(d)
  }
  assert.deepEqual(bad, [], 'make-up workdays must stay non-holidays: SPEC §1 keeps them idle via the weekend rule')
})

test('defaultCalendar: holidayOn / coverage / holiday labels', { skip: missing }, () => {
  const cal = hol.defaultCalendar
  assert.ok(cal, 'defaultCalendar must be exported')
  for (const d of [H2025[0], '2026-10-01', '2026-10-06', '2026-02-23']) {
    const h = cal.holidayOn(d)
    assert.ok(h && typeof h.name === 'string' && h.name.length > 0, `holidayOn(${d}) should return {dateKey,name}`)
    assert.equal(h.dateKey, d)
  }
  for (const d of [...MAKEUP_2026, '2026-10-08', '2026-10-09', '2025-10-09']) {
    assert.equal(cal.holidayOn(d), undefined, `${d} must not be a holiday`)
  }
  assert.equal(cal.coverage('2026-10-06'), 'known')
  assert.equal(cal.coverage('2027-01-01'), 'unknown', 'no official 2027 notice exists yet')
  assert.equal(cal.coverage('2024-05-01'), 'unknown', 'years outside the dataset are unknown')
})

test('extra overlay wins over built-in; years filter narrows coverage', { skip: missing }, () => {
  const c1 = hol.createCalendar({ extra: { '2026-10-14': '验证用假日' } })
  assert.equal(c1.holidayOn('2026-10-14')?.name, '验证用假日', 'extra must override/extend the built-in table')
  assert.equal(c1.holidayOn('2026-10-01')?.name, hol.HOLIDAY_YEARS[2026]['2026-10-01'], 'built-ins stay visible')

  const c2 = hol.createCalendar({ years: [2026] })
  assert.equal(c2.coverage('2026-05-01'), 'known')
  assert.equal(c2.coverage('2025-05-01'), 'unknown', 'years:[2026] must exclude 2025 from coverage')
})

// FINDING F1 (reported to Lead + core-dev 2026-10-09): `years` narrows coverage() but NOT
// holidayOn(), so a date whose coverage is 'unknown' can still report a holiday. classify() then
// emits { holidayCoverage:'unknown', reason:'holiday', holiday:{...} } — a state the UI cannot
// describe ("unknown year" warning + authoritative holiday at the same time).
test('[FINDING F1] calendar must not report holiday data for a year it declares unknown', { skip: missing }, () => {
  const c2 = hol.createCalendar({ years: [2026] })
  assert.equal(c2.coverage('2025-05-01'), 'unknown')
  assert.equal(c2.holidayOn('2025-05-01'), undefined,
    'coverage(2025) is "unknown" yet holidayOn(2025-05-01) still returns 劳动节 — inconsistent. ' +
    'Either holidayOn must respect `years`, or `years` must not narrow coverage. See verify/EVIDENCE.md F1.')
})

test('createCalendar exposes years[] and source{}', { skip: missing }, () => {
  const cal = hol.createCalendar()
  assert.deepEqual([...cal.years].sort((a, b) => a - b), [...KNOWN_YEARS].sort((a, b) => a - b))
  assert.equal(typeof cal.source, 'object')
  for (const y of [2025, 2026]) {
    assert.ok(cal.source[y], `HOLIDAY_SOURCE[${y}] missing`)
    assert.ok(String(cal.source[y]).length > 0)
  }
})

// SPEC §2.2 freezes HOLIDAY_SOURCE as `{ 2025: '<official notice URL/title>' }` (one string per
// year) and separately requires the cross-checked sources to be recorded. core-dev keeps the
// official URL in HOLIDAY_SOURCE and the full audit list in HOLIDAY_SOURCE_DETAIL.
test('HOLIDAY_SOURCE / HOLIDAY_SOURCE_DETAIL record >=2 independent sources per year', { skip: missing }, () => {
  const hosts = (v) => [...new Set((String(JSON.stringify(v)).match(/[a-z0-9.-]+\.(?:cn|com|org|net)\b/gi) ?? []))]
  for (const y of [2025, 2026]) {
    const main = hosts(hol.HOLIDAY_SOURCE[y])
    assert.ok(main.length >= 1, `${y}: HOLIDAY_SOURCE must carry the official notice URL`)
    assert.ok(main.some((h) => /gov\.cn$/i.test(h)), `${y}: official gov.cn URL expected, got ${JSON.stringify(main)}`)

    const detail = hol.HOLIDAY_SOURCE_DETAIL?.[y]
    assert.ok(detail, `${y}: HOLIDAY_SOURCE_DETAIL[${y}] missing — the cross-check audit trail must exist`)
    assert.ok(detail.official?.url, `${y}: detail.official.url missing`)
    assert.ok(Array.isArray(detail.crossChecks) && detail.crossChecks.length >= 1,
      `${y}: expected >=1 independent cross-check, got ${JSON.stringify(detail.crossChecks)}`)
    const all = hosts([main, detail.crossChecks])
    assert.ok(all.some((h) => !/gov\.cn$/i.test(h)),
      `${y}: expected an independent (non-gov.cn) source, got ${JSON.stringify(all)}`)
    for (const c of detail.crossChecks) {
      assert.ok(typeof c.url === 'string' && c.url.length > 0, `${y}: cross-check without URL: ${JSON.stringify(c)}`)
      assert.ok(typeof c.title === 'string' && c.title.length > 0, `${y}: cross-check without title: ${JSON.stringify(c)}`)
    }
    // the verbatim notice text must be present so a reviewer can diff it against the URL
    assert.ok(Array.isArray(detail.notice) && detail.notice.length >= 6, `${y}: verbatim notice lines expected`)
  }
})

test('loadCalendarFile is best-effort and never throws', { skip: missing }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-verify-'))
  try {
    assert.doesNotThrow(() => hol.loadCalendarFile(join(dir, 'nope.json')))
    const corrupt = join(dir, 'corrupt.json')
    writeFileSync(corrupt, '{ this is not json')
    assert.doesNotThrow(() => hol.loadCalendarFile(corrupt))
    const good = join(dir, 'extra.json')
    writeFileSync(good, JSON.stringify({ '2026-10-14': '文件假日' }))
    const cal = hol.loadCalendarFile(good)
    if (cal && typeof cal.holidayOn === 'function') {
      assert.equal(cal.holidayOn('2026-10-14')?.name, '文件假日')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('classify() reports the unknown-year warning for 2027', { skip: missing }, async () => {
  const sched = await import('../lib/core/schedule.js')
  const s = sched.classify(bjEpoch(2027, 1, 1, 10, 0, 0))
  assert.equal(s.holidayCoverage, 'unknown')
  assert.equal(s.unknownHolidayYear, 2027)
  assert.equal(s.phase, 'peak', 'SPEC §1: unknown holiday year ⇒ the date is treated as a non-holiday')
})
