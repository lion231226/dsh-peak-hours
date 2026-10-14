/**
 * Gate semantics (SPEC §2.4 / §3.4) — fake clock, no real time involved.
 *
 * Acceptance semantics fixed by the Lead:
 *  1. entering while `phase === 'idle'` (08:59:59, 12:00:00, 18:00:00, mid-idle)
 *     releases immediately, registering no waiter and no timer;
 *  2. entering while `phase === 'peak'` (09:00:00.000, 09:00:00.001,
 *     17:59:59.999, …) is held until the next idle boundary, released exactly
 *     on the transition millisecond;
 *  3. a task released at 08:59:59 is held from its NEXT gate check (which lands
 *     after 09:00:00) — that is the "running task pauses at peak start" path.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Gate } from '../../lib/host/gate.js'
import { bj, createFakeGate, flush, observe } from './helpers.mjs'

const FRI = '2026-10-09'
const SAT = '2026-10-10'
const MON = '2026-10-12'

/** A fresh controller per waiter, so abort paths stay independent. */
function controller() {
  return new AbortController()
}

test('idle entry releases immediately and registers nothing (acceptance 1)', async () => {
  for (const [dateKey, time] of [
    [FRI, '08:59:59'],
    [FRI, '12:00:00'],
    [FRI, '12:30:00'],
    [FRI, '18:00:00'],
    [FRI, '23:59:59'],
    [SAT, '10:00:00'],
  ]) {
    const { gate, timers } = createFakeGate({ startMs: bj(dateKey, time) })
    const signal = controller().signal
    const waiter = observe(gate.wait(signal))
    await flush()
    assert.equal(waiter.status, 'resolved', `${dateKey} ${time} must release immediately`)
    assert.equal(gate.waiterCount, 0)
    assert.equal(timers.liveTimerCount, 0, `${dateKey} ${time} must not arm a timer`)
    assert.equal(gate.isPaused(), false)
  }
})

test('always mode never holds, even deep inside a peak window (acceptance 2, mode rule)', async () => {
  const { gate, timers } = createFakeGate({ startMs: bj(FRI, '10:00:00'), mode: 'always' })
  const waiter = observe(gate.wait(controller().signal))
  await flush()
  assert.equal(waiter.status, 'resolved')
  assert.equal(gate.waiterCount, 0)
  assert.equal(timers.liveTimerCount, 0)
  assert.equal(gate.isPaused(), false)
  // …and switching to idle-only with zero waiters arms nothing.
  const host = createFakeGate({ startMs: bj(FRI, '10:00:00'), mode: 'idle-only' })
  host.gate.notifyChanged()
  assert.equal(host.timers.liveTimerCount, 0)
})

test('peak entry is held and released exactly at the 12:00:00 idle boundary (acceptance 2)', async () => {
  const cases = [
    ['09:00:00.000', bj(FRI, '09:00:00')],
    ['09:00:00.001', bj(FRI, '09:00:00') + 1],
    ['11:59:59.999', bj(FRI, '11:59:59') + 999],
  ]
  for (const [label, startMs] of cases) {
    const { gate, timers } = createFakeGate({ startMs })
    const waiter = observe(gate.wait(controller().signal))
    await flush()
    assert.equal(waiter.status, 'pending', `${label} must hold`)
    assert.equal(gate.waiterCount, 1)
    assert.equal(timers.liveTimerCount, 1, 'exactly one boundary timer')
    assert.equal(gate.targetAt, bj(FRI, '12:00:00'))

    assert.equal(timers.advanceTo(bj(FRI, '12:00:00') - 1), 0, 'nothing fires before the boundary')
    await flush()
    assert.equal(waiter.status, 'pending', 'still held one millisecond before the boundary')

    timers.advanceTo(bj(FRI, '12:00:00'))
    await flush()
    assert.equal(waiter.status, 'resolved', 'released exactly at 12:00:00.000')
    assert.equal(gate.waiterCount, 0)
    assert.equal(timers.liveTimerCount, 0, 'no timer survives the release')
  }
})

test('peak entry at 17:59:59.999 is released exactly at 18:00:00', async () => {
  const { gate, timers } = createFakeGate({ startMs: bj(FRI, '17:59:59') + 999 })
  const waiter = observe(gate.wait(controller().signal))
  await flush()
  assert.equal(waiter.status, 'pending')
  assert.equal(gate.targetAt, bj(FRI, '18:00:00'))
  timers.advanceTo(bj(FRI, '17:59:59') + 999)
  await flush()
  assert.equal(waiter.status, 'pending')
  timers.advanceTo(bj(FRI, '18:00:00'))
  await flush()
  assert.equal(waiter.status, 'resolved')
  assert.equal(timers.liveTimerCount, 0)
})

test('a task released at 08:59:59 is held by its next check after 09:00:00 (acceptance 3)', async () => {
  const { gate, timers } = createFakeGate({ startMs: bj(FRI, '08:59:59') })
  const signal = controller().signal

  // The step that starts one second before the window runs: idle is runnable.
  const first = observe(gate.wait(signal))
  await flush()
  assert.equal(first.status, 'resolved')
  assert.equal(gate.waiterCount, 0)

  // Its next gate check (pre-step boundary or the tool gate) lands in the window.
  timers.setNow(bj(FRI, '09:00:00'))
  const second = observe(gate.wait(signal))
  await flush()
  assert.equal(second.status, 'pending', 'the running task pauses once the window opens')

  timers.advanceTo(bj(FRI, '09:00:01'))
  await flush()
  assert.equal(second.status, 'pending', 'still held after crossing 09:00:00')
  assert.equal(gate.waiterCount, 1)

  timers.advanceTo(bj(FRI, '12:00:00'))
  await flush()
  assert.equal(second.status, 'resolved', 'released at the idle boundary')

  // Outside the windows the same task runs again.
  const third = observe(gate.wait(signal))
  await flush()
  assert.equal(third.status, 'resolved')
})

test('concurrent waiters share ONE timer and are released together', async () => {
  const { gate, timers } = createFakeGate({ startMs: bj(FRI, '09:30:00') })
  const waiters = [observe(gate.wait(controller().signal)), observe(gate.wait(controller().signal)), observe(gate.wait(controller().signal))]
  await flush()
  assert.equal(gate.waiterCount, 3)
  assert.equal(timers.liveTimerCount, 1, 'a single boundary timer serves every waiter')

  timers.advanceTo(bj(FRI, '12:00:00'))
  await flush()
  for (const waiter of waiters) assert.equal(waiter.status, 'resolved')
  assert.equal(gate.waiterCount, 0)
  assert.equal(timers.liveTimerCount, 0)
})

test('abort during the hold propagates (with and without an explicit reason)', async () => {
  const { gate, timers } = createFakeGate({ startMs: bj(FRI, '10:00:00') })

  const first = controller()
  const held = observe(gate.wait(first.signal))
  await flush()
  assert.equal(held.status, 'pending')
  first.abort(new Error('user stopped the task'))
  await flush()
  assert.equal(held.status, 'rejected')
  assert.equal(held.error.message, 'user stopped the task')
  assert.equal(gate.waiterCount, 0, 'an aborted waiter is removed')
  assert.equal(timers.liveTimerCount, 0, 'the last waiter leaving clears the timer')

  const second = controller()
  const heldAgain = observe(gate.wait(second.signal))
  await flush()
  assert.equal(heldAgain.status, 'pending')
  second.abort()
  await flush()
  assert.equal(heldAgain.status, 'rejected')
  assert.equal(heldAgain.error.name, 'AbortError')
  assert.equal(gate.waiterCount, 0)
  assert.equal(timers.liveTimerCount, 0)
})

test('an already-aborted signal rejects without registering a waiter', async () => {
  const { gate, timers } = createFakeGate({ startMs: bj(FRI, '10:00:00') })
  const aborted = controller()
  aborted.abort()
  await assert.rejects(gate.wait(aborted.signal), (error) => error.name === 'AbortError')
  assert.equal(gate.waiterCount, 0)
  assert.equal(timers.liveTimerCount, 0)
})

test('aborting one waiter leaves its peers held on the same timer', async () => {
  const { gate, timers } = createFakeGate({ startMs: bj(FRI, '09:30:00') })
  const doomed = controller()
  const survivor = controller()
  const first = observe(gate.wait(doomed.signal))
  const second = observe(gate.wait(survivor.signal))
  await flush()
  assert.equal(gate.waiterCount, 2)

  doomed.abort(new Error('only the first task stopped'))
  await flush()
  assert.equal(first.status, 'rejected')
  assert.equal(second.status, 'pending')
  assert.equal(gate.waiterCount, 1)
  assert.equal(timers.liveTimerCount, 1)

  timers.advanceTo(bj(FRI, '12:00:00'))
  await flush()
  assert.equal(second.status, 'resolved')
  assert.equal(timers.liveTimerCount, 0)
})

test('abort listeners are detached once a waiter settles', async () => {
  const { gate, timers } = createFakeGate({ startMs: bj(FRI, '09:30:00') })
  const released = controller()
  const observed = observe(gate.wait(released.signal))
  await flush()
  timers.advanceTo(bj(FRI, '12:00:00'))
  await flush()
  assert.equal(observed.status, 'resolved')
  // A late abort must not resurrect a waiter or throw.
  released.abort(new Error('late abort'))
  await flush()
  assert.equal(gate.waiterCount, 0)
  assert.equal(timers.liveTimerCount, 0)
})

test('switching to always (or a new mode write) releases held waiters immediately', async () => {
  const host = createFakeGate({ startMs: bj(FRI, '09:30:00') })
  const waiters = [observe(host.gate.wait(controller().signal)), observe(host.gate.wait(controller().signal))]
  await flush()
  assert.equal(host.gate.waiterCount, 2)
  host.setMode('always')
  host.gate.notifyChanged()
  await flush()
  for (const waiter of waiters) assert.equal(waiter.status, 'resolved')
  assert.equal(host.gate.waiterCount, 0)
  assert.equal(host.timers.liveTimerCount, 0)
})

test('a clock jump out of the window releases waiters on notifyChanged', async () => {
  const host = createFakeGate({ startMs: bj(FRI, '10:00:00') })
  const waiter = observe(host.gate.wait(controller().signal))
  await flush()
  assert.equal(waiter.status, 'pending')
  // Simulate the clock override being cleared/advanced past the boundary.
  host.timers.setNow(bj(FRI, '12:00:00'))
  host.gate.notifyChanged()
  await flush()
  assert.equal(waiter.status, 'resolved')
  assert.equal(host.timers.liveTimerCount, 0)
})

test('re-arming is floored at 1 Hz: a stalled or degenerate clock cannot spin', async () => {
  // nextTransition that never moves forward -> the gate must not poll faster than 1 Hz.
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    nextTransition: (epochMs) => ({ at: epochMs, to: 'idle' }),
  })
  const waiter = observe(host.gate.wait(controller().signal))
  await flush()
  assert.equal(waiter.status, 'pending')
  assert.equal(host.timers.liveTimerCount, 1)
  assert.ok(host.timers.liveTimers[0].delayMs >= 1000, `re-arm delay ${host.timers.liveTimers[0].delayMs} must be >= 1000ms`)

  // A degenerate transition that keeps reporting the same target stays floored too.
  const stuck = createFakeGate({ startMs: bj(FRI, '10:00:00'), nextTransition: () => ({ at: bj(FRI, '10:00:00'), to: 'idle' }) })
  const held = observe(stuck.gate.wait(controller().signal))
  await flush()
  assert.equal(held.status, 'pending')
  assert.ok(stuck.timers.liveTimers[0].delayMs >= 1000)
})

test('a throwing schedule core fails open (never holds, never throws)', async () => {
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    classify: () => {
      throw new Error('core exploded')
    },
  })
  const waiter = observe(host.gate.wait(controller().signal))
  await flush()
  assert.equal(waiter.status, 'resolved', 'a broken classifier must not hold a task')
  assert.equal(host.timers.liveTimerCount, 0)

  const transitionBomb = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    nextTransition: () => {
      throw new Error('transition exploded')
    },
  })
  const held = observe(transitionBomb.gate.wait(controller().signal))
  await flush()
  assert.equal(held.status, 'pending', 'still held: the phase says peak')
  assert.ok(transitionBomb.timers.liveTimers[0].delayMs >= 1000, 'unknown boundary re-checks at the 1 Hz floor')

  // The same broken transition must still release when the phase turns idle.
  transitionBomb.timers.setNow(bj(FRI, '12:00:00'))
  transitionBomb.gate.notifyChanged()
  await flush()
  assert.equal(held.status, 'resolved')
})

test('dispose releases waiters, cancels the timer and fails open afterwards', async () => {
  const host = createFakeGate({ startMs: bj(FRI, '09:30:00') })
  const waiters = [observe(host.gate.wait(controller().signal)), observe(host.gate.wait(controller().signal))]
  await flush()
  assert.equal(host.timers.liveTimerCount, 1)

  host.gate.dispose()
  await flush()
  for (const waiter of waiters) assert.equal(waiter.status, 'resolved', 'held turns resume on unload instead of hanging')
  assert.equal(host.gate.waiterCount, 0)
  assert.equal(host.timers.liveTimerCount, 0, 'no timer survives disposal')
  assert.equal(host.gate.timerArmed, false)

  const after = observe(host.gate.wait(controller().signal))
  await flush()
  assert.equal(after.status, 'resolved')
  assert.equal(host.timers.liveTimerCount, 0)
})

test('a task entering in a peak window on a Saturday is not held (weekend is idle)', async () => {
  const { gate } = createFakeGate({ startMs: bj(SAT, '10:00:00') })
  const waiter = observe(gate.wait(controller().signal))
  await flush()
  assert.equal(waiter.status, 'resolved')
})

test('next weekday boundary: entering Saturday 00:00 is idle; Monday 09:00 holds until 12:00', async () => {
  const monday = createFakeGate({ startMs: bj(MON, '09:00:00') })
  const waiter = observe(monday.gate.wait(controller().signal))
  await flush()
  assert.equal(waiter.status, 'pending')
  assert.equal(monday.gate.targetAt, bj(MON, '12:00:00'))
  monday.timers.advanceTo(bj(MON, '12:00:00'))
  await flush()
  assert.equal(waiter.status, 'resolved')
})

test('the public Gate constructor validates its required dependencies', () => {
  assert.throws(() => new Gate({ getMode: () => 'always' }), /requires now/)
  assert.throws(() => new Gate({ now: () => 0 }), /requires getMode/)
})

test('peakLeadMs is an opt-in lead guard and is off by default', async () => {
  // Default: 08:59:59 is idle and runnable.
  const strict = createFakeGate({ startMs: bj(FRI, '08:59:59') })
  const released = observe(strict.gate.wait(controller().signal))
  await flush()
  assert.equal(released.status, 'resolved')
  assert.equal(strict.timers.liveTimerCount, 0)

  // Opt-in: the same instant is held across the peak boundary.
  const guarded = createFakeGate({ startMs: bj(FRI, '08:59:59'), peakLeadMs: 1000 })
  const held = observe(guarded.gate.wait(controller().signal))
  await flush()
  assert.equal(held.status, 'pending')
  assert.equal(guarded.gate.targetAt, bj(FRI, '09:00:00'))
  guarded.timers.advanceTo(bj(FRI, '09:00:00'))
  await flush()
  assert.equal(held.status, 'pending', 'the peak window keeps it held')
  assert.equal(guarded.gate.targetAt, bj(FRI, '12:00:00'))
  guarded.timers.advanceTo(bj(FRI, '12:00:00'))
  await flush()
  assert.equal(held.status, 'resolved')
})

// ── SPEC §9.2: the gate judges a task by ITS OWN session ─────────────────────

test('per-session: session A runs freely while session B is held in the same peak window', async () => {
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    mode: 'idle-only', // the host default
    sessionModes: { 'session-a': 'always', 'session-b': 'idle-only' },
  })

  const free = observe(host.gate.wait(controller().signal, 'session-a'))
  const held = observe(host.gate.wait(controller().signal, 'session-b'))
  await flush()
  assert.equal(free.status, 'resolved', 'session A is always-on: it must never be held because B is idle-only')
  assert.equal(held.status, 'pending', 'session B is idle-only: it must be held even while A runs')
  assert.equal(host.gate.waiterCount, 1, 'only B is waiting')
  assert.equal(host.timers.liveTimerCount, 1)
  assert.equal(host.gate.isPaused('session-a'), false)
  assert.equal(host.gate.isPaused('session-b'), true)
})

test('per-session: waiter accounting is per session and host-wide', async () => {
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    mode: 'idle-only',
    sessionModes: { 'session-a': 'idle-only', 'session-b': 'idle-only' },
  })
  const a1 = observe(host.gate.wait(controller().signal, 'session-a'))
  const a2 = observe(host.gate.wait(controller().signal, 'session-a'))
  const b1 = observe(host.gate.wait(controller().signal, 'session-b'))
  await flush()
  assert.equal(host.gate.waiterCountFor('session-a'), 2)
  assert.equal(host.gate.waiterCountFor('session-b'), 1)
  assert.equal(host.gate.waiterCountFor('session-c'), 0)
  assert.equal(host.gate.waiterCount, 3, 'waitingTasksTotal')
  assert.equal(host.timers.liveTimerCount, 1, 'all sessions share the single boundary timer')

  a1.value
  host.timers.advanceTo(bj(FRI, '12:00:00'))
  await flush()
  for (const waiter of [a1, a2, b1]) assert.equal(waiter.status, 'resolved')
  assert.equal(host.gate.waiterCount, 0)
  assert.equal(host.timers.liveTimerCount, 0)
})

test('per-session: a mode write releases only that session and leaves the others held', async () => {
  // `b` carries an explicit override; `a` and `c` follow the host default.
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    mode: 'idle-only',
    sessionModes: { b: 'idle-only' },
  })
  const a = observe(host.gate.wait(controller().signal, 'a'))
  const b = observe(host.gate.wait(controller().signal, 'b'))
  const c = observe(host.gate.wait(controller().signal, 'c'))
  await flush()
  assert.equal(host.gate.waiterCount, 3)

  host.setSessionMode('b', 'always')
  host.gate.notifyChanged('b')
  await flush()
  assert.equal(a.status, 'pending', 'a is untouched')
  assert.equal(b.status, 'resolved', 'b switched to always and is released at once')
  assert.equal(c.status, 'pending', 'c is untouched')
  assert.equal(host.gate.waiterCount, 2)
  assert.equal(host.timers.liveTimerCount, 1, 'the remaining sessions keep the single timer')

  // A default write releases the sessions that follow the default; b's own
  // override is gone with it, and any session still on idle-only would stay.
  host.setMode('always')
  host.gate.notifyChanged()
  await flush()
  assert.equal(a.status, 'resolved')
  assert.equal(c.status, 'resolved')
  assert.equal(host.gate.waiterCount, 0)
  assert.equal(host.timers.liveTimerCount, 0)
})

test('per-session: a session with its own override ignores a default write', async () => {
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    mode: 'idle-only',
    sessionModes: { pinned: 'idle-only' },
  })
  const pinned = observe(host.gate.wait(controller().signal, 'pinned'))
  const follower = observe(host.gate.wait(controller().signal, 'follower'))
  await flush()
  assert.equal(host.gate.waiterCount, 2)

  host.setMode('always')
  host.gate.notifyChanged()
  await flush()
  assert.equal(follower.status, 'resolved', 'the follower picks up the new default')
  assert.equal(pinned.status, 'pending', 'the pinned override keeps its own choice')
  assert.equal(host.gate.waiterCount, 1)

  host.setSessionMode('pinned', 'always')
  host.gate.notifyChanged('pinned')
  await flush()
  assert.equal(pinned.status, 'resolved')
  assert.equal(host.timers.liveTimerCount, 0)
})

test('per-session: a committed write for one session never disturbs another session', async () => {
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    mode: 'idle-only',
    sessionModes: { a: 'idle-only', b: 'idle-only' },
  })
  const a = observe(host.gate.wait(controller().signal, 'a'))
  const b = observe(host.gate.wait(controller().signal, 'b'))
  await flush()

  // A writes to session A *without* changing its mode (always → always is not
  // the case here: A stays idle-only), simulating an unrelated session write.
  host.gate.notifyChanged('b')
  await flush()
  assert.equal(a.status, 'pending')
  assert.equal(b.status, 'pending')
  assert.equal(host.gate.waiterCount, 2)
  host.gate.notifyChanged(undefined)
  await flush()
  assert.equal(a.status, 'pending')
  assert.equal(b.status, 'pending')
})

test('per-session: an unresolvable sessionId follows the default mode, never a fixed answer', async () => {
  // default = idle-only → an unresolved task is held (must not be silently allowed).
  const heldHost = createFakeGate({ startMs: bj(FRI, '10:00:00'), mode: 'idle-only', sessionModes: {} })
  const held = observe(heldHost.gate.wait(controller().signal, undefined))
  await flush()
  assert.equal(held.status, 'pending', 'default idle-only holds an unresolved task')
  assert.equal(heldHost.gate.waiterCountFor(undefined), 1, 'it is counted in the no-session bucket')
  assert.equal(heldHost.gate.waiterCountFor(''), 1)
  assert.equal(heldHost.gate.waiterCountFor('other'), 0)

  // default = always → an unresolved task runs (must not be held by someone else's choice).
  const freeHost = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    mode: 'always',
    sessionModes: { other: 'idle-only' },
  })
  const free = observe(freeHost.gate.wait(controller().signal, undefined))
  await flush()
  assert.equal(free.status, 'resolved', 'default always releases an unresolved task')
  assert.equal(freeHost.gate.waiterCount, 0)
  assert.equal(freeHost.timers.liveTimerCount, 0)
})

test('per-session: an override beats the default in both directions', async () => {
  const host = createFakeGate({ startMs: bj(FRI, '10:00:00'), mode: 'always', sessionModes: { strict: 'idle-only' } })
  const strict = observe(host.gate.wait(controller().signal, 'strict'))
  const loose = observe(host.gate.wait(controller().signal, 'loose'))
  await flush()
  assert.equal(strict.status, 'pending', 'the override wins over an always default')
  assert.equal(loose.status, 'resolved')

  const inverse = createFakeGate({ startMs: bj(FRI, '10:00:00'), mode: 'idle-only', sessionModes: { loose: 'always' } })
  const free = observe(inverse.gate.wait(controller().signal, 'loose'))
  const held = observe(inverse.gate.wait(controller().signal, 'other'))
  await flush()
  assert.equal(free.status, 'resolved', 'the override wins over an idle-only default')
  assert.equal(held.status, 'pending')
})

test('per-session: an abort only ends its own wait, peers stay held', async () => {
  const host = createFakeGate({ startMs: bj(FRI, '10:00:00'), mode: 'idle-only' })
  const doomed = controller()
  const a = observe(host.gate.wait(doomed.signal, 'a'))
  const b = observe(host.gate.wait(controller().signal, 'b'))
  await flush()
  assert.equal(host.gate.waiterCountFor('a'), 1)

  doomed.abort(new Error('session a stopped'))
  await flush()
  assert.equal(a.status, 'rejected')
  assert.equal(b.status, 'pending')
  assert.equal(host.gate.waiterCountFor('a'), 0)
  assert.equal(host.gate.waiterCountFor('b'), 1)
  assert.equal(host.timers.liveTimerCount, 1)
})

test('per-session: a broken mode resolver fails open per session', async () => {
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    getMode: () => {
      throw new Error('store exploded')
    },
  })
  const waiter = observe(host.gate.wait(controller().signal, 'a'))
  await flush()
  assert.equal(waiter.status, 'resolved', 'an unreadable mode must never strand a task')
  assert.equal(host.timers.liveTimerCount, 0)
})

test('an unresolved session is observable: one warning and a dedicated bucket (P1-1)', async () => {
  const logs = []
  const host = createFakeGate({
    startMs: bj(FRI, '10:00:00'),
    mode: 'idle-only',
    log: { warn: (message) => logs.push(String(message)) },
  })
  const first = observe(host.gate.wait(controller().signal, undefined))
  const second = observe(host.gate.wait(controller().signal, ''))
  const named = observe(host.gate.wait(controller().signal, 'session-a'))
  await flush()
  assert.equal(first.status, 'pending')
  assert.equal(second.status, 'pending')
  assert.equal(named.status, 'pending')
  assert.equal(host.gate.unresolvedWaiterCount, 2, 'both unresolved tasks are counted')
  assert.equal(host.gate.waiterCountFor(''), 2)
  assert.equal(host.gate.waiterCountFor('session-a'), 1)
  assert.equal(host.gate.waiterCount, 3)
  assert.equal(logs.filter((message) => message.includes('no resolvable session id')).length, 1, 'warned exactly once, not per waiter')

  host.timers.advanceTo(bj(FRI, '12:00:00'))
  await flush()
  assert.equal(host.gate.unresolvedWaiterCount, 0)
})

test('per-session: switching the default to idle-only immediately holds a fresh check', async () => {
  const host = createFakeGate({ startMs: bj(FRI, '10:00:00'), mode: 'always', sessionModes: {} })
  const before = observe(host.gate.wait(controller().signal, 'no-override'))
  await flush()
  assert.equal(before.status, 'resolved', 'always releases')

  host.setMode('idle-only')
  host.gate.notifyChanged()
  const after = observe(host.gate.wait(controller().signal, 'no-override'))
  await flush()
  assert.equal(after.status, 'pending', 'the reverse switch must hold immediately, not at the next boundary')
  assert.equal(host.gate.waiterCountFor('no-override'), 1)
  assert.equal(host.timers.liveTimerCount, 1)
})
