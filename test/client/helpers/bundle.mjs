/**
 * Test helper: load `lib/client/index.js` the way the browser shell does.
 *
 * The bundle is a classic script (not ESM) whose only side effect is
 * `window.__ModuleLoader__.load({ id, factory })`. This helper runs it inside a
 * fresh `node:vm` context with a fake loader, a `require` stub for the two shell
 * seed modules, and a recording `console`, then hands back the factory, the
 * captured registration, and the materialized exports.
 *
 * `createReactStub()` is a hook *harness*, not React: it implements the small
 * slice of the hook contract the bundle uses (per-component slot arrays, deps
 * equality, effect cleanups) so the render path can be executed in plain Node.
 * No DOM and no React package are involved.
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Absolute path of the browser bundle under test (`<root>/lib/client/index.js`). */
export const BUNDLE_PATH = join(HERE, '..', '..', '..', 'lib', 'client', 'index.js')

const sameDeps = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

/**
 * A minimal hooks harness, keyed by component path so nested components keep
 * their own slot arrays (the parent's render only *creates* child elements).
 * @returns {{ react: object, runtime: object, runEffects: Function, unmount: Function }}
 */
export function createReactStub() {
  const runtime = { contexts: new Map(), cursors: new Map(), current: 'root', pending: [], renders: 0, stateUpdates: 0 }

  const slotsFor = (path) => {
    let slots = runtime.contexts.get(path)
    if (slots === undefined) {
      slots = []
      runtime.contexts.set(path, slots)
    }
    return slots
  }
  const nextIndex = () => {
    const index = runtime.cursors.get(runtime.current) ?? 0
    runtime.cursors.set(runtime.current, index + 1)
    return index
  }
  const enqueueEffect = (fn, deps) => {
    const slots = slotsFor(runtime.current)
    const index = nextIndex()
    const previous = slots[index]
    if (previous === undefined || previous.kind !== 'effect') {
      slots[index] = { kind: 'effect', deps: deps ? [...deps] : undefined, cleanup: undefined }
      runtime.pending.push({ path: runtime.current, index, fn })
      return
    }
    const changed = deps === undefined || previous.deps === undefined || !sameDeps(previous.deps, deps)
    if (!changed) return
    previous.deps = deps ? [...deps] : undefined
    runtime.pending.push({ path: runtime.current, index, fn })
  }

  const react = {
    __runtime: runtime,
    /** Enter one component render pass (the harness calls this, never the bundle). */
    __enter(path) {
      runtime.current = path
      runtime.cursors.set(path, 0)
      runtime.renders += 1
    },
    useState(initial) {
      const slots = slotsFor(runtime.current)
      const index = nextIndex()
      if (slots[index] === undefined) {
        slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = slots[index]
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(value, slot.value)) {
            slot.value = value
            runtime.stateUpdates += 1
          }
        },
      ]
    },
    useRef(initial) {
      const slots = slotsFor(runtime.current)
      const index = nextIndex()
      if (slots[index] === undefined) slots[index] = { kind: 'ref', value: { current: initial } }
      return slots[index].value
    },
    useEffect(fn, deps) {
      enqueueEffect(fn, deps)
    },
    useCallback(fn, deps) {
      const slots = slotsFor(runtime.current)
      const index = nextIndex()
      const previous = slots[index]
      if (previous === undefined || previous.kind !== 'callback') {
        slots[index] = { kind: 'callback', fn, deps: deps ? [...deps] : undefined }
        return fn
      }
      if (deps === undefined || previous.deps === undefined || !sameDeps(previous.deps, deps)) {
        previous.fn = fn
        previous.deps = deps ? [...deps] : undefined
      }
      return previous.fn
    },
    useMemo(fn) {
      return fn()
    },
    createElement() {
      throw new Error('bundle must use react/jsx-runtime, not createElement')
    },
  }

  const runEffects = () => {
    for (const item of runtime.pending.splice(0)) {
      const slot = slotsFor(item.path)[item.index]
      if (slot && typeof slot.cleanup === 'function') {
        slot.cleanup()
        slot.cleanup = undefined
      }
      const cleanup = item.fn()
      if (slot) slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }
  const unmount = () => {
    for (const slots of runtime.contexts.values()) {
      for (const slot of slots) {
        if (slot && typeof slot.cleanup === 'function') {
          slot.cleanup()
          slot.cleanup = undefined
        }
      }
    }
  }
  return { react, runtime, runEffects, unmount }
}

/** Recording `document` stub: only the listener seams the bundle uses. */
export function createFakeDocument() {
  const listeners = new Map()
  return {
    visibilityState: 'visible',
    listeners,
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    count(type) {
      return listeners.get(type)?.size ?? 0
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
    },
  }
}

/** Real timers, bound so the vm context cannot leak the `this` binding question. */
export function createRealTimers() {
  return {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  }
}

/** Deterministic `Date` subclass: `Date.now()` returns the injected clock. */
export function createFakeClock(startMs = 0) {
  let current = startMs
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(current)
      else super(...args)
    }
    static now() {
      return current
    }
  }
  return {
    Date: FakeDate,
    advance(ms) {
      current += ms
      return current
    },
    set(ms) {
      current = ms
      return current
    },
    get now() {
      return current
    },
  }
}

/** Deterministic timers: nothing fires unless a test asks for it. */
export function createFakeTimers() {
  let nextId = 0
  const intervals = []
  const timeouts = []
  const clear = (list, handle) => {
    const index = list.indexOf(handle)
    if (index >= 0) list.splice(index, 1)
  }
  const timers = {
    intervals,
    timeouts,
    setInterval(fn, ms) {
      const handle = { id: ++nextId, fn, ms }
      intervals.push(handle)
      return handle
    },
    clearInterval(handle) {
      clear(intervals, handle)
    },
    setTimeout(fn, ms) {
      const handle = { id: ++nextId, fn, ms }
      timeouts.push(handle)
      return handle
    },
    clearTimeout(handle) {
      clear(timeouts, handle)
    },
    /** Fire the pending timeout callbacks without removing periodic handles. */
    flushTimeouts() {
      for (const handle of timeouts.splice(0)) handle.fn()
    },
  }
  return timers
}

/** Minimal `react/jsx-runtime` stub that records the element shape. */
function jsxRuntimeStub() {
  const make = (type, props, key) => ({ type, props: props ?? {}, key: key ?? null })
  return { jsx: make, jsxs: make, Fragment: Symbol.for('react.fragment') }
}

/**
 * Execute the bundle in an isolated context.
 * @param {{ react?: object, document?: object, fetch?: Function, timers?: object }} [options]
 * @returns an object with the registration, the materialized exports, the
 *   recording `console` sinks, and every injected collaborator.
 */
export function loadBundle(options = {}) {
  const warnings = []
  const errors = []
  const harness = options.harness ?? createReactStub()
  const fakeDocument = options.document ?? createFakeDocument()
  const timers = options.timers ?? createRealTimers()
  const state = {
    registration: null,
    loadCount: 0,
    warnings,
    errors,
    factory: null,
    exports: null,
    window: null,
    context: null,
    harness,
    react: harness.react,
    document: fakeDocument,
    timers,
    fetch: options.fetch ?? null,
  }

  const window = {
    __ModuleLoader__: {
      load(registration) {
        state.loadCount += 1
        state.registration = registration
      },
    },
  }

  const context = createContext({
    window,
    globalThis: undefined,
    console: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error: (...args) => errors.push(args.map(String).join(' ')),
      log: () => {},
      info: () => {},
      debug: () => {},
    },
    require(spec) {
      if (spec === 'react') return harness.react
      if (spec === 'react/jsx-runtime') return jsxRuntimeStub()
      throw new Error(`unexpected require(${JSON.stringify(spec)})`)
    },
    document: fakeDocument,
    fetch: state.fetch ?? undefined,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    AbortController,
    Date: options.date ?? Date,
    Math,
    JSON,
  })
  context.globalThis = context
  state.window = window
  state.context = context

  const source = readFileSync(BUNDLE_PATH, 'utf8')
  runInContext(source, context, { filename: BUNDLE_PATH })

  state.factory = state.registration?.factory ?? null
  return state
}

/**
 * Run the registered factory and return its memoized exports.
 * @param {object} [load] - a result from {@link loadBundle}.
 * @returns {object} the module exports (`apply`, `inject`, `__internals`, …).
 */
export function materialize(load = loadBundle()) {
  if (typeof load.factory !== 'function') throw new Error('bundle did not register a factory')
  const exports = load.factory(load.context.require)
  load.exports = exports
  return exports
}

/** Convenience: load + materialize in one call. */
export function loadBundleExports(options = {}) {
  const load = loadBundle(options)
  const exports = materialize(load)
  return { load, exports, internals: exports.__internals }
}

/**
 * A recording context stub shaped like the cordis client root the shell hands to
 * `apply`: `effect(cb, label)` runs `cb` immediately like the real dispatcher
 * does for a live fiber, `locale` is a dictionary face, `slots` is the render
 * slot service. `failOn` injects a throw into one seam.
 * @param {{ failOn?: 'effect'|'locale'|'slots'|'inject'|'register' }} [options]
 */
export function createCtxStub(options = {}) {
  const calls = { effects: [], injections: [], registrations: [], localeRegisters: [], binds: [] }
  const disposers = []

  const ctx = {
    calls,
    effect(callback, label) {
      calls.effects.push(label)
      if (options.failOn === 'effect') throw new Error('effect unavailable')
      const dispose = callback()
      const disposer = typeof dispose === 'function' ? dispose : () => {}
      disposers.push(disposer)
      return disposer
    },
    locale: {
      register(ns, dicts) {
        calls.localeRegisters.push({ ns, dicts })
        if (options.failOn === 'locale') throw new Error('locale face missing')
        return () => {}
      },
      bind(ns) {
        calls.binds.push(ns)
        return (key) => key
      },
    },
    slots: {
      inject(key, callback) {
        calls.injections.push(key)
        if (options.failOn === 'inject') throw new Error('slot not declared')
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(registerOptions, component) {
        calls.registrations.push({ options: registerOptions, component })
        if (options.failOn === 'register') throw new Error('slot not declared')
        return () => {}
      },
    },
  }
  ctx.disposeAll = () => disposers.forEach((dispose) => dispose())
  return ctx
}

/**
 * A `fetch` stub: `{ status, body, reject, delayMs }` (or an array of them) →
 * a recording fetch implementation.
 */
export function createFetchStub(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const calls = []
  const impl = (url, init) => {
    calls.push({ url, init })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (!next) return Promise.reject(new Error('no stubbed response'))
    if (next.reject) return Promise.reject(next.reject)
    if (next.delayMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(makeResponse(next)), next.delayMs)
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            const error = new Error('The operation was aborted.')
            error.name = 'AbortError'
            reject(error)
          })
        }
      })
    }
    return Promise.resolve(makeResponse(next))
  }
  impl.calls = calls
  return impl
}

/**
 * A URL-routed `fetch` stub: `{ 'GET /api/x': { status, body, reject } }`, where
 * a value may be an array consumed in order (the last entry repeats).
 * @returns a recording fetch implementation with `calls` and `count(key)`.
 */
export function createRoutedFetch(routes) {
  const calls = []
  const impl = (url, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url}`
    calls.push({ key, url, init })
    const route = routes[key]
    if (route === undefined) return Promise.reject(new Error(`unrouted request: ${key}`))
    const entry = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route
    if (entry.reject) return Promise.reject(entry.reject)
    return Promise.resolve(makeResponse(entry))
  }
  impl.calls = calls
  impl.count = (key) => calls.filter((call) => call.key === key).length
  return impl
}

function makeResponse(spec) {
  const status = spec.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => spec.body,
  }
}
