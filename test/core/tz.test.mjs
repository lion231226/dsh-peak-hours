import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { HOLIDAY_YEARS } from '../../lib/core/holidays.js'
import { classify, formatBeijing, nextTransition } from '../../lib/core/schedule.js'
import { bj } from './_helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scheduleUrl = pathToFileURL(resolve(here, '../../lib/core/schedule.js')).href
const holidaysUrl = pathToFileURL(resolve(here, '../../lib/core/holidays.js')).href

/** Instants that cover every branch: windows, lunch break, weekend, holidays, rollovers. */
const SAMPLES = [
  bj(2025, 1, 1, 0, 0, 0),
  bj(2025, 1, 28, 9, 0, 0),
  bj(2025, 5, 2, 14, 30, 0),
  bj(2025, 10, 5, 11, 0, 0),
  bj(2025, 12, 31, 18, 0, 0),
  bj(2026, 1, 3, 12, 0, 0),
  bj(2026, 2, 15, 9, 30, 0),
  bj(2026, 3, 11, 9, 0, 0),
  bj(2026, 3, 11, 12, 0, 0),
  bj(2026, 3, 11, 17, 59, 59, 999),
  bj(2026, 3, 14, 10, 0, 0),
  bj(2026, 6, 19, 15, 0, 0),
  bj(2026, 9, 27, 20, 0, 0),
  bj(2026, 10, 7, 18, 0, 0),
  bj(2026, 10, 10, 9, 0, 0),
  bj(2027, 10, 1, 10, 0, 0),
  bj(2028, 2, 29, 10, 0, 0),
]

const TIMES = { UTC: 'UTC', NewYork: 'America/New_York', Kolkata: 'Asia/Kolkata', Kiritimati: 'Pacific/Kiritimati' }

function projection() {
  return {
    out: SAMPLES.map((t) => {
      const state = classify(t)
      const next = nextTransition(t)
      return [state.phase, state.reason, state.dateKey, state.minuteOfDay, state.weekday, next.at, next.to, formatBeijing(t)]
    }),
    years: Object.keys(HOLIDAY_YEARS).map(Number),
  }
}

const PROBE = `
const { classify, nextTransition, formatBeijing } = await import(${JSON.stringify(scheduleUrl)})
const { HOLIDAY_YEARS } = await import(${JSON.stringify(holidaysUrl)})
const samples = ${JSON.stringify(SAMPLES)}
const projection = {
  out: samples.map((t) => {
    const state = classify(t)
    const next = nextTransition(t)
    return [state.phase, state.reason, state.dateKey, state.minuteOfDay, state.weekday, next.at, next.to, formatBeijing(t)]
  }),
  years: Object.keys(HOLIDAY_YEARS).map(Number),
}
process.stdout.write(JSON.stringify({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offsetMinutes: new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(),
  projection,
}))
`

test('core results do not depend on the host time zone', () => {
  const expected = projection()
  const offsets = new Set()

  for (const [label, tz] of Object.entries(TIMES)) {
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    })
    const result = JSON.parse(raw)
    // ICU canonicalises some zone ids (e.g. Asia/Kolkata -> Asia/Calcutta), so compare the
    // canonical form instead of the raw string.
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone
    assert.equal(result.tz, canonical, `TZ=${tz} was not applied (${label})`)
    assert.deepEqual(result.projection, expected, `results changed under TZ=${tz}`)
    offsets.add(result.offsetMinutes)
  }

  // Sanity: the probe really did run in different zones, so the comparison above is meaningful.
  assert.ok(offsets.size >= 3, `expected several distinct UTC offsets, got ${[...offsets].join(',')}`)
})
