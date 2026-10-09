// verify/repro-f6.mjs — F6 diagnostic: boot the plugin under the REAL cordis runtime.
//
// This is the closest possible reproduction of what the shipped app does, without touching the
// running app: real cordis 4.0.4 (verbatim bundle from _recon), real fiber/inject/effect/event
// semantics, stub `timer` + `webServer` services matching their shipped contracts.
//
//   node verify/repro-f6.mjs
//
// Exit 1 if the fiber fails (prints the real startup error), 0 if it mounts and answers routes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRealCordis, makeWebServerStub, makeTimerStub } from './lib/real-cordis.mjs'

const home = mkdtempSync(join(tmpdir(), 'peak-f6-home-'))
process.env.DSH_HOME = home
console.log(`DSH_HOME (throwaway) = ${home}`)

const { Context, cordisSourcePath, __byteIdentical } = await loadRealCordis()
console.log(`cordis bundle = ${cordisSourcePath} (byte-identical copy: ${__byteIdentical})`)

const root = new Context()
const ws = makeWebServerStub()
const timer = makeTimerStub()
root.provide('timer', timer)
root.provide('webServer', ws)
console.log(`services provided: timer, webServer`)

const plugin = await import('../lib/host/index.js')
console.log(`plugin: name=${plugin.name} inject=${JSON.stringify(plugin.inject)} apply=${typeof plugin.apply}`)

const fiber = root.plugin(plugin, {})
let failure = null
try {
  await fiber.await()
  console.log(`FIBER OK  state=${fiber.state} (2 = active)`)
} catch (error) {
  failure = error
  console.log('FIBER FAILED — real startup error follows:')
  console.log(error?.stack ?? String(error))
}

const routes = [...ws.exact.keys()]
console.log(`registered routes (${routes.length}): ${JSON.stringify(routes)}`)

// --- proof of mechanism -------------------------------------------------------------------
// cordis treats the value a plugin's apply() RESOLVES to as an effect cleanup handle:
//   safeCollect(dispose) { if (typeof dispose === "function") collect(dispose)
//                          else if (!isNullable(dispose)) throw new TypeError("Invalid effect") }
// (see _recon/src/cordis/lib/index.js:1138-1145). `apply` is async and resolves to the mounted
// surface OBJECT, which is neither a function nor nullable → "Invalid effect".
// Wrapping it so apply() resolves to undefined must mount cleanly; that isolates the cause.
const ws2 = makeWebServerStub()
const root2 = new Context()
root2.provide('timer', makeTimerStub())
root2.provide('webServer', ws2)
const wrapped = {
  name: plugin.name,
  inject: plugin.inject,
  async apply(ctx, config) {
    const surface = await plugin.apply(ctx, config)
    void surface            // discard: resolving to undefined is what cordis accepts
  },
}
const fiber2 = root2.plugin(wrapped, {})
try {
  await fiber2.await()
  console.log(`\nPROOF: with apply() resolving to undefined, the fiber is OK (state=${fiber2.state}) and ${ws2.exact.size} routes registered: ${JSON.stringify([...ws2.exact.keys()])}`)
  const health = await ws2.call('/api/peak-hours/health', { method: 'GET' })
  console.log(`  GET /api/peak-hours/health -> ${health.status} ${JSON.stringify(health.body)}`)
  const st = await ws2.call('/api/peak-hours/state', { method: 'GET' })
  console.log(`  GET /api/peak-hours/state  -> ${st.status} mode=${st.body?.state?.mode} phase=${st.body?.state?.phase} nowText=${st.body?.state?.nowText}`)
  const mode = await ws2.call('/api/peak-hours/mode', { method: 'POST', body: { mode: 'idle-only' } })
  console.log(`  POST /api/peak-hours/mode  -> ${mode.status} mode=${mode.body?.state?.mode}`)
} catch (error) {
  console.log('\nPROOF FAILED — the wrapper also fails, so the cause is elsewhere:')
  console.log(error?.stack ?? String(error))
}

rmSync(home, { recursive: true, force: true })
if (failure) {
  console.log('\nF6 REPRODUCED: the plugin fiber fails under the real cordis runtime.')
  process.exit(1)
}
console.log('\nF6 NOT REPRODUCED: the plugin mounts and serves routes under the real cordis runtime.')
process.exit(0)
