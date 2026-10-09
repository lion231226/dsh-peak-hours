/**
 * Lead-side pre-install smoke test (no DSH runtime involved).
 *
 * Imports the host half exactly as the Loader would (package root -> lib/host/index.js),
 * mounts it against a fake cordis context, and drives the registered routes with real
 * HTTP requests. Catches import errors, wiring mistakes and route-shape problems before
 * the plugin is copied into the live profile.
 *
 * Usage: node tools/smoke-host.mjs
 * Writes its state file under a temp DSH_HOME, never into ~/.dsh.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = new URL('..', import.meta.url)
const stateHome = mkdtempSync(join(tmpdir(), 'peak-hours-smoke-'))
process.env.DSH_HOME = stateHome
process.env.DSH_PEAK_HOURS_ALLOW_CLOCK = '1'

const failures = []
const notes = []
function check(label, ok, detail = '') {
  if (ok) notes.push(`PASS ${label}`)
  else {
    failures.push(`${label}${detail ? ` :: ${detail}` : ''}`)
    notes.push(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

/**
 * One isolated fake cordis context. A factory (not a singleton) because `apply`
 * and `mount` each need their own registration surface: `apply` is called first
 * to pin the entry contract, then `mount` runs the real flow.
 */
function makeCtx() {
  const listeners = new Map()
  const routes = new Map()
  const effects = []
  const notesRef = []
  const ctx = {
  logger: {
    info: (m) => notes.push(`[info] ${m}`),
    warn: (m) => notes.push(`[warn] ${m}`),
    error: (m) => notes.push(`[error] ${m}`),
  },
  timer: {
    timeout(callback, delay) {
      const handle = setTimeout(callback, delay)
      return () => clearTimeout(handle)
    },
  },
  on(name, listener, options) {
    const list = listeners.get(name) ?? []
    if (options?.prepend) list.unshift(listener)
    else list.push(listener)
    listeners.set(name, list)
    return () => {
      const current = listeners.get(name) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  },
  effect(callback, label) {
    const dispose = callback()
    effects.push({ label, dispose })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  webServer: {
    register(route) {
      if (!route || typeof route.path !== 'string' || typeof route.handler !== 'function') {
        throw new Error(`bad route shape: ${JSON.stringify(Object.keys(route ?? {}))}`)
      }
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  }
  return { ctx, listeners, routes, effects }
}

const mod = await import(new URL('lib/host/index.js', projectRoot).href)
check('host half imports', true)
check('exports name', mod.name === 'peak-hours', String(mod.name))
check('exports inject [timer, webServer]', JSON.stringify(mod.inject) === JSON.stringify(['timer', 'webServer']), JSON.stringify(mod.inject))

// Entry contract first (finding F6): cordis feeds the value `apply` resolves
// into its effect collector, which accepts only a function or null/undefined.
const entryProbe = makeCtx()
const applyResult = await mod.apply(entryProbe.ctx, {})
check('apply() resolves undefined (F6 regression)', applyResult === undefined, `got ${typeof applyResult}`)
check('apply() never resolves to a function', typeof applyResult !== 'function')
for (const { dispose } of entryProbe.effects.reverse()) if (typeof dispose === 'function') dispose()

// Then the real flow through the exported mount(), which returns the surface.
const { ctx, listeners, routes, effects } = makeCtx()
const mounted = await mod.mount(ctx, {}, { logger: ctx.logger, registry: [] })
check('mount() returns the surface', mounted !== undefined && typeof mounted === 'object')
check('gates registered on agent/pre-step', (listeners.get('agent/pre-step') ?? []).length === 1)
check('gates registered on tools/pre-execute', (listeners.get('tools/pre-execute') ?? []).length === 1)
check('routes registered', routes.size >= 4, `routes=${[...routes.keys()].join(',')}`)
for (const path of ['/api/peak-hours/state', '/api/peak-hours/mode', '/api/peak-hours/clock', '/api/peak-hours/health']) {
  check(`route ${path}`, routes.has(path))
}

// Serve the registered routes on a real socket so the handlers run end to end.
const { createServer } = await import('node:http')
const server = createServer((req, res) => {
  const route = routes.get(new URL(req.url, 'http://x').pathname)
  if (!route) {
    res.writeHead(401)
    res.end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function call(path, body) {
  const response = await fetch(base + path, body === undefined
    ? undefined
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let json = null
  const text = await response.text()
  try { json = JSON.parse(text) } catch { /* keep raw */ }
  return { status: response.status, json, text }
}

const health = await call('/api/peak-hours/health')
check('GET health -> 200 {ok:true}', health.status === 200 && health.json?.ok === true, health.text.slice(0, 200))

const initial = await call('/api/peak-hours/state')
check('GET state -> 200 ok', initial.status === 200 && initial.json?.ok === true, initial.text.slice(0, 300))
for (const field of ['mode', 'phase', 'reason', 'now', 'nextTransitionAt', 'paused', 'waitingTasks', 'holidayCoverage', 'timeZone', 'peakWindows']) {
  check(`state.${field} present`, initial.json?.state !== undefined && field in initial.json.state)
}
check('default mode is always', initial.json?.state?.mode === 'always', JSON.stringify(initial.json?.state?.mode))

const idleMode = await call('/api/peak-hours/mode', { mode: 'idle-only' })
check('POST mode idle-only -> 200', idleMode.status === 200 && idleMode.json?.state?.mode === 'idle-only', idleMode.text.slice(0, 200))
const badMode = await call('/api/peak-hours/mode', { mode: 'nonsense' })
check('POST bad mode -> 4xx {ok:false}', badMode.status >= 400 && badMode.status < 500 && badMode.json?.ok === false, badMode.text.slice(0, 200))

// Force a peak instant (2026-10-09 is a Friday; 10:30 Beijing is inside the morning peak).
const fridayPeak = Date.UTC(2026, 9, 9, 2, 30, 0) // 10:30 Beijing
const offsetMs = fridayPeak - Date.now()
const peak = await call('/api/peak-hours/clock', { offsetMs, ttlMs: 60000 })
check('POST clock(peak) -> 200', peak.status === 200, peak.text.slice(0, 200))
check('clockOverride echoed with ttl', peak.json?.state?.clockOverride?.offsetMs === offsetMs && peak.json?.state?.clockOverride?.ttlMs === 60000, JSON.stringify(peak.json?.state?.clockOverride))
check('peak phase detected', peak.json?.state?.phase === 'peak', JSON.stringify(peak.json?.state?.phase))
check('paused=true in idle-only + peak', peak.json?.state?.paused === true)
check('peakWindow label 09:00-12:00 present', JSON.stringify(peak.json?.state?.peakWindows) === JSON.stringify(['09:00-12:00', '14:00-18:00']), JSON.stringify(peak.json?.state?.peakWindows))

// A gate wait started inside peak must stay held (no release before the idle boundary).
const gate = mounted.gate
const controller = new AbortController()
let released = false
const waiting = gate.wait(controller.signal).then(() => { released = true }, () => { released = true })
await new Promise((resolve) => setTimeout(resolve, 300))
const duringPeak = await call('/api/peak-hours/state')
check('waitingTasks=1 while held', duringPeak.json?.state?.waitingTasks === 1, JSON.stringify(duringPeak.json?.state?.waitingTasks))
check('still not released inside peak', released === false)

// Clearing the override returns to real (idle) time and must release the waiter.
const cleared = await call('/api/peak-hours/clock', { offsetMs: null })
check('POST clock(null) -> cleared', cleared.status === 200 && cleared.json?.state?.clockOverride === null, cleared.text.slice(0, 200))
await waiting
check('waiter released after override cleared', released === true)

// Back to always: the gate must never hold again.
const always = await call('/api/peak-hours/mode', { mode: 'always' })
check('POST mode always -> 200', always.status === 200 && always.json?.state?.mode === 'always', always.text.slice(0, 120))

// Dispose everything: no listener and no timer may survive.
for (const { dispose } of effects.reverse()) {
  if (typeof dispose === 'function') dispose()
}
check('listeners removed on dispose', (listeners.get('agent/pre-step') ?? []).length === 0 && (listeners.get('tools/pre-execute') ?? []).length === 0)
check('routes removed on dispose', routes.size === 0, `left=${[...routes.keys()].join(',')}`)

server.close()
rmSync(stateHome, { recursive: true, force: true })

console.log(notes.join('\n'))
console.log(`\n${failures.length === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures.length})`}`)
for (const failure of failures) console.log(` - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
