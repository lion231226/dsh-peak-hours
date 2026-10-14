// verify/client.test.mjs — verifier-owned check of the client half (SPEC §2.5).
//
// Runs the real browser bundle in a sandbox: the wrapper is a plain script that calls
// `window.__ModuleLoader__.load({ id, factory })`, so we capture that call, invoke the factory with
// stub `react` / `react/jsx-runtime`, and assert the mount contract and the SPEC §2.5 labels.
// This complements the live `Slots.listSubTree` query (which needs the Harness page connected).
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../lib/client/index.js', import.meta.url))
const source = readFileSync(BUNDLE, 'utf8')

/** Evaluate the bundle, capture load({id,factory}), run the factory, return module.exports. */
function loadBundle() {
  const captured = []
  const element = (type, props, key) => ({ $$element: true, type, props: props ?? {}, key })
  const react = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init ?? null }),
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    createElement: element,
  }
  const jsxRuntime = {
    jsx: element,
    jsxs: element,
    Fragment: Symbol.for('react.fragment'),
  }
  const requireStub = (id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require(${JSON.stringify(id)}) — the bundle must only need react`)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => captured.push(def) } },
    globalThis: undefined,
    console: { warn: () => {}, error: () => {}, log: () => {}, info: () => {} },
    document: { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => { throw new Error('no network in the sandbox') },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error, Symbol, Promise, Map, Set, RegExp,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'lib/client/index.js' })
  assert.equal(captured.length, 1, 'the bundle must call window.__ModuleLoader__.load exactly once')
  const def = captured[0]
  assert.equal(typeof def.factory, 'function', 'load({ factory }) is required by the module loader')
  const module = { exports: {} }
  const exported = def.factory(requireStub)
  assert.ok(exported && typeof exported === 'object', 'the factory must return module.exports')
  return { def, exported }
}

const { def, exported } = loadBundle()

test('client bundle uses the mandatory ModuleLoader wrapper', () => {
  assert.equal(def.id, 'dsh-peak-hours')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /Object\.defineProperty\(exports,\s*Symbol\.toStringTag/)
  assert.match(source, /require\(["']react["']\)/)
  assert.match(source, /require\(["']react\/jsx-runtime["']\)/)
})

test('client exports inject = ["slots","locale"] and an apply function', () => {
  assert.deepEqual([...exported.inject], ['slots', 'locale'])
  assert.equal(typeof exported.apply, 'function')
})

test('apply() never throws, whatever the host context looks like (SPEC §2.5)', () => {
  for (const ctx of [
    undefined, null, {}, { locale: {} }, { slots: {} },
    { slots: { register: () => { throw new Error('boom') }, inject: (s, cb) => cb() } },
    { locale: { register: () => { throw new Error('boom') } }, slots: undefined },
    { effect: () => { throw new Error('boom') }, locale: { register: () => {} }, slots: { register: () => {}, inject: (s, cb) => cb() } },
  ]) {
    assert.doesNotThrow(() => exported.apply(ctx), `apply(${JSON.stringify(ctx)}) must not throw`)
  }
})

// P9 added a SECOND slot occupant of the same id (the peak-queue banner in
// `conversation.input.dock`, order 30). The first version of this stub recorded into a single
// `record.slot/record.entry`, so the banner silently overwrote the pill and the assertion failed
// — a stub false red, not an implementation defect. The stub now collects every registration and
// the assertions lock both occupants.
test('apply() registers BOTH slot occupants with the frozen ids/orders', () => {
  const effects = []
  const injected = []
  const registrations = []
  let ns, dicts
  const ctx = {
    effect: (fn) => { const d = fn(); effects.push(d); return () => {} },
    locale: { register: (namespace, dictionaries) => { ns = namespace; dicts = dictionaries; return () => {} } },
    slots: {
      inject: (slot, cb) => { injected.push(slot); return cb() },
      register: (entry, component) => { registrations.push({ slot: entry.name, entry, component }); return () => {} },
    },
  }
  exported.apply(ctx)

  assert.deepEqual([...injected].sort(), ['conversation.input.dock', 'conversation.input.left'],
    'the bundle must inject exactly the two composer slots it occupies')
  const bySlot = new Map(registrations.map((r) => [r.slot, r]))

  // 1. composer pill — immediately right of the mode buttons (SPEC §2.5)
  const pill = bySlot.get('conversation.input.left')
  assert.ok(pill, `expected a conversation.input.left occupant, got ${JSON.stringify([...bySlot.keys()])}`)
  assert.equal(pill.entry.id, 'peak-hours', 'the Slots inspect query looks for this exact occupant id')
  assert.equal(pill.entry.order, 20)
  assert.equal(pill.entry.name, 'conversation.input.left')
  assert.equal(typeof pill.component, 'function', 'a renderable component must be registered')

  // 2. peak-queue banner (P9) — same id, its own slot, higher order
  const banner = bySlot.get('conversation.input.dock')
  assert.ok(banner, `expected a conversation.input.dock occupant, got ${JSON.stringify([...bySlot.keys()])}`)
  assert.equal(banner.entry.id, 'peak-hours')
  assert.equal(banner.entry.order, 30)
  assert.equal(banner.entry.name, 'conversation.input.dock')
  assert.equal(typeof banner.component, 'function')
  assert.notEqual(banner.component, pill.component, 'the two occupants must render different components')

  assert.equal(ns, 'dsh-peak-hours')
  assert.ok(dicts && typeof dicts === 'object', 'a dictionary must be registered for the namespace')
  assert.ok(effects.length >= 4, `every registration must be effect-owned, got ${effects.length} effects`)
})

test('SPEC §2.5 labels: the pill reads exactly 全天运行 / 运行中 / 已暂停', () => {
  const { deriveView, translate, DICTS, DOT_COLOR, EMPTY_SNAPSHOT } = exported.__internals
  // The SP4 client requires a v2 envelope: it needs `modeSource` + `defaultMode` to consider the
  // host current, and reads a v1-shaped envelope as "unavailable" by design (SPEC §9.4, verified
  // as positive evidence by the Lead). The helper therefore enriches each state with the frozen v2
  // fields; an explicit field in the literal still wins.
  const label = (state, error = null) => {
    const enriched = {
      sessionId: 'verify-sess', modeSource: 'default', defaultMode: state.mode,
      waitingTasks: 0, waitingTasksTotal: 0, ...state,
    }
    const view = deriveView({ state: enriched, fetchedAtMs: Date.now(), error })
    return { text: translate(DICTS, 'zh', view.labelKey), dotColor: view.dotColor, view }
  }

  const always = label({ mode: 'always', phase: 'idle', reason: 'off-hours', paused: false })
  assert.equal(always.text, '全天运行')
  assert.equal(always.dotColor, DOT_COLOR.neutral, 'always mode uses the neutral dot')

  const running = label({ mode: 'idle-only', phase: 'idle', reason: 'off-hours', paused: false })
  assert.equal(running.text, '空闲时段 · 运行中')
  assert.equal(running.dotColor, DOT_COLOR.success, 'idle-only outside peak uses the green dot')

  const paused = label({ mode: 'idle-only', phase: 'peak', reason: 'peak', paused: true })
  assert.equal(paused.text, '空闲时段 · 已暂停')
  assert.equal(paused.dotColor, DOT_COLOR.warn, 'idle-only inside peak uses the amber dot')

  // a failed fetch must be muted and non-throwing, never an exception.
  // NOTE (reported to Lead as F7, informational): SPEC §2.5 quotes the muted label as "不可用",
  // the implementation renders "时段不可用" — a superset that keeps the quoted word, so the
  // intent (a muted unavailable state, no exception) holds. Asserting `contains` rather than
  // blessing either exact string; recorded in verify/EVIDENCE.md.
  const failed = label({ mode: 'idle-only', phase: 'peak', paused: true }, new Error('offline'))
  assert.match(failed.text, /不可用/, `expected a muted unavailable label containing 不可用, got ${JSON.stringify(failed.text)}`)
  assert.equal(failed.dotColor, DOT_COLOR.muted)
  assert.equal(failed.view.available, false)
  assert.equal(failed.view.stale, true, 'the last-good state must stay available to the popover')

  const view = deriveView(EMPTY_SNAPSHOT)
  assert.equal(typeof view.labelKey, 'string')
})

test('both registered components render without throwing under a stub React', () => {
  const { PeakHoursControl, PeakHoursBanner, DOCK, DOCK_ID, DOCK_ORDER, SLOT, SLOT_ID, SLOT_ORDER } = exported.__internals

  // the frozen slot constants must agree with what apply() actually registered
  assert.deepEqual([SLOT, SLOT_ID, SLOT_ORDER], ['conversation.input.left', 'peak-hours', 20])
  assert.deepEqual([DOCK, DOCK_ID, DOCK_ORDER], ['conversation.input.dock', 'peak-hours', 30])

  const leaves = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { leaves.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node === 'object' && node.$$element) { walk(node.props?.children); return }
  }

  let pill
  // SPEC §9.4: both occupants act on the CURRENT session — with no session they render nothing.
  // That is a deliberate new behaviour, so it is asserted rather than treated as a failure.
  let withoutSession
  assert.doesNotThrow(() => { withoutSession = PeakHoursControl({}) }, 'the pill must not throw without a session')
  assert.equal(withoutSession, null, 'no session ⇒ the composer control renders nothing (SPEC §9.4)')
  let bannerWithout
  assert.doesNotThrow(() => { bannerWithout = PeakHoursBanner({}) }, 'the banner must not throw without a session')
  assert.equal(bannerWithout, null, 'no session ⇒ the queue banner renders nothing (SPEC §9.4)')

  assert.doesNotThrow(() => { pill = PeakHoursControl({ sessionId: 'verify-sess' }) }, 'the composer pill must render with a session')
  walk(pill)
  assert.ok(leaves.length > 0, 'the pill must render at least one text label when it has a session')

  // P9 banner: with an empty store it is not showing, so it must render nothing — and above all
  // must not throw (a throwing slot component would break the composer).
  let banner
  assert.doesNotThrow(() => { banner = PeakHoursBanner({ sessionId: 'verify-sess' }) }, 'the queue banner must not throw')
  assert.equal(banner, null, 'the queue banner must render nothing while no work is being held')
})
