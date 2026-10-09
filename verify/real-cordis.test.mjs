// verify/real-cordis.test.mjs — verifier-owned regression gate on the REAL cordis runtime.
//
// Why this file exists: the plugin's host half is only correct if it survives real cordis 4.0.4
// semantics. A hand-written `ctx` mock is too permissive — in particular cordis treats the value
// a plugin's `apply()` RESOLVES to as an effect cleanup handle and throws `TypeError: Invalid
// effect` for anything that is neither a function nor nullish
// (_recon/src/cordis/lib/index.js:1138-1145). That exact defect (finding F6) killed the live
// fiber (`plugin_manager list_plugins` → `fiberPhase:"failed"`, all routes 401) while the mock
// suite stayed green. This file mounts the real thing instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRealCordis, makeWebServerStub, makeTimerStub } from './lib/real-cordis.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RECON = join(HERE, '..', '_recon', 'src', 'cordis', 'lib', 'index.js')
const reconPresent = existsSync(RECON)
const skipReason = reconPresent ? false : `real cordis not extracted at ${RECON}`

let plugin = null, loadErr = null
try { plugin = await import('../lib/host/index.js') } catch (e) { loadErr = e }
const missing = plugin ? skipReason : `lib/host/index.js unavailable: ${loadErr?.message}`

/** Mount the plugin under real cordis with stub services; returns the handles. */
async function mountReal({ dshHome }) {
  const { Context } = await loadRealCordis()
  const root = new Context()
  const ws = makeWebServerStub()
  const timer = makeTimerStub()
  root.provide('timer', timer)
  root.provide('webServer', ws)
  const previous = process.env.DSH_HOME
  if (dshHome !== undefined) process.env.DSH_HOME = dshHome
  try {
    const fiber = root.plugin(plugin, {})
    await fiber.await()          // rethrows the real startup error (e.g. TypeError: Invalid effect)
    return { root, ws, timer, fiber }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

const EXPECTED_PATHS = ['/api/peak-hours/state', '/api/peak-hours/mode', '/api/peak-hours/clock', '/api/peak-hours/health']

test('real cordis: apply() must not resolve to an object — fiber active + 4 live routes', { skip: missing }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'peak-real-home-'))
  try {
    let mounted = null
    try {
      mounted = await mountReal({ dshHome: home })
    } catch (error) {
      assert.fail(
        `mounting under the REAL cordis threw ${error?.name}: ${error?.message}\n` +
        'cordis treats the value apply() resolves to as an effect cleanup handle and requires it to ' +
        'be a function or nullish (_recon/src/cordis/lib/index.js:1138-1145). Return undefined/null ' +
        'from apply(); never return the mounted surface object. See verify/EVIDENCE.md F6.')
    }
    assert.equal(mounted.fiber.state, 2, 'fiber state must be 2 (active)')
    assert.deepEqual([...mounted.ws.exact.keys()].sort(), [...EXPECTED_PATHS].sort())

    const health = await mounted.ws.call('/api/peak-hours/health', { method: 'GET' })
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)
    assert.equal(health.body.plugin, 'dsh-peak-hours')
    assert.ok(health.body.version)

    const state = await mounted.ws.call('/api/peak-hours/state', { method: 'GET' })
    assert.equal(state.status, 200)
    assert.equal(state.body.ok, true)
    assert.equal(state.body.state.mode, 'always', 'a fresh state file defaults to always')
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(state.body.state.nowText))

    const flip = await mounted.ws.call('/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only' } })
    assert.equal(flip.status, 200)
    assert.equal(flip.body.state.mode, 'idle-only')
    const bad = await mounted.ws.call('/api/peak-hours/mode', { method: 'POST', body: { mode: 'nope' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)

    // real effect diagnostics: both gates and the route effect must be owned by this fiber
    const labels = (mounted.fiber.getEffects?.() ?? []).map((e) => e.label)
    for (const want of ['peak-hours: agent/pre-step gate', 'peak-hours: tools/pre-execute gate', 'peak-hours: routes']) {
      assert.ok(labels.includes(want), `expected effect "${want}", got ${JSON.stringify(labels)}`)
    }

    await mounted.fiber.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('real cordis: unload disposes every route and timer, then re-mounting works', { skip: missing }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'peak-real-home-'))
  try {
    const first = await mountReal({ dshHome: home })
    assert.equal(first.ws.exact.size, 4)
    const flip = await first.ws.call('/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only' } })
    assert.equal(flip.status, 200)
    const state1 = await first.ws.call('/api/peak-hours/state', { method: 'GET' })
    assert.equal(state1.body.state.mode, 'idle-only')
    await first.fiber.dispose()
    assert.equal(first.ws.exact.size, 0, 'unload must unregister every route (SPEC §3.6)')
    assert.equal(first.ws.disposed.length, 4, 'every route disposer must have run')
    assert.equal(first.timer.live.size, 0, 'unload must leave no live timer')

    // the exact path a profile re-activation takes: unload, then mount again in a fresh context
    const second = await mountReal({ dshHome: home })
    assert.equal(second.fiber.state, 2, 're-mounting after a clean unload must succeed')
    assert.deepEqual([...second.ws.exact.keys()].sort(), [...EXPECTED_PATHS].sort())
    const state = await second.ws.call('/api/peak-hours/state', { method: 'GET' })
    assert.equal(state.status, 200)
    assert.equal(state.body.state.mode, 'idle-only', 'the mode persisted by the first mount must be read back')
    await second.fiber.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('real cordis: the duplicate-route guard is real, so a second mount needs a dispose first', { skip: missing }, async () => {
  // Mirrors _recon/src/dsh-host-webserver/lib/index.js:179. Documents that re-activation must
  // dispose the previous fiber; a loader that re-applies without unloading cannot work.
  const ws = makeWebServerStub()
  ws.register({ kind: 'exact', path: '/api/x', handler: () => {} })
  assert.throws(() => ws.register({ kind: 'exact', path: '/api/x', handler: () => {} }), /duplicate exact route/)
})
