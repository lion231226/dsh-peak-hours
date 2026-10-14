/**
 * dsh-peak-hours — host plugin (SPEC §2.4).
 *
 * `always` mode changes nothing. In `idle-only` mode two waterfalls hold every
 * task at a safe boundary whenever a peak window is in force, and release them
 * on the exact millisecond the next idle window starts:
 *
 *  1. `agent/pre-step` — the primary gate. Payload
 *     `{ messages, turn, step, signal }`; verified in the extracted runtime at
 *     `_recon/src/dsh-agent-loop/lib/index.js:905,911-918` (signal) with the
 *     loop calling `signal.throwIfAborted()` right after the waterfall
 *     (`:919`), so an aborted wait propagating as a throw is exactly the
 *     control flow the runtime already expects.
 *  2. `tools/pre-execute` — the mid-turn gate. Payload is the `ToolExecution`
 *     (`_recon/src/dsh-tools/lib/index.js:3225`) which carries `signal`
 *     (`:3139` `const signal = exec.signal`, `:3148` in the base record),
 *     seeded from the step's abort signal
 *     (`_recon/src/dsh-agent-loop/lib/index.js:511-517`). Abort here is
 *     reported as the designed `{ kind: 'cancel' }` decision (`:3236-3240`)
 *     instead of a throw, because a throwing `prepare()` becomes a scheduler
 *     failure that fails the whole step (`:641-644`).
 *
 * `llm/stream` also exposes an abortable `options.signal`
 * (`_recon/src/dsh-agent-loop/lib/index.js:1269-1276` sets it;
 * `_recon/src/dsh-llm/lib/index.js:2371` is the waterfall), but it is NOT
 * gated: that waterfall returns an `AsyncIterable`, not a promise, so holding
 * there would mean wrapping the chunk stream in an async generator — and the
 * loop already starts the assistant-stream attempt before pulling the first
 * chunk (`dsh-agent-loop:1074-1076`). The primary gate re-checks before every
 * LLM call, and the tool gate covers the intra-step boundary, so the extra
 * wrapper would add breakage risk without adding coverage.
 *
 * Every registration is owned by this plugin's fiber (`ctx.effect` / the
 * disposer `ctx.on` returns), and the gate's timers sit in one scope that is
 * drained on unload: disposing the plugin leaves no listener and no timer.
 *
 * Both listeners register with `{ global: true, prepend: true }`: the two
 * waterfalls are dispatched through a scope carrier keyed by the agent
 * (`dsh-scope`'s `scopeTarget`), and `global` is the runtime's own idiom for a
 * package-level observer (e.g. `_recon/src/dsh-llm/lib/invariant.js:63`) —
 * it admits this listener for every agent, including subagents, which is
 * exactly "all DSH tasks".
 */

import { readFile } from 'node:fs/promises'
import { allowClockOverrideFromEnv, createClock } from './clock.js'
import { loadCore } from './core-bridge.js'
import { Gate, isAbortLike } from './gate.js'
import { createHandlers, createWebRoutes } from './routes.js'
import { buildState } from './state.js'
import { createModeStore, resolveStatePath, sanitizeSessionId } from './store.js'

/** Stable cordis plugin name. */
export const name = 'peak-hours'

/** Services required before the gate and the routes can mount. */
export const inject = ['timer', 'webServer']

/** Reported by `GET /health` and used for diagnostics. */
export const PLUGIN_NAME = 'dsh-peak-hours'

/** Version reported when package.json cannot be read. */
export const DEFAULT_VERSION = '0.0.0'

/** Human-readable error text. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read this package's version without a JSON import assertion. */
async function readVersion() {
  try {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    const version = JSON.parse(raw)?.version
    return typeof version === 'string' && version !== '' ? version : DEFAULT_VERSION
  } catch {
    return DEFAULT_VERSION
  }
}

/**
 * Whether a signal can actually cancel a gate wait. A missing signal (or one
 * without `addEventListener`) would make the hold uninterruptible, so the gate
 * is skipped entirely in that case.
 * @param signal - candidate abort signal.
 * @returns whether the hold would be abortable.
 */
export function isUsableSignal(signal) {
  return (
    signal !== null &&
    signal !== undefined &&
    typeof signal === 'object' &&
    typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function'
  )
}

/**
 * Own every timer the gate and the clock arm, so one `ctx.effect` drains them
 * on unload. Prefers the injected `ctx.timer` service and falls back to a raw
 * `setTimeout` when the service is absent or refuses.
 * @param ctx - plugin context (for the timer service).
 * @param logger - optional logger.
 * @returns `{ schedule, disposeAll }`.
 */
export function createTimerScope(ctx, logger = null) {
  const live = new Set()
  const schedule = (delayMs, callback) => {
    let active = true
    let cancel
    const stop = () => {
      if (!active) return
      active = false
      live.delete(stop)
      try {
        cancel?.()
      } catch {
        /* a failing disposer must not break the gate */
      }
    }
    const fire = () => {
      if (!active) return
      active = false
      live.delete(stop)
      callback()
    }
    if (typeof ctx?.timer?.timeout === 'function') {
      try {
        cancel = ctx.timer.timeout(fire, delayMs)
      } catch (error) {
        try {
          logger?.warn?.(`[peak-hours] ctx.timer.unavailable: ${errorText(error)}`)
        } catch {
          /* ignore */
        }
        cancel = undefined
      }
    }
    if (typeof cancel !== 'function') {
      const handle = setTimeout(fire, delayMs)
      cancel = () => clearTimeout(handle)
    }
    live.add(stop)
    return stop
  }
  return {
    schedule,
    /** Cancel every outstanding timer (called on unload). */
    disposeAll() {
      for (const stop of [...live]) stop()
      live.clear()
    },
  }
}

/**
 * Mount the plugin. Never throws: a failed mount is logged and leaves the
 * shell untouched (a throwing plugin would fail its fiber). Anything already
 * registered when the failure happens is disposed, so a half-mount leaves no
 * listener, route or timer behind.
 *
 * The return value is deliberately `undefined`. Cordis feeds whatever a plugin
 * resolves with into the fiber's effect collector:
 *
 *   cordis/lib/index.js:1138-1145 — `const effect = runner.execute.call(this)`
 *   then `else if ("then" in effect) return effect.then(safeCollect)`, and
 *   `safeCollect` accepts only a function (a disposer) or null/undefined,
 *   throwing `TypeError: Invalid effect` for anything else.
 *
 * An async `apply` must therefore resolve to nullish. Resolving with the mount
 * surface object fails the whole fiber (state 3) and registers nothing — which
 * is exactly what the live profile showed before this fix (0 routes, every
 * `/api/peak-hours/*` falling through to the 401 fallback). Tests that need the
 * surface call {@link mount} directly.
 *
 * @param ctx - cordis context.
 * @param config - `{ allowClockOverride?: boolean, version?: string }`.
 * @returns `undefined`, always.
 */
export async function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? null
  const registry = []
  try {
    await mount(ctx, config ?? {}, { logger, registry })
  } catch (error) {
    for (const dispose of registry.reverse()) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    try {
      logger?.error?.(`[peak-hours] mount failed: ${errorText(error)}`)
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/**
 * The real mount: {@link apply} contains its failures and unwinds its
 * registrations. Exported for tests only — the plugin entry point itself must
 * resolve to `undefined` (see {@link apply}).
 * @param ctx - cordis context.
 * @param config - plugin config.
 * @param options - `{ logger, registry }`; the registry collects the fiber
 *   disposers so the caller can unwind a half-mount.
 * @returns the mounted surface `{ gate, clock, store, handlers, core, version }`.
 */
export async function mount(ctx, config = {}, options = {}) {
  const { logger = ctx?.logger ?? null, registry = [], store: injectedStore = null } = options
  const allowClockOverride =
    config.allowClockOverride === undefined ? allowClockOverrideFromEnv(process.env) : config.allowClockOverride !== false
  const version = typeof config.version === 'string' && config.version !== '' ? config.version : await readVersion()
  const timers = createTimerScope(ctx, logger)
  const core = await loadCore({ logger })
  // `store` is injectable through the internal options object (tests drive the
  // write-ordering path); the plugin entry point always uses the real one.
  const store = injectedStore ?? createModeStore({ file: resolveStatePath(), logger })
  await store.read()

  let gate = null

  /**
   * The initiating Agent of the current asynchronous chain, when the runtime
   * exposes `ctx.agents` (dsh-agent registers the service as `agents`,
   * `_recon/src/dsh-agent/lib/index.js:332`; `currentInitiator()` at `:368`).
   * Accessed defensively and never injected: an unmet `inject` would park this
   * fiber in `pending` forever, while this fallback is only a safety net.
   */
  const initiatorSessionId = () => {
    try {
      const agents = ctx.agents
      if (agents === undefined || agents === null || typeof agents.currentInitiator !== 'function') return undefined
      const agent = agents.currentInitiator()
      return sessionIdOf(agent)
    } catch {
      return undefined
    }
  }

  /** Session id of one agent-like object (`dsh-agent-loop:552` destructures `agent.session`). */
  function sessionIdOf(agent) {
    try {
      const id = agent?.session?.id ?? agent?.id
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
    } catch {
      return undefined
    }
  }

  const clock = createClock({
    schedule: (delayMs, callback) => timers.schedule(delayMs, callback),
    onExpire: () => {
      try {
        logger?.info?.('[peak-hours] clock override expired; re-evaluating the gate')
      } catch {
        /* ignore */
      }
      gate?.notifyChanged()
    },
  })

  // A broken schedule core must never hold a turn: both wrappers degrade to
  // "idle" (release now) and log instead of throwing into the loop.
  const safeClassify = (epochMs) => {
    try {
      const info = core.classify(epochMs)
      return info !== null && typeof info === 'object' ? info : { phase: 'idle', reason: 'off-hours' }
    } catch (error) {
      try {
        logger?.warn?.(`[peak-hours] classify failed: ${errorText(error)}`)
      } catch {
        /* ignore */
      }
      return { phase: 'idle', reason: 'off-hours', holiday: null, holidayCoverage: 'known', unknownHolidayYear: null }
    }
  }
  const safeNextTransition = (epochMs) => {
    try {
      const next = core.nextTransition(epochMs)
      return Number.isFinite(next?.at) ? next : { at: epochMs, to: 'idle' }
    } catch (error) {
      try {
        logger?.warn?.(`[peak-hours] nextTransition failed: ${errorText(error)}`)
      } catch {
        /* ignore */
      }
      return { at: epochMs, to: 'idle' }
    }
  }

  gate = new Gate({
    now: () => clock.now(),
    classify: safeClassify,
    nextTransition: safeNextTransition,
    // SPEC §9.2: the only place a mode is decided — sessions[id] → default.
    getMode: (sessionId) => store.modeFor(sessionId).mode,
    schedule: (delayMs, callback) => timers.schedule(delayMs, callback),
    log: logger,
  })

  /** Build the state envelope for one session (SPEC §2.3 + §9.3). */
  const snapshot = (sessionId = null) => {
    const now = clock.now()
    const resolved = store.modeFor(sessionId)
    return buildState({
      mode: resolved.mode,
      defaultMode: store.defaultMode,
      modeSource: resolved.source,
      sessionId,
      now,
      info: safeClassify(now),
      next: safeNextTransition(now),
      waitingTasks: sessionId === null ? gate.waiterCount : gate.waiterCountFor(sessionId),
      waitingTasksTotal: gate.waiterCount,
      waitingTasksUnresolved: gate.unresolvedWaiterCount,
      clockOverride: clock.override,
      allowClockOverride,
    })
  }

  const handlers = createHandlers({
    snapshot,
    setMode: async (mode, sessionId = null) => {
      // SEC-2 defence in depth: a present-but-invalid id is refused, never
      // silently widened into a host-wide default write.
      const { id, error } = sanitizeSessionId(sessionId)
      if (sessionId !== null && sessionId !== undefined && error !== null) return false
      // P1-3: `store.setMode` updates the in-memory state synchronously and only
      // then queues the disk write, so re-evaluate the gate immediately — a slow
      // or stuck filesystem must not leave the gate on the previous mode while
      // the API already reports the new one.
      const write = store.setMode(mode, id)
      // A session write re-checks only that session; a default write must
      // re-check everyone (a session with no override follows `default` and has
      // to switch behaviour immediately, in both directions).
      gate.notifyChanged(id === null ? undefined : id)
      return await write
    },
    clearSession: async (sessionId) => {
      const { id, error } = sanitizeSessionId(sessionId)
      if (id === null || error !== null) return false
      const write = store.clearSession(id)
      gate.notifyChanged(id)
      return await write
    },
    setClock: async (offsetMs, ttlMs) => {
      clock.setOffsetMs(offsetMs, { ttlMs })
      gate.notifyChanged()
    },
    allowClockOverride,
    pluginName: PLUGIN_NAME,
    version,
  })

  /**
   * Primary gate: hold every step until that session's schedule leaves the peak
   * window. The session comes from the task itself, never from the last write,
   * and never from the listener's `this`:
   *
   *  1. `payload.agent` — `agentEvents` fuses the subject into the payload
   *     (`_recon/src/dsh-agent/lib/types/dispatch.js:37-42` `fused`, called by
   *     `dsh-agent-loop:911` `this.dispatch.waterfall("agent/pre-step", …)`,
   *     built at `dsh-agent-loop:777` `agentEvents(loopCtx, this)`); the shipped
   *     listener at `_recon/src/dsh-agent/lib/index.js:193` destructures that
   *     same `agent` field and reads `agent.session`.
   *  2. `ctx.agents.currentInitiator()` — the inherited Agent of this
   *     asynchronous chain (`_recon/src/dsh-agent/lib/index.js:368`, service
   *     registered as `agents` at `:332`).
   *
   * SPEC §9.2 records the measurement that retired the older `this.session?.id`
   * recipe: cordis binds a waterfall listener to the dispatch receiver
   * (`_recon/src/cordis/lib/index.js:259-263`), and that receiver is an opaque
   * dsh-scope carrier (`_recon/src/dsh-scope/lib/index.js:327-338`) whose
   * `session`/`id` are always `undefined`.
   *
   * An abort is rethrown (the loop calls `signal.throwIfAborted()` right after
   * the waterfall anyway); any other failure fails open and proceeds.
   */
  async function onPreStep(payload, next) {
    const signal = payload?.signal
    const sessionId = sessionIdOf(payload?.agent) ?? initiatorSessionId()
    if (isUsableSignal(signal)) {
      try {
        await gate.wait(signal, sessionId)
      } catch (error) {
        if (isAbortLike(error, signal)) throw error
        try {
          logger?.warn?.(`[peak-hours] pre-step gate failed open: ${errorText(error)}`)
        } catch {
          /* ignore */
        }
      }
    }
    return next()
  }

  /**
   * Mid-turn gate: hold right before a tool body is dispatched. The payload
   * **is** the ToolExecution and carries `exec.agent`
   * (`_recon/src/dsh-tools/lib/index.js:1201,1305,3456`), with
   * `ctx.agents.currentInitiator()` as the fallback. An abort becomes the
   * runtime's designed `{ kind: 'cancel' }` decision — throwing here would be
   * classified as a scheduler failure and fail the step (`dsh-agent-loop:641-644`).
   */
  async function onPreExecute(exec, next) {
    const signal = exec?.signal
    const sessionId = sessionIdOf(exec?.agent) ?? initiatorSessionId()
    if (isUsableSignal(signal)) {
      try {
        await gate.wait(signal, sessionId)
      } catch (error) {
        if (isAbortLike(error, signal)) return { kind: 'cancel' }
        try {
          logger?.warn?.(`[peak-hours] tool gate failed open: ${errorText(error)}`)
        } catch {
          /* ignore */
        }
      }
    }
    return next()
  }

  /** Register one fiber-owned resource; a later mount failure unwinds it. */
  const own = (label, run) => {
    const dispose = ctx.effect(run, label)
    registry.push(typeof dispose === 'function' ? dispose : () => {})
    return dispose
  }

  own('peak-hours: gate', () => () => gate.dispose())
  own('peak-hours: timers', () => () => {
    clock.dispose()
    timers.disposeAll()
  })
  own('peak-hours: agent/pre-step gate', () => ctx.on('agent/pre-step', onPreStep, { global: true, prepend: true }))
  own('peak-hours: tools/pre-execute gate', () => ctx.on('tools/pre-execute', onPreExecute, { global: true, prepend: true }))
  own('peak-hours: routes', () => {
    const disposers = createWebRoutes(handlers, { logger }).map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          try {
            logger?.warn?.(`[peak-hours] route disposal failed: ${errorText(error)}`)
          } catch {
            /* ignore */
          }
        }
      }
    }
  })

  try {
    logger?.info?.(
      `[peak-hours] mounted: default=${store.defaultMode} sessions=${Object.keys(store.snapshot().sessions).length} core=${core.source} clockOverride=${allowClockOverride ? 'enabled' : 'disabled'}`,
    )
  } catch {
    /* ignore */
  }

  return { gate, clock, store, handlers, core: core.source, version, allowClockOverride }
}
