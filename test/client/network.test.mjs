/**
 * Network contract tests (SPEC 2.5 + 9.3): same-origin plain fetch, 8 s
 * AbortController timeout, per-session reads, scoped writes, and the rule that no
 * failure is ever thrown — every one resolves to a result the UI renders.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundleExports, createFetchStub } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { requestJson, loadState, pushMode, describeFetchError, stateUrl, modeTarget, API_STATE, API_MODE, REQUEST_TIMEOUT_MS } = internals

const SESSION = 'session-abc'
const STATE = { mode: 'idle-only', phase: 'peak', paused: true, now: 1, nextTransitionAt: 2, msUntilTransition: 1 }
const GET_URL = `${API_STATE}?session=${SESSION}`

test('routes and the timeout match SPEC 2.3 / 2.5', () => {
  assert.equal(API_STATE, '/api/peak-hours/state')
  assert.equal(API_MODE, '/api/peak-hours/mode')
  assert.equal(REQUEST_TIMEOUT_MS, 8000)
})

test('9.3: the state URL carries the session as a query parameter', () => {
  assert.equal(stateUrl(SESSION), GET_URL)
  assert.equal(stateUrl('a b/c'), `${API_STATE}?session=a%20b%2Fc`, 'the id must be encoded, not interpolated raw')
})

test('9.3: a session write targets that session; a default write carries no session', () => {
  assert.deepEqual({ ...modeTarget('session', SESSION) }, { scope: 'session', session: SESSION })
  assert.deepEqual({ ...modeTarget('default', SESSION) }, { scope: 'default', session: null })
  assert.deepEqual({ ...modeTarget(undefined, SESSION) }, { scope: 'session', session: SESSION }, 'session scope is the default')
})

test('loadState returns the state object from an ok envelope for one session', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE } })
  const result = await loadState(fetchImpl, SESSION)
  assert.equal(result.error, null)
  assert.deepEqual(result.state, STATE)
  assert.equal(fetchImpl.calls[0].url, GET_URL)
  assert.equal(fetchImpl.calls[0].init.method, 'GET')
  assert.equal(fetchImpl.calls[0].init.credentials, 'same-origin')
  assert.ok(fetchImpl.calls[0].init.signal, 'a GET must carry an abort signal')
  assert.equal(fetchImpl.calls[0].init.body, undefined)
})

test('loadState refuses to read without a session instead of asking for the default', async () => {
  for (const bad of [undefined, null, '', 42]) {
    const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE } })
    const result = await loadState(fetchImpl, bad)
    assert.equal(result.state, null)
    assert.equal(result.error, 'session missing')
    assert.equal(fetchImpl.calls.length, 0, 'no request may be sent without a session')
  }
})

test('loadState maps HTTP errors to a result, never a throw', async () => {
  const result = await loadState(createFetchStub({ status: 500, body: { ok: false, error: 'boom' } }), SESSION)
  assert.equal(result.state, null)
  assert.equal(result.error, 'HTTP 500')
})

test('loadState maps a rejected fetch to a result', async () => {
  const result = await loadState(createFetchStub({ reject: new Error('ECONNREFUSED') }), SESSION)
  assert.equal(result.state, null)
  assert.equal(result.error, 'ECONNREFUSED')
})

test('loadState rejects an envelope without a state object', async () => {
  assert.equal((await loadState(createFetchStub({ status: 200, body: { ok: true } }), SESSION)).error, 'state payload missing')
  assert.equal((await loadState(createFetchStub({ status: 200, body: { ok: false, error: 'nope' } }), SESSION)).error, 'state payload missing')
})

test('loadState survives a body that is not JSON', async () => {
  const fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
  const result = await loadState(fetchImpl, SESSION)
  assert.equal(result.state, null)
  assert.equal(result.error, 'bad json')
})

test('loadState reports a missing fetch implementation instead of throwing', async () => {
  const result = await loadState(null, SESSION)
  assert.equal(result.state, null)
  assert.equal(result.error, 'fetch unavailable')
})

test('the request aborts after the timeout and resolves to a result', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE }, delayMs: 200 })
  const started = Date.now()
  const result = await loadState(fetchImpl, SESSION, 20)
  assert.equal(result.state, null)
  assert.equal(result.error, 'timeout', 'an aborted request must read as a timeout')
  assert.ok(Date.now() - started < 190, 'the request must not outlive its timeout')
})

test('a slow response inside the deadline still resolves', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE }, delayMs: 30 })
  const result = await loadState(fetchImpl, SESSION, 5000)
  assert.equal(result.error, null)
  assert.deepEqual(result.state, STATE)
})

test('9.3/9.4: switching posts { mode, session, scope:"session" } — never a global write', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: { ...STATE, mode: 'always', sessionId: SESSION, modeSource: 'session' } } })
  const result = await pushMode(fetchImpl, 'always', modeTarget('session', SESSION))
  assert.equal(result.error, null)
  assert.equal(result.state.mode, 'always')
  const call = fetchImpl.calls[0]
  assert.equal(call.url, API_MODE)
  assert.equal(call.init.method, 'POST')
  assert.deepEqual({ ...call.init.headers }, { 'content-type': 'application/json' })
  assert.equal(call.init.body, JSON.stringify({ mode: 'always', scope: 'session', session: SESSION }))
})

test('9.3/9.4: the default entry posts { mode, scope:"default" } and no session', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE } })
  await pushMode(fetchImpl, 'idle-only', modeTarget('default', SESSION))
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.deepEqual(body, { mode: 'idle-only', scope: 'default' })
  assert.equal('session' in body, false, 'a present session would imply session scope on the host')
})

test('SEC-4: every write path carries Content-Type: application/json (host answers 415 without it)', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: { ...STATE, modeSource: 'default', defaultMode: 'idle-only' } } })
  await pushMode(fetchImpl, 'always', modeTarget('session', SESSION))
  await pushMode(fetchImpl, null, modeTarget('session', SESSION))
  await pushMode(fetchImpl, 'idle-only', modeTarget('default', SESSION))
  assert.equal(fetchImpl.calls.length, 3)
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.headers['content-type'], 'application/json', 'a bare POST would be rejected with 415')
  }
  // A GET must not pretend to send a body.
  const reads = createFetchStub({ status: 200, body: { ok: true, state: STATE } })
  await loadState(reads, SESSION)
  assert.equal(reads.calls[0].init.headers, undefined)
})

test('SEC-4: the write headers are exactly the JSON content type, not a simple-request type', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE } })
  await pushMode(fetchImpl, 'always', modeTarget('session', SESSION))
  assert.deepEqual({ ...fetchImpl.calls[0].init.headers }, { 'content-type': 'application/json' })
  assert.equal(fetchImpl.calls[0].init.credentials, 'same-origin')
})

test('9.3: the request builder still passes mode:null through — an API capability the UI no longer offers', async () => {
  // The interface writes explicit overrides only (both options send a real mode).
  // The host keeps supporting "clear this session's override", so the builder must
  // not silently turn null into "always" if some other caller ever uses it.
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: { ...STATE, modeSource: 'default', defaultMode: 'idle-only' } } })
  const result = await pushMode(fetchImpl, null, modeTarget('session', SESSION))
  assert.equal(result.error, null)
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { mode: null, scope: 'session', session: SESSION })
  assert.equal(fetchImpl.calls[0].init.body.includes('"always"'), false, 'a cleared override must never be normalized into a mode')
})

test('pushMode normalizes an unknown mode to always', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE } })
  await pushMode(fetchImpl, 'nonsense', modeTarget('session', SESSION))
  assert.equal(fetchImpl.calls[0].init.body, JSON.stringify({ mode: 'always', scope: 'session', session: SESSION }))
  await pushMode(fetchImpl, undefined, modeTarget('session', SESSION))
  assert.equal(fetchImpl.calls[1].init.body, JSON.stringify({ mode: 'always', scope: 'session', session: SESSION }))
})

test('pushMode reports a rejected POST as a result', async () => {
  const result = await pushMode(createFetchStub({ reject: new Error('offline') }), 'always', modeTarget('session', SESSION))
  assert.equal(result.state, null)
  assert.equal(result.error, 'offline')
})

test('requestJson rejects a malformed response object', async () => {
  const result = await requestJson(() => Promise.resolve({ json: async () => ({}) }), '/x', null, 100)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'invalid response')
})

test('describeFetchError names the abort case and never throws', () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  assert.equal(describeFetchError(abort), 'timeout')
  assert.equal(describeFetchError(new Error('boom')), 'boom')
  assert.equal(describeFetchError(null), 'network error')
  assert.equal(describeFetchError({}), 'network error')
  assert.equal(describeFetchError('weird'), 'network error')
})
