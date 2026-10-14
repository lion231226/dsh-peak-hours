/**
 * dsh-peak-hours — per-session mode persistence (SPEC §9.1).
 *
 * The state file is v2:
 *
 *   { "version": 2, "default": "always", "sessions": { "<sessionId>": "idle-only" } }
 *
 * Reading is best-effort and total: a missing, unreadable, corrupt, or
 * unrecognized file falls back to `{ default: 'always', sessions: {} }`, logs
 * once, and never throws. A v1 file (`{ mode }`) migrates in place — `default`
 * becomes that mode, `sessions` starts empty, and the upgrade is written back —
 * with one log line. Writing is atomic (unique temp file + rename) and equally
 * non-throwing: a failed write leaves the in-memory state in force and only
 * logs. Writes are serialized so rapid toggles cannot interleave.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** File name under DSH_HOME. */
export const STATE_FILE_NAME = 'peak-hours-state.json'

/** Persisted schema version (SPEC §9.1). */
export const STATE_VERSION = 2

/** Fallback mode for every degraded path. */
export const DEFAULT_MODE = 'always'

/** Upper bound on remembered per-session overrides (SPEC §9.6, LRU-by-set). */
export const MAX_SESSIONS = 500

/** Upper bound on one session id (SEC-7: also enforced when loading a file). */
export const MAX_SESSION_ID_LENGTH = 128

/**
 * Ids that would silently corrupt a plain-object table (`__proto__` assignment
 * is a no-op on a normal object, `constructor`/`prototype` shadow built-ins).
 * SPEC §9.6: rejected with 400 rather than silently dropped.
 */
export const RESERVED_SESSION_IDS = Object.freeze(['__proto__', 'constructor', 'prototype'])

/** The only two accepted modes. */
export const MODES = Object.freeze(['always', 'idle-only'])

/**
 * Whether a value is a persisted mode literal.
 * @param value - candidate.
 * @returns whether it is `always` or `idle-only`.
 */
export function isMode(value) {
  return value === 'always' || value === 'idle-only'
}

/**
 * Normalize a session id. An absent/blank/invalid id means "no session" — the
 * lenient form used for lookups and for the `?session=` query.
 * @param value - candidate session id.
 * @returns the trimmed id, or `null`.
 */
export function normalizeSessionId(value) {
  return sanitizeSessionId(value).id
}

/**
 * Validate a session id, distinguishing "absent" from "present but invalid".
 * @param value - candidate session id.
 * @returns `{ id, error }` — `error` is a message only for a present-but-invalid
 *   value (too long, reserved, wrong type); a blank id is an error as well
 *   because it was explicitly supplied.
 */
export function sanitizeSessionId(value) {
  if (value === undefined || value === null) return { id: null, error: null }
  if (typeof value !== 'string') return { id: null, error: 'session must be a string' }
  const trimmed = value.trim()
  if (trimmed === '') return { id: null, error: 'session must be a non-empty string' }
  if (trimmed.length > MAX_SESSION_ID_LENGTH) {
    return { id: null, error: `session id is longer than ${MAX_SESSION_ID_LENGTH} characters` }
  }
  if (RESERVED_SESSION_IDS.includes(trimmed)) return { id: null, error: `session id "${trimmed}" is reserved` }
  return { id: trimmed, error: null }
}

/**
 * Resolve DSH_HOME: the `DSH_HOME` env var, else `~/.dsh`.
 * @param env - environment bag.
 * @param home - home directory.
 * @returns the DSH home directory.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const explicit = env?.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  return join(home, '.dsh')
}

/**
 * Resolve the state file path.
 * @param options.env - environment bag.
 * @param options.home - home directory.
 * @returns the absolute state file path.
 */
export function resolveStatePath({ env = process.env, home = homedir() } = {}) {
  return join(resolveDshHome(env, home), STATE_FILE_NAME)
}

/** Human-readable error text for one log line. */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Normalize one parsed state file into the v2 shape.
 *
 * Session overrides are held in a `Map` so recency follows the real write order
 * (SPEC §9.6 LRU-by-set): a plain object enumerates integer-like keys in
 * ascending numeric order, which is what made the previous eviction pick the
 * numerically smallest id instead of the least recently written one. On load
 * the file's textual order is used, with the documented caveat that
 * integer-like ids come back in numeric order because JSON objects carry no
 * other order for them.
 *
 * @param parsed - parsed JSON (any shape).
 * @param fallback - fallback default mode.
 * @returns `{ state, migrated, degraded, note }` — `migrated` marks a v1 upgrade,
 *   `degraded` a corrupt/unrecognized file, `state.sessions` is a `Map`.
 */
export function normalizeState(parsed, fallback = DEFAULT_MODE) {
  const base = () => ({ version: STATE_VERSION, default: fallback, sessions: new Map() })
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: base(), migrated: false, degraded: true, note: `not a JSON object (${JSON.stringify(parsed ?? null)})` }
  }
  const sessions = new Map()
  const rawSessions = parsed.sessions
  if (rawSessions !== null && typeof rawSessions === 'object' && !Array.isArray(rawSessions)) {
    for (const key of Object.keys(rawSessions)) {
      const { id, error } = sanitizeSessionId(key)
      if (id !== null && error === null && isMode(rawSessions[key])) sessions.set(id, rawSessions[key])
    }
  }
  const hasV2Fields = parsed.version === STATE_VERSION || Object.hasOwn(parsed, 'default') || Object.hasOwn(parsed, 'sessions')
  if (hasV2Fields) {
    const defaultMode = isMode(parsed.default) ? parsed.default : fallback
    const degraded = !isMode(parsed.default)
    return {
      state: { version: STATE_VERSION, default: defaultMode, sessions },
      migrated: false,
      degraded,
      note: degraded ? `unrecognized default ${JSON.stringify(parsed.default ?? null)}` : '',
    }
  }
  // v1: { mode } — the old host-wide choice becomes the default.
  if (isMode(parsed.mode)) {
    return {
      state: { version: STATE_VERSION, default: parsed.mode, sessions: new Map() },
      migrated: true,
      degraded: false,
      note: `v1 mode "${parsed.mode}" migrated to default`,
    }
  }
  return { state: base(), migrated: false, degraded: true, note: `unrecognized mode ${JSON.stringify(parsed.mode ?? null)}` }
}

/**
 * Create the per-session mode store.
 * @param options.file - absolute state file path.
 * @param options.logger - optional logger (`info`/`warn`).
 * @param options.fs - injected `{ readFile, writeFile, rename, mkdir, rm }` (tests).
 * @param options.defaultMode - fallback default mode.
 * @param options.maxSessions - per-session override cap.
 * @returns `{ file, read, snapshot, modeFor, defaultMode, setMode, clearSession }`.
 */
export function createModeStore({ file, logger = null, fs = null, defaultMode = DEFAULT_MODE, maxSessions = MAX_SESSIONS } = {}) {
  const io = fs ?? { readFile, writeFile, rename, mkdir, rm }
  const fallback = isMode(defaultMode) ? defaultMode : DEFAULT_MODE
  let state = null
  let loggedFallback = false
  /** Serializes writes so two rapid mode toggles cannot interleave. */
  let queue = Promise.resolve()
  /** Makes every temporary path unique, even across processes. */
  let writeSequence = 0

  const logOnce = (level, message) => {
    if (loggedFallback) return
    loggedFallback = true
    try {
      const sink = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : null
      sink?.(`[peak-hours] ${message}`)
    } catch {
      /* logging must never break state loading */
    }
  }

  /** The exact bytes persisted for the current in-memory state. */
  const serialize = (value) =>
    `${JSON.stringify({ version: STATE_VERSION, default: value.default, sessions: toPlainSessions(value.sessions) }, null, 2)}\n`

  /** One atomic write. Runs strictly after the previous write settled. */
  const persist = async () => {
    const temporary = `${file}.${process.pid}.${(writeSequence += 1)}.tmp`
    try {
      await io.mkdir(dirname(file), { recursive: true })
      await io.writeFile(temporary, serialize(state), 'utf8')
      await io.rename(temporary, file)
      return true
    } catch (error) {
      try {
        await io.rm?.(temporary, { force: true })
      } catch {
        /* the temp file may never have been created */
      }
      try {
        logger?.warn?.(`[peak-hours] could not persist state to ${file}: ${errorText(error)}`)
      } catch {
        /* ignore */
      }
      return false
    }
  }

  /** Queue one write of the current in-memory state. */
  const enqueuePersist = () => {
    const task = queue.then(
      () => persist(),
      () => persist(),
    )
    queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  /**
   * Evict the least recently written session overrides once the cap is exceeded
   * (SPEC §9.6 LRU-by-set). The table is a `Map`, so its key order is the true
   * write order — a plain object would enumerate integer-like ids ascending and
   * drop the wrong entry. Each evicted session is logged once.
   */
  const enforceCap = () => {
    const limit = Number.isInteger(maxSessions) && maxSessions > 0 ? maxSessions : MAX_SESSIONS
    while ((state?.sessions?.size ?? 0) > limit) {
      const oldest = state.sessions.keys().next().value
      state.sessions.delete(oldest)
      try {
        logger?.info?.(
          `[peak-hours] evicted the least recently written session override "${oldest}"; the table is capped at ${limit}`,
        )
      } catch {
        /* ignore */
      }
    }
  }

  /** A fresh empty v2 state whose session table is a recency-ordered Map. */
  const emptyState = () => ({ version: STATE_VERSION, default: fallback, sessions: new Map() })

  /** Convert the recency-ordered table into a null-prototype plain object. */
  const toPlainSessions = (map) => {
    const out = Object.create(null)
    for (const [id, mode] of map) out[id] = mode
    return out
  }

  return {
    /** Path this store persists to. */
    file,
    /**
     * Load the persisted state once, then serve the cached value.
     * A v1 file is migrated (and the upgrade written back); a corrupt or
     * unreadable file degrades to `{ default, sessions: {} }`. Never throws.
     * @returns the in-memory v2 state.
     */
    async read() {
      if (state !== null) return state
      let text
      try {
        text = await io.readFile(file, 'utf8')
      } catch (error) {
        state = emptyState()
        if (error?.code === 'ENOENT') logOnce('info', `no state file at ${file}; defaulting to mode "${fallback}"`)
        else logOnce('warn', `state file ${file} is unreadable (${errorText(error)}); defaulting to mode "${fallback}"`)
        return state
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        state = emptyState()
        logOnce('warn', `state file ${file} is corrupt (${errorText(error)}); defaulting to mode "${fallback}"`)
        return state
      }
      const result = normalizeState(parsed, fallback)
      state = result.state
      if (result.migrated) {
        logOnce('info', `state file ${file}: ${result.note}`)
        await enqueuePersist()
      } else if (result.degraded) {
        logOnce('warn', `state file ${file}: ${result.note}; defaulting to "${fallback}"`)
      }
      return state
    },
    /**
     * A copy of the in-memory state (safe to hand out). `sessions` is a
     * null-prototype object so a hostile id can never reach `Object.prototype`.
     * @returns `{ version, default, sessions }`.
     */
    snapshot() {
      const current = state ?? emptyState()
      return { version: STATE_VERSION, default: current.default, sessions: toPlainSessions(current.sessions) }
    },
    /**
     * Resolve one session's mode (SPEC §9.2): `sessions[id]` → `default`.
     * An absent/blank/invalid id resolves to `default`.
     * @param sessionId - the task's session id, when known.
     * @returns `{ mode, source: 'session' | 'default' }`.
     */
    modeFor(sessionId) {
      const current = state ?? emptyState()
      const id = normalizeSessionId(sessionId)
      if (id !== null && isMode(current.sessions.get(id))) return { mode: current.sessions.get(id), source: 'session' }
      return { mode: current.default, source: 'default' }
    },
    /** The host-wide default mode. */
    get defaultMode() {
      return (state ?? { default: fallback }).default
    },
    /**
     * Persist a mode. The in-memory value changes synchronously — before the
     * queued disk write — so the running gate always matches the last request.
     * Writing a session's mode refreshes its recency (SPEC §9.6 LRU-by-set).
     * @param mode - `always` or `idle-only`.
     * @param sessionId - the session to override; `null`/absent writes `default`.
     *   A present-but-invalid id is refused (returns false) and never falls back
     *   to writing the default (SEC-2).
     * @returns whether this write landed.
     */
    setMode(mode, sessionId = null) {
      if (!isMode(mode)) return Promise.resolve(false)
      const target = state ?? (state = emptyState())
      if (sessionId === null || sessionId === undefined) {
        target.default = mode
        return enqueuePersist()
      }
      const { id, error } = sanitizeSessionId(sessionId)
      if (id === null || error !== null) return Promise.resolve(false)
      target.sessions.delete(id)
      target.sessions.set(id, mode)
      enforceCap()
      return enqueuePersist()
    },
    /**
     * Drop one session override so it follows `default` again.
     * @param sessionId - the session to clear.
     * @returns whether this write landed.
     */
    clearSession(sessionId) {
      const target = state ?? (state = emptyState())
      const { id, error } = sanitizeSessionId(sessionId)
      if (id === null || error !== null) return Promise.resolve(false)
      target.sessions.delete(id)
      return enqueuePersist()
    },
  }
}
