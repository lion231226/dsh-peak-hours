// verify/e2e-runtime.mjs — verifier-owned live runtime E2E for the installed dsh-peak-hours plugin.
//
// Loopback routes need no token (confirmed by Lead on this machine).
//
//   node verify/e2e-runtime.mjs            # routes / state contract / clock override / TTL / auto-resume
//   node verify/e2e-runtime.mjs --cleanup   # only reset mode=always and clear the clock override
//
// It ALWAYS restores `mode:always` + `offsetMs:null` on exit, and arms a watchdog that clears the
// clock override after WATCHDOG_MS even if this process dies, so a simulated peak can never strand
// the session (SPEC §2.3 makes the override TTL-bounded for the same reason).
import { classifyOracle, nextTransitionOracle, bjParts } from './lib/oracle.mjs'

const BASE = process.env.PEAK_HOURS_BASE ?? 'http://127.0.0.1:19387'
const WATCHDOG_MS = Number(process.env.PEAK_HOURS_WATCHDOG_MS ?? 90000)
const results = []

const stamp = () => new Date().toISOString()
const log = (...a) => console.log(`[${stamp()}]`, ...a)
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  :: ${detail}` : ''}`)
}

async function api(path, { method = 'GET', body } = {}, timeoutMs = 8000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, {
      method,
      signal: ac.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* keep raw text */ }
    return { status: res.status, json, text }
  } finally { clearTimeout(timer) }
}
const state = async () => (await api('/api/peak-hours/state')).json?.state
const setMode = (mode) => api('/api/peak-hours/mode', { method: 'POST', body: { mode } })
const setClock = (offsetMs, ttlMs) =>
  api('/api/peak-hours/clock', { method: 'POST', body: ttlMs === undefined ? { offsetMs } : { offsetMs, ttlMs } })

async function restore() {
  try { await setMode('always') } catch (e) { console.log('restore mode failed:', e.message) }
  try { const r = await setClock(null); console.log('restore clock →', r.status, r.text?.slice(0, 140)) } catch (e) { console.log('restore clock failed:', e.message) }
}

if (process.argv.includes('--cleanup')) { await restore(); log('cleanup done'); process.exit(0) }

const watchdog = setTimeout(async () => {
  console.log(`\n!! WATCHDOG (${WATCHDOG_MS} ms) fired — clearing clock override and mode\n`)
  await restore()
}, WATCHDOG_MS)
watchdog.unref?.()
process.on('SIGINT', async () => { await restore(); process.exit(130) })

let exitCode = 0
try {
  // ---------------------------------------------------------------- 0. health
  const health = await api('/api/peak-hours/health')
  if (health.status === 401 || /unauthor|forbidden/i.test(health.text ?? '')) {
    console.log('ABORTED: /api/peak-hours/health answered 401 — the plugin is NOT mounted.')
    console.log('  The loopback fallback returns 401 for an unregistered /api route (Lead-confirmed).')
    console.log('  Check the loader entry first: plugin_manager list_plugins → look for entryId "include:peak-hours";')
    console.log('  enabled=true but fiberPhase="failed" means apply() died and the fiber is not retried automatically.')
    console.log('  Fix the cause, re-copy the package, then re-activate the entry (reload/toggle) and re-run this script.')
    process.exit(3)
  }
  check('GET /api/peak-hours/health → 200 + {ok:true,plugin:"dsh-peak-hours",version}',
    health.status === 200 && health.json?.ok === true && health.json?.plugin === 'dsh-peak-hours' && !!health.json?.version,
    `status=${health.status} body=${health.text.slice(0, 160)}`)

  // ---------------------------------------------------------------- 1. state contract (SPEC §2.3)
  await restore()
  const s0 = await state()
  check('GET /api/peak-hours/state → 200 with a state envelope', !!s0 && typeof s0 === 'object', JSON.stringify(s0).slice(0, 260))
  if (!s0 || typeof s0 !== 'object') throw new Error('no state envelope; aborting')

  const FIELDS = ['mode', 'phase', 'reason', 'now', 'nowText', 'nextTransitionAt', 'nextTransitionText',
    'nextPhase', 'msUntilTransition', 'paused', 'waitingTasks', 'holidayToday', 'holidayCoverage',
    'unknownHolidayYear', 'timeZone', 'peakWindows', 'clockOverride', 'config']
  const missing = FIELDS.filter((f) => !(f in s0))
  check('state carries every SPEC §2.3 field', missing.length === 0, `missing=${JSON.stringify(missing)}`)
  check('peakWindows === ["09:00-12:00","14:00-18:00"]', JSON.stringify(s0.peakWindows) === '["09:00-12:00","14:00-18:00"]', JSON.stringify(s0.peakWindows))
  check('timeZone mentions Asia/Shanghai', /Asia\/Shanghai/.test(String(s0.timeZone)), String(s0.timeZone))
  check('nowText matches YYYY-MM-DD HH:mm:ss', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(s0.nowText)), String(s0.nowText))
  check('nowText === bjParts(now)', s0.nowText === bjParts(s0.now).text, `${s0.nowText} vs ${bjParts(s0.now).text}`)
  check('nextTransitionText === bjParts(nextTransitionAt)', s0.nextTransitionText === bjParts(s0.nextTransitionAt).text,
    `${s0.nextTransitionText} vs ${bjParts(s0.nextTransitionAt).text}`)
  check('msUntilTransition === nextTransitionAt - now', s0.msUntilTransition === s0.nextTransitionAt - s0.now,
    `${s0.msUntilTransition} vs ${s0.nextTransitionAt - s0.now}`)
  check('paused === (mode==="idle-only" && phase==="peak")',
    s0.paused === (s0.mode === 'idle-only' && s0.phase === 'peak'), JSON.stringify({ mode: s0.mode, phase: s0.phase, paused: s0.paused }))
  check('waitingTasks is a non-negative integer', Number.isInteger(s0.waitingTasks) && s0.waitingTasks >= 0, String(s0.waitingTasks))
  check('config.allowClockOverride is boolean', typeof s0.config?.allowClockOverride === 'boolean', JSON.stringify(s0.config))

  const oReal = classifyOracle(s0.now)
  check('phase/reason at now match the independent oracle', oReal.phase === s0.phase && oReal.reason === s0.reason,
    `impl=${s0.phase}/${s0.reason} oracle=${oReal.phase}/${oReal.reason} @${oReal.text}`)
  const oNext = nextTransitionOracle(s0.now)
  check('nextTransitionAt matches the independent oracle', oNext?.at === s0.nextTransitionAt, `impl=${s0.nextTransitionAt} oracle=${oNext?.at}`)
  check('nextPhase === oracle .to', oNext?.to === s0.nextPhase, `impl=${s0.nextPhase} oracle=${oNext?.to}`)
  log('state(baseline) =', JSON.stringify(s0))

  // ---------------------------------------------------------------- 2. error handling
  const badMode = await setMode('nonsense')
  check('POST /mode invalid mode → 4xx + {ok:false,error}',
    badMode.status >= 400 && badMode.status < 500 && badMode.json?.ok === false && typeof badMode.json?.error === 'string',
    `status=${badMode.status} body=${badMode.text.slice(0, 160)}`)
  const badClock = await setClock('not-a-number')
  check('POST /clock invalid offsetMs → 4xx + {ok:false,error}',
    badClock.status >= 400 && badClock.status < 500 && badClock.json?.ok === false, `status=${badClock.status} body=${badClock.text.slice(0, 160)}`)
  const badTtl = await setClock(60000, -5)
  check('POST /clock negative ttlMs → 4xx', badTtl.status >= 400 && badTtl.status < 500, `status=${badTtl.status} body=${badTtl.text.slice(0, 160)}`)
  const wrongMethod = await api('/api/peak-hours/mode', { method: 'GET' })
  check('GET /mode (POST-only route) → 405', wrongMethod.status === 405, `status=${wrongMethod.status} body=${wrongMethod.text.slice(0, 120)}`)

  const allow = s0.config?.allowClockOverride === true
  if (!allow) {
    check('clock override enabled on this machine (required for the peak simulation)', false,
      'config.allowClockOverride=false — DSH_PEAK_HOURS_ALLOW_CLOCK=0; the live peak/release checks are 未验证')
  } else {
    // -------------------------------------------------------------- 3. clock override → peak
    const realNow = Date.now()
    let peakTarget = null
    for (let probe = realNow; probe < realNow + 14 * 86400e3; probe += 60e3) {
      if (classifyOracle(probe).phase === 'peak') { peakTarget = probe + 10 * 60e3; break }
    }
    check('found an upcoming peak instant for the override', Number.isFinite(peakTarget), String(peakTarget))
    const offPeak = peakTarget - realNow

    const rPeak = await setClock(offPeak)
    check('POST /clock {offsetMs} → 200 envelope', rPeak.status === 200 && rPeak.json?.ok === true, `status=${rPeak.status} body=${rPeak.text.slice(0, 200)}`)
    const sPeak = await state()
    check('clockOverride echoes {offsetMs, expiresAt, ttlMs}', sPeak.clockOverride?.offsetMs === offPeak &&
      Number.isInteger(sPeak.clockOverride?.expiresAt) && Number.isInteger(sPeak.clockOverride?.ttlMs),
      JSON.stringify(sPeak.clockOverride))
    check('default ttlMs is 600000 (10 min) when omitted', sPeak.clockOverride?.ttlMs === 600_000, String(sPeak.clockOverride?.ttlMs))
    check('expiresAt ≈ realNow + ttlMs (TTL is real-time, not overridden)',
      Math.abs(sPeak.clockOverride.expiresAt - (Date.now() + sPeak.clockOverride.ttlMs)) < 15_000,
      `expiresAt-realtimdelta=${sPeak.clockOverride.expiresAt - Date.now()} ttl=${sPeak.clockOverride.ttlMs}`)
    check('override landed in a peak window (phase=peak, reason=peak)', sPeak.phase === 'peak' && sPeak.reason === 'peak',
      JSON.stringify({ phase: sPeak.phase, reason: sPeak.reason, nowText: sPeak.nowText }))
    check('independent oracle agrees with the overridden instant', classifyOracle(sPeak.now).phase === 'peak',
      `${sPeak.nowText} oracle=${classifyOracle(sPeak.now).phase}`)
    check('mode=always ⇒ paused=false even inside peak', sPeak.paused === false, JSON.stringify({ mode: sPeak.mode, paused: sPeak.paused }))
    log('state(peak, mode=always) =', JSON.stringify(sPeak))

    // -------------------------------------------------------------- 4. idle-only → paused
    const rMode = await setMode('idle-only')
    check('POST /mode idle-only → 200 envelope', rMode.status === 200 && rMode.json?.ok === true, `status=${rMode.status}`)
    const sPaused = await state()
    check('idle-only + peak ⇒ paused=true', sPaused.paused === true,
      JSON.stringify({ mode: sPaused.mode, phase: sPaused.phase, paused: sPaused.paused, waitingTasks: sPaused.waitingTasks }))
    check('mode=idle-only persists across reads', (await state()).mode === 'idle-only')
    log('state(peak, mode=idle-only) =', JSON.stringify(sPaused))

    // -------------------------------------------------------------- 5. short TTL auto-expiry
    const offShort = offPeak + 30 * 60e3       // a different offset, 30 virtual minutes later
    const rShort = await setClock(offShort, 3000)
    check('POST /clock with ttlMs=3000 → 200', rShort.status === 200 && rShort.json?.ok === true, `status=${rShort.status}`)
    const sShort = await state()
    check('short TTL echoed (ttlMs=3000)', sShort.clockOverride?.ttlMs === 3000, JSON.stringify(sShort.clockOverride))
    check('short-TTL override is still peak & paused while alive', sShort.phase === 'peak' && sShort.paused === true,
      JSON.stringify({ nowText: sShort.nowText, phase: sShort.phase, paused: sShort.paused }))
    log('waiting 5 s for the 3 s TTL to expire ...')
    await new Promise((r) => setTimeout(r, 5000))
    const sExpired = await state()
    check('override auto-expired by itself (clockOverride === null)', sExpired.clockOverride === null, JSON.stringify(sExpired.clockOverride))
    check('after expiry now is real time again', Math.abs(sExpired.now - Date.now()) < 120_000,
      `${sExpired.nowText} vs ${bjParts(Date.now()).text}`)
    check('after expiry the gate re-evaluated: paused=false with real idle now', sExpired.paused === false,
      JSON.stringify({ phase: sExpired.phase, reason: sExpired.reason, paused: sExpired.paused }))
    check('expiry did not change the mode', sExpired.mode === 'idle-only', sExpired.mode)
    log('state(after TTL expiry) =', JSON.stringify(sExpired))

    // -------------------------------------------------------------- 6. auto-resume exactly on the boundary
    const rHold = await setClock(offPeak, 300_000)
    check('re-arm peak override with a 5 min TTL', rHold.status === 200, `status=${rHold.status}`)
    const sHold = await state()
    const fromPeak = nextTransitionOracle(sHold.now)
    check('next transition from peak goes to idle (lunch/evening boundary)', fromPeak?.to === 'idle',
      JSON.stringify({ at: fromPeak?.at, to: fromPeak?.to, text: fromPeak ? bjParts(fromPeak.at).text : null }))
    const boundary = fromPeak.at
    await setClock(boundary - 20_000 - Date.now(), 120_000)
    const sBefore = await state()
    check('20 s before the boundary: still peak & paused', sBefore.phase === 'peak' && sBefore.paused === true,
      JSON.stringify({ nowText: sBefore.nowText, phase: sBefore.phase, paused: sBefore.paused, msUntilTransition: sBefore.msUntilTransition }))
    log(`waiting ${(boundary - sBefore.now) / 1000 + 3}s for the boundary at ${bjParts(boundary).text} ...`)
    // NOTE: `boundary` is a VIRTUAL instant (the override shifts "now"). The override is a fixed
    // offset, so virtual time advances in lockstep with real time — the real wait must come from
    // the VIRTUAL now (`sBefore.now`), never from `Date.now()`. Using Date.now() here once made
    // this script sleep ~65 h and trip its own 90 s watchdog (verifier script bug V1, not an
    // implementation defect). `setClock` above is different: an offset IS relative to the real
    // clock, so `boundary - 20_000 - Date.now()` there is correct.
    await new Promise((r) => setTimeout(r, (boundary - sBefore.now) + 3000))
    const sAfter = await state()
    check('after the boundary: phase=idle & paused=false with no request from the test',
      sAfter.phase === 'idle' && sAfter.paused === false,
      JSON.stringify({ nowText: sAfter.nowText, phase: sAfter.phase, reason: sAfter.reason, paused: sAfter.paused }))
    check('mode stayed idle-only across the boundary', sAfter.mode === 'idle-only', sAfter.mode)
    log('state(after boundary) =', JSON.stringify(sAfter))
  }

  // ---------------------------------------------------------------- 7. restore
  await restore()
  const sEnd = await state()
  check('override cleared: clockOverride === null', sEnd.clockOverride === null, JSON.stringify(sEnd.clockOverride))
  check('mode restored to always', sEnd.mode === 'always', sEnd.mode)
  check('after restore, now is real time (within 120 s of Date.now())', Math.abs(sEnd.now - Date.now()) < 120_000,
    `${sEnd.nowText} vs ${bjParts(Date.now()).text}`)
  log('state(restored) =', JSON.stringify(sEnd))
} catch (err) {
  exitCode = 2
  console.log('ABORTED:', err?.stack ?? String(err))
} finally {
  clearTimeout(watchdog)
  await restore()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== E2E SUMMARY: ${results.length - failed.length}/${results.length} checks passed =====`)
if (failed.length) { console.log('FAILED CHECKS:'); for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`) }
if (exitCode === 0 && failed.length) exitCode = 1
console.log(exitCode === 0 ? 'E2E RESULT: 已验证' : 'E2E RESULT: 失败')
process.exit(exitCode)
