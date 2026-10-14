/**
 * Route contract (SPEC §2.3): the framework-free handler core plus the thin
 * webserver adapter (loopback fence, method check, JSON body, error mapping).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { API_ROOT, MAX_JSON_BODY_BYTES, ROUTE_PATHS, createHandlers, createWebRoutes, isLoopbackRequest, readJsonBody } from '../../lib/host/routes.js'
import { createFakeRequest, createFakeResponse } from './helpers.mjs'

const FRI = '2026-10-09'

/** A stub state object good enough to prove the envelope shape. */
function stubState(overrides = {}) {
  return {
    mode: 'always',
    defaultMode: 'always',
    modeSource: 'default',
    sessionId: null,
    phase: 'idle',
    reason: 'off-hours',
    now: 1,
    nowText: '2026-10-09 18:08:06',
    nextTransitionAt: 2,
    nextTransitionText: '2026-10-12 09:00:00',
    nextPhase: 'peak',
    msUntilTransition: 1,
    paused: false,
    waitingTasks: 0,
    waitingTasksTotal: 0,
    waitingTasksUnresolved: 0,
    holidayToday: null,
    holidayCoverage: 'known',
    unknownHolidayYear: null,
    timeZone: 'Asia/Shanghai (UTC+8)',
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    clockOverride: null,
    config: { allowClockOverride: true },
    ...overrides,
  }
}

/** Handlers over recording stubs; the session table mirrors the real store. */
function buildHandlers({ allowClockOverride = true, defaultMode = 'always' } = {}) {
  const calls = { setMode: [], setClock: [], clearSession: [] }
  const sessions = new Map()
  let defaultChoice = defaultMode
  let clockOverride = null
  const resolve = (sessionId) => {
    if (typeof sessionId === 'string' && sessions.has(sessionId)) return { mode: sessions.get(sessionId), source: 'session' }
    return { mode: defaultChoice, source: 'default' }
  }
  const snapshot = (sessionId = null) => {
    const resolved = resolve(sessionId)
    return stubState({
      mode: resolved.mode,
      defaultMode: defaultChoice,
      modeSource: resolved.source,
      sessionId: sessionId ?? null,
      clockOverride,
    })
  }
  const handlers = createHandlers({
    snapshot,
    setMode: async (mode, sessionId = null) => {
      calls.setMode.push([mode, sessionId])
      if (sessionId === null) defaultChoice = mode
      else sessions.set(sessionId, mode)
      return true
    },
    clearSession: async (sessionId) => {
      calls.clearSession.push(sessionId)
      if (typeof sessionId !== 'string' || sessionId === '') return false
      sessions.delete(sessionId)
      return true
    },
    setClock: async (offsetMs, ttlMs) => {
      calls.setClock.push([offsetMs, ttlMs])
      clockOverride = offsetMs === null ? null : { offsetMs, expiresAt: 9, ttlMs: ttlMs ?? 600_000 }
    },
    allowClockOverride,
    pluginName: 'dsh-peak-hours',
    version: '0.1.0',
  })
  return { handlers, calls, sessions, defaultChoice: () => defaultChoice, clockOverride: () => clockOverride }
}

test('GET state returns the success envelope with the frozen field set', async () => {
  const { handlers } = buildHandlers()
  const result = await handlers.state()
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.deepEqual(Object.keys(result.body), ['ok', 'state'])
  assert.deepEqual(result.body.state, stubState())
})

test('POST mode accepts both literals and echoes the envelope', async () => {
  const { handlers, calls } = buildHandlers()
  for (const mode of ['always', 'idle-only']) {
    const result = await handlers.mode({ mode })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.state.mode, mode)
  }
  assert.deepEqual(calls.setMode, [
    ['always', null],
    ['idle-only', null],
  ])
})

test('POST mode rejects invalid input with 4xx + {ok:false,error}', async () => {
  const { handlers, calls } = buildHandlers()
  for (const body of [
    { mode: 'sometimes' },
    { mode: '' },
    { mode: null },
    { mode: 42 },
    { mode: ['always'] },
    {},
    null,
    'always',
  ]) {
    const result = await handlers.mode(body)
    assert.ok(result.status >= 400 && result.status < 500, `status ${result.status} must be 4xx`)
    assert.equal(result.body.ok, false)
    assert.equal(typeof result.body.error, 'string')
    assert.ok(result.body.error.length > 0)
  }
  assert.deepEqual(calls.setMode, [], 'a rejected body must not reach the mode writer')
})

test('POST clock is refused with 403 when the override is disabled', async () => {
  const { handlers, calls } = buildHandlers({ allowClockOverride: false })
  for (const body of [{ offsetMs: 1000 }, { offsetMs: null }]) {
    const result = await handlers.clock(body)
    assert.equal(result.status, 403)
    assert.equal(result.body.ok, false)
    assert.match(result.body.error, /disabled/)
  }
  assert.deepEqual(calls.setClock, [], 'a refused override must not reach the clock')
})

test('POST clock installs an integer offset and clears it with null', async () => {
  const { handlers, calls } = buildHandlers()
  const set = await handlers.clock({ offsetMs: -3_600_000, ttlMs: 120_000 })
  assert.equal(set.status, 200)
  assert.equal(set.body.ok, true)
  assert.deepEqual(set.body.state.clockOverride, { offsetMs: -3_600_000, expiresAt: 9, ttlMs: 120_000 })
  assert.deepEqual(calls.setClock, [[-3_600_000, 120_000]])

  const cleared = await handlers.clock({ offsetMs: null })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.state.clockOverride, null)
  assert.deepEqual(calls.setClock[1], [null, undefined])

  const zero = await handlers.clock({ offsetMs: 0, ttlMs: 1000 })
  assert.equal(zero.status, 200)
  assert.deepEqual(calls.setClock[2], [0, 1000])
})

test('POST clock rejects malformed bodies with 4xx', async () => {
  const { handlers, calls } = buildHandlers()
  for (const body of [
    { offsetMs: '1000' },
    { offsetMs: 1.5 },
    { offsetMs: Number.NaN },
    { offsetMs: [1] },
    { offsetMs: 1000, ttlMs: 0 },
    { offsetMs: 1000, ttlMs: -1 },
    { offsetMs: 1000, ttlMs: '60000' },
    {},
    null,
  ]) {
    const result = await handlers.clock(body)
    assert.ok(result.status >= 400 && result.status < 500, `status ${result.status} must be 4xx for ${JSON.stringify(body)}`)
    assert.equal(result.body.ok, false)
    assert.equal(typeof result.body.error, 'string')
  }
  assert.deepEqual(calls.setClock, [])
})

test('GET health reports plugin identity without the state snapshot', async () => {
  const { handlers } = buildHandlers()
  const result = await handlers.health()
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true, plugin: 'dsh-peak-hours', version: '0.1.0' })
})

test('the webserver adapter registers the four frozen exact paths', () => {
  const { handlers } = buildHandlers()
  const routes = createWebRoutes(handlers)
  assert.deepEqual(
    routes.map((route) => [route.kind, route.path]),
    [
      ['exact', ROUTE_PATHS.state],
      ['exact', ROUTE_PATHS.mode],
      ['exact', ROUTE_PATHS.clock],
      ['exact', ROUTE_PATHS.health],
    ],
  )
  for (const route of routes) assert.equal(typeof route.handler, 'function')
  assert.equal(API_ROOT, '/api/peak-hours')
})

test('the adapter answers GET state as JSON through a real (fake) request/response pair', async () => {
  const { handlers } = buildHandlers()
  const routes = createWebRoutes(handlers)
  const stateRoute = routes[0]
  const res = createFakeResponse()
  await stateRoute.handler(createFakeRequest({ method: 'GET', url: ROUTE_PATHS.state }), res)
  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.json.ok, true)
  assert.equal(res.json.state.mode, 'always')
})

test('the adapter parses a POST body and rejects a bad method, a bad body and a foreign peer', async () => {
  const { handlers, calls } = buildHandlers()
  const routes = createWebRoutes(handlers)
  const modeRoute = routes[1]

  const ok = createFakeResponse()
  await modeRoute.handler(createFakeRequest({ method: 'POST', url: ROUTE_PATHS.mode, body: { mode: 'idle-only' } }), ok)
  assert.equal(ok.state.status, 200)
  assert.equal(ok.json.state.mode, 'idle-only')

  const wrongMethod = createFakeResponse()
  await modeRoute.handler(createFakeRequest({ method: 'GET', url: ROUTE_PATHS.mode }), wrongMethod)
  assert.equal(wrongMethod.state.status, 405)
  assert.equal(wrongMethod.state.allow, 'POST')
  assert.equal(wrongMethod.json.ok, false)

  const badBody = createFakeResponse()
  await modeRoute.handler(createFakeRequest({ method: 'POST', url: ROUTE_PATHS.mode, body: '{not json' }), badBody)
  assert.equal(badBody.state.status, 400)
  assert.equal(badBody.json.ok, false)

  const oversized = createFakeResponse()
  await modeRoute.handler(
    createFakeRequest({ method: 'POST', url: ROUTE_PATHS.mode, body: `{"mode":"always","pad":"${'x'.repeat(MAX_JSON_BODY_BYTES)}"}` }),
    oversized,
  )
  assert.equal(oversized.state.status, 400)

  const foreign = createFakeResponse()
  await modeRoute.handler(
    createFakeRequest({ method: 'POST', url: ROUTE_PATHS.mode, body: { mode: 'idle-only' }, remoteAddress: '10.0.0.7', host: '10.0.0.7:19387' }),
    foreign,
  )
  assert.equal(foreign.state.status, 403)
  assert.equal(foreign.json.ok, false)

  assert.deepEqual(calls.setMode, [['idle-only', null]], 'only the well-formed local request reached the writer')
})

test('a throwing handler becomes a JSON 4xx instead of an unhandled rejection', async () => {
  const routes = createWebRoutes(
    {
      state: async () => {
        throw new Error('boom')
      },
      mode: async () => ({ status: 200, body: { ok: true } }),
      clock: async () => ({ status: 200, body: { ok: true } }),
      health: async () => ({ status: 200, body: { ok: true } }),
    },
    { logger: { warn: () => {} } },
  )
  const res = createFakeResponse()
  await routes[0].handler(createFakeRequest({ method: 'GET', url: ROUTE_PATHS.state }), res)
  assert.equal(res.state.status, 400)
  assert.deepEqual(res.json, { ok: false, error: 'boom' })
})

test('loopback detection accepts the desktop GUI peer and refuses a LAN peer', () => {
  assert.equal(isLoopbackRequest(createFakeRequest({ remoteAddress: '127.0.0.1', host: '127.0.0.1:19387' })), true)
  assert.equal(isLoopbackRequest(createFakeRequest({ remoteAddress: '::1', host: '[::1]:19387' })), true)
  assert.equal(isLoopbackRequest(createFakeRequest({ remoteAddress: '::ffff:127.0.0.1', host: 'localhost:19387' })), true)
  assert.equal(isLoopbackRequest(createFakeRequest({ remoteAddress: '192.168.1.20', host: '192.168.1.20:19387' })), false)
  assert.equal(isLoopbackRequest(createFakeRequest({ remoteAddress: '10.0.0.5', host: '127.0.0.1:19387' })), false)
  assert.equal(isLoopbackRequest({}), true, 'an unknown peer is left to the host webserver binding')
})

test('readJsonBody rejects empty, non-object and unparseable bodies', async () => {
  assert.deepEqual(await readJsonBody(createFakeRequest({ method: 'POST', body: { offsetMs: 5 } })), { offsetMs: 5 })
  assert.equal(await readJsonBody(createFakeRequest({ method: 'POST', body: '' })), undefined)
  assert.equal(await readJsonBody(createFakeRequest({ method: 'POST', body: 'null' })), undefined)
  assert.equal(await readJsonBody(createFakeRequest({ method: 'POST', body: '[1,2]' })), undefined)
  assert.equal(await readJsonBody(createFakeRequest({ method: 'POST', body: 'nope' })), undefined)
})

test('createHandlers refuses to build without a snapshot provider', () => {
  assert.throws(() => createHandlers({}), /requires snapshot/)
})

test('the reported state reflects a real gate waiter count', async () => {
  const { handlers } = buildHandlers()
  const withWaiters = createHandlers({
    snapshot: () => stubState({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 3, nowText: '2026-10-09 10:00:00' }),
    setMode: async () => {},
    setClock: async () => {},
  })
  const result = await withWaiters.state()
  assert.equal(result.body.state.waitingTasks, 3)
  assert.equal(result.body.state.paused, true)
  assert.equal((await handlers.state()).body.state.waitingTasks, 0)
})

// ── SPEC §9.3: session scoping ──────────────────────────────────────────────

test('GET state reports the requested session and its resolved mode', async () => {
  const { handlers } = buildHandlers({ defaultMode: 'idle-only' })
  await handlers.mode({ mode: 'always', session: 'session-a' })

  const scoped = await handlers.state({ session: 'session-a' })
  assert.equal(scoped.status, 200)
  assert.equal(scoped.body.state.sessionId, 'session-a')
  assert.equal(scoped.body.state.mode, 'always')
  assert.equal(scoped.body.state.modeSource, 'session')
  assert.equal(scoped.body.state.defaultMode, 'idle-only')

  const other = await handlers.state({ session: 'session-b' })
  assert.equal(other.body.state.sessionId, 'session-b')
  assert.equal(other.body.state.mode, 'idle-only')
  assert.equal(other.body.state.modeSource, 'default')

  const none = await handlers.state()
  assert.equal(none.body.state.sessionId, null)
  assert.equal(none.body.state.mode, 'idle-only')
  assert.equal(none.body.state.modeSource, 'default')

  const blank = await handlers.state({ session: '   ' })
  assert.equal(blank.body.state.sessionId, null, 'a blank session is no session')
})

test('POST mode writes the session scope, the default scope, and the implied scope', async () => {
  const { handlers, calls, defaultChoice } = buildHandlers()

  // explicit session scope
  const scoped = await handlers.mode({ mode: 'always', session: 'session-a', scope: 'session' })
  assert.equal(scoped.status, 200)
  assert.equal(scoped.body.state.sessionId, 'session-a')
  assert.equal(scoped.body.state.modeSource, 'session')
  assert.deepEqual(calls.setMode.at(-1), ['always', 'session-a'])

  // implied by `session` alone
  const implied = await handlers.mode({ mode: 'idle-only', session: 'session-b' })
  assert.equal(implied.status, 200)
  assert.deepEqual(calls.setMode.at(-1), ['idle-only', 'session-b'])

  // explicit default scope
  const asDefault = await handlers.mode({ mode: 'idle-only', scope: 'default' })
  assert.equal(asDefault.status, 200)
  assert.equal(asDefault.body.state.sessionId, null)
  assert.equal(asDefault.body.state.modeSource, 'default')
  assert.deepEqual(calls.setMode.at(-1), ['idle-only', null])

  // neither → default, keeping the old curl examples working
  const legacy = await handlers.mode({ mode: 'always' })
  assert.equal(legacy.status, 200)
  assert.deepEqual(calls.setMode.at(-1), ['always', null])
  assert.equal(defaultChoice(), 'always')
})

test('SEC-2: every malformed scope/session shape is 4xx and never writes the default', async () => {
  const { handlers, calls, defaultChoice, clockOverride } = buildHandlers({ defaultMode: 'idle-only' })
  const before = defaultChoice()
  const bodies = [
    { mode: 'always', session: null },
    { mode: 'always', session: {} },
    { mode: 'always', session: 123 },
    { mode: 'always', session: '   ' },
    { mode: 'always', session: 'x'.repeat(129) },
    { mode: 'always', session: '__proto__' },
    { mode: 'always', session: 'constructor' },
    { mode: 'always', session: 'prototype' },
    { mode: 'always', scope: 'session' },
    { mode: 'always', session: 'session-a', scope: 'default' },
    { mode: 'always', scope: 'nonsense' },
    { mode: 'always', scope: null },
  ]
  for (const body of bodies) {
    const result = await handlers.mode(body)
    assert.ok(result.status >= 400 && result.status < 500, `expected 4xx for ${JSON.stringify(body)}, got ${result.status}`)
    assert.equal(result.body.ok, false)
    assert.equal(typeof result.body.error, 'string')
  }
  assert.deepEqual(calls.setMode, [], 'the writer was never reached')
  assert.equal(defaultChoice(), before, 'the default choice is unchanged')
  assert.equal(clockOverride(), null)
})

test('`mode: null` with a session clears that override (SPEC §9.3 addendum)', async () => {
  const { handlers, calls } = buildHandlers({ defaultMode: 'idle-only' })
  await handlers.mode({ mode: 'always', session: 'session-a' })
  assert.equal((await handlers.state({ session: 'session-a' })).body.state.modeSource, 'session')

  const cleared = await handlers.mode({ mode: null, session: 'session-a', scope: 'session' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.state.sessionId, 'session-a')
  assert.equal(cleared.body.state.modeSource, 'default', 'the session follows the default again')
  assert.equal(cleared.body.state.mode, 'idle-only')
  assert.deepEqual(calls.clearSession, ['session-a'])
  assert.deepEqual(calls.setMode, [['always', 'session-a']], 'clearing is not a write')

  // `mode: null` without a session cannot clear the default
  const bad = await handlers.mode({ mode: null })
  assert.equal(bad.status, 400)
  const badDefault = await handlers.mode({ mode: null, scope: 'default' })
  assert.equal(badDefault.status, 400)
})

// ── SEC-4 / SEC-6 fences ────────────────────────────────────────────────────

test('SEC-4: a cross-site or non-JSON POST is refused before the body is parsed', async () => {
  const { handlers, calls } = buildHandlers()
  const routes = createWebRoutes(handlers, { logger: { warn: () => {} } })
  const modeRoute = routes[1]

  const plain = createFakeResponse()
  await modeRoute.handler(createFakeRequest({ method: 'POST', url: ROUTE_PATHS.mode, body: { mode: 'always' }, headers: { 'content-type': 'text/plain' } }), plain)
  assert.equal(plain.state.status, 415, 'a no-preflight "simple request" must not be processed')
  assert.equal(plain.json.ok, false)

  const missing = createFakeResponse()
  await modeRoute.handler(
    createFakeRequest({ method: 'POST', url: ROUTE_PATHS.mode, body: { mode: 'always' }, headers: { 'content-type': undefined } }),
    missing,
  )
  assert.equal(missing.state.status, 415)

  const crossSite = createFakeResponse()
  await modeRoute.handler(
    createFakeRequest({
      method: 'POST',
      url: ROUTE_PATHS.mode,
      body: { mode: 'always' },
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    }),
    crossSite,
  )
  assert.equal(crossSite.state.status, 403)
  assert.equal(crossSite.json.ok, false)

  const json = createFakeResponse()
  await modeRoute.handler(createFakeRequest({ method: 'POST', url: ROUTE_PATHS.mode, body: { mode: 'always' } }), json)
  assert.equal(json.state.status, 200)
  assert.equal(json.json.ok, true)
  assert.deepEqual(calls.setMode, [['always', null]], 'only the JSON request reached the writer')

  // GET routes are unaffected by the POST-only media-type fence.
  const stateRoute = routes[0]
  const get = createFakeResponse()
  await stateRoute.handler(createFakeRequest({ method: 'GET', url: ROUTE_PATHS.state }), get)
  assert.equal(get.state.status, 200)
})

test('SEC-6: the clock TTL is capped at 30 minutes and defaults to 10', async () => {
  const { handlers, calls } = buildHandlers()
  const tooLong = await handlers.clock({ offsetMs: 1000, ttlMs: 3_600_000 })
  assert.equal(tooLong.status, 400)
  assert.match(tooLong.body.error, /1800000/)
  assert.match(tooLong.body.error, /30 minute/)
  assert.deepEqual(calls.setClock, [])

  const atCeiling = await handlers.clock({ offsetMs: 1000, ttlMs: 1_800_000 })
  assert.equal(atCeiling.status, 200)
  assert.deepEqual(calls.setClock.at(-1), [1000, 1_800_000])

  const defaulted = await handlers.clock({ offsetMs: 1000 })
  assert.equal(defaulted.status, 200)
  assert.deepEqual(calls.setClock.at(-1), [1000, undefined])
  assert.equal(defaulted.body.state.clockOverride.ttlMs, 600_000, 'no ttlMs → the documented 10-minute default')
})

test('the adapter forwards ?session= to the handler', async () => {
  const { handlers } = buildHandlers({ defaultMode: 'always' })
  await handlers.mode({ mode: 'idle-only', session: 'session-a' })
  const routes = createWebRoutes(handlers, { logger: { warn: () => {} } })
  const res = createFakeResponse()
  await routes[0].handler(createFakeRequest({ method: 'GET', url: `${ROUTE_PATHS.state}?session=session-a` }), res)
  assert.equal(res.state.status, 200)
  assert.equal(res.json.state.sessionId, 'session-a')
  assert.equal(res.json.state.modeSource, 'session')
})

test('a route path family is exposed for the client half', () => {
  assert.deepEqual(ROUTE_PATHS, {
    state: '/api/peak-hours/state',
    mode: '/api/peak-hours/mode',
    clock: '/api/peak-hours/clock',
    health: '/api/peak-hours/health',
  })
  void FRI
})
