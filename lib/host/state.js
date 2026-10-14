/**
 * dsh-peak-hours — host state snapshot builder.
 *
 * Emits exactly the frozen `GET /api/peak-hours/state` contract: SPEC §2.3 plus
 * the per-session fields of SPEC §9.3 (`sessionId`, `mode` = resolved,
 * `defaultMode`, `modeSource`, `waitingTasks` = this session / global when no
 * session was asked for, `waitingTasksTotal`).
 *
 * Pure: every input is passed in, nothing is read from the ambient clock or the
 * filesystem, so the field set can be asserted in `node:test` directly.
 */

import { formatBeijing } from './clock.js'
import { normalizeSessionId } from './store.js'

/** Reported time zone label (SPEC §2.3). */
export const TIME_ZONE = 'Asia/Shanghai (UTC+8)'

/** Human-readable peak windows (SPEC §1: [540,720) and [840,1080)). */
export const PEAK_WINDOWS_TEXT = Object.freeze(['09:00-12:00', '14:00-18:00'])

const MODES = new Set(['always', 'idle-only'])
const PHASES = new Set(['peak', 'idle'])
const REASONS = new Set(['peak', 'off-hours', 'weekend', 'holiday'])

/**
 * Build the frozen state object.
 * @param input.mode - the resolved mode of the reported session (or `default`).
 * @param input.defaultMode - the host-wide default mode.
 * @param input.modeSource - `'session'` when an override applied, else `'default'`.
 * @param input.sessionId - the reported session, or `null` when none was asked for.
 * @param input.now - effective epoch ms (clock override already applied).
 * @param input.info - `classify(now)` result from the schedule core.
 * @param input.next - `nextTransition(now)` result from the schedule core.
 * @param input.waitingTasks - this session's gate waiters (host-wide when no
 *   session was asked for, per the Lead's 2026-10-14 ruling).
 * @param input.waitingTasksTotal - host-wide gate waiters.
 * @param input.waitingTasksUnresolved - waiters whose session id could not be
 *   resolved (they follow the host default; P1-1 observability).
 * @param input.clockOverride - `{ offsetMs, expiresAt, ttlMs }` or `null`.
 * @param input.allowClockOverride - whether `POST /clock` is enabled.
 * @returns the `state` object of the SPEC §2.3/§9.3 envelope.
 */
export function buildState({
  mode,
  defaultMode,
  modeSource,
  sessionId = null,
  now,
  info,
  next,
  waitingTasks = 0,
  waitingTasksTotal = 0,
  waitingTasksUnresolved = 0,
  clockOverride = null,
  allowClockOverride = true,
} = {}) {
  const resolvedMode = MODES.has(mode) ? mode : 'always'
  const hostDefault = MODES.has(defaultMode) ? defaultMode : resolvedMode
  const requestedSession = normalizeSessionId(sessionId)
  const phase = PHASES.has(info?.phase) ? info.phase : 'idle'
  const reason = REASONS.has(info?.reason) ? info.reason : phase === 'peak' ? 'peak' : 'off-hours'
  const nextAt = Number.isFinite(next?.at) ? next.at : now
  const nextPhase = PHASES.has(next?.to) ? next.to : phase === 'peak' ? 'idle' : 'peak'
  const total = Number.isInteger(waitingTasksTotal) && waitingTasksTotal > 0 ? waitingTasksTotal : 0
  const scoped = Number.isInteger(waitingTasks) && waitingTasks > 0 ? waitingTasks : 0
  const override =
    clockOverride !== null && clockOverride !== undefined && Number.isInteger(clockOverride.offsetMs)
      ? {
          offsetMs: clockOverride.offsetMs,
          expiresAt: Number.isFinite(clockOverride.expiresAt) ? clockOverride.expiresAt : null,
          ttlMs: Number.isInteger(clockOverride.ttlMs) ? clockOverride.ttlMs : null,
        }
      : null
  // Without a session question the only honest answer is the host-wide count
  // (Lead ruling 2026-10-14 on SPEC §9.3).
  const reportedWaits = requestedSession === null ? total : scoped
  return {
    mode: resolvedMode,
    defaultMode: hostDefault,
    modeSource: modeSource === 'session' ? 'session' : 'default',
    sessionId: requestedSession,
    phase,
    reason,
    now,
    nowText: formatBeijing(now),
    nextTransitionAt: nextAt,
    nextTransitionText: formatBeijing(nextAt),
    nextPhase,
    msUntilTransition: Math.max(0, nextAt - now),
    paused: resolvedMode === 'idle-only' && phase === 'peak',
    waitingTasks: reportedWaits,
    waitingTasksTotal: total,
    waitingTasksUnresolved:
      Number.isInteger(waitingTasksUnresolved) && waitingTasksUnresolved > 0 ? waitingTasksUnresolved : 0,
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
