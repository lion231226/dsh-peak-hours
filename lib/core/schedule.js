/**
 * Peak/idle schedule kernel (SPEC.md §1 and §2.1).
 *
 * Pure: no I/O, no `Date.now()`, no framework imports. Every instant is an `epochMs` number and
 * every calendar field is derived from `new Date(epochMs + BJ_OFFSET_MS)` with the **UTC**
 * getters, so the result never depends on the host time zone or on DST (China has none).
 *
 * Phase rules:
 *   peak  <=> weekday in 1..5 AND dateKey is not a statutory holiday AND
 *             minuteOfDay in [540,720) or [840,1080)   (09:00-12:00, 14:00-18:00 Beijing)
 *   idle  <=> everything else (weekends, holidays, 00:00-09:00, 12:00-14:00, 18:00-24:00)
 */

import { defaultCalendar } from './holidays.js'

export const BJ_OFFSET_MS = 8 * 3600 * 1000

/** Peak windows as `[startMinute, endMinute)` pairs of `minuteOfDay`. */
export const PEAK_WINDOWS = Object.freeze([Object.freeze([540, 720]), Object.freeze([840, 1080])])

/** Human-readable form of `PEAK_WINDOWS`, for API payloads and UI labels. */
export const PEAK_WINDOW_LABELS = Object.freeze(['09:00-12:00', '14:00-18:00'])

const MINUTE_MS = 60000
const DAY_MS = 86400000

/**
 * Beijing minute-of-day values at which the phase can change: local midnight plus every peak
 * window edge. Between two consecutive candidates the phase is constant, which is what makes
 * the boundary scan in `nextTransition` exact rather than approximate.
 */
const PHASE_BOUNDARY_MINUTES = Object.freeze([0, 540, 720, 840, 1080])

/** Give up after ~10 years of holidays; only reachable with a calendar that never has a weekday. */
const MAX_SCAN_DAYS = 3660

function requireFinite(value, name) {
  // Only numbers and non-empty numeric strings are accepted; `null`/`''`/booleans are rejected
  // instead of silently coercing to 0 (which would classify 1970-01-01).
  let n = NaN
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a finite epoch timestamp in ms, got ${String(value)}`)
  return n
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function dateKeyOf(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

function isInPeakWindow(minuteOfDay) {
  for (const [start, end] of PEAK_WINDOWS) {
    if (minuteOfDay >= start && minuteOfDay < end) return true
  }
  return false
}

function holidayOn(calendar, dateKey) {
  if (calendar && typeof calendar.holidayOn === 'function') {
    const entry = calendar.holidayOn(dateKey)
    if (entry && entry.name !== undefined && entry.name !== null) {
      return { dateKey: typeof entry.dateKey === 'string' ? entry.dateKey : dateKey, name: entry.name }
    }
  }
  return null
}

function coverageOf(calendar, dateKey) {
  if (calendar && typeof calendar.coverage === 'function') {
    return calendar.coverage(dateKey) === 'unknown' ? 'unknown' : 'known'
  }
  return 'known'
}

/**
 * Beijing calendar fields for an instant.
 * @returns {{ dateKey: string, minuteOfDay: number, weekday: number, dayIndex: number }}
 *   `weekday`: 0 = Sunday … 6 = Saturday. `dayIndex`: days since 1970-01-01 in Beijing.
 */
export function bjFields(epochMs) {
  const t = requireFinite(epochMs, 'epochMs')
  const shifted = t + BJ_OFFSET_MS
  const date = new Date(shifted)
  return {
    dateKey: dateKeyOf(date),
    minuteOfDay: date.getUTCHours() * 60 + date.getUTCMinutes(),
    weekday: date.getUTCDay(),
    dayIndex: Math.floor(shifted / DAY_MS),
  }
}

export function bjDateKey(epochMs) {
  return bjFields(epochMs).dateKey
}

export function bjMinuteOfDay(epochMs) {
  return bjFields(epochMs).minuteOfDay
}

export function bjWeekday(epochMs) {
  return bjFields(epochMs).weekday
}

/** `'YYYY-MM-DD HH:mm:ss'` in Beijing time (used for the host state payload). */
export function formatBeijing(epochMs) {
  const t = requireFinite(epochMs, 'epochMs')
  const date = new Date(t + BJ_OFFSET_MS)
  return (
    `${dateKeyOf(date)} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  )
}

/** Phase only — the hot path of `nextTransition`, without building the full classification. */
function phaseAt(epochMs, calendar) {
  const date = new Date(epochMs + BJ_OFFSET_MS)
  const weekday = date.getUTCDay()
  if (weekday < 1 || weekday > 5) return 'idle'
  if (!isInPeakWindow(date.getUTCHours() * 60 + date.getUTCMinutes())) return 'idle'
  if (holidayOn(calendar, dateKeyOf(date))) return 'idle'
  return 'peak'
}

/**
 * Classify one instant.
 * @returns {{ phase: 'peak'|'idle', reason: 'peak'|'off-hours'|'weekend'|'holiday',
 *   dateKey: string, minuteOfDay: number, weekday: number,
 *   holiday: {dateKey: string, name: string}|null,
 *   holidayCoverage: 'known'|'unknown', unknownHolidayYear: number|null }}
 */
export function classify(epochMs, calendar = defaultCalendar) {
  const { dateKey, minuteOfDay, weekday } = bjFields(epochMs)
  const holiday = holidayOn(calendar, dateKey)
  const holidayCoverage = coverageOf(calendar, dateKey)
  const isWorkday = weekday >= 1 && weekday <= 5

  let phase
  let reason
  if (isWorkday && holiday === null && isInPeakWindow(minuteOfDay)) {
    phase = 'peak'
    reason = 'peak'
  } else {
    phase = 'idle'
    if (holiday !== null) reason = 'holiday'
    else if (isWorkday) reason = 'off-hours'
    else reason = 'weekend'
  }

  return {
    phase,
    reason,
    dateKey,
    minuteOfDay,
    weekday,
    holiday,
    holidayCoverage,
    unknownHolidayYear: holidayCoverage === 'unknown' ? Number(dateKey.slice(0, 4)) : null,
  }
}

/** `true` exactly when `classify(epochMs).phase === 'peak'`. */
export function isPeak(epochMs, calendar = defaultCalendar) {
  return classify(epochMs, calendar).phase === 'peak'
}

/**
 * The next phase change strictly after `epochMs`.
 *
 * The phase only changes at 00:00 / 09:00 / 12:00 / 14:00 / 18:00 Beijing time, so the scan
 * walks those candidate minute boundaries in order and returns the first one whose phase differs
 * from the millisecond before it. Exact for every input: inside a window, in the lunch break, in
 * a weekend, in a 9-day holiday, and across year rollovers.
 *
 * @returns {{ at: number, to: 'peak'|'idle' }} `at` is the exact millisecond the new phase begins.
 * @throws {TypeError} for a non-finite `epochMs`.
 * @throws {Error} if no change exists within ~10 years (only possible with a degenerate calendar).
 */
export function nextTransition(epochMs, calendar = defaultCalendar) {
  const t = requireFinite(epochMs, 'epochMs')
  const firstMinute = Math.floor(t / MINUTE_MS) + 1
  const startDay = Math.floor((firstMinute * MINUTE_MS + BJ_OFFSET_MS) / DAY_MS)

  for (let day = startDay; day <= startDay + MAX_SCAN_DAYS; day += 1) {
    const midnight = day * DAY_MS - BJ_OFFSET_MS
    for (const minuteOfDay of PHASE_BOUNDARY_MINUTES) {
      const at = midnight + minuteOfDay * MINUTE_MS
      if (at <= t) continue
      const after = phaseAt(at, calendar)
      if (phaseAt(at - 1, calendar) !== after) return { at, to: after }
    }
  }

  throw new Error('nextTransition: no phase change within 10 years (degenerate calendar?)')
}

/**
 * Contiguous phase segments covering `[fromMs, toMs)`; the last segment ends exactly at `toMs`.
 * Every boundary (except the clamped last one) is a real `nextTransition` instant, so each
 * segment carries a single `phase`. `reason` is the reason at `from` — inside a long idle run it
 * can change without the phase changing (e.g. off-hours -> weekend -> holiday).
 * @returns {Array<{from: number, to: number, phase: 'peak'|'idle', reason: string}>}
 */
export function phaseSegments(fromMs, toMs, calendar = defaultCalendar) {
  const from = requireFinite(fromMs, 'fromMs')
  const to = requireFinite(toMs, 'toMs')
  if (to <= from) return []

  const segments = []
  let cursor = from
  while (cursor < to) {
    const { phase, reason } = classify(cursor, calendar)
    const end = Math.min(nextTransition(cursor, calendar).at, to)
    segments.push({ from: cursor, to: end, phase, reason })
    cursor = end
  }
  return segments
}
