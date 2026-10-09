/**
 * Production wiring (SPEC §2.4): what `apply()` actually registers, what the
 * two waterfalls do on the real path, and that disposal leaves nothing behind.
 *
 * The plugin's own clock reads `Date.now()`, so the test drives the phase
 * through the documented clock override (deterministic: 2026-11-19 is a
 * Thursday with no Chinese statutory holiday, so 10:00 is peak and 12:00:05 is
 * idle under both the real core and the degraded fallback) while the timers are
 * the same deterministic fake registry used by the gate tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_VERSION, PLUGIN_NAME, apply, inject, isUsableSignal, mount, name } from '../../lib/host/index.js'
import { ROUTE_PATHS } from '../../lib/host/routes.js'
import { STATE_FILE_NAME } from '../../lib/host/store.js'
import { acceptPluginResult, bj, createFakeCtx, createFakeTimers, flush, observe } from './helpers.mjs'

const PEAK_DAY = '2026-11-19' // Thursday, no statutory holiday
const PEAK_AT = bj(PEAK_DAY, '10:00:00')
const AFTER_MORNING = bj(PEAK_DAY, '12:00:05')
const LONG_TTL = 8 * 3600 * 1000

/** Run one body against a private DSH_HOME, restoring the env afterwards. */
async function withHome(t, body) {
  const home = await mkdtemp(join(tmpdir(), 'peak-hours-host-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  return await body(home)
}

/** A fake context plus fake timers over a private DSH_HOME. */
async function withFakeCtx(t, body) {
  return await withHome(t, async (home) => {
    const timers = createFakeTimers(PEAK_AT)
    const fake = createFakeCtx({ timers })
    return await body({ home, timers, fake })
  })
}

/**
 * Mount the surface directly. `apply()` must resolve to `undefined` (cordis
 * collects a plugin's resolved value as an effect handle), so the surface is
 * only reachable through the exported `mount()`.
 */
async function mountPlugin(t, config = { allowClockOverride: true }) {
  return await withFakeCtx(t, async ({ home, timers, fake }) => {
    const surface = await mount(fake.ctx, config, { registry: [] })
    assert.ok(surface, 'mount must return the surface')
    return { home, timers, fake, surface }
  })
}

/** Point the plugin clock at one Beijing instant (override + gate re-evaluation). */
function setNow(surface, epochMs, ttlMs = LONG_TTL) {
  surface.clock.setOffsetMs(epochMs - Date.now(), { ttlMs })
  surface.gate.notifyChanged()
}

test('the module exports the frozen plugin surface', () => {
  assert.equal(name, 'peak-hours')
  assert.deepEqual(inject, ['timer', 'webServer'])
  assert.equal(PLUGIN_NAME, 'dsh-peak-hours')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof mount, 'function')
  assert.equal(DEFAULT_VERSION, '0.0.0')
})

test('apply() resolves to undefined: cordis collects a plugin result as an effect handle (F6 regression)', async (t) => {
  await withFakeCtx(t, async ({ fake }) => {
    const result = await apply(fake.ctx, { allowClockOverride: true })
    // cordis/lib/index.js:1138-1145 (reached from Fiber._reload at :1356):
    // `safeCollect` takes a function as a disposer, null/undefined as "no
    // cleanup", and throws `TypeError: Invalid effect` for anything else —
    // which fails the whole fiber and registers nothing.
    assert.equal(result, undefined, 'apply must resolve to undefined, never the surface object')
    assert.notEqual(typeof result, 'function', 'a function result would be collected and called on unload')
    assert.equal(acceptPluginResult(result), 'none')
    assert.equal(fake.routes.size, 4, 'the mount really registered its routes')
    assert.equal(fake.activeListeners('agent/pre-step').length, 1)
    assert.equal(fake.activeListeners('tools/pre-execute').length, 1)
    fake.disposeAll()
  })
})

test('apply() in always-mode-default config also resolves to undefined', async (t) => {
  await withFakeCtx(t, async ({ fake }) => {
    assert.equal(await apply(fake.ctx), undefined)
    assert.equal(fake.routes.size, 4)
    fake.disposeAll()
  })
})

test('a second apply while the first mount is live is contained and leaves no residue', async (t) => {
  await withFakeCtx(t, async ({ fake }) => {
    await apply(fake.ctx, { allowClockOverride: true })
    const liveEffects = fake.effects.filter((entry) => entry.active).length
    assert.equal(fake.routes.size, 4)

    const second = await apply(fake.ctx, { allowClockOverride: true })
    assert.equal(second, undefined)
    assert.equal(fake.routes.size, 4, "the first mount's routes are untouched")
    assert.equal(fake.activeListeners('agent/pre-step').length, 1, 'no duplicated listener')
    assert.equal(fake.activeListeners('tools/pre-execute').length, 1)
    assert.equal(fake.effects.filter((entry) => entry.active).length, liveEffects, 'the failed re-mount unwound every effect it registered')
    assert.ok(
      fake.logs.some((entry) => entry.level === 'error' && entry.message.includes('mount failed')),
      'the duplicate-route failure is reported, not swallowed silently',
    )
    fake.disposeAll()
  })
})

test('unload then re-mount in the same process starts from a clean state', async (t) => {
  await withFakeCtx(t, async ({ fake }) => {
    await apply(fake.ctx, { allowClockOverride: true })
    assert.equal(fake.routes.size, 4)
    assert.equal(fake.activeListeners('agent/pre-step').length, 1)

    // The fiber unloads: every listener, route and effect goes with it.
    fake.disposeAll()
    assert.equal(fake.routes.size, 0)
    assert.equal(fake.activeListeners('agent/pre-step').length, 0)
    assert.equal(fake.activeListeners('tools/pre-execute').length, 0)

    // A fresh activation must not trip over duplicate routes.
    await apply(fake.ctx, { allowClockOverride: true })
    assert.equal(fake.routes.size, 4, 're-mount re-registers every route')
    assert.equal(fake.activeListeners('agent/pre-step').length, 1)
    assert.equal(fake.activeListeners('tools/pre-execute').length, 1)
    assert.equal(
      fake.logs.filter((entry) => entry.level === 'error').length,
      0,
      'a clean re-mount logs no mount failure',
    )
    fake.disposeAll()
    assert.equal(fake.routes.size, 0)
  })
})

test('isUsableSignal only trusts a real abortable signal', () => {
  assert.equal(isUsableSignal(new AbortController().signal), true)
  assert.equal(isUsableSignal(undefined), false)
  assert.equal(isUsableSignal(null), false)
  assert.equal(isUsableSignal({}), false)
  assert.equal(isUsableSignal({ aborted: false }), false)
  assert.equal(isUsableSignal({ aborted: false, addEventListener: () => {} }), true)
  assert.equal(isUsableSignal({ aborted: 'no', addEventListener: () => {} }), false)
})

test('apply registers the primary gate, the mid-turn gate and the four routes', async (t) => {
  const { fake, surface, timers } = await mountPlugin(t)

  assert.equal(fake.activeListeners('agent/pre-step').length, 1, 'exactly one pre-step listener')
  assert.equal(fake.activeListeners('tools/pre-execute').length, 1, 'exactly one pre-execute listener')
  assert.equal(fake.activeListeners('agent/pre-step')[0].options.prepend, true)
  assert.equal(fake.activeListeners('agent/pre-step')[0].options.global, true, 'every agent, including subagents')
  assert.equal(fake.activeListeners('tools/pre-execute')[0].options.prepend, true)
  assert.equal(fake.activeListeners('tools/pre-execute')[0].options.global, true)
  assert.deepEqual([...fake.routes.keys()].sort(), Object.values(ROUTE_PATHS).sort())

  assert.equal(surface.core === 'core' || surface.core === 'fallback', true)
  assert.equal(surface.version, '0.1.0', 'the reported version comes from package.json')
  assert.equal(surface.allowClockOverride, true)

  // A fresh DSH_HOME has no state file: the mode starts at always, silently.
  const state = (await surface.handlers.state()).body.state
  assert.equal(state.mode, 'always')
  assert.equal(timers.liveTimerCount, 0)
  assert.equal(surface.gate.waiterCount, 0)
  const warns = fake.logs.filter((entry) => entry.level === 'warn' && !entry.message.includes('schedule core unavailable'))
  assert.deepEqual(warns, [], 'a healthy mount warns about nothing')
})

test('always mode passes every step straight through', async (t) => {
  const { fake, surface } = await mountPlugin(t)
  setNow(surface, PEAK_AT)
  const decision = await fake.invoke('agent/pre-step', { messages: [], turn: 1, step: 1, signal: new AbortController().signal })
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(surface.gate.waiterCount, 0)
})

test('idle-only holds a real pre-step across the peak window and releases it at the boundary', async (t) => {
  const { fake, surface, timers } = await mountPlugin(t)
  assert.equal((await surface.handlers.mode({ mode: 'idle-only' })).status, 200)

  setNow(surface, PEAK_AT)
  const peakState = (await surface.handlers.state()).body.state
  assert.equal(peakState.phase, 'peak', `expected a peak phase at ${PEAK_DAY} 10:00 (core=${surface.core})`)
  assert.equal(peakState.mode, 'idle-only')
  assert.equal(peakState.paused, true)
  assert.equal(peakState.waitingTasks, 0)

  const controller = new AbortController()
  const pending = observe(fake.invoke('agent/pre-step', { messages: [], turn: 1, step: 1, signal: controller.signal }))
  await flush()
  assert.equal(pending.status, 'pending', 'the step must not proceed during peak')
  assert.equal(surface.gate.waiterCount, 1)
  assert.equal(surface.gate.timerArmed, true, 'the boundary timer is armed')
  assert.equal(surface.gate.targetAt, bj(PEAK_DAY, '12:00:00'))

  const waitingState = (await surface.handlers.state()).body.state
  assert.equal(waitingState.waitingTasks, 1, 'the state reports the held task')
  assert.equal(waitingState.paused, true)

  // The idle boundary arrives: the gate re-evaluates on its own timer.
  setNow(surface, AFTER_MORNING)
  timers.advanceBy(bj(PEAK_DAY, '12:00:00') - PEAK_AT)
  await flush()
  assert.deepEqual(pending.value, { kind: 'enter', messages: [] }, 'the held step resumes by itself')
  assert.equal(surface.gate.waiterCount, 0)
  assert.equal(surface.gate.timerArmed, false)
  assert.equal((await surface.handlers.state()).body.state.waitingTasks, 0)
})

test('idle-only releases immediately outside the windows', async (t) => {
  const { fake, surface } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })
  for (const instant of [bj(PEAK_DAY, '08:59:59'), bj(PEAK_DAY, '12:00:00'), bj(PEAK_DAY, '18:00:00'), bj('2026-11-21', '10:00:00')]) {
    setNow(surface, instant)
    const state = (await surface.handlers.state()).body.state
    assert.equal(state.phase, 'idle', `expected idle at ${state.nowText}`)
    const pending = observe(fake.invoke('agent/pre-step', { messages: [], turn: 1, step: 1, signal: new AbortController().signal }))
    await flush()
    assert.equal(pending.status, 'resolved', `must not hold at ${state.nowText}`)
    assert.equal(surface.gate.waiterCount, 0)
  }
})

test('an abort during the hold propagates out of the primary gate', async (t) => {
  const { fake, surface } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })
  setNow(surface, PEAK_AT)

  const controller = new AbortController()
  const pending = observe(fake.invoke('agent/pre-step', { messages: [], turn: 1, step: 1, signal: controller.signal }))
  await flush()
  assert.equal(pending.status, 'pending')

  controller.abort(new Error('user cancelled the turn'))
  await flush()
  assert.equal(pending.status, 'rejected')
  assert.equal(pending.error.message, 'user cancelled the turn')
  assert.equal(surface.gate.waiterCount, 0)
  assert.equal(surface.gate.timerArmed, false)
})

test('the tool gate holds before dispatch and cancels (never throws) on abort', async (t) => {
  const { fake, surface } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })
  setNow(surface, PEAK_AT)

  const controller = new AbortController()
  const exec = { callId: 'c1', name: 'pwsh', arguments: {}, signal: controller.signal }
  const pending = observe(fake.invoke('tools/pre-execute', exec))
  await flush()
  assert.equal(pending.status, 'pending', 'the tool must not be dispatched during peak')
  assert.equal(surface.gate.waiterCount, 1)

  controller.abort(new Error('turn aborted'))
  await flush()
  assert.equal(pending.status, 'resolved', 'the tool gate must resolve, not reject')
  assert.deepEqual(pending.value, { kind: 'cancel' }, 'the designed cancellation decision')
  assert.equal(surface.gate.waiterCount, 0)
})

test('the tool gate passes through outside peak and without a usable signal', async (t) => {
  const { fake, surface } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })
  setNow(surface, PEAK_AT)

  const noSignal = await fake.invoke('tools/pre-execute', { callId: 'c2', name: 'pwsh', arguments: {} })
  assert.deepEqual(noSignal, { kind: 'enter', messages: [] }, 'no signal means no hold: an unabortable wait is never armed')

  setNow(surface, AFTER_MORNING)
  const idle = await fake.invoke('tools/pre-execute', { callId: 'c3', name: 'pwsh', arguments: {}, signal: new AbortController().signal })
  assert.deepEqual(idle, { kind: 'enter', messages: [] })
})

test('a gate failure that is not an abort fails open instead of breaking the turn', async (t) => {
  const { fake, surface, timers } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })
  setNow(surface, PEAK_AT)

  // A hostile signal whose subscription throws: the hold cannot be established,
  // so the gate must log and let the call through.
  const hostile = {
    aborted: false,
    reason: undefined,
    addEventListener: () => {
      throw new TypeError('signal cannot subscribe')
    },
    removeEventListener: () => {},
  }
  const preStep = await fake.invoke('agent/pre-step', { messages: [], turn: 1, step: 1, signal: hostile })
  assert.deepEqual(preStep, { kind: 'enter', messages: [] })
  assert.equal(surface.gate.waiterCount, 0)
  assert.ok(fake.logs.some((entry) => entry.level === 'warn' && entry.message.includes('failed open')))

  const tool = await fake.invoke('tools/pre-execute', { callId: 'c4', name: 'pwsh', arguments: {}, signal: hostile })
  assert.deepEqual(tool, { kind: 'enter', messages: [] })
  assert.equal(timers.liveTimerCount <= 2, true)
})

test('the mode write persists to <DSH_HOME>/peak-hours-state.json', async (t) => {
  const { home, surface } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })
  const raw = JSON.parse(await readFile(join(home, STATE_FILE_NAME), 'utf8'))
  assert.equal(raw.mode, 'idle-only')
})

test('switching back to always releases held tasks immediately', async (t) => {
  const { fake, surface } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })
  setNow(surface, PEAK_AT)
  const pending = observe(fake.invoke('agent/pre-step', { messages: [], turn: 1, step: 1, signal: new AbortController().signal }))
  await flush()
  assert.equal(pending.status, 'pending')

  assert.equal((await surface.handlers.mode({ mode: 'always' })).body.state.mode, 'always')
  await flush()
  assert.equal(pending.status, 'resolved')
  assert.equal(surface.gate.waiterCount, 0)
  assert.equal(surface.gate.timerArmed, false)
})

test('the clock override is TTL-bounded and its expiry releases the gate', async (t) => {
  const { fake, surface, timers } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })

  const response = await surface.handlers.clock({ offsetMs: PEAK_AT - Date.now(), ttlMs: 5000 })
  const requestedOffset = PEAK_AT - Date.now()
  assert.equal(response.status, 200)
  const override = response.body.state.clockOverride
  assert.ok(Math.abs(override.offsetMs - requestedOffset) < 1000, 'the offset is echoed')
  assert.equal(override.ttlMs, 5000)
  assert.equal(typeof override.expiresAt, 'number')

  const pending = observe(fake.invoke('agent/pre-step', { messages: [], turn: 1, step: 1, signal: new AbortController().signal }))
  await flush()
  assert.equal(pending.status, 'pending', 'the faked clock puts the gate in peak')

  // The TTL fires: the override clears itself, logs once, and the gate re-evaluates.
  timers.advanceBy(5000)
  await flush()
  assert.equal(surface.clock.override, null)
  assert.equal(pending.status, 'resolved', 'the expiry released the held task')
  assert.equal(surface.gate.waiterCount, 0)
  assert.ok(fake.logs.some((entry) => entry.level === 'info' && entry.message.includes('clock override expired')))
  const state = (await surface.handlers.state()).body.state
  assert.equal(state.clockOverride, null)
})

test('clock override can be disabled by config', async (t) => {
  const { surface } = await mountPlugin(t, { allowClockOverride: false })
  assert.equal((await surface.handlers.clock({ offsetMs: 1000 })).status, 403)
  assert.equal((await surface.handlers.state()).body.state.config.allowClockOverride, false)
})

test('disposal leaves no listener, route or timer behind', async (t) => {
  const { fake, surface, timers } = await mountPlugin(t)
  await surface.handlers.mode({ mode: 'idle-only' })
  setNow(surface, PEAK_AT)
  const pending = observe(fake.invoke('agent/pre-step', { messages: [], turn: 1, step: 1, signal: new AbortController().signal }))
  await flush()
  assert.equal(pending.status, 'pending')

  fake.disposeAll()

  assert.equal(fake.activeListeners('agent/pre-step').length, 0)
  assert.equal(fake.activeListeners('tools/pre-execute').length, 0)
  assert.equal(fake.routes.size, 0)
  assert.equal(surface.gate.waiterCount, 0, 'held tasks are released on unload')
  assert.equal(surface.gate.timerArmed, false)
  assert.equal(timers.liveTimerCount, 0, 'every gate and clock timer is gone')
  await flush()
  assert.equal(pending.status, 'resolved')

  // A disposed plugin no longer participates: the same peak-time check runs free.
  const signal = new AbortController().signal
  const after = observe(fake.invoke('agent/pre-step', { messages: [], turn: 2, step: 1, signal }))
  await flush()
  assert.equal(after.status, 'resolved', 'a disposed plugin must not gate anything')
  assert.deepEqual(after.value, { kind: 'enter', messages: [] })
  assert.equal(surface.clock.offsetMs, null, 'the clock override went with the plugin')
})

test('a broken webServer is contained: apply logs and leaves nothing registered', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'peak-hours-host-broken-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  const logs = []
  const effects = []
  const listeners = []
  const broken = {
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]), error: (message) => logs.push(['error', message]) },
    timer: { timeout: () => () => {} },
    on: (event, handler) => {
      listeners.push(event)
      return () => {}
    },
    effect: (run, label) => {
      const dispose = run()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    webServer: {
      register: () => {
        throw new Error('webserver is not listening')
      },
    },
  }
  const surface = await apply(broken, { allowClockOverride: true })
  assert.equal(surface, undefined, 'a failed mount reports nothing instead of throwing')
  assert.ok(logs.some(([level, message]) => level === 'error' && String(message).includes('mount failed')))
  assert.equal(listeners.length, 2, 'the gates were registered before the failure…')
  for (const entry of effects) {
    assert.equal(entry.label.startsWith('peak-hours:'), true)
  }
})

test('two mounts in the same host do not share state', async (t) => {
  const first = await mountPlugin(t)
  const second = await mountPlugin(t)
  await first.surface.handlers.mode({ mode: 'idle-only' })
  assert.equal((await first.surface.handlers.state()).body.state.mode, 'idle-only')
  assert.equal((await second.surface.handlers.state()).body.state.mode, 'always')
  assert.notEqual(first.fake.ctx, second.fake.ctx)
})
