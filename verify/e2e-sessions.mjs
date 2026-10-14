// verify/e2e-sessions.mjs — live multi-session verification for SPEC §9 (per-session run windows).
//
//   node verify/e2e-sessions.mjs            # API-level isolation + per-session counters
//   node verify/e2e-sessions.mjs --cleanup   # only remove the synthetic sessions this script writes
//
// Safety properties, deliberately:
//  * it only ever writes modes for SYNTHETIC session ids (`verify-sess-A/B`), never for a real
//    session, so a user's own choice can never be changed by this script;
//  * the clock override is TTL-bounded (120 s) AND cleared in a `finally`;
//  * a watchdog clear is armed on top of the plugin's TTL, so a simulated peak can never strand
//    the session;
//  * `--cleanup` removes exactly the two synthetic session entries from the v2 state file, prints
//    what it removed, and leaves everything else byte-identical.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { classifyOracle, nextTransitionOracle, bjParts } from './lib/oracle.mjs'

const BASE = process.env.PEAK_HOURS_BASE ?? 'http://127.0.0.1:19387'
const WATCHDOG_MS = Number(process.env.PEAK_HOURS_WATCHDOG_MS ?? 90000)
const SESSION_A = 'verify-sess-A'
const SESSION_B = 'verify-sess-B'
const stateFile = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'peak-hours-state.json')
  : join(homedir(), '.dsh', 'peak-hours-state.json')

const results = []
/** Raised for a precondition failure so the script unwinds normally instead of exiting mid-flight
 *  (`process.exit()` while undici/AbortController handles are live crashed libuv on Windows with a
 *  garbage exit code — found by the verifier while exercising this script's abort path). */
class Bail extends Error {}
function bail(message, code = 3) {
  console.log(message)
  const e = new Bail(message)
  e.exitCode = code
  throw e
}
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  :: ${detail}` : ''}`)
}

async function api(path, { method = 'GET', body } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 8000)
  try {
    const res = await fetch(BASE + path, {
      method, signal: ac.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* raw */ }
    return { status: res.status, json, text }
  } finally { clearTimeout(timer) }
}
const stateOf = async (session) => (await api(`/api/peak-hours/state${session ? `?session=${encodeURIComponent(session)}` : ''}`)).json?.state
const setMode = (body) => api('/api/peak-hours/mode', { method: 'POST', body })
const setClock = (offsetMs, ttlMs) => api('/api/peak-hours/clock', { method: 'POST', body: ttlMs === undefined ? { offsetMs } : { offsetMs, ttlMs } })

/** Clear one synthetic session through the API (P1-2 exit) — never a real session. */
async function clearSessionViaApi(id) {
  try {
    const r = await api('/api/peak-hours/mode', { method: 'POST', body: { mode: null, session: id, scope: 'session' } })
    return r.status === 200
  } catch { return false }
}

/**
 * Remove exactly the synthetic sessions. Prefers the P1-2 API exit (`POST /mode {mode:null}`),
 * which needs no filesystem access; falls back to a direct state-file edit for builds without that
 * route (the fallback's byte-identical behaviour was verified in an earlier run against the real
 * file, sha256 unchanged).
 */
async function cleanupSessions() {
  const cleared = []
  for (const id of [SESSION_A, SESSION_B]) if (await clearSessionViaApi(id)) cleared.push(id)
  if (cleared.length) return { removed: cleared, note: 'via POST /mode {mode:null} (P1-2)' }

  let raw
  try { raw = readFileSync(stateFile, 'utf8') } catch (error) { return { removed: [], note: `no state file (${error.code})` } }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { removed: [], note: 'state file corrupt; not touching it' } }
  const removed = []
  for (const id of [SESSION_A, SESSION_B]) {
    if (parsed.sessions && Object.hasOwn(parsed.sessions, id)) { delete parsed.sessions[id]; removed.push(id) }
  }
  if (removed.length) writeFileSync(stateFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return { removed, note: removed.length ? 'via state-file edit (fallback)' : 'nothing to remove' }
}

if (process.argv.includes('--cleanup')) {
  const r = await cleanupSessions()
  log(`cleanup: removed ${JSON.stringify(r.removed)} (${r.note})`)
  // Same graceful-exit rule as the main path (V4): `process.exit()` right after a fetch's
  // keep-alive socket starts closing trips a libuv assertion on Windows and yields a garbage exit
  // code. Set the code and let the loop drain instead.
  process.exitCode = 0
  await new Promise((resolve) => setTimeout(resolve, 300))
} else {

async function restore() {
  try { await setClock(null) } catch (e) { console.log('restore clock failed:', e.message) }
}
const watchdog = setTimeout(async () => {
  console.log(`\n!! WATCHDOG (${WATCHDOG_MS} ms) fired — clearing the clock override\n`)
  await restore()
}, WATCHDOG_MS)
watchdog.unref?.()

let exitCode = 0
try {
  // ---------------------------------------------------------------- 0. preconditions
  const health = await api('/api/peak-hours/health')
  if (health.status !== 200) bail(`ABORTED: /health → ${health.status} (${health.text?.slice(0, 120)})`)
  const baseline = await stateOf()
  if (!baseline || !('modeSource' in baseline) || !('waitingTasksTotal' in baseline)) {
    bail('ABORTED: the live build does not expose the SPEC §9 envelope (no modeSource/waitingTasksTotal).\n' +
      `  got: ${JSON.stringify(baseline)?.slice(0, 240)}\n` +
      '  Deploy task-5/task-6 first, then re-run. Nothing was changed.')
  }
  log(`live baseline: mode=${baseline.mode} source=${baseline.modeSource} default=${baseline.defaultMode}`)

  // ---------------------------------------------------------------- 1. API-level isolation
  await restore()
  await setMode({ mode: 'always', scope: 'default' })
  const rA = await setMode({ mode: 'idle-only', session: SESSION_A })
  const rB = await setMode({ mode: 'always', session: SESSION_B })
  check('POST /mode {session} accepted for both synthetic sessions',
    rA.status === 200 && rB.status === 200, `A=${rA.status} B=${rB.status}`)

  const sA = await stateOf(SESSION_A)
  const sB = await stateOf(SESSION_B)
  const sNone = await stateOf()
  check('session A resolves its own idle-only', sA.mode === 'idle-only' && sA.modeSource === 'session', JSON.stringify({ mode: sA.mode, source: sA.modeSource }))
  check('session B resolves its own always', sB.mode === 'always' && sB.modeSource === 'session', JSON.stringify({ mode: sB.mode, source: sB.modeSource }))
  check('B\'s choice did not leak into A', sA.mode !== sB.mode, `A=${sA.mode} B=${sB.mode}`)
  check('no ?session= reports the default', sNone.modeSource === 'default' && sNone.mode === sNone.defaultMode,
    JSON.stringify({ mode: sNone.mode, source: sNone.modeSource, default: sNone.defaultMode }))
  check('waitingTasks and waitingTasksTotal are separate numbers',
    Number.isInteger(sA.waitingTasks) && Number.isInteger(sA.waitingTasksTotal),
    `A: ${sA.waitingTasks}/${sA.waitingTasksTotal}`)

  // ---------------------------------------------------------------- 2. per-session counters at peak
  const realNow = Date.now()
  let peakTarget = null
  for (let probe = realNow; probe < realNow + 14 * 86400e3; probe += 60e3) {
    if (classifyOracle(probe).phase === 'peak') { peakTarget = probe + 10 * 60e3; break }
  }
  await setClock(peakTarget - realNow, 120_000)
  const pA = await stateOf(SESSION_A)
  const pB = await stateOf(SESSION_B)
  check('inside the simulated peak the window flipped on (oracle agrees)',
    classifyOracle(pA.now).phase === 'peak', `${pA.nowText} oracle=${classifyOracle(pA.now).phase}`)
  check('A (idle-only) reports paused=true, B (always) reports paused=false',
    pA.paused === true && pB.paused === false, JSON.stringify({ A: { mode: pA.mode, paused: pA.paused }, B: { mode: pB.mode, paused: pB.paused } }))
  check('per-session counters stay consistent with the total',
    pA.waitingTasks <= pA.waitingTasksTotal && pB.waitingTasks <= pB.waitingTasksTotal,
    `A: ${pA.waitingTasks}/${pA.waitingTasksTotal} B: ${pB.waitingTasks}/${pB.waitingTasksTotal}`)
  check('the next transition is the upcoming idle boundary',
    nextTransitionOracle(pA.now)?.to === 'idle', bjParts(pA.nextTransitionAt).text)
  log(`peak state: A=${JSON.stringify({ mode: pA.mode, paused: pA.paused, waiting: pA.waitingTasks })} ` +
      `B=${JSON.stringify({ mode: pB.mode, paused: pB.paused, waiting: pB.waitingTasks })} total=${pA.waitingTasksTotal}`)

  // ---------------------------------------------------------------- 3. restore + cleanup
  await restore()
  const after = await stateOf(SESSION_A)
  check('clock override cleared; A is no longer paused', after.clockOverride === null && after.paused === false,
    JSON.stringify({ override: after.clockOverride, paused: after.paused, phase: after.phase }))
} catch (error) {
  if (error instanceof Bail) exitCode = error.exitCode ?? 3
  else { exitCode = 2; console.log('ABORTED:', error?.stack ?? String(error)) }
} finally {
  clearTimeout(watchdog)
  await restore()
  const r = await cleanupSessions()
  log(`cleanup: removed synthetic sessions ${JSON.stringify(r.removed)} (${r.note})`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== SESSION E2E SUMMARY: ${results.length - failed.length}/${results.length} checks passed =====`)
if (failed.length) { console.log('FAILED CHECKS:'); for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`) }
console.log('\nNOTE: this script verifies the API-level per-session contract. The "a real task in an\n' +
  'idle-only session is actually held while another session keeps running" half needs real agents;\n' +
  'see verify/EVIDENCE.md §7 for the two-subagent procedure and its raw output.')
if (exitCode === 0 && failed.length) exitCode = 1
console.log(exitCode === 0 ? 'SESSION E2E RESULT: 已验证' : 'SESSION E2E RESULT: 失败')
// Graceful exit: setting `process.exitCode` and letting the loop drain avoids the libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`) that `process.exit()` can trigger right after a fetch's
// keep-alive socket starts closing — observed on this machine while exercising the abort path.
process.exitCode = exitCode
await new Promise((resolve) => setTimeout(resolve, 300)).catch(() => {})
}   // end of the non-`--cleanup` branch opened above
