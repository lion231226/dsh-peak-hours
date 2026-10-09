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

/** Handlers over recording stubs. */
function buildHandlers({ allowClockOverride = true } = {}) {
  const calls = { setMode: [], setClock: [] }
  let state = stubState()
  const handlers = createHandlers({
    snapshot: () => state,
    setMode: async (mode) => {
      calls.setMode.push(mode)
      state = stubState({ mode, paused: mode === 'idle-only' })
    },
    setClock: async (offsetMs, ttlMs) => {
      calls.setClock.push([offsetMs, ttlMs])
      state = stubState({ clockOverride: offsetMs === null ? null : { offsetMs, expiresAt: 9, ttlMs: ttlMs ?? 600_000 } })
    },
    allowClockOverride,
    pluginName: 'dsh-peak-hours',
    version: '0.1.0',
  })
  return { handlers, calls, current: () => state }
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
  assert.deepEqual(calls.setMode, ['always', 'idle-only'])
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

  assert.deepEqual(calls.setMode, ['idle-only'], 'only the well-formed local request reached the writer')
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

test('a route path family is exposed for the client half', () => {
  assert.deepEqual(ROUTE_PATHS, {
    state: '/api/peak-hours/state',
    mode: '/api/peak-hours/mode',
    clock: '/api/peak-hours/clock',
    health: '/api/peak-hours/health',
  })
  void FRI
})
