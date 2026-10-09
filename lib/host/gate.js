/**
 * dsh-peak-hours — the peak-window gate.
 *
 * Framework-free by construction: the clock, the schedule core (`classify` /
 * `nextTransition`), the current mode, and the timer factory are all injected.
 * `node:test` therefore drives the exact production semantics with a fake
 * clock (SPEC §2.4, §3.4).
 *
 * Semantics:
 *  - `wait(signal)` resolves immediately when `mode !== 'idle-only'` or the
 *    current phase is `idle` (never holds in `always` mode).
 *  - during a peak window it registers one waiter and arms ONE timer aimed at
 *    the exact `nextTransition().at`; each firing re-evaluates the phase and
 *    releases every waiter when the idle boundary is reached.
 *  - re-arming is floored at 1 Hz, so a stalled/rewound clock cannot spin.
 *  - an abort during the hold rejects the wait with the signal's reason (or a
 *    DOMException `AbortError`), and removes its listener — the abort is never
 *    swallowed.
 *  - nothing in here throws for a non-abort reason: `classify`/`nextTransition`
 *    failures degrade to "do not hold" / "re-check at the 1 Hz floor".
 */

/** Never re-arm a timer faster than this, which is the SPEC's 1 Hz polling floor. */
const DEFAULT_MIN_REARM_MS = 1000

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
 * A gate that holds callers until the schedule leaves a peak window.
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
  #disposed = false

  /**
   * @param options - injected dependencies.
   * @param options.now - `() => epochMs` effective now (override already applied).
   * @param options.classify - `(epochMs) => { phase, ... }` from the schedule core.
   * @param options.nextTransition - `(epochMs) => { at, to }` from the schedule core.
   * @param options.getMode - `() => 'always' | 'idle-only'`.
   * @param options.schedule - `(delayMs, callback) => cancel` timer factory.
   * @param options.onWaitersChange - optional `(count) => void` observer.
   * @param options.minRearmMs - 1 Hz floor (values below 1000 are clamped).
   * @param options.peakLeadMs - optional lead guard: also hold during the last
   *   `peakLeadMs` milliseconds of an idle stretch whose next transition is
   *   INTO a peak window, so a step started one instant before 09:00 does not
   *   run into the window. Defaults to 0 = strict frozen rule (an idle phase
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

  /** Number of tasks currently held (SPEC §2.3 `waitingTasks`). */
  get waiterCount() {
    return this.#waiters.size
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
   * Whether a new waiter would be held right now.
   * @returns `true` only in `idle-only` mode while {@link #shouldHold} agrees.
   */
  isPaused() {
    if (this.#disposed) return false
    if (this.#getMode() !== 'idle-only') return false
    return this.#shouldHold(this.#now())
  }

  /**
   * Hold until the schedule leaves the current peak window.
   * Resolves immediately in `always` mode and, under the strict default
   * (`peakLeadMs === 0`), whenever the phase is idle.
   * @param signal - the caller's abort signal; the wait rejects on abort.
   * @returns a promise settled on release (or rejected on abort).
   */
  async wait(signal) {
    throwIfAborted(signal)
    if (this.#disposed) return
    if (this.#getMode() !== 'idle-only') return
    if (!this.#shouldHold(this.#now())) return
    await this.#hold(signal)
  }

  /**
   * Re-evaluate after an external change (mode write, clock override set or
   * expired): release waiters when the window is over, re-arm otherwise.
   */
  notifyChanged() {
    try {
      this.#reevaluate()
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
  #hold(signal) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null }
      if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
        waiter.onAbort = () => {
          if (!this.#waiters.delete(waiter)) return
          this.#notifyWaiters()
          this.#reevaluate()
          reject(abortErrorOf(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.#waiters.add(waiter)
      this.#notifyWaiters()
      this.#reevaluate()
    })
  }

  /** Release when the window is over, re-arm while it lasts, no-op when empty. */
  #reevaluate() {
    if (this.#disposed) {
      this.#releaseAll()
      return
    }
    if (this.#waiters.size === 0) {
      this.#clearTimer()
      return
    }
    if (this.#getMode() !== 'idle-only') {
      this.#releaseAll()
      return
    }
    if (!this.#shouldHold(this.#now())) {
      this.#releaseAll()
      return
    }
    this.#arm()
  }

  /**
   * Whether the gate must hold at `now`: always inside a peak window, and —
   * only when `peakLeadMs > 0` — during the last milliseconds of an idle
   * stretch that transitions INTO a peak window.
   * @param now - effective epoch ms.
   * @returns whether a waiter is held at that instant.
   */
  #shouldHold(now) {
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

  /** Resolve every waiter and detach its abort listener. */
  #releaseAll() {
    this.#clearTimer()
    if (this.#waiters.size === 0) return
    const waiters = [...this.#waiters]
    this.#waiters.clear()
    this.#notifyWaiters()
    for (const waiter of waiters) this.#settleWaiter(waiter, true)
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

  /** Tell the observer the waiter count moved. */
  #notifyWaiters() {
    if (this.#onWaitersChange === null) return
    try {
      this.#onWaitersChange(this.#waiters.size)
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
