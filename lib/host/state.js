/**
 * dsh-peak-hours — host state snapshot builder.
 *
 * Emits exactly the frozen `GET /api/peak-hours/state` contract (SPEC §2.3).
 * Pure: every input is passed in, nothing is read from the ambient clock or
 * the filesystem, so the field set can be asserted in `node:test` directly.
 */

import { formatBeijing } from './clock.js'

/** Reported time zone label (SPEC §2.3). */
export const TIME_ZONE = 'Asia/Shanghai (UTC+8)'

/** Human-readable peak windows (SPEC §1: [540,720) and [840,1080)). */
export const PEAK_WINDOWS_TEXT = Object.freeze(['09:00-12:00', '14:00-18:00'])

const MODES = new Set(['always', 'idle-only'])
const PHASES = new Set(['peak', 'idle'])
const REASONS = new Set(['peak', 'off-hours', 'weekend', 'holiday'])

/**
 * Build the frozen state object.
 * @param input.mode - persisted run mode.
 * @param input.now - effective epoch ms (clock override already applied).
 * @param input.info - `classify(now)` result from the schedule core.
 * @param input.next - `nextTransition(now)` result from the schedule core.
 * @param input.waitingTasks - current gate waiter count.
 * @param input.clockOverride - `{ offsetMs, expiresAt, ttlMs }` or `null`.
 * @param input.allowClockOverride - whether `POST /clock` is enabled.
 * @returns the `state` object of the SPEC §2.3 envelope.
 */
export function buildState({
  mode,
  now,
  info,
  next,
  waitingTasks = 0,
  clockOverride = null,
  allowClockOverride = true,
} = {}) {
  const resolvedMode = MODES.has(mode) ? mode : 'always'
  const phase = PHASES.has(info?.phase) ? info.phase : 'idle'
  const reason = REASONS.has(info?.reason) ? info.reason : phase === 'peak' ? 'peak' : 'off-hours'
  const nextAt = Number.isFinite(next?.at) ? next.at : now
  const nextPhase = PHASES.has(next?.to) ? next.to : phase === 'peak' ? 'idle' : 'peak'
  const override =
    clockOverride !== null && clockOverride !== undefined && Number.isInteger(clockOverride.offsetMs)
      ? {
          offsetMs: clockOverride.offsetMs,
          expiresAt: Number.isFinite(clockOverride.expiresAt) ? clockOverride.expiresAt : null,
          ttlMs: Number.isInteger(clockOverride.ttlMs) ? clockOverride.ttlMs : null,
        }
      : null
  return {
    mode: resolvedMode,
    phase,
    reason,
    now,
    nowText: formatBeijing(now),
    nextTransitionAt: nextAt,
    nextTransitionText: formatBeijing(nextAt),
    nextPhase,
    msUntilTransition: Math.max(0, nextAt - now),
    paused: resolvedMode === 'idle-only' && phase === 'peak',
    waitingTasks: Number.isInteger(waitingTasks) && waitingTasks > 0 ? waitingTasks : 0,
    holidayToday: info?.holiday ?? null,
    holidayCoverage: info?.holidayCoverage === 'unknown' ? 'unknown' : 'known',
    unknownHolidayYear: Number.isInteger(info?.unknownHolidayYear) ? info.unknownHolidayYear : null,
    timeZone: TIME_ZONE,
    peakWindows: [...PEAK_WINDOWS_TEXT],
    clockOverride: override,
    config: { allowClockOverride: allowClockOverride === true },
  }
}

/**
 * Wrap a state object in the success envelope used by every route.
 * @param state - {@link buildState} result.
 * @returns `{ ok: true, state }`.
 */
export function stateEnvelope(state) {
  return { ok: true, state }
}
