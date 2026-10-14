/**
 * dsh-peak-hours — host clock with an expiring manual override.
 *
 * Framework-free: the real "now" reader and the timer factory are injected so
 * `node:test` can drive this module with a deterministic fake clock. The
 * override exists for live verification of the gate; it is deliberately
 * TTL-bounded (SPEC §2.3 safety addendum) because pretending "now" is a peak
 * window would otherwise hold every gated task — including the session that
 * installed the override — until the next real idle boundary.
 */

/** Beijing is fixed UTC+8, no DST (SPEC §1). */
export const BJ_OFFSET_MS = 8 * 3600 * 1000

/** Auto-expiry applied when `POST /clock` omits `ttlMs` (10 minutes). */
export const DEFAULT_CLOCK_TTL_MS = 600_000

/**
 * Hard ceiling on an override TTL (SEC-6): a clock override moves the host-wide
 * clock, so an unbounded TTL would strand every idle-only session for as long
 * as its author asked. 30 minutes.
 */
export const MAX_CLOCK_TTL_MS = 30 * 60_000

/** Zero-pad one non-negative integer to two digits. */
function pad2(value) {
  return value < 10 ? `0${String(value)}` : String(value)
}

/**
 * Render one epoch millisecond value as a Beijing-time string.
 * @param epochMs - epoch milliseconds.
 * @returns `YYYY-MM-DD HH:mm:ss` in UTC+8 (SPEC §2.3 `nowText`).
 */
export function formatBeijing(epochMs) {
  const d = new Date(Number(epochMs) + BJ_OFFSET_MS)
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  return `${date} ${time}`
}

/**
 * Normalize an offset: only an integer or an explicit null/undefined passes.
 * @param value - candidate offset in milliseconds.
 * @returns the integer offset, or `null` when unset/invalid.
 */
export function normalizeOffsetMs(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value
}

/**
 * Normalize an override TTL.
 * @param value - candidate TTL in milliseconds; `undefined`/`null` uses `fallback`.
 * @param fallback - default TTL.
 * @param max - hard ceiling (SEC-6); a larger value is invalid.
 * @returns a positive integer TTL, or `null` when the value is invalid.
 */
export function normalizeTtlMs(value, fallback = DEFAULT_CLOCK_TTL_MS, max = MAX_CLOCK_TTL_MS) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  if (Number.isInteger(max) && max > 0 && value > max) return null
  return value
}

/**
 * Whether the manual clock override is allowed on this machine.
 * `DSH_PEAK_HOURS_ALLOW_CLOCK=0` disables it (SPEC §2.3); anything else allows it.
 * @param env - environment bag (defaults to `process.env`).
 * @returns whether `POST /clock` may install an override.
 */
export function allowClockOverrideFromEnv(env = process.env) {
  const raw = env?.DSH_PEAK_HOURS_ALLOW_CLOCK
  return raw === undefined || raw === null || String(raw) !== '0'
}

/**
 * Create the host clock.
 * @param options - injected dependencies.
 * @param options.readNow - real wall-clock reader (ms).
 * @param options.schedule - `(delayMs, callback) => cancel`; when omitted a TTL
 *   is still recorded but never fires (tests that only inspect state pass their
 *   own scheduler).
 * @param options.onExpire - called once when a TTL expires (after the override
 *   was cleared), so the caller can log and re-evaluate the gate.
 * @returns the clock: `now()`, `offsetMs`, `override`, `setOffsetMs()`, `dispose()`.
 */
export function createClock({ readNow = () => Date.now(), schedule = null, onExpire = null } = {}) {
  let offsetMs = null
  let expiresAt = null
  let ttlMs = null
  let cancelExpiry = null

  const clearExpiry = () => {
    if (cancelExpiry === null) return
    const cancel = cancelExpiry
    cancelExpiry = null
    try {
      cancel()
    } catch {
      /* a failing timer disposer must never surface: the clock is on the request path */
    }
  }

  const clock = {
    /** Effective "now" in epoch milliseconds, including any override. */
    now: () => readNow() + (offsetMs ?? 0),
    /** Raw wall clock, ignoring the override. */
    realNow: () => readNow(),
    /** Current offset, or `null` when no override is installed. */
    get offsetMs() {
      return offsetMs
    },
    /** SPEC §2.3 `clockOverride` payload, or `null`. */
    get override() {
      return offsetMs === null ? null : { offsetMs, expiresAt, ttlMs }
    },
    /**
     * Install or clear the override. Setting an offset always arms its TTL;
     * clearing cancels it. Never throws for valid input.
     * @param next - integer offset or `null` to clear.
     * @param options - `ttlMs` (default {@link DEFAULT_CLOCK_TTL_MS}).
     * @returns the new `override` payload (or `null`).
     */
    setOffsetMs(next, options = {}) {
      const normalized = normalizeOffsetMs(next)
      clearExpiry()
      if (normalized === null) {
        offsetMs = null
        expiresAt = null
        ttlMs = null
        return null
      }
      const ttl = normalizeTtlMs(options.ttlMs)
      if (ttl === null) throw new RangeError('ttlMs must be a positive integer')
      offsetMs = normalized
      ttlMs = ttl
      expiresAt = readNow() + ttl
      if (typeof schedule === 'function') {
        cancelExpiry = schedule(ttl, () => {
          cancelExpiry = null
          offsetMs = null
          expiresAt = null
          ttlMs = null
          try {
            onExpire?.({ reason: 'ttl' })
          } catch {
            /* an expiry hook must never throw out of a timer callback */
          }
        })
      }
      return clock.override
    },
    /** Drop the override and its timer. Safe to call repeatedly. */
    dispose() {
      clearExpiry()
      offsetMs = null
      expiresAt = null
      ttlMs = null
    },
  }
  return clock
}
