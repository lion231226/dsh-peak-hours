/**
 * dsh-peak-hours — mode persistence.
 *
 * The mode lives in `<DSH_HOME>/peak-hours-state.json` (SPEC §2.4). Reading is
 * best-effort and total: a missing, unreadable, corrupt, or unrecognized file
 * falls back to `always`, logs once, and never throws. Writing is atomic
 * (temp file + rename) and equally non-throwing: a failed write leaves the
 * in-memory mode in force and only logs.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** File name under DSH_HOME. */
export const STATE_FILE_NAME = 'peak-hours-state.json'

/** Fallback mode for every degraded path (SPEC §2.4). */
export const DEFAULT_MODE = 'always'

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
 * Create the mode store.
 * @param options.file - absolute state file path.
 * @param options.logger - optional logger (`info`/`warn`).
 * @param options.fs - injected `{ readFile, writeFile, rename, mkdir }` (tests).
 * @param options.defaultMode - fallback mode.
 * @returns `{ read, peek, write }`.
 */
export function createModeStore({ file, logger = null, fs = null, defaultMode = DEFAULT_MODE } = {}) {
  const io = fs ?? { readFile, writeFile, rename, mkdir, rm }
  const fallback = isMode(defaultMode) ? defaultMode : DEFAULT_MODE
  let cached = null
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

  /** One atomic write. Runs strictly after the previous write settled. */
  const persist = async (mode) => {
    const temporary = `${file}.${process.pid}.${(writeSequence += 1)}.tmp`
    try {
      await io.mkdir(dirname(file), { recursive: true })
      await io.writeFile(temporary, `${JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
      await io.rename(temporary, file)
      return true
    } catch (error) {
      try {
        await io.rm?.(temporary, { force: true })
      } catch {
        /* the temp file may never have been created */
      }
      try {
        logger?.warn?.(`[peak-hours] could not persist mode to ${file}: ${errorText(error)}`)
      } catch {
        /* ignore */
      }
      return false
    }
  }

  return {
    /** Path this store persists to. */
    file,
    /**
     * Read the persisted mode once, then serve the cached value.
     * @returns the mode, never throwing.
     */
    async read() {
      if (cached !== null) return cached
      let text
      try {
        text = await io.readFile(file, 'utf8')
      } catch (error) {
        cached = fallback
        if (error?.code === 'ENOENT') logOnce('info', `no state file at ${file}; defaulting to mode "${fallback}"`)
        else logOnce('warn', `state file ${file} is unreadable (${errorText(error)}); defaulting to mode "${fallback}"`)
        return cached
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        cached = fallback
        logOnce('warn', `state file ${file} is corrupt (${errorText(error)}); defaulting to mode "${fallback}"`)
        return cached
      }
      if (isMode(parsed?.mode)) {
        cached = parsed.mode
        return cached
      }
      cached = fallback
      logOnce('warn', `state file ${file} has an unrecognized mode ${JSON.stringify(parsed?.mode ?? null)}; defaulting to "${fallback}"`)
      return cached
    },
    /**
     * The mode currently in force without touching the disk.
     * @returns the cached mode, or the fallback before the first read.
     */
    peek() {
      return cached ?? fallback
    },
    /**
     * Persist a mode atomically. The in-memory value changes synchronously —
     * before the queued disk write — so the running gate always matches the
     * last request even while writes are still in flight. Writes are
     * serialized and use a unique temporary path, so two rapid toggles cannot
     * truncate each other's temp file or publish a half-written state file;
     * the last call wins on disk.
     * @param mode - `always` or `idle-only`.
     * @returns whether this write landed.
     */
    write(mode) {
      if (!isMode(mode)) return Promise.resolve(false)
      cached = mode
      const task = queue.then(
        () => persist(mode),
        () => persist(mode),
      )
      queue = task.then(
        () => undefined,
        () => undefined,
      )
      return task
    },
  }
}
