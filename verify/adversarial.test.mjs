// verify/adversarial.test.mjs — verifier-owned adversarial checks (SPEC §3 item 6).
//
// Everything here is redirected away from the live profile: DSH_HOME points at
// verify/tmp/**, so the verifier never mutates C:\Users\81521\.dsh\peak-hours-state.json.
// The real `apply()` is driven by a fake cordis context, which also lets us assert that
// disposal leaves no listener, route, or timer behind.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bjEpoch } from './lib/oracle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, '..')
const PROFILE = 'C:\\Users\\81521\\.dsh\\profiles\\desktop'

let store = null, hostIndex = null, stateMod = null, loadErr = null
try {
  store = await import('../lib/host/store.js')
  hostIndex = await import('../lib/host/index.js')
  stateMod = await import('../lib/host/state.js')
} catch (e) { loadErr = e }
const missing = store && hostIndex && stateMod ? false : `lib/host/* unavailable: ${loadErr?.message}`

const mkTmp = () => mkdtempSync(join(tmpdir(), 'peak-adv-'))

/** Run `fn` with DSH_HOME pointed at a throwaway directory; always restores the env. */
async function withDshHome(fn) {
  const dir = mkTmp()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try { return await fn(dir) } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Fake cordis context: records every registration and every timer. */
function makeCtx() {
  let seq = 0
  const listeners = [], effects = [], routes = [], timers = new Set(), logs = []
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
    },
    timer: {
      timeout(cb, delayMs) {
        const handle = { id: ++seq, cb, delayMs, cancelled: false }
        timers.add(handle)
        return () => { handle.cancelled = true; timers.delete(handle) }
      },
    },
    on(event, handler, opts) {
      const rec = { event, handler, opts, disposed: false }
      listeners.push(rec)
      return () => { rec.disposed = true }
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    webServer: {
      register(route) {
        const rec = { route, disposed: false }
        routes.push(rec)
        return () => { rec.disposed = true }
      },
    },
  }
  const disposeAll = () => {
    for (const d of effects) { try { d?.() } catch { /* report via assertions instead */ } }
  }
  return { ctx, listeners, effects, routes, timers, logs, disposeAll }
}

test('subject modules present (lib/host/*)', () => {
  assert.ok(store && hostIndex && stateMod, missing)
})

// ---------------------------------------------------------------------------------------
// Corrupt / missing / hostile state file
// ---------------------------------------------------------------------------------------
test('state store: missing, corrupt, unreadable and unrecognized inputs all fall back to always', { skip: missing }, async () => {
  await withDshHome(async (dir) => {
    const file = join(dir, 'peak-hours-state.json')
    const logs = []
    const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) }

    // 1. missing
    const s1 = store.createModeStore({ file, logger })
    assert.equal((await s1.read()).default, 'always', 'a missing state file must default to always')
    assert.equal((await s1.read()).default, 'always', 'reads are repeatable')

    // 2. corrupt JSON
    writeFileSync(file, '{ this is not json at all', 'utf8')
    const s2 = store.createModeStore({ file, logger })
    assert.equal((await s2.read()).default, 'always')
    assert.ok(logs.some((l) => /corrupt/i.test(l)), `expected a corrupt-file log, got ${JSON.stringify(logs)}`)

    // 3. valid JSON, wrong shape
    writeFileSync(file, JSON.stringify({ mode: 'sometimes' }), 'utf8')
    assert.equal((await store.createModeStore({ file, logger }).read()).default, 'always')

    // 4. valid JSON, not an object
    writeFileSync(file, '[1,2,3]', 'utf8')
    assert.equal((await store.createModeStore({ file, logger }).read()).default, 'always')
    writeFileSync(file, 'null', 'utf8')
    assert.equal((await store.createModeStore({ file, logger }).read()).default, 'always')

    // 5. unreadable path (a directory, not a file)
    mkdirSync(join(dir, 'adir'), { recursive: true })
    assert.equal((await store.createModeStore({ file: join(dir, 'adir'), logger }).read()).default, 'always')

    // 6. valid idle-only round-trips, then a corrupt file is REPAIRED by a write
    writeFileSync(file, JSON.stringify({ mode: 'idle-only' }), 'utf8')
    const s6 = store.createModeStore({ file, logger })
    assert.equal((await s6.read()).default, 'idle-only')
    assert.equal(await s6.setMode('always', null), true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).default, 'always', 'the write must land as valid JSON (v2 shape)')
    writeFileSync(file, 'garbage', 'utf8')
    assert.equal((await store.createModeStore({ file, logger }).read()).default, 'always')
  })
})

test('state store: DSH_HOME is honoured and falls back to ~/.dsh', { skip: missing }, () => {
  const p1 = store.resolveStatePath({ env: { DSH_HOME: 'C:\\tmp\\x' }, home: 'C:\\home' })
  assert.equal(p1, join('C:\\tmp\\x', 'peak-hours-state.json'))
  const p2 = store.resolveStatePath({ env: {}, home: 'C:\\home' })
  assert.equal(p2, join('C:\\home', '.dsh', 'peak-hours-state.json'))
})

test('state store: 200 rapid writes never corrupt the file and the last write wins', { skip: missing }, async () => {
  await withDshHome(async (dir) => {
    const file = join(dir, 'peak-hours-state.json')
    const s = store.createModeStore({ file })
    await s.read()
    const modes = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 'always' : 'idle-only'))
    await Promise.all(modes.map((m) => s.setMode(m, null)))
    const last = modes[modes.length - 1]
    assert.equal(s.defaultMode, last, 'in-memory default must match the last request')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).default, last, 'the file must be the last write')
    assert.deepEqual(readdirSync(dir), ['peak-hours-state.json'], 'no .tmp litter may survive the renames')
  })
})

// ---------------------------------------------------------------------------------------
// Full plugin mount against a fake cordis context: registrations, hold, disposal
// ---------------------------------------------------------------------------------------
test('apply() mounts 2 listeners + 4 routes + owning effects, and the routes match SPEC §2.3', { skip: missing }, async () => {
  await withDshHome(async () => {
    const h = makeCtx()
    const surface = await hostIndex.mount(h.ctx, {}, { logger: h.ctx.logger })
    assert.ok(surface, 'apply() must return a mounted surface')
    assert.equal(surface.core, 'core', 'the real schedule core must be in use (not the degraded fallback)')
    assert.equal(surface.allowClockOverride, true)

    const events = h.listeners.map((l) => l.event).sort()
    assert.deepEqual(events, ['agent/pre-step', 'tools/pre-execute'], 'exactly the two SPEC §2.4 gates')
    for (const l of h.listeners) assert.equal(l.opts?.prepend, true, 'gates should be registered with prepend')

    const paths = h.routes.map((r) => `${r.route.kind} ${r.route.path}`).sort()
    assert.deepEqual(paths, [
      'exact /api/peak-hours/clock',
      'exact /api/peak-hours/health',
      'exact /api/peak-hours/mode',
      'exact /api/peak-hours/state',
    ])
    assert.ok(h.logs.some(([lvl, m]) => lvl === 'info' && /mounted/.test(m)), `expected a mount log, got ${JSON.stringify(h.logs)}`)
    h.disposeAll()
  })
})

test('corrupt state file at mount: the plugin still mounts and reports mode always', { skip: missing }, async () => {
  await withDshHome(async (dir) => {
    writeFileSync(join(dir, 'peak-hours-state.json'), '{{{ not json', 'utf8')
    const h = makeCtx()
    const surface = await hostIndex.mount(h.ctx, {}, { logger: h.ctx.logger })
    assert.ok(surface, 'a corrupt state file must never prevent the mount')
    const s = (await surface.handlers.state()).body.state
    assert.equal(s.mode, 'always')
    assert.ok(h.logs.some(([lvl, m]) => lvl === 'warn' && /corrupt/i.test(m)), `expected one corrupt-file warning, got ${JSON.stringify(h.logs)}`)
    h.disposeAll()
  })
})

test('unknown holiday year 2029 flows through the state envelope as a loud warning', { skip: missing }, async () => {
  const info = (await import('../lib/core/index.js')).classify(bjEpoch(2029, 3, 14, 10, 0, 0))   // Wednesday
  const built = stateMod.buildState({
    mode: 'always',
    now: bjEpoch(2029, 3, 14, 10, 0, 0),
    info,
    next: { at: bjEpoch(2029, 3, 14, 12, 0, 0), to: 'idle' },
    waitingTasks: 0,
    clockOverride: null,
    allowClockOverride: true,
  })
  assert.equal(built.phase, 'peak', 'SPEC §1: an unknown holiday year is treated as a non-holiday weekday')
  assert.equal(built.reason, 'peak')
  assert.equal(built.holidayCoverage, 'unknown')
  assert.equal(built.unknownHolidayYear, 2029)
  assert.equal(built.holidayToday, null)
  assert.equal(built.paused, false, 'mode=always never pauses')
  assert.equal(built.nowText, '2029-03-14 10:00:00')
})

test('mode + clock routes: 400s, 403 when disabled, and a real hold that dispose() releases', { skip: missing }, async () => {
  await withDshHome(async () => {
    const h = makeCtx()
    const surface = await hostIndex.mount(h.ctx, {}, { logger: h.ctx.logger })
    const { handlers } = surface

    // --- validation
    assert.equal((await handlers.mode(null)).status, 400)
    assert.equal((await handlers.mode({})).status, 400)
    assert.equal((await handlers.mode({ mode: 'sometimes' })).status, 400)
    assert.equal((await handlers.clock({})).status, 400)
    assert.equal((await handlers.clock({ offsetMs: 1.5 })).status, 400)
    assert.equal((await handlers.clock({ offsetMs: 1000, ttlMs: 0 })).status, 400)
    assert.equal((await handlers.clock({ offsetMs: 1000, ttlMs: -1 })).status, 400)
    assert.equal((await handlers.clock({ offsetMs: 1000, ttlMs: 1.5 })).status, 400)
    assert.equal((await handlers.health()).body.ok, true)

    // --- 50 rapid mode flips through the route
    for (let i = 0; i < 50; i++) {
      const r = await handlers.mode({ mode: i % 2 === 0 ? 'idle-only' : 'always' })
      assert.equal(r.status, 200)
    }
    assert.equal((await handlers.state()).body.state.mode, 'always', 'last flip wins')

    // --- create a real hold via the real routes, then dispose
    const peakAt = bjEpoch(2026, 10, 14, 10, 0, 0)          // Wednesday inside the morning window
    const offset = peakAt - Date.now()
    assert.equal((await handlers.clock({ offsetMs: offset, ttlMs: 60_000 })).status, 200)
    assert.equal((await handlers.mode({ mode: 'idle-only' })).status, 200)
    const st = (await handlers.state()).body.state
    assert.equal(st.paused, true, `expected paused=true, got ${JSON.stringify(st)}`)
    assert.equal(st.clockOverride.ttlMs, 60_000)

    const preStep = h.listeners.find((l) => l.event === 'agent/pre-step')
    const ac = new AbortController()
    let delegated = 0
    const pending = preStep.handler({ signal: ac.signal }, () => { delegated++; return Promise.resolve('next-done') })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(delegated, 0, 'a step arriving during peak must NOT be delegated downstream')
    assert.equal(surface.gate.waiterCount, 1)
    assert.ok(h.timers.size >= 1, 'the boundary timer must be armed')

    // --- unload: no listener, no timer, no held turn
    h.disposeAll()
    await pending.then(() => {}, () => {})
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(surface.gate.waiterCount, 0, 'dispose must release every waiter')
    assert.equal(surface.gate.timerArmed, false, 'dispose must disarm the boundary timer')
    assert.ok([...h.timers].every((t) => t.cancelled), 'every scheduled timer must be cancelled on unload')
    assert.ok(h.routes.every((r) => r.disposed), 'every route must be disposed on unload')
    assert.ok(h.listeners.every((l) => l.disposed), 'every listener must be disposed on unload')
  })
})

// FINDING F6 regression gate (raised by the verifier, fixed by host-dev 2026-10-09): cordis feeds
// whatever a plugin's apply() RESOLVES to into the fiber effect collector, which accepts only a
// function or nullish (_recon/src/cordis/lib/index.js:1138-1145). Returning the mount surface
// object threw `TypeError: Invalid effect` in the live app, failing the fiber and leaving
// `/api/peak-hours/*` at the 401 fallback. verify/real-cordis.test.mjs proves it against real
// cordis; this cheap assertion pins the exact contract.
test('[F6 regression] apply() resolves to undefined yet still registers everything', { skip: missing }, async () => {
  await withDshHome(async () => {
    const h = makeCtx()
    const returned = await hostIndex.apply(h.ctx, {})
    assert.equal(returned, undefined,
      'apply() must resolve to undefined/null: cordis turns any other resolved value into an ' +
      'effect cleanup handle and throws TypeError: Invalid effect, failing the whole fiber (F6).')
    assert.deepEqual(h.listeners.map((l) => l.event).sort(), ['agent/pre-step', 'tools/pre-execute'])
    assert.equal(h.routes.length, 4, 'apply() must still register all four routes')
    h.disposeAll()
  })
})

test('allowClockOverride=false refuses the clock route with 403 and keeps the real clock', { skip: missing }, async () => {
  await withDshHome(async () => {
    const h = makeCtx()
    const surface = await hostIndex.mount(h.ctx, { allowClockOverride: false }, { logger: h.ctx.logger })
    assert.equal((await surface.handlers.state()).body.state.config.allowClockOverride, false)
    const r = await surface.handlers.clock({ offsetMs: 3600_000 })
    assert.equal(r.status, 403)
    assert.equal(r.body.ok, false)
    assert.equal((await surface.handlers.state()).body.state.clockOverride, null, 'a refused override must not be installed')
    h.disposeAll()
  })
})

test('clock override TTL expires by itself and notifies the gate', { skip: missing }, async () => {
  const { createClock } = await import('../lib/host/clock.js')
  let fired = null
  const scheduled = []
  const clock = createClock({
    readNow: () => 1_000_000,
    schedule: (delayMs, cb) => { scheduled.push({ delayMs, cb }); return () => { scheduled.pop() } },
    onExpire: (info) => { fired = info },
  })
  assert.equal(clock.override, null)
  const ov = clock.setOffsetMs(5400_000)
  assert.deepEqual({ offsetMs: ov.offsetMs, ttlMs: ov.ttlMs, expiresAt: ov.expiresAt }, { offsetMs: 5400_000, ttlMs: 600_000, expiresAt: 1_600_000 })
  assert.equal(clock.now(), 6_400_000, 'now() must include the offset')
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delayMs, 600_000, 'the default TTL timer must be 10 minutes')
  scheduled[0].cb()
  assert.equal(clock.override, null, 'the override must clear itself at expiry')
  assert.deepEqual(fired, { reason: 'ttl' })
  assert.equal(clock.now(), 1_000_000, 'after expiry now() is the real clock again')
  assert.throws(() => clock.setOffsetMs(1, { ttlMs: 0 }), RangeError)
  clock.dispose()
})

// ---------------------------------------------------------------------------------------
// Dependency hygiene (SPEC §2: `@deepseek-ai/*` only in peerDependencies; no runtime deps)
// ---------------------------------------------------------------------------------------
test('project package.json declares no runtime dependencies', { skip: missing }, () => {
  const pkg = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8'))
  const deps = pkg.dependencies ?? {}
  assert.deepEqual(Object.keys(deps), [], `dependencies must stay empty, got ${JSON.stringify(deps)}`)
  const badPeer = Object.keys(pkg.peerDependencies ?? {}).filter((k) => !k.startsWith('@deepseek-ai/'))
  assert.deepEqual(badPeer, [], 'peerDependencies should only carry @deepseek-ai/* peers')
  assert.equal(pkg.type, 'module')
})

test('no new @deepseek-ai/* package appeared in the desktop profile vs the pre-install baseline', { skip: missing }, () => {
  const baselineFile = join(HERE, 'baseline', 'deepseek-ai-modules.txt')
  if (!existsSync(baselineFile)) { console.log('no baseline captured; skipping profile comparison'); return }
  const baseline = new Set(readFileSync(baselineFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  const dir = join(PROFILE, 'node_modules', '@deepseek-ai')
  const current = new Set(existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
        const pj = join(dir, e.name, 'package.json')
        return existsSync(pj) ? `${e.name}@${JSON.parse(readFileSync(pj, 'utf8')).version}` : e.name
      })
    : [])
  const added = [...current].filter((x) => !baseline.has(x))
  const removed = [...baseline].filter((x) => !current.has(x))
  assert.deepEqual(added, [], `dsh-peak-hours must not install @deepseek-ai/* into the profile: ${JSON.stringify(added)}`)
  assert.deepEqual(removed, [], `baseline packages disappeared: ${JSON.stringify(removed)}`)
})
