/**
 * dsh-peak-hours — schedule-core bridge.
 *
 * The host half consumes exactly three names from the frozen core surface
 * (SPEC §2.1): `classify`, `nextTransition`, `defaultCalendar`. The import is
 * dynamic and contained so that this half loads, and its unit tests run, even
 * while `lib/core` is still being written in parallel.
 *
 * When the core is genuinely unavailable (a broken install) the bridge falls
 * back to a degraded weekday+window classifier. The fallback has NO holiday
 * dataset, so it reports `holidayCoverage: 'unknown'` — the UI then shows its
 * unknown-holiday warning instead of silently mislabelling a statutory holiday
 * as peak. It is a loud, honest degradation, never a silent wrong answer.
 */

import { BJ_OFFSET_MS } from './clock.js'

/** Peak windows in Beijing minutes-of-day: 09:00-12:00 and 14:00-18:00 (SPEC §1). */
const PEAK_WINDOWS = Object.freeze([
  [540, 720],
  [840, 1080],
])

/** Two-digit zero pad. */
function pad2(value) {
  return value < 10 ? `0${String(value)}` : String(value)
}

/** Beijing calendar fields of one instant. */
function beijingFields(epochMs) {
  const d = new Date(Number(epochMs) + BJ_OFFSET_MS)
  return {
    dateKey: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay(),
    year: d.getUTCFullYear(),
  }
}

/**
 * Degraded classifier: weekday windows only, no holiday knowledge.
 * @param epochMs - epoch milliseconds.
 * @returns a `classify()`-shaped record with `holidayCoverage: 'unknown'`.
 */
export function fallbackClassify(epochMs) {
  const { dateKey, minuteOfDay, weekday, year } = beijingFields(epochMs)
  const inWindow = PEAK_WINDOWS.some(([from, to]) => minuteOfDay >= from && minuteOfDay < to)
  const peak = weekday >= 1 && weekday <= 5 && inWindow
  const weekend = weekday === 0 || weekday === 6
  return {
    phase: peak ? 'peak' : 'idle',
    reason: peak ? 'peak' : weekend ? 'weekend' : 'off-hours',
    dateKey,
    minuteOfDay,
    weekday,
    holiday: null,
    holidayCoverage: 'unknown',
    unknownHolidayYear: year,
  }
}

/**
 * Degraded transition search: minute-by-minute forward scan, bounded to 15 days.
 * @param epochMs - epoch milliseconds.
 * @returns `{ at, to }` for the next phase change.
 */
export function fallbackNextTransition(epochMs) {
  const startPhase = fallbackClassify(epochMs).phase
  const firstBoundary = Math.floor(epochMs / 60_000) * 60_000 + 60_000
  const limit = firstBoundary + 15 * 24 * 60 * 60_000
  for (let at = firstBoundary; at <= limit; at += 60_000) {
    const phase = fallbackClassify(at).phase
    if (phase !== startPhase) return { at, to: phase }
  }
  return { at: limit, to: startPhase === 'peak' ? 'idle' : 'peak' }
}

/** Human-readable error text. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Load the schedule core, falling back to the degraded classifier.
 * @param options.logger - optional logger (`warn`); the fallback is announced once.
 * @returns `{ source, classify, nextTransition }`, never throwing.
 */
export async function loadCore({ logger = null } = {}) {
  try {
    const core = await import('../core/index.js')
    if (typeof core?.classify === 'function' && typeof core?.nextTransition === 'function') {
      return {
        source: 'core',
        classify: (epochMs) => core.classify(epochMs),
        nextTransition: (epochMs) => core.nextTransition(epochMs),
      }
    }
    throw new TypeError('lib/core/index.js does not export classify/nextTransition')
  } catch (error) {
    try {
      logger?.warn?.(
        `[peak-hours] schedule core unavailable (${errorText(error)}); using the degraded weekday-only fallback (no holiday dataset)`,
      )
    } catch {
      /* ignore */
    }
    return {
      source: 'fallback',
      classify: (epochMs) => fallbackClassify(epochMs),
      nextTransition: (epochMs) => fallbackNextTransition(epochMs),
    }
  }
}
