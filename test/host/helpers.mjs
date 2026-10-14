/**
 * Shared, dependency-free test doubles for the host half.
 *
 * Everything the host modules touch is injected in production too (clock,
 * schedule core, timer factory), so these doubles exercise the real code paths
 * rather than a parallel implementation.
 */

import { Gate } from '../../lib/host/gate.js'
import { createClock } from '../../lib/host/clock.js'

/** Beijing is fixed UTC+8. */
export const BJ_OFFSET_MS = 8 * 3600 * 1000

/** Epoch ms of one Beijing `YYYY-MM-DD` / `HH:mm:ss` wall-clock instant. */
export function bj(dateKey, time = '00:00:00') {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hours, minutes, seconds] = time.split(':').map(Number)
  return Date.UTC(year, month - 1, day, hours, minutes, seconds) - BJ_OFFSET_MS
}

/** Two-digit pad. */
function pad2(value) {
  return value < 10 ? `0${String(value)}` : String(value)
}

/**
 * A minimal, fully deterministic schedule core with the SPEC §1 windows and an
 * optional holiday set (the real core is exercised separately, when present).
 */
export function createFakeSchedule({ holidays = [] } = {}) {
  const holidaySet = new Set(holidays)
  const classify = (epochMs) => {
    const d = new Date(epochMs + BJ_OFFSET_MS)
    const dateKey = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
    const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes()
    const weekday = d.getUTCDay()
    const holiday = holidaySet.has(dateKey) ? { dateKey, name: 'fake holiday' } : null
    const inWindow = (minuteOfDay >= 540 && minuteOfDay < 720) || (minuteOfDay >= 840 && minuteOfDay < 1080)
    const peak = holiday === null && weekday >= 1 && weekday <= 5 && inWindow
    const reason = peak ? 'peak' : holiday !== null ? 'holiday' : weekday === 0 || weekday === 6 ? 'weekend' : 'off-hours'
    return {
      phase: peak ? 'peak' : 'idle',
      reason,
      dateKey,
      minuteOfDay,
      weekday,
      holiday,
      holidayCoverage: 'known',
      unknownHolidayYear: null,
    }
  }
  const nextTransition = (epochMs) => {
    const startPhase = classify(epochMs).phase
    const first = Math.floor(epochMs / 60_000) * 60_000 + 60_000
    for (let at = first; at <= first + 15 * 24 * 60 * 60_000; at += 60_000) {
      const phase = classify(at).phase
      if (phase !== startPhase) return { at, to: phase }
    }
    return { at: first, to: startPhase === 'peak' ? 'idle' : 'peak' }
  }
  return { classify, nextTransition }
}

/**
 * Manual timer registry: nothing fires until the owning test moves `now` and
 * calls `advanceTo`/`advanceBy`, which makes boundary exactness provable.
 */
export function createFakeTimers(startMs) {
  let now = startMs
  let sequence = 0
  const timers = new Set()
  const schedule = (delayMs, callback) => {
    const timer = { id: ++sequence, at: now + Math.max(0, delayMs), delayMs, callback, cancelled: false }
    timers.add(timer)
    return () => {
      timer.cancelled = true
      timers.delete(timer)
    }
  }
  const live = () => [...timers].filter((timer) => !timer.cancelled).sort((a, b) => a.at - b.at || a.id - b.id)
  const fireDue = () => {
    let fired = 0
    for (const timer of live()) {
      if (timer.cancelled || timer.at > now) continue
      timer.cancelled = true
      timers.delete(timer)
      timer.callback()
      fired += 1
    }
    return fired
  }
  return {
    schedule,
    now: () => now,
    setNow: (value) => {
      now = value
    },
    advanceTo: (value) => {
      if (value < now) throw new Error(`fake timers cannot move backwards (${value} < ${now})`)
      now = value
      return fireDue()
    },
    advanceBy: (delta) => {
      now += delta
      return fireDue()
    },
    fireDue,
    get liveTimers() {
      return live()
    },
    get liveTimerCount() {
      return live().length
    },
  }
}

/**
 * A gate wired to fake timers plus the fake schedule.
 * @param options.sessionModes - when given, per-session overrides with `mode` as
 *   the host default (mirrors `sessions[id]` → `default`); when omitted every
 *   session uses `mode`.
 */
export function createFakeGate({
  startMs,
  mode = 'idle-only',
  sessionModes = null,
  peakLeadMs = 0,
  schedule = createFakeSchedule(),
  classify,
  nextTransition,
  getMode: getModeOverride,
  log = null,
} = {}) {
  const timers = createFakeTimers(startMs)
  let currentMode = mode
  const overrides = sessionModes === null ? null : { ...sessionModes }
  const getMode =
    typeof getModeOverride === 'function'
      ? getModeOverride
      : (sessionId) => {
          if (overrides === null) return currentMode
          const id = typeof sessionId === 'string' ? sessionId.trim() : ''
          if (id !== '' && overrides[id] !== undefined) return overrides[id]
          return currentMode
        }
  const gate = new Gate({
    now: () => timers.now(),
    classify: classify ?? schedule.classify,
    nextTransition: nextTransition ?? schedule.nextTransition,
    getMode,
    schedule: timers.schedule,
    peakLeadMs,
    log,
  })
  return {
    timers,
    gate,
    schedule,
    /** Set the host default mode (used by sessions without an override). */
    setMode: (next) => {
      currentMode = next
    },
    /** Set/clear one session override. */
    setSessionMode: (sessionId, next) => {
      if (overrides === null) return
      if (next === undefined || next === null) delete overrides[sessionId]
      else overrides[sessionId] = next
    },
    modeFor: getMode,
    get mode() {
      return currentMode
    },
  }
}

/** A clock wired to fake timers (same time base as {@link createFakeGate}). */
export function createFakeClock(timers, { onExpire = null } = {}) {
  return createClock({ readNow: () => timers.now(), schedule: timers.schedule, onExpire })
}

/** Resolve after the microtask queue and the check phase drain. */
export async function flush(rounds = 2) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** Non-invasive promise observer. */
export function observe(promise) {
  const record = { status: 'pending', value: undefined, error: undefined }
  promise.then(
    (value) => {
      record.status = 'resolved'
      record.value = value
    },
    (error) => {
      record.status = 'rejected'
      record.error = error
    },
  )
  return record
}

/**
 * Mirror of cordis's `safeCollect` for the value a plugin's `apply()` resolves
 * with (cordis/lib/index.js:1138-1145, reached through `Fiber._reload` at
 * :1356). A function is taken as a disposer, null/undefined as "no cleanup",
 * and anything else fails the whole fiber with `TypeError: Invalid effect`.
 * @param value - the resolved plugin result.
 * @returns `'disposer'` or `'none'` when cordis would accept it.
 */
export function acceptPluginResult(value) {
  if (typeof value === 'function') return 'disposer'
  if (value === null || value === undefined) return 'none'
  throw new TypeError('Invalid effect')
}

/**
 * A minimal cordis-context double: records listeners/effects/routes exactly the
 * way the runtime's `ctx.on`, `ctx.effect` and `ctx.webServer.register` do.
 */
export function createFakeCtx({ timers = null, agents = undefined } = {}) {
  const listeners = new Map()
  const routes = new Map()
  const effects = []
  const logs = []
  const record = (level) => (...args) => {
    logs.push({ level, message: args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ') })
  }
  const logger = { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
  const ctx = {
    logger,
    ...(agents === undefined ? {} : { agents }),
    timer: timers === null ? undefined : { timeout: (callback, delayMs) => timers.schedule(delayMs, callback) },
    on(event, handler, options = {}) {
      const entry = { handler, options, active: true }
      const list = listeners.get(event) ?? []
      if (options.prepend) list.unshift(entry)
      else list.push(entry)
      listeners.set(event, list)
      return () => {
        if (!entry.active) return
        entry.active = false
        const live = listeners.get(event) ?? []
        const at = live.indexOf(entry)
        if (at !== -1) live.splice(at, 1)
      }
    },
    effect(run, label) {
      const dispose = run()
      // Faithful to cordis's safeCollect: an effect body may return a disposer
      // or nothing at all, never an arbitrary value.
      acceptPluginResult(dispose)
      const entry = { label, dispose, active: true }
      effects.push(entry)
      return () => {
        if (!entry.active) return
        entry.active = false
        if (typeof dispose === 'function') dispose()
      }
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const activeListeners = (event) => (listeners.get(event) ?? []).filter((entry) => entry.active)
  const invokeWith = async (event, thisArg, args) => {
    const list = activeListeners(event)
    const innermost = async () => ({ kind: 'enter', messages: [] })
    let index = -1
    const next = () => {
      index += 1
      const entry = list[index]
      return entry === undefined ? innermost() : entry.handler.apply(thisArg, [...args, next])
    }
    return await next()
  }
  return {
    ctx,
    listeners,
    routes,
    effects,
    logs,
    activeListeners,
    /** Drive one waterfall exactly like cordis: outermost listener first, `next()` descends. */
    async invoke(event, ...args) {
      return await invokeWith(event, undefined, args)
    },
    /**
     * Drive one waterfall with an explicit `this`, mirroring cordis's
     * `hook.callback.bind(thisArg)` (cordis/lib/index.js:259-263) where the
     * bound receiver is the dispatch carrier.
     */
    async invokeBound(event, thisArg, ...args) {
      return await invokeWith(event, thisArg, args)
    },
    /** Dispose every effect in reverse registration order, like the fiber does. */
    disposeAll() {
      for (const entry of [...effects].reverse()) {
        if (!entry.active) continue
        entry.active = false
        try {
          entry.dispose?.()
        } catch {
          /* mirror the runtime: disposal failures are contained */
        }
      }
    },
  }
}

/** A fake `IncomingMessage` with an async-iterable body. */
export function createFakeRequest({
  method = 'GET',
  url = '/',
  body = undefined,
  remoteAddress = '127.0.0.1',
  host = '127.0.0.1:19387',
  headers = {},
} = {}) {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = raw === '' ? [] : [Buffer.from(raw, 'utf8')]
  // A real same-origin client always sends JSON; the SEC-4 fence requires it.
  const defaults = method === 'POST' ? { 'content-type': 'application/json' } : {}
  return {
    method,
    url,
    headers: { host, ...defaults, ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A fake `ServerResponse` capturing status, headers and payload. */
export function createFakeResponse() {
  const state = { status: 0, headers: null, payload: '', ended: false, headersSent: false, allow: undefined }
  return {
    state,
    get json() {
      return state.payload === '' ? undefined : JSON.parse(state.payload)
    },
    setHeader(name, value) {
      if (String(name).toLowerCase() === 'allow') state.allow = value
    },
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
      state.headersSent = true
    },
    end(payload) {
      state.ended = true
      if (typeof payload === 'string') state.payload = payload
    },
  }
}

/** In-memory `node:fs/promises` double for the mode store. */
export function createMemoryFs(initial = {}, { latencyMs = 0 } = {}) {
  const files = new Map(Object.entries(initial))
  const delay = async () => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs))
  }
  const enoent = (path) => {
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`)
    error.code = 'ENOENT'
    return error
  }
  return {
    files,
    async readFile(path) {
      const key = String(path)
      if (!files.has(key)) throw enoent(key)
      return files.get(key)
    },
    async writeFile(path, data) {
      await delay()
      files.set(String(path), String(data))
    },
    async rename(from, to) {
      await delay()
      const source = String(from)
      const target = String(to)
      if (!files.has(source)) throw enoent(source)
      files.set(target, files.get(source))
      files.delete(source)
    },
    async rm(path) {
      files.delete(String(path))
    },
    async mkdir() {},
  }
}
