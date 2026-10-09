/**
 * Shared test helpers. Deliberately independent of `lib/core`: timestamps are built with
 * `Date.UTC` (so a bug in the +8h shift cannot hide), the holiday expectation is written out as
 * explicit literal date lists transcribed from the State Council notices, and the reference
 * phase model is a second implementation of the SPEC.md §1 rule.
 *
 * Not a test file (no `.test.` in the name), so `node --test test/core` does not execute it.
 */

export const BJ = 8 * 3600 * 1000
export const MINUTE = 60000
export const HOUR = 3600000
export const DAY = 86400000

/** Beijing wall-clock time -> epoch ms. Month is 1-based, like a human writes it. */
export function bj(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - BJ
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** `'YYYY-MM-DD HH:mm:ss.SSS'` in Beijing time. */
export function fmt(epochMs) {
  const d = new Date(epochMs + BJ)
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.` +
    `${String(d.getUTCMilliseconds()).padStart(3, '0')}`
  )
}

/** `'YYYY-MM-DD'` in Beijing time. */
export function key(epochMs) {
  return fmt(epochMs).slice(0, 10)
}

/* --------------------------------------------------------------------------------------- *
 * Expected holiday days, written out day by day from the official notices (days OFF only;
 * 调休上班 days are absent on purpose).
 * --------------------------------------------------------------------------------------- */

export const EXPECTED_HOLIDAY_DAYS = {
  2025: [
    '2025-01-01', // 元旦
    '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', // 春节 (1/28 - 2/4)
    '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
    '2025-04-04', '2025-04-05', '2025-04-06', // 清明节
    '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05', // 劳动节
    '2025-05-31', '2025-06-01', '2025-06-02', // 端午节
    '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', // 国庆节、中秋节 (10/1 - 10/8)
    '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  ],
  2026: [
    '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', // 春节 (2/15 - 2/23)
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06', // 清明节
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
    '2026-06-19', '2026-06-20', '2026-06-21', // 端午节
    '2026-09-25', '2026-09-26', '2026-09-27', // 中秋节
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', // 国庆节 (10/1 - 10/7)
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
}

/** 调休上班 days: they are NOT holidays, and per SPEC.md §1 they are still idle. */
export const EXPECTED_MAKEUP_WORKDAYS = [
  '2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11',
  '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
]

const REFERENCE_SETS = Object.fromEntries(
  Object.entries(EXPECTED_HOLIDAY_DAYS).map(([year, days]) => [Number(year), new Set(days)]),
)

/**
 * Independent reference model of the phase rule: peak iff Mon-Fri, not a holiday, and inside a
 * window. Years outside `EXPECTED_HOLIDAY_DAYS` have no holiday data, so every weekday window is
 * peak there.
 */
export function referencePhase(epochMs) {
  const d = new Date(epochMs + BJ)
  const weekday = d.getUTCDay()
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes()
  const dateKey = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  const holidays = REFERENCE_SETS[d.getUTCFullYear()]
  const isHoliday = holidays ? holidays.has(dateKey) : false
  const inWindow = (minuteOfDay >= 540 && minuteOfDay < 720) || (minuteOfDay >= 840 && minuteOfDay < 1080)
  return weekday >= 1 && weekday <= 5 && !isHoliday && inWindow ? 'peak' : 'idle'
}

/** Deterministic PRNG so a failing property test can be replayed. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Boundary times of the day under test: the peak edges plus one second/ms either side. */
export const BOUNDARY_TIMES = [
  { hour: 8, minute: 59, second: 59, ms: 0, label: '08:59:59' },
  { hour: 9, minute: 0, second: 0, ms: 0, label: '09:00:00' },
  { hour: 11, minute: 59, second: 59, ms: 0, label: '11:59:59' },
  { hour: 12, minute: 0, second: 0, ms: 0, label: '12:00:00' },
  { hour: 13, minute: 59, second: 59, ms: 0, label: '13:59:59' },
  { hour: 14, minute: 0, second: 0, ms: 0, label: '14:00:00' },
  { hour: 17, minute: 59, second: 59, ms: 0, label: '17:59:59' },
  { hour: 18, minute: 0, second: 0, ms: 0, label: '18:00:00' },
]
