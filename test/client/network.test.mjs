/**
 * Network contract tests: 8 s AbortController timeout, same-origin plain fetch,
 * POST body shape, and the rule that no failure is ever thrown — every one
 * resolves to a result the UI renders as "unavailable".
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundleExports, createFetchStub } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { requestJson, loadState, pushMode, describeFetchError, API_STATE, API_MODE, REQUEST_TIMEOUT_MS } = internals

const STATE = { mode: 'idle-only', phase: 'peak', paused: true, now: 1, nextTransitionAt: 2, msUntilTransition: 1 }

test('routes and the timeout match SPEC 2.3 / 2.5', () => {
  assert.equal(API_STATE, '/api/peak-hours/state')
  assert.equal(API_MODE, '/api/peak-hours/mode')
  assert.equal(REQUEST_TIMEOUT_MS, 8000)
})

test('loadState returns the state object from an ok envelope', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE } })
  const result = await loadState(fetchImpl)
  assert.equal(result.error, null)
  assert.deepEqual(result.state, STATE)
  assert.equal(fetchImpl.calls[0].url, API_STATE)
  assert.equal(fetchImpl.calls[0].init.method, 'GET')
  assert.equal(fetchImpl.calls[0].init.credentials, 'same-origin')
  assert.ok(fetchImpl.calls[0].init.signal, 'a GET must carry an abort signal')
  assert.equal(fetchImpl.calls[0].init.body, undefined)
})

test('loadState maps HTTP errors to a result, never a throw', async () => {
  const result = await loadState(createFetchStub({ status: 500, body: { ok: false, error: 'boom' } }))
  assert.equal(result.state, null)
  assert.equal(result.error, 'HTTP 500')
})

test('loadState maps a rejected fetch to a result', async () => {
  const result = await loadState(createFetchStub({ reject: new Error('ECONNREFUSED') }))
  assert.equal(result.state, null)
  assert.equal(result.error, 'ECONNREFUSED')
})

test('loadState rejects an envelope without a state object', async () => {
  assert.equal((await loadState(createFetchStub({ status: 200, body: { ok: true } }))).error, 'state payload missing')
  assert.equal((await loadState(createFetchStub({ status: 200, body: { ok: false, error: 'nope' } }))).error, 'state payload missing')
})

test('loadState survives a body that is not JSON', async () => {
  const fetchImpl = () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
  const result = await loadState(fetchImpl)
  assert.equal(result.state, null)
  assert.equal(result.error, 'bad json')
})

test('loadState reports a missing fetch implementation instead of throwing', async () => {
  const result = await loadState(null)
  assert.equal(result.state, null)
  assert.equal(result.error, 'fetch unavailable')
})

test('the request aborts after the timeout and resolves to a result', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE }, delayMs: 200 })
  const started = Date.now()
  const result = await loadState(fetchImpl, 20)
  assert.equal(result.state, null)
  assert.equal(result.error, 'timeout', 'an aborted request must read as a timeout')
  assert.ok(Date.now() - started < 190, 'the request must not outlive its timeout')
})

test('a slow response inside the deadline still resolves', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE }, delayMs: 30 })
  const result = await loadState(fetchImpl, 5000)
  assert.equal(result.error, null)
  assert.deepEqual(result.state, STATE)
})

test('pushMode posts { mode } as JSON', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: { ...STATE, mode: 'idle-only' } } })
  const result = await pushMode(fetchImpl, 'idle-only')
  assert.equal(result.error, null)
  assert.equal(result.state.mode, 'idle-only')
  const call = fetchImpl.calls[0]
  assert.equal(call.url, API_MODE)
  assert.equal(call.init.method, 'POST')
  assert.deepEqual({ ...call.init.headers }, { 'content-type': 'application/json' })
  assert.equal(call.init.body, JSON.stringify({ mode: 'idle-only' }))
})

test('pushMode normalizes an unknown mode to always', async () => {
  const fetchImpl = createFetchStub({ status: 200, body: { ok: true, state: STATE } })
  await pushMode(fetchImpl, 'nonsense')
  assert.equal(fetchImpl.calls[0].init.body, JSON.stringify({ mode: 'always' }))
  await pushMode(fetchImpl, undefined)
  assert.equal(fetchImpl.calls[1].init.body, JSON.stringify({ mode: 'always' }))
})

test('pushMode reports a rejected POST as a result', async () => {
  const result = await pushMode(createFetchStub({ reject: new Error('offline') }), 'always')
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
