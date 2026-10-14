/**
 * dsh-peak-hours — the peak-window gate (per session, SPEC §9.2).
 *
 * Framework-free by construction: the clock, the schedule core (`classify` /
 * `nextTransition`), the per-session mode resolver, and the timer factory are
 * all injected, so `node:test` drives the exact production semantics with a
 * fake clock.
 *
 * Semantics:
 *  - `wait(signal, sessionId)` resolves immediately when that session's mode is
 *    not `idle-only` or the current phase is `idle` (never holds in `always`).
 *  - during a peak window it registers one waiter **tagged with its session** and
 *    arms ONE timer aimed at the exact `nextTransition().at`; each firing
 *    re-evaluates every waiter against its own session's mode, releasing those
 *    whose window is over and keeping the rest.
 *  - a session's mode change releases only that session's waiters.
 *  - an unresolvable sessionId resolves through the injected `getMode`, which
 *    falls back to the host default — never "silently always allowed" and never
 *    "always held" (SPEC §9.2).
 *  - re-arming is floored at 1 Hz, so a stalled/rewound clock cannot spin.
 *  - an abort during the hold rejects the wait with the signal's reason (or a
 *    DOMException `AbortError`), and removes its listener — the abort is never
 *    swallowed.
 *  - nothing in here throws for a non-abort reason: `classify`/`nextTransition`/
 *    `getMode` failures degrade to "do not hold" / "re-check at the 1 Hz floor".
 */

/** Never re-arm a timer faster than this, which is the SPEC's 1 Hz polling floor. */
const DEFAULT_MIN_REARM_MS = 1000

/** The waiter bucket for a task whose session could not be resolved. */
export const NO_SESSION_KEY = ''

/**
 * The error an aborted wait must reject with: the signal's own reason when it
 * has one, else a fresh `AbortError` (matching `AbortSignal.throwIfAborted()`).
 * @param signal - the aborted signal.
 * @returns an Error or DOMException to throw.
 */
export function abortErrorOf(signal) {
  if (signal?.reason !== undefined && signal?.reason !== null) return signal.reason
  return new DOMException('This operation was aborted', 'AbortError')
}

/**
 * `AbortSignal.throwIfAborted()` without relying on the method existing.
 * @param signal - optional abort signal.
 */
export function throwIfAborted(signal) {
  if (signal === undefined || signal === null) return
  if (signal.aborted === true) throw abortErrorOf(signal)
}

/**
 * Whether a caught error is the abort of `signal` (as opposed to a real bug
 * that must not be mistaken for cancellation).
 * @param error - the caught value.
 * @param signal - the signal the wait was bound to.
 * @returns whether the error represents that abort.
 */
export function isAbortLike(error, signal) {
  if (signal?.aborted === true && (error === signal.reason || error === undefined || error === null)) return true
  if (error instanceof DOMException) return error.name === 'AbortError'
  return error?.name === 'AbortError'
}

/**
 * The bucket key a waiter is accounted under.
 * @param sessionId - the task's session id, when known.
 * @returns the trimmed id, or {@link NO_SESSION_KEY} for an unresolved task.
 */
export function sessionKeyOf(sessionId) {
  if (typeof sessionId !== 'string') return NO_SESSION_KEY
  const trimmed = sessionId.trim()
  return trimmed === '' ? NO_SESSION_KEY : trimmed
}

/**
 * A gate that holds callers until their own session's schedule leaves a peak
 * window.
 */
export class Gate {
  #now
  #classify
  #nextTransition
  #getMode
  #schedule
  #onWaitersChange
  #minRearmMs
  #peakLeadMs
  #log
  #waiters = new Set()
  #cancelTimer = null
  #targetAt = null
  #lastFiredTarget = null
  #loggedUnresolved = false
  #disposed = false

  /**
   * @param options - injected dependencies.
   * @param options.now - `() => epochMs` effective now (override already applied).
   * @param options.classify - `(epochMs) => { phase, ... }` from the schedule core.
   * @param options.nextTransition - `(epochMs) => { at, to }` from the schedule core.
   * @param options.getMode - `(sessionId) => 'always' | 'idle-only'`, already
   *   resolved through `sessions[id]` → `default`.
   * @param options.schedule - `(delayMs, callback) => cancel` timer factory.
   * @param options.onWaitersChange - optional `(total, sessionId) => void` observer.
   * @param options.minRearmMs - 1 Hz floor (values below 1000 are clamped).
   * @param options.peakLeadMs - optional lead guard: also hold during the last
   *   `peakLeadMs` milliseconds of an idle stretch whose next transition is
   *   INTO a peak window. Defaults to 0 = strict frozen rule (an idle phase
   *   never holds).
   * @param options.log - optional logger with `.warn`.
   */
  constructor(options = {}) {
    const {
      now,
      classify,
      nextTransition,
      getMode,
      schedule,
      onWaitersChange = null,
      minRearmMs = DEFAULT_MIN_REARM_MS,
      peakLeadMs = 0,
      log = null,
    } = options
    if (typeof now !== 'function') throw new TypeError('Gate requires now()')
    if (typeof getMode !== 'function') throw new TypeError('Gate requires getMode()')
    this.#now = now
    this.#classify = typeof classify === 'function' ? classify : () => ({ phase: 'idle' })
    this.#nextTransition = typeof nextTransition === 'function' ? nextTransition : () => null
    this.#getMode = getMode
    this.#schedule =
      typeof schedule === 'function'
        ? schedule
        : (delayMs, callback) => {
            const handle = setTimeout(callback, delayMs)
            return () => clearTimeout(handle)
          }
    this.#onWaitersChange = typeof onWaitersChange === 'function' ? onWaitersChange : null
    this.#minRearmMs = Number.isInteger(minRearmMs) && minRearmMs >= DEFAULT_MIN_REARM_MS ? minRearmMs : DEFAULT_MIN_REARM_MS
    this.#peakLeadMs = Number.isInteger(peakLeadMs) && peakLeadMs > 0 ? Math.min(peakLeadMs, 60_000) : 0
    this.#log = log
  }

  /** Host-wide number of held tasks (SPEC §9.3 `waitingTasksTotal`). */
  get waiterCount() {
    return this.#waiters.size
  }

  /**
   * Held tasks whose session could not be resolved (P1-1: the host must be able
   * to see that per-session isolation silently degraded to the default).
   */
  get unresolvedWaiterCount() {
    return this.waiterCountFor(NO_SESSION_KEY)
  }

  /**
   * Number of held tasks of one session (SPEC §9.3 `waitingTasks`).
   * @param sessionId - the session to count; an unresolvable id counts the
   *   "no session" bucket.
   * @returns the waiter count for that bucket.
   */
  waiterCountFor(sessionId) {
    const key = sessionKeyOf(sessionId)
    let count = 0
    for (const waiter of this.#waiters) if (waiter.key === key) count += 1
    return count
  }

  /** Whether a boundary timer is armed (diagnostics; must be 0 after disposal). */
  get timerArmed() {
    return this.#cancelTimer !== null
  }

  /** The transition instant the armed timer targets, or `null`. */
  get targetAt() {
    return this.#targetAt
  }

  /**
   * Whether a new waiter for this session would be held right now.
   * @param sessionId - the task's session id, when known.
   * @returns `true` only when that session's mode is `idle-only` and the phase
   *   (or the optional lead guard) calls for a hold.
   */
  isPaused(sessionId) {
    if (this.#disposed) return false
    return this.#shouldHold(sessionId, this.#now())
  }

  /**
   * Hold until this session's schedule leaves the current peak window.
   * Resolves immediately when the session's mode is not `idle-only`, and —
   * under the strict default (`peakLeadMs === 0`) — whenever the phase is idle.
   * @param signal - the caller's abort signal; the wait rejects on abort.
   * @param sessionId - the owning session; unresolved tasks use the default mode.
   * @returns a promise settled on release (or rejected on abort).
   */
  async wait(signal, sessionId) {
    throwIfAborted(signal)
    if (this.#disposed) return
    if (!this.#shouldHold(sessionId, this.#now())) return
    await this.#hold(signal, sessionId)
  }

  /**
   * Re-evaluate after an external change (a mode write, clock override set or
   * expired): release the waiters whose window is over, re-arm otherwise.
   * @param sessionId - when given, only that session's waiters are re-checked
   *   (a session write cannot disturb another session); omitted = all.
   */
  notifyChanged(sessionId = undefined) {
    try {
      this.#reevaluate(sessionId)
    } catch (error) {
      this.#warn('notifyChanged failed', error)
    }
  }

  /**
   * Release every waiter and cancel the timer. Wired to the plugin fiber so an
   * unload leaves neither a listener nor a timer behind; held turns resume
   * rather than hang (the runtime's own teardown signal governs their fate).
   */
  dispose() {
    this.#disposed = true
    this.#releaseAll()
  }

  /** Register one waiter and make sure the boundary timer is armed. */
  #hold(signal, sessionId) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, key: sessionKeyOf(sessionId), sessionId, onAbort: null }
      if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
        waiter.onAbort = () => {
          if (!this.#waiters.delete(waiter)) return
          this.#notifyWaiters(waiter.key)
          this.#reevaluate()
          reject(abortErrorOf(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.#waiters.add(waiter)
      if (waiter.key === NO_SESSION_KEY && !this.#loggedUnresolved) {
        // P1-1: log once, not per waiter — a missing session id means this task
        // follows the host default, which must be diagnosable rather than silent.
        this.#loggedUnresolved = true
        this.#warn('a gate wait had no resolvable session id and follows the host default mode')
      }
      this.#notifyWaiters(waiter.key)
      this.#reevaluate()
    })
  }

  /**
   * Release the waiters whose session is no longer gated; re-arm while any
   * remain.
   * @param sessionId - restrict the check to one session (its own mode write).
   */
  #reevaluate(sessionId = undefined) {
    if (this.#disposed) {
      this.#releaseAll()
      return
    }
    if (this.#waiters.size === 0) {
      this.#clearTimer()
      return
    }
    // Phase first: an idle window releases everyone, whatever their mode.
    if (!this.#phaseGated(this.#now())) {
      this.#releaseAll()
      return
    }
    // Then each waiter's own session: a session that switched to `always`
    // (or had its override cleared onto an `always` default) is released here,
    // and only here — other sessions stay held on the same single timer.
    for (const waiter of [...this.#waiters]) {
      if (sessionId !== undefined && waiter.key !== sessionKeyOf(sessionId)) continue
      if (this.#modeOf(waiter.sessionId) !== 'idle-only') this.#releaseWaiter(waiter)
    }
    if (this.#waiters.size === 0) {
      this.#clearTimer()
      return
    }
    this.#arm()
  }

  /**
   * Whether the gate must hold at `now` for one session: always inside a peak
   * window, and — only when `peakLeadMs > 0` — during the last milliseconds of
   * an idle stretch that transitions INTO a peak window.
   * @param sessionId - the task's session id, when known.
   * @param now - effective epoch ms.
   * @returns whether a waiter would be held at that instant.
   */
  #shouldHold(sessionId, now) {
    if (this.#modeOf(sessionId) !== 'idle-only') return false
    return this.#phaseGated(now)
  }

  /** Whether the phase alone (ignoring modes) holds anything at `now`. */
  #phaseGated(now) {
    if (this.#phaseAt(now) === 'peak') return true
    if (this.#peakLeadMs <= 0) return false
    const next = this.#transitionAfter(now)
    if (next === null || next.to !== 'peak') return false
    const delta = next.at - now
    return delta > 0 && delta <= this.#peakLeadMs
  }

  /** Arm the single boundary timer at the next transition instant. */
  #arm() {
    const now = this.#now()
    const next = this.#transitionAfter(now)
    const at = next !== null && Number.isFinite(next.at) ? next.at : null
    if (at === null) {
      // Unknown schedule: never spin, re-check at the 1 Hz floor.
      this.#setTimer(this.#minRearmMs, now + this.#minRearmMs)
      return
    }
    let delay = at - now
    // A transition that did not move after firing (stalled/rewound clock or a
    // degenerate schedule) is retried at the 1 Hz floor instead of spinning.
    if (delay <= 0 || at === this.#lastFiredTarget) delay = this.#minRearmMs
    this.#setTimer(delay, now + delay)
  }

  /** Replace the armed timer (there is never more than one). */
  #setTimer(delayMs, targetAt) {
    this.#clearTimer()
    this.#targetAt = targetAt
    this.#cancelTimer = this.#schedule(delayMs, () => {
      this.#cancelTimer = null
      this.#lastFiredTarget = this.#targetAt
      try {
        this.#reevaluate()
      } catch (error) {
        this.#warn('gate timer failed', error)
      }
    })
  }

  /** Cancel the armed timer, if any. */
  #clearTimer() {
    const cancel = this.#cancelTimer
    this.#cancelTimer = null
    this.#targetAt = null
    if (cancel === null || cancel === undefined) return
    try {
      cancel()
    } catch (error) {
      this.#warn('timer disposer failed', error)
    }
  }

  /** Release every waiter and detach its abort listener. */
  #releaseAll() {
    this.#clearTimer()
    if (this.#waiters.size === 0) return
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    for (const waiter of waiters) this.#settleWaiter(waiter, true)
    this.#notifyWaiters()
  }

  /** Release exactly one waiter. */
  #releaseWaiter(waiter) {
    if (!this.#waiters.delete(waiter)) return
    this.#settleWaiter(waiter, true)
    this.#notifyWaiters(waiter.key)
  }

  /** Detach one waiter's abort listener and resolve it. */
  #settleWaiter(waiter, resolve) {
    if (waiter.signal !== null && waiter.signal !== undefined && waiter.onAbort !== null) {
      try {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      } catch (error) {
        this.#warn('abort listener removal failed', error)
      }
      waiter.onAbort = null
    }
    if (resolve) waiter.resolve()
  }

  /** Best-effort phase lookup; a broken classifier must not throw into a turn. */
  #phaseAt(epochMs) {
    try {
      const info = this.#classify(epochMs)
      return info?.phase === 'peak' ? 'peak' : 'idle'
    } catch (error) {
      this.#warn('classify failed; treating as idle', error)
      return 'idle'
    }
  }

  /** Best-effort transition lookup; `null` means "no known boundary". */
  #transitionAfter(epochMs) {
    try {
      const next = this.#nextTransition(epochMs)
      return next !== null && next !== undefined && Number.isFinite(next.at) ? next : null
    } catch (error) {
      this.#warn('nextTransition failed; re-checking at 1 Hz', error)
      return null
    }
  }

  /** Best-effort mode lookup; a broken resolver fails open (never holds). */
  #modeOf(sessionId) {
    try {
      return this.#getMode(sessionId) === 'idle-only' ? 'idle-only' : 'always'
    } catch (error) {
      this.#warn('getMode failed; treating the session as always', error)
      return 'always'
    }
  }

  /** Tell the observer the waiter count moved. */
  #notifyWaiters(sessionId = undefined) {
    if (this.#onWaitersChange === null) return
    try {
      this.#onWaitersChange(this.#waiters.size, sessionId)
    } catch (error) {
      this.#warn('waiter observer failed', error)
    }
  }

  /** Log a swallowed internal failure without ever throwing. */
  #warn(message, error) {
    try {
      this.#log?.warn?.(`peak-hours gate: ${message}`, error)
    } catch {
      /* logging must never break the gate */
    }
  }
}
