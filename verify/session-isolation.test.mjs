// verify/session-isolation.test.mjs — verifier-owned checks for SPEC §9 (per-session run windows).
//
// The risk this file exists for: "one session switches mode, every session changes with it".
// So the tests never assert on a shared mode variable — they drive the REAL apply()/mount() with
// fake agents carrying different sessionIds and check each gate's own decision, including
// interleaved writes that would expose any "last session written" cross-talk.
//
// The per-session feature is being implemented in parallel (task-5 host / task-6 client). Until the
// v2 surface exists these tests SKIP with an explicit reason (visible as a non-zero `skipped` count
// in the node --test summary) instead of silently passing; the verifier re-runs them on the Lead's
// deployment notice.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bjEpoch } from './lib/oracle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

let host = null, storeMod = null, loadErr = null
try {
  host = await import('../lib/host/index.js')
  storeMod = await import('../lib/host/store.js')
} catch (e) { loadErr = e }
const missing = host && storeMod ? false : `lib/host/* unavailable: ${loadErr?.message}`

/** Peak instant used throughout: 2026-10-14 (Wed) 10:00 Beijing — inside the morning window. */
const PEAK_AT = bjEpoch(2026, 10, 14, 10, 0, 0)
const OFFSET_TO_PEAK = () => PEAK_AT - Date.now()

/**
 * Is the SPEC §9 feature actually wired up? Detection requires BOTH halves, because task-5 lands
 * `store.js` before `index.js`/`routes.js`, and a store-only check would turn the suite red with
 * "not implemented" noise instead of a clear "still pending":
 *   (a) the v2 store shape (probed behaviourally on a temp file), and
 *   (b) the live state envelope carrying the new contract fields through a real mount.
 */
async function detectPerSession() {
  const dir = mkdtempSync(join(tmpdir(), 'peak-sess-detect-'))
  const file = join(dir, 'peak-hours-state.json')
  writeFileSync(file, JSON.stringify({ version: 2, default: 'always', sessions: { s1: 'idle-only' } }), 'utf8')
  let storeReady = false, storeSeen = 'n/a'
  try {
    const s = storeMod.createModeStore({ file })
    const v = await s.read()
    storeSeen = typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 120) : typeof v
    storeReady = !!v && typeof v === 'object' && 'default' in v && 'sessions' in v
    if (storeReady) {
      const resolved = s.modeFor?.('s1')
      storeReady = resolved?.mode === 'idle-only' && resolved?.source === 'session'
      storeSeen += ` modeFor(s1)=${JSON.stringify(resolved)}`
    }
  } catch (error) {
    storeSeen = `threw ${error?.message}`
  } finally { rmSync(dir, { recursive: true, force: true }) }

  let envelopeReady = false, envelopeSeen = 'n/a'
  if (storeReady) {
    const h = makeCtx()
    let home = null
    try {
      const mounted = await mountWith(h)
      home = mounted.dir
      const st = (await callRoute(h, '/api/peak-hours/state')).body?.state
      const fields = st ? ['modeSource', 'defaultMode', 'waitingTasksTotal'].filter((f) => f in st) : []
      envelopeReady = fields.length === 3
      envelopeSeen = st ? `fields=${JSON.stringify(fields)}` : 'no envelope'
    } catch (error) {
      envelopeSeen = `mount threw ${error?.message}`
    } finally {
      h.disposeAll()
      if (home) rmSync(home, { recursive: true, force: true })
    }
  }
  return { ready: storeReady && envelopeReady, seen: `store[${storeSeen}] envelope[${envelopeSeen}]` }
}
const detect = host && storeMod ? await detectPerSession() : { ready: false, seen: 'n/a' }
const pending = detect.ready ? false
  : `SPEC §9 per-session surface not present yet (createModeStore().read() → ${detect.seen}); awaiting task-5/task-6`

// ---------------------------------------------------------------------------------------
// Fake cordis ctx: captures listeners, routes, effects and timers; provides an `agents`
// service whose currentInitiator() the test controls.
// ---------------------------------------------------------------------------------------
function makeCtx() {
  const listeners = [], effects = [], routes = [], timers = new Set(), logs = []
  const sessionState = { initiator: undefined }
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
    },
    agents: { currentInitiator: () => sessionState.initiator },
    timer: {
      timeout(cb, delayMs) {
        const h = { cb, delayMs, cancelled: false }
        timers.add(h)
        return () => { h.cancelled = true; timers.delete(h) }
      },
    },
    on(event, handler, opts) { const rec = { event, handler, opts, disposed: false }; listeners.push(rec); return () => { rec.disposed = true } },
    effect(fn) { const d = fn(); effects.push(d); return d },
    webServer: { register(route) { const rec = { route, disposed: false }; routes.push(rec); return () => { rec.disposed = true } } },
  }
  return {
    ctx, listeners, effects, routes, timers, logs, sessionState,
    disposeAll() { for (const d of effects) { try { d?.() } catch { /* asserted elsewhere */ } } },
    listener(event) { return listeners.find((l) => l.event === event) },
  }
}

/** Mount the real plugin against a fake ctx with DSH_HOME redirected to a throwaway dir. */
async function mountWith(h, { stateFile = null, config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'peak-sess-home-'))
  if (stateFile !== null) writeFileSync(join(dir, 'peak-hours-state.json'), stateFile, 'utf8')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const surface = await host.mount(h.ctx, config, { logger: h.ctx.logger })
    return { surface, dir }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

/** Call one registered route the way the webserver would, query string included. */
async function callRoute(h, url, { method = 'GET', body, omitContentType = false, headers = {} } = {}) {
  const [pathname] = url.split('?')
  const rec = h.routes.find((r) => r.route.path === pathname)
  if (!rec) return { status: 404, body: null }
  // NOTE: the route record is `{ kind, path, handler }` — it carries NO `method` field; method
  // enforcement lives inside the handler (it answers 405 itself). An earlier version of this helper
  // compared a non-existent `route.method` against 'GET' and therefore answered every POST with a
  // fabricated 405, which made the whole suite fail for the wrong reason (V7b).
  let status = 200, payload = null
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(code) { status = code; this.headersSent = true },
    end(text) { if (text !== undefined && text !== '') { try { payload = JSON.parse(text) } catch { payload = text } } },
  }
  const req = {
    method,
    url,
    // SEC-4: the per-session work hardened the write routes — a POST body without
    // `content-type: application/json` is 415, and `sec-fetch-site: cross-site` is 403. A fake
    // request that omits the header silently turns every POST into a 415 (found as V7).
    // `omitContentType`/`headers` exist so the fence itself can be tested rather than bypassed.
    headers: {
      host: '127.0.0.1:19387',
      ...(method === 'POST' && !omitContentType ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
  await rec.route.handler(req, res)
  return { status, body: payload }
}

/** A fake Agent as it appears inside `payload.agent` (and inside a ToolExecution). */
const agentFor = (id) => ({ id, session: { id } })

/**
 * The REAL shape of `this` inside an `agent/pre-step` waterfall listener: an opaque scoped
 * carrier. Acceptance review (R2) reproduced on the live runtime that `this.session === undefined`
 * and `this.id` is absent — the session is only reachable through `payload.agent`. An earlier
 * version of {@link drivePreStep} passed the SAME fake agent as both `this` and `payload.agent`,
 * which let a wrong `this.session?.id ?? this.id` implementation pass: a false green that hid the
 * round's blocking defect. The carrier below therefore carries NO session information at all, so
 * any `this`-based resolution degrades to `default` and is caught by these tests.
 */
const opaqueCarrier = () => ({ [Symbol('cordis.scope')]: true, _carrier: 'opaque scoped carrier' })

/** A carrier that LIES: it does carry a session id, deliberately different from payload.agent. */
const lyingCarrier = (id) => ({ id, session: { id } })

async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)) }
function tracker(p) { const rec = { status: 'pending', value: undefined }; p.then((v) => { rec.status = 'resolved'; rec.value = v }, (e) => { rec.status = 'rejected'; rec.value = e }); return rec }

/**
 * Drive `agent/pre-step` for one session, with the REAL call shape: an opaque `this` and the
 * session on `payload.agent` only. `carrier` can be overridden to probe precedence.
 */
function drivePreStep(h, sessionId, { signal, carrier } = {}) {
  const rec = h.listener('agent/pre-step')
  assert.ok(rec, 'agent/pre-step listener must be registered')
  const agent = agentFor(sessionId)
  const ac = signal ? null : new AbortController()
  const useSignal = signal ?? ac.signal
  const out = { delegated: 0 }
  const p = rec.handler.call(carrier ?? opaqueCarrier(), { agent, messages: [], turn: 1, step: 1, signal: useSignal }, () => {
    out.delegated++
    return Promise.resolve({ kind: 'enter', messages: [] })
  })
  return { tracker: tracker(p), out, abort: () => ac?.abort() }
}

/** Drive `tools/pre-execute` with an explicit exec payload. */
function drivePreExecute(h, exec, { signal } = {}) {
  const rec = h.listener('tools/pre-execute')
  assert.ok(rec, 'tools/pre-execute listener must be registered')
  const ac = signal ? null : new AbortController()
  const out = { delegated: 0 }
  const p = rec.handler.call({}, { ...exec, signal: signal ?? ac.signal }, () => { out.delegated++; return Promise.resolve({ kind: 'allow' }) })
  return { tracker: tracker(p), out, abort: () => ac?.abort() }
}

test('subject module present (lib/host/index.js + store.js)', () => {
  assert.ok(host && storeMod, missing)
})

test('[gate] SPEC §9 per-session surface is implemented', { skip: pending }, () => {
  assert.equal(detect.ready, true)
})

// ---------------------------------------------------------------------------------------
// 1. Cross-session isolation (the core risk)
// ---------------------------------------------------------------------------------------
test('isolation: A=always passes while B=idle-only is held at the same peak instant', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { surface, dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    const atPeak = (await callRoute(h, '/api/peak-hours/state')).body.state
    assert.equal(atPeak.phase, 'peak', `the clock override must land in a peak window, got ${atPeak.nowText}`)

    assert.equal((await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', session: 'A' } })).status, 200)
    assert.equal((await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })).status, 200)

    const a = drivePreStep(h, 'A'); await flush()
    const b = drivePreStep(h, 'B'); await flush()

    assert.equal(a.out.delegated, 1, 'session A (always) must be delegated immediately')
    assert.equal(a.tracker.status, 'resolved', 'session A must not be held')
    assert.equal(b.out.delegated, 0, 'session B (idle-only, peak) must NOT be delegated')
    assert.equal(b.tracker.status, 'pending', 'session B must be held')
    assert.equal(surface.gate.waiterCount, 1, 'exactly one waiter (session B) may be registered')

    b.abort(); await flush()
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('isolation: the decision follows the task\'s own session, not the last session written', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    // Deliberately interleaved: write A, write B, then drive A first — a shared/last-write-wins
    // implementation would release A and hold B; the correct one does the opposite.
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', session: 'A' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'A' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', session: 'B' } })
    // now: A idle-only (written first), B always (written last)
    const a = drivePreStep(h, 'A'); await flush()
    const b = drivePreStep(h, 'B'); await flush()
    assert.equal(a.out.delegated, 0, 'A (idle-only) must be held although it was written BEFORE B')
    assert.equal(a.tracker.status, 'pending')
    assert.equal(b.out.delegated, 1, 'B (always) must pass although it was written LAST')
    assert.equal(b.tracker.status, 'resolved')

    // flip both and re-drive: the held session must now pass and vice versa
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', session: 'A' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })
    const a2 = drivePreStep(h, 'A'); await flush()
    const b2 = drivePreStep(h, 'B'); await flush()
    assert.equal(a2.out.delegated, 1, 'A was flipped to always and must pass')
    assert.equal(b2.out.delegated, 0, 'B was flipped to idle-only and must be held')
    a.abort(); b2.abort(); await flush()
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('isolation: an unknown session resolves to `default`, never to another session\'s choice', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', scope: 'default' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })

    const unknown = drivePreStep(h, 'never-configured'); await flush()
    assert.equal(unknown.out.delegated, 1, 'an unconfigured session follows `default` (always) and passes')

    const b = drivePreStep(h, 'B'); await flush()
    assert.equal(b.out.delegated, 0, 'B keeps its own idle-only and is held')
    b.abort(); await flush()
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------------------
// 1b. Where the sessionId comes from (R2): payload.agent, because `this` is opaque
// ---------------------------------------------------------------------------------------
test('sessionId source: the decision follows payload.agent, not an opaque `this`', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', session: 'A' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })

    // opaque `this` (the real shape) — only payload.agent can carry the session
    const a = drivePreStep(h, 'A'); await flush()
    const b = drivePreStep(h, 'B'); await flush()
    assert.equal(a.out.delegated, 1, 'A (always) must pass with an opaque carrier')
    assert.equal(b.out.delegated, 0, 'B (idle-only) must be held with an opaque carrier')

    // a carrier that LIES about the session must not override payload.agent
    const lied = drivePreStep(h, 'A', { carrier: lyingCarrier('B') }); await flush()
    assert.equal(lied.out.delegated, 1,
      'a conflicting session on `this` must be ignored: payload.agent (A=always) is authoritative')
    b.abort(); await flush()
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('[mutation teeth] the same scenario catches a `this`-based session resolution', { skip: pending || missing }, async () => {
  // The wrong contract, written out as a twin listener: it resolves the session from `this` only.
  // If the scenario cannot tell the twin apart from the real listener, the scenario is worthless —
  // this test asserts that the twin DELEGATES an idle-only session that the real listener HOLDS.
  const h = makeCtx()
  const { surface, dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', scope: 'default' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })
    const st = (await callRoute(h, '/api/peak-hours/state?session=B')).body.state
    assert.equal(st.phase, 'peak', 'the scenario must be at peak for the twin to be discriminable')

    // the buggy twin: `this.session?.id ?? this.id` (the contract that was actually wrong)
    const buggyTwin = function (payload, next) {
      const id = this?.session?.id ?? this?.id
      const mode = surface.store.modeFor(id).mode
      if (mode === 'idle-only') return new Promise(() => {})   // hold forever
      return next()
    }
    let twinDelegated = 0
    buggyTwin.call(opaqueCarrier(), { agent: agentFor('B'), signal: new AbortController().signal },
      () => { twinDelegated++; return Promise.resolve({ kind: 'enter', messages: [] }) })
    await flush()
    assert.equal(twinDelegated, 1,
      'with an opaque carrier the `this`-based twin cannot see B and lets it through — i.e. the ' +
      'scenario does discriminate; a false green here would mean these tests have no teeth')

    const real = drivePreStep(h, 'B'); await flush()
    assert.equal(real.out.delegated, 0, 'the real listener holds B in the identical call shape')
    real.abort(); await flush()
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('R5 at the HTTP layer: 200 on POST /mode must imply the choice was persisted', { skip: pending || missing }, async () => {
  // The store-level half lives in verify/session-store.test.mjs. Here the API contract is pinned:
  // a request that reports success must NOT leave the session resolving to `default` because the
  // write was silently dropped (the `__proto__` hazard). Either the API refuses with 4xx, or a
  // subsequent GET must report `modeSource: 'session'` with the requested mode.
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    const ids = ['__proto__', 'constructor', 'prototype', 'toString']
    for (const id of ids) {
      const wrote = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: id } })
      const read = await callRoute(h, `/api/peak-hours/state?session=${encodeURIComponent(id)}`)
      const st = read.body?.state
      if (wrote.status === 200) {
        assert.equal(st?.modeSource, 'session',
          `POST /mode returned 200 for session ${JSON.stringify(id)} but the session resolves as ` +
          `${JSON.stringify(st?.modeSource)} — the write was silently swallowed`)
        assert.equal(st?.mode, 'idle-only')
      } else {
        assert.ok(wrote.status >= 400 && wrote.status < 500, `expected 4xx for ${JSON.stringify(id)}, got ${wrote.status}`)
        assert.equal(st?.modeSource, 'default', 'a refused session write must not resolve as a session')
      }
    }
    // and the file must not have been polluted
    const raw = readFileSync(join(dir, 'peak-hours-state.json'), 'utf8')
    assert.doesNotMatch(raw, /__proto__/, 'a session id must never reach the file as a literal __proto__ key')
    assert.equal({}.polluted, undefined)
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('P1-1: an unresolvable session is counted and warned once — never silent', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    // default = idle-only at peak, so an UNRESOLVED waiter is actually HELD (otherwise it would
    // resolve immediately and there would be nothing to count).
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', scope: 'default' } })
    h.sessionState.initiator = undefined

    const rec = h.listener('agent/pre-step')
    const forge = () => {
      const ac = new AbortController()
      const out = { delegated: 0 }
      // no `agent` in the payload at all, and no initiator either → unresolvable
      const p = rec.handler.call(opaqueCarrier(), { messages: [], turn: 1, step: 1, signal: ac.signal },
        () => { out.delegated++; return Promise.resolve({ kind: 'enter', messages: [] }) })
      return { tracker: tracker(p), out, abort: () => ac.abort() }
    }
    const sessionWarns = () => h.logs.filter(([lvl, m]) => lvl === 'warn' && /session/i.test(m)).length

    const first = forge(); await flush()
    assert.equal(first.out.delegated, 0, 'default=idle-only at peak must hold an unresolved waiter')
    const st = (await callRoute(h, '/api/peak-hours/state')).body.state
    assert.equal(st.waitingTasksUnresolved, 1,
      'an unresolvable waiter must be visible as waitingTasksUnresolved (P1-1: never silent)')
    assert.equal(sessionWarns(), 1, `exactly one warning is required, got ${JSON.stringify(h.logs)}`)

    const second = forge(); await flush()
    const st2 = (await callRoute(h, '/api/peak-hours/state')).body.state
    assert.equal(st2.waitingTasksUnresolved, 2, 'the counter tracks each unresolved waiter')
    assert.equal(sessionWarns(), 1, 'the warning is emitted once, not once per waiter')

    first.abort(); second.abort(); await flush()
    const st3 = (await callRoute(h, '/api/peak-hours/state')).body.state
    assert.equal(st3.waitingTasksUnresolved, 0, 'the counter returns to zero when they leave')
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('SEC-4: the write fence answers 415 without JSON content-type and 403 for cross-site', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    const noCt = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always' }, omitContentType: true })
    assert.equal(noCt.status, 415, `a POST body without application/json must be 415, got ${noCt.status}`)
    const crossSite = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always' }, headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.status, 403, `a cross-site write must be 403, got ${crossSite.status}`)
    const clockNoCt = await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: 1000 }, omitContentType: true })
    assert.equal(clockNoCt.status, 415, 'the fence covers /clock as well as /mode')
    assert.equal((await callRoute(h, '/api/peak-hours/state')).status, 200, 'GET stays open — only writes are fenced')
    assert.equal((await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always' } })).status, 200)
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('P1-2: mode:null clears one session override; without a session it is a 400', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', scope: 'default' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'S' } })
    assert.equal((await callRoute(h, '/api/peak-hours/state?session=S')).body.state.modeSource, 'session')

    const noSession = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: null } })
    assert.equal(noSession.status, 400, 'clearing requires a session')

    const cleared = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: null, session: 'S', scope: 'session' } })
    assert.equal(cleared.status, 200)
    const st = (await callRoute(h, '/api/peak-hours/state?session=S')).body.state
    assert.equal(st.modeSource, 'default', 'after clearing, the session follows the default again')
    assert.equal(st.mode, 'always')
    const raw = readFileSync(join(dir, 'peak-hours-state.json'), 'utf8')
    assert.doesNotMatch(raw, /"S"/, 'the cleared session must be gone from the file, not merely masked in memory')
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------------------
// 2. Tool gate session ownership
// ---------------------------------------------------------------------------------------
test('tool gate: exec.agent.session.id decides, independently of other sessions', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', session: 'A' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })

    const a = drivePreExecute(h, { agent: agentFor('A') }); await flush()
    const b = drivePreExecute(h, { agent: agentFor('B') }); await flush()
    assert.equal(a.out.delegated, 1, 'tool call in session A (always) must be allowed')
    assert.equal(b.out.delegated, 0, 'tool call in session B (idle-only, peak) must be held')
    assert.equal(b.tracker.status, 'pending')
    b.abort(); await flush()
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('tool gate: a missing exec.agent falls back to currentInitiator() and still holds an idle-only session', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', scope: 'default' } })

    // no exec.agent, but the initiator is session B → the idle-only choice must be honoured
    h.sessionState.initiator = agentFor('B')
    const viaInitiator = drivePreExecute(h, {}); await flush()
    assert.equal(viaInitiator.out.delegated, 0,
      'a missing exec.agent must NOT become "unresolvable ⇒ pass" — the initiator is session B (idle-only)')
    assert.equal(viaInitiator.tracker.status, 'pending')
    viaInitiator.abort(); await flush()

    // no exec.agent and no initiator → falls back to `default` (always here) ⇒ allowed
    h.sessionState.initiator = undefined
    const viaDefault = drivePreExecute(h, {}); await flush()
    assert.equal(viaDefault.out.delegated, 1, 'with no agent and no initiator the `default` (always) applies')

    // and with `default` = idle-only, the same payload must be held (never silently allowed)
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', scope: 'default' } })
    const heldByDefault = drivePreExecute(h, {}); await flush()
    assert.equal(heldByDefault.out.delegated, 0, 'default=idle-only must hold an unresolvable tool call')
    heldByDefault.abort(); await flush()
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------------------
// 3. State file v2: migration, corrupt fallback, concurrency
// ---------------------------------------------------------------------------------------
test('state file: v1 {mode} migrates to v2 {default, sessions:{}} with one log line', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h, { stateFile: JSON.stringify({ mode: 'idle-only' }) })
  try {
    const s = (await callRoute(h, '/api/peak-hours/state')).body.state
    assert.equal(s.defaultMode, 'idle-only', 'the v1 mode must become the v2 default')
    assert.equal(s.mode, 'idle-only', 'and therefore the resolved mode of a session with no choice')
    assert.equal(s.modeSource, 'default')
    const migrationLogs = h.logs.filter(([, m]) => /migrat|v1|version/i.test(m))
    assert.equal(migrationLogs.length, 1, `expected exactly one migration log line, got ${JSON.stringify(h.logs)}`)
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('state file: a corrupt v2 file falls back to default=always and logs once', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h, { stateFile: '{{{ not json' })
  try {
    const s = (await callRoute(h, '/api/peak-hours/state')).body.state
    assert.equal(s.defaultMode, 'always')
    assert.equal(s.modeSource, 'default')
    assert.equal(h.logs.filter(([lvl]) => lvl === 'warn').length, 1, `expected one warning, got ${JSON.stringify(h.logs)}`)
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('state file: many concurrent per-session writes never corrupt the v2 file (F5 regression)', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  const file = join(dir, 'peak-hours-state.json')
  try {
    // Drive concurrency through the frozen HTTP contract, not an internal store signature.
    const calls = []
    for (let i = 0; i < 60; i++) {
      calls.push(callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: i % 2 ? 'always' : 'idle-only', session: `s${i % 7}` } }))
      calls.push(callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: i % 2 ? 'idle-only' : 'always', scope: 'default' } }))
    }
    const settled = await Promise.all(calls)
    assert.ok(settled.every((r) => r.status === 200), `every write must succeed, got ${JSON.stringify(settled.map((r) => r.status).slice(0, 12))}`)

    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) // throws → the test fails, which is the point
    assert.equal(parsed.version, 2)
    assert.ok(parsed.sessions && typeof parsed.sessions === 'object')
    assert.deepEqual(readdirSync(dir), ['peak-hours-state.json'], `no temp litter may survive, got ${JSON.stringify(readdirSync(dir))}`)

    // and the in-memory state must agree with what landed on disk
    for (const id of ['s0', 's1', 's6']) {
      const s = (await callRoute(h, `/api/peak-hours/state?session=${id}`)).body.state
      assert.equal(s.mode, parsed.sessions[id], `session ${id} in memory (${s.mode}) must match the file (${parsed.sessions[id]})`)
    }
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------------------
// 4. Route contract
// ---------------------------------------------------------------------------------------
test('route contract: GET /state?session= reports mode/modeSource/defaultMode and both counts', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    const noSession = (await callRoute(h, '/api/peak-hours/state')).body.state
    assert.equal(noSession.modeSource, 'default', 'omitting ?session= must report the default as the mode')
    assert.equal(noSession.defaultMode, 'always')
    assert.equal(typeof noSession.waitingTasks, 'number')
    assert.equal(typeof noSession.waitingTasksTotal, 'number', 'waitingTasksTotal must exist (the old global count)')

    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'A' } })
    const forA = (await callRoute(h, '/api/peak-hours/state?session=A')).body.state
    assert.equal(forA.sessionId, 'A')
    assert.equal(forA.mode, 'idle-only')
    assert.equal(forA.modeSource, 'session')
    assert.equal(forA.defaultMode, 'always', 'A\'s choice must not leak into the default')

    const forOther = (await callRoute(h, '/api/peak-hours/state?session=Z')).body.state
    assert.equal(forOther.mode, 'always')
    assert.equal(forOther.modeSource, 'default')
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('waitingTasks is per session while waitingTasksTotal stays host-wide (breaking change pinned)', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/clock', { method: 'POST', body: { offsetMs: OFFSET_TO_PEAK(), ttlMs: 120_000 } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'A' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'B' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', session: 'C' } })

    const a1 = drivePreStep(h, 'A'); await flush()
    const a2 = drivePreStep(h, 'A'); await flush()
    const b1 = drivePreStep(h, 'B'); await flush()
    const c1 = drivePreStep(h, 'C'); await flush()

    const sA = (await callRoute(h, '/api/peak-hours/state?session=A')).body.state
    const sB = (await callRoute(h, '/api/peak-hours/state?session=B')).body.state
    const sC = (await callRoute(h, '/api/peak-hours/state?session=C')).body.state
    assert.equal(sA.waitingTasks, 2, 'session A has two waiters')
    assert.equal(sB.waitingTasks, 1, 'session B has one waiter')
    assert.equal(sC.waitingTasks, 0, 'session C (always) has none')
    assert.equal(sA.waitingTasksTotal, 3, 'the host-wide total is still reported separately')
    assert.equal(sB.waitingTasksTotal, 3)
    assert.equal(sC.waitingTasksTotal, 3)

    // SPEC §9.3: WITHOUT `?session=` the OLD host-wide semantics are kept, precisely so existing
    // session-less curl scripts, README snippets and older verifiers keep working. This is the
    // backward-compatibility half of a breaking change, and it is easy to break silently.
    const sHost = (await callRoute(h, '/api/peak-hours/state')).body.state
    assert.equal(sHost.waitingTasks, 3,
      'a session-less GET must keep the host-wide count in `waitingTasks` (SPEC §9.3)')
    assert.equal(sHost.waitingTasksTotal, 3)
    assert.equal(sHost.modeSource, 'default')

    // releasing one session must not touch the others' counts
    c1.abort(); a1.abort(); await flush()
    const after = (await callRoute(h, '/api/peak-hours/state?session=A')).body.state
    assert.equal(after.waitingTasks, 1, 'only A\'s own waiter was released')
    assert.equal(after.waitingTasksTotal, 2)
    a2.abort(); b1.abort(); await flush()
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('route contract: POST /mode session / scope=default / neither, and 4xx on bad input', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    // 1. session write
    const r1 = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'A' } })
    assert.equal(r1.status, 200)
    assert.equal(r1.body.state.mode, 'idle-only')
    assert.equal(r1.body.state.modeSource, 'session')
    // 2. default write — the envelope of a session-less request reports the DEFAULT resolution
    // (SPEC §9.3), so A's unchanged choice must be checked through A's own view, not this response.
    const r2 = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', scope: 'default' } })
    assert.equal(r2.status, 200)
    assert.equal(r2.body.state.defaultMode, 'idle-only')
    assert.equal(r2.body.state.modeSource, 'default', 'a session-less write reports the default as its mode')
    const aView = (await callRoute(h, '/api/peak-hours/state?session=A')).body.state
    assert.equal(aView.mode, 'idle-only')
    assert.equal(aView.modeSource, 'session', 'a default write must not change A\'s explicit choice')
    const zView = (await callRoute(h, '/api/peak-hours/state?session=Z')).body.state
    assert.equal(zView.mode, 'idle-only', 'an unconfigured session follows the new default')
    assert.equal(zView.modeSource, 'default')
    // 3. neither → default (legacy curl calls keep working)
    const r3 = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always' } })
    assert.equal(r3.status, 200)
    assert.equal(r3.body.state.defaultMode, 'always')
    // 4. invalid inputs
    for (const body of [null, {}, { mode: 'nope' }, { mode: 'always', session: 42 }, { mode: 'always', scope: 'everything' }]) {
      const r = await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body })
      assert.ok(r.status >= 400 && r.status < 500, `body ${JSON.stringify(body)} must be rejected with 4xx, got ${r.status}`)
      assert.equal(r.body.ok, false)
    }
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('write path persists per session without disturbing other sessions (round-trip)', { skip: pending || missing }, async () => {
  const h = makeCtx()
  const { dir } = await mountWith(h)
  try {
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', session: 'A' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'always', session: 'B' } })
    await callRoute(h, '/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only', scope: 'default' } })
    const raw = readFileSync(join(dir, 'peak-hours-state.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 2, `expected a v2 file, got ${raw}`)
    assert.equal(parsed.default, 'idle-only')
    assert.equal(parsed.sessions.A, 'idle-only')
    assert.equal(parsed.sessions.B, 'always')
  } finally { h.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})
