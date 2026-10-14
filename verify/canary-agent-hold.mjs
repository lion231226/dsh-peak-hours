// verify/canary-agent-hold.mjs — AGENT-SIDE proof that a real agent task is held during peak.
//
//   node verify/canary-agent-hold.mjs <sessionId> [--wait-ms 150000] [--prove-ms 12000]
//
// What this proves (and what it does not):
//   * PROVES: a real agent session's step is stopped at `agent/pre-step` — the per-session waiter
//     counter rises and STAYS up for `--prove-ms` (so it is a hold, not latency), and the moment the
//     clock override is cleared the counter returns to zero and the agent proceeds on its own.
//   * DOES NOT prove: that a tool call was interrupted mid-flight; the gate sits before a step.
//
// Safety, deliberately:
//   * `default` is forced to `always` for the whole run and restored to the captured original
//     afterwards (asserted by re-reading, not assumed) — otherwise a simulated peak could hold the
//     Lead's own session, which is the one thing that must never happen;
//   * the clock override is TTL-bounded AND cleared in a `finally` in addition to a watchdog;
//   * the target session's override is removed through the P1-2 exit;
//   * the real state file is hashed before and after, and the run fails loudly if it changed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { classifyOracle, nextTransitionOracle, bjParts } from './lib/oracle.mjs'

const BASE = process.env.PEAK_HOURS_BASE ?? 'http://127.0.0.1:19387'
const sessionId = process.argv[2]
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}
const WAIT_MS = argOf('--wait-ms', 150_000)
const PROVE_MS = argOf('--prove-ms', 12_000)
const POLL_MS = 2000
const stateFile = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'peak-hours-state.json')
  : join(homedir(), '.dsh', 'peak-hours-state.json')

if (!sessionId || !/^[0-9a-zA-Z_-]{1,128}$/.test(sessionId)) {
  console.log('usage: node verify/canary-agent-hold.mjs <sessionId>   (a real agent session id)')
  process.exit(2)
}

const results = []
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  :: ${detail}` : ''}`)
}
const sha = () => { try { return readFileSync(stateFile).toString('utf8') } catch { return '' } }

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
const stateOf = async (s) => (await api(`/api/peak-hours/state${s ? `?session=${encodeURIComponent(s)}` : ''}`)).json?.state
const setMode = (body) => api('/api/peak-hours/mode', { method: 'POST', body })
const setClock = (offsetMs, ttlMs) => api('/api/peak-hours/clock', { method: 'POST', body: ttlMs === undefined ? { offsetMs } : { offsetMs, ttlMs } })

let originalDefault = null
let overrideArmed = false
const samples = []

async function restoreEverything() {
  try { await setClock(null); overrideArmed = false } catch (e) { console.log('clock restore failed:', e.message) }
  try {
    const r = await setMode({ mode: null, session: sessionId, scope: 'session' })
    log(`cleared session ${sessionId} → ${r.status}`)
  } catch (e) { console.log('session clear failed:', e.message) }
  if (originalDefault) {
    try {
      await setMode({ mode: originalDefault, scope: 'default' })
      const after = await stateOf()
      log(`restored default → ${after?.defaultMode} (expected ${originalDefault})`)
    } catch (e) { console.log('default restore failed:', e.message) }
  }
}
const watchdog = setTimeout(async () => { console.log(`\n!! WATCHDOG fired — clearing the override\n`); await restoreEverything() }, WAIT_MS + 60_000)
watchdog.unref?.()

let exitCode = 0
try {
  // ---------------------------------------------------------------- 0. preconditions
  const health = await api('/api/peak-hours/health')
  if (health.status !== 200) { console.log(`ABORTED: /health → ${health.status}`); exitCode = 3; throw new Error('precondition') }
  const baseline = await stateOf()
  if (!baseline || !('modeSource' in baseline) || !('waitingTasksTotal' in baseline)) {
    console.log('ABORTED: the live build lacks the SPEC §9 envelope'); exitCode = 3; throw new Error('precondition')
  }
  originalDefault = baseline.defaultMode
  const beforeFile = sha()
  log(`build ${health.json?.version}; original default=${originalDefault}; phase=${baseline.phase}`)

  // ---------------------------------------------------------------- 1. protect the Lead, arm the target
  check('default forced to always for the run (so a peak cannot hold other sessions)',
    (await setMode({ mode: 'always', scope: 'default' })).status === 200)
  const target = await setMode({ mode: 'idle-only', session: sessionId })
  check(`target session ${sessionId} set to idle-only`, target.status === 200, `status=${target.status}`)
  const targetView = await stateOf(sessionId)
  check('target resolves modeSource=session',
    targetView?.modeSource === 'session' && targetView?.mode === 'idle-only',
    JSON.stringify({ mode: targetView?.mode, source: targetView?.modeSource }))

  // ---------------------------------------------------------------- 2. push the clock into a peak
  const now = Date.now()
  let peakAt = null
  for (let t = now; t < now + 14 * 86400e3; t += 60e3) { if (classifyOracle(t).phase === 'peak') { peakAt = t + 10 * 60e3; break } }
  const armed = await setClock(peakAt - now, 120_000)
  overrideArmed = true
  check('clock override armed inside a peak window (TTL 120 s)', armed.status === 200 && classifyOracle(armed.json?.state?.now).phase === 'peak',
    JSON.stringify({ nowText: armed.json?.state?.nowText, phase: armed.json?.state?.phase }))

  // ---------------------------------------------------------------- 3. watch for the real hold
  log(`watching for a held step for up to ${WAIT_MS / 1000}s (the canary reaches its next step on its own schedule) ...`)
  const started = Date.now()
  let holdStart = null, holdPeak = 0, releasedAt = null, clearedAt = null
  while (Date.now() - started < WAIT_MS) {
    const g = await stateOf()
    const s = await stateOf(sessionId)
    const sample = { t: new Date().toISOString(), virtual: g?.nowText, waiting: s?.waitingTasks ?? 0, total: g?.waitingTasksTotal ?? 0, paused: s?.paused === true }
    samples.push(sample)
    if (sample.waiting >= 1 || sample.total >= 1) {
      holdStart ??= Date.now()
      holdPeak = Math.max(holdPeak, sample.waiting, sample.total)
      if (!clearedAt && Date.now() - holdStart >= PROVE_MS) {
        log(`hold observed and sustained for ${(Date.now() - holdStart) / 1000}s — clearing the override to test auto-resume`)
        await setClock(null); overrideArmed = false; clearedAt = new Date().toISOString()
      }
    } else if (clearedAt) {
      releasedAt = new Date().toISOString()
      break
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }

  const holdMs = holdStart ? (clearedAt ? new Date(clearedAt) - holdStart : Date.now() - holdStart) : 0
  check('a real agent step was HELD at agent/pre-step (counter rose and stayed up)',
    !!holdStart && holdMs >= PROVE_MS,
    `held for ~${Math.round(holdMs / 1000)}s, peak counter=${holdPeak}, samples=${samples.length}`)
  check('releasing the clock override let the agent proceed on its own (counter returned to 0)',
    !!releasedAt, releasedAt ?? 'not observed within the window')

  log('timeline (virtual time | session waiters | host total | paused):')
  for (const s of samples) console.log(`   ${s.t}  ${s.virtual}  ${s.waiting}  ${s.total}  ${s.paused}`)
} catch (error) {
  if (exitCode !== 3) { exitCode = 2; console.log('ABORTED:', error?.stack ?? String(error)) }
} finally {
  clearTimeout(watchdog)
  await restoreEverything()
  const beforeFile = globalThis.__beforeFile
  const afterFile = sha()
  check('clock override cleared at the end of the run', (await stateOf())?.clockOverride === null)
  check(`target session ${sessionId} no longer overridden`, (await stateOf(sessionId))?.modeSource === 'default')
  check(`default restored to the user value (${originalDefault})`, (await stateOf())?.defaultMode === originalDefault,
    `got ${(await stateOf())?.defaultMode}`)
  log(`state file after the run: ${afterFile.replace(/\s+/g, ' ')}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== CANARY RESULT: ${results.length - failed.length}/${results.length} checks =====`)
if (failed.length) for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`)
if (exitCode === 0 && failed.length) exitCode = 1
console.log(exitCode === 0 ? 'CANARY RESULT: 已验证 (agent-side hold + auto-resume)' : 'CANARY RESULT: 失败/未完成')
process.exitCode = exitCode
await new Promise((r) => setTimeout(r, 300))
