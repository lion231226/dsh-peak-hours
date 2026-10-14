// verify/session-store.test.mjs — SPEC §9.1 file-contract checks (v2 state file), verifier-owned.
//
// These assert the FROZEN ARTIFACT (`<DSH_HOME>/peak-hours-state.json` shape and behaviour) rather
// than an internal design: the test writes a file of a given shape, drives the store's only public
// entry points, and then re-reads the file from disk. Skips loudly while the v2 store is absent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let storeMod = null, loadErr = null
try { storeMod = await import('../lib/host/store.js') } catch (e) { loadErr = e }
const missing = storeMod ? false : `lib/host/store.js unavailable: ${loadErr?.message}`

/** v2 detection: a fresh store reading a v2 file must hand back an object with default+sessions. */
function v2Ready() {
  if (!storeMod) return false
  const dir = mkdtempSync(join(tmpdir(), 'peak-store-detect-'))
  try {
    const file = join(dir, 'peak-hours-state.json')
    writeFileSync(file, JSON.stringify({ version: 2, default: 'always', sessions: {} }), 'utf8')
    const snapshot = storeMod.createModeStore({ file })
    return typeof snapshot.modeFor === 'function' && typeof snapshot.setMode === 'function'
  } catch { return false } finally { rmSync(dir, { recursive: true, force: true }) }
}
const pending = v2Ready() ? false : 'SPEC §9.1 v2 store not implemented yet (task-5 pending)'

/** Create a store over a temp dir and hand back helpers. */
function withStore(initial, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'peak-store-'))
  const file = join(dir, 'peak-hours-state.json')
  if (initial !== undefined) writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial), 'utf8')
  const logs = []
  const logger = { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]), error: (m) => logs.push(['error', String(m)]) }
  const store = storeMod.createModeStore({ file, logger })
  return Promise.resolve(fn({ store, file, dir, logs })).finally(() => rmSync(dir, { recursive: true, force: true }))
}
const onDisk = (file) => JSON.parse(readFileSync(file, 'utf8'))
/**
 * Count session entries without assuming the in-memory container type. SPEC §9.1 freezes the FILE
 * format (a JSON object), not whether `read()` hands back a plain object or a Map — the
 * implementation moved to a Map for order stability, which is internal. Assertions therefore use
 * this helper plus `modeFor()` rather than deep-equalling the snapshot.
 */
const sessionCount = (v) => (v instanceof Map ? v.size : (v && typeof v === 'object' ? Object.keys(v).length : -1))

test('subject module present (lib/host/store.js)', () => {
  assert.ok(storeMod, missing)
})

test('v1 {mode} migrates to v2 on disk: default preserved, sessions empty, exactly one log', { skip: pending || missing }, async () => {
  await withStore({ mode: 'idle-only', updatedAt: '2026-10-14T06:36:18.431Z' }, async ({ store, file, logs }) => {
    const read = await store.read()
    assert.equal(read.version, 2, 'read() must report the v2 shape')
    assert.equal(read.default, 'idle-only', 'the v1 host-wide mode becomes the v2 default')
    assert.equal(sessionCount(read.sessions), 0, 'no session entries after migration')

    const written = onDisk(file)
    assert.equal(written.version, 2, 'the migrated file must be written back as v2')
    assert.equal(written.default, 'idle-only')
    assert.deepEqual(written.sessions, {})

    const migrationLogs = logs.filter(([, m]) => /migrat/i.test(m))
    assert.equal(migrationLogs.length, 1, `expected exactly one migration log, got ${JSON.stringify(logs)}`)

    // idempotent: reading again must not migrate or log again
    const second = storeMod.createModeStore({ file, logger: { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]) } })
    assert.equal((await second.read()).default, 'idle-only')
    assert.equal(logs.filter(([, m]) => /migrat/i.test(m)).length, 1, 'migration must not repeat')
  })
})

test('a corrupt file falls back to {default:always, sessions:{}} with exactly one warning', { skip: pending || missing }, async () => {
  await withStore('{{{ definitely not json', async ({ store, logs }) => {
    const read = await store.read()
    assert.equal(read.default, 'always')
    assert.equal(sessionCount(read.sessions), 0, 'no session entries after migration')
    assert.equal(logs.filter(([lvl]) => lvl === 'warn').length, 1, `expected one warning, got ${JSON.stringify(logs)}`)
    // it must remain usable: the next write produces valid v2 JSON
    await store.setMode('idle-only', 'S')
    assert.equal(read.version, 2)
  })
})

test('missing file: defaults to always without throwing', { skip: pending || missing }, async () => {
  await withStore(undefined, async ({ store }) => {
    const read = await store.read()
    assert.equal(read.version, 2)
    assert.equal(read.default, 'always')
    assert.equal(sessionCount(read.sessions), 0, 'no session entries after migration')
  })
})

test('malformed v2 values are sanitized rather than trusted or thrown', { skip: pending || missing }, async () => {
  await withStore({ version: 2, default: 'sometimes', sessions: { good: 'idle-only', bad: 'nope', 7: 'always', '': 'always' } }, async ({ store }) => {
    const read = await store.read()
    assert.equal(read.default, 'always', 'an unrecognized default degrades to always')
    assert.deepEqual(store.modeFor('good'), { mode: 'idle-only', source: 'session' }, 'valid session entries survive')
    assert.deepEqual(store.modeFor('bad'), { mode: 'always', source: 'default' }, 'an invalid mode must be dropped')
  })
})

test('modeFor resolves sessions[id] → default, and never crosses sessions', { skip: pending || missing }, async () => {
  await withStore({ version: 2, default: 'always', sessions: { A: 'idle-only', B: 'always' } }, async ({ store }) => {
    await store.read()
    assert.deepEqual(store.modeFor('A'), { mode: 'idle-only', source: 'session' })
    assert.deepEqual(store.modeFor('B'), { mode: 'always', source: 'session' })
    assert.deepEqual(store.modeFor('never-seen'), { mode: 'always', source: 'default' })
    assert.deepEqual(store.modeFor(null), { mode: 'always', source: 'default' }, 'a blank id resolves to default')

    // writing one session must not disturb another
    await store.setMode('always', 'A')
    assert.deepEqual(store.modeFor('A'), { mode: 'always', source: 'session' })
    assert.deepEqual(store.modeFor('B'), { mode: 'always', source: 'session' })
    await store.setMode('idle-only', null)                 // default write
    assert.deepEqual(store.modeFor('never-seen'), { mode: 'idle-only', source: 'default' })
    assert.deepEqual(store.modeFor('A'), { mode: 'always', source: 'session' }, 'A keeps its explicit choice')
  })
})

test('session cap: bounded at MAX_SESSIONS, least-recently-SET eviction (untouched session reverts to default)', { skip: pending || missing }, async () => {
  // SPEC §9.1 fixes the v2 file shape and says nothing about a maximum number of sessions. The
  // implementation caps at MAX_SESSIONS. The verifier MEASURED the eviction policy rather than
  // assuming one: `setMode` deletes then re-adds the key, so an update refreshes its recency
  // (an earlier FIFO hypothesis was wrong). This test pins the observable contract — bounded
  // memory, and memory agreeing with the file — and reports the policy for the record.
  const cap = storeMod.MAX_SESSIONS ?? 500
  await withStore({ version: 2, default: 'always', sessions: {} }, async ({ store, file, logs }) => {
    await store.read()
    await store.setMode('idle-only', 'A')            // inserted first → index 0
    await store.setMode('always', 'B')
    await store.setMode('idle-only', 'A')            // an UPDATE: does it move A to the back?
    const afterUpdate = Object.keys(onDisk(file).sessions)
    const aIndex = afterUpdate.indexOf('A')

    for (let i = 0; i < cap + 20; i++) await store.setMode('idle-only', `filler${i}`)
    const parsed = onDisk(file)
    const kept = Object.hasOwn(parsed.sessions, 'A')

    console.log(`[observation] MAX_SESSIONS=${cap}; after being updated A sits at index ${aIndex} of ` +
      `${afterUpdate.length} (a non-zero index means an update DOES refresh its recency, i.e. LRU-by-set); ` +
      `after ${cap + 20} newer sessions A is ${kept ? 'kept' : `EVICTED → reverts to default "${parsed.default}"`}`)

    // hard assertions: bounded memory, and memory must agree with the file
    assert.ok(Object.keys(parsed.sessions).length <= cap, 'the file must stay bounded')
    assert.equal(store.modeFor('A').source, kept ? 'session' : 'default', 'memory and file must agree about A')

    // SPEC §9.6 (Lead ruling 2026-10-14): the cap stays, the policy is LRU-by-set, and every
    // eviction must be VISIBLE in the log instead of silently dropping a user's choice.
    const evictionLogs = logs.filter(([, m]) => /evict/i.test(m))
    assert.ok(evictionLogs.length >= 1,
      `an eviction must be logged (SPEC §9.6), got ${JSON.stringify(logs.slice(-4))}`)
    if (!kept) {
      assert.equal(store.modeFor('A').mode, parsed.default,
        'an evicted session must resolve to `default` (that is the truthful modeSource: "default")')
    }
  })
})

test('persisted v2 file round-trips per-session choices and stays valid under concurrency', { skip: pending || missing }, async () => {
  await withStore({ version: 2, default: 'always', sessions: {} }, async ({ store, file, dir }) => {
    await store.read()
    const ops = []
    for (let i = 0; i < 80; i++) {
      ops.push(store.setMode(i % 2 ? 'always' : 'idle-only', `s${i % 5}`))
      ops.push(store.setMode(i % 3 ? 'always' : 'idle-only', null))
    }
    await Promise.all(ops)
    const parsed = onDisk(file)                            // throws → test fails, which is the point
    assert.equal(parsed.version, 2)
    assert.ok(parsed.sessions && typeof parsed.sessions === 'object')
    assert.deepEqual(readdirSync(dir), ['peak-hours-state.json'], `temp litter survived: ${JSON.stringify(readdirSync(dir))}`)
    // the in-memory resolution must agree with the file
    for (const id of ['s0', 's1', 's4']) {
      const fromMemory = store.modeFor(id)
      assert.equal(fromMemory.mode, parsed.sessions[id] ?? parsed.default,
        `session ${id}: memory ${fromMemory.mode} vs file ${parsed.sessions[id] ?? parsed.default}`)
    }
  })
})

test('R4/LRU discrimination: with cap 2, writing 3,1,2 leaves {1,2} — not {2,3}', { skip: pending || missing }, async () => {
  // The disputed case (host-dev vs an earlier Lead note): under LRU-by-set the least recently
  // WRITTEN session goes first, so 3,1,2 with a cap of 2 keeps {1,2}. A {2,3} result would mean
  // eviction followed `Object.keys`' numeric-ascending order instead of recency — the pre-fix bug.
  const dir = mkdtempSync(join(tmpdir(), 'peak-lru-'))
  const file = join(dir, 'peak-hours-state.json')
  try {
    const store = storeMod.createModeStore({ file, maxSessions: 2 })
    await store.read()
    for (const id of ['3', '1', '2']) await store.setMode('idle-only', id)
    const keys = Object.keys(onDisk(file).sessions).sort()
    assert.deepEqual(keys, ['1', '2'],
      `LRU-by-set must keep {'1','2'}; got ${JSON.stringify(keys)} — {'2','3'} would indicate ` +
      'numeric-ascending eviction rather than least-recently-set')
    assert.deepEqual(store.modeFor('1'), { mode: 'idle-only', source: 'session' })
    assert.deepEqual(store.modeFor('2'), { mode: 'idle-only', source: 'session' })
    assert.deepEqual(store.modeFor('3'), { mode: 'always', source: 'default' }, 'the evicted 3 falls back to default')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('R4/LRU: with cap 2, writing 1,2,3 leaves {2,3} (both policies agree here)', { skip: pending || missing }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-lru2-'))
  const file = join(dir, 'peak-hours-state.json')
  try {
    const store = storeMod.createModeStore({ file, maxSessions: 2 })
    await store.read()
    for (const id of ['1', '2', '3']) await store.setMode('idle-only', id)
    assert.deepEqual(Object.keys(onDisk(file).sessions).sort(), ['2', '3'])
    assert.deepEqual(store.modeFor('1'), { mode: 'always', source: 'default' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('R6 / reserved ids: long and reserved session ids are refused, never silently stored', { skip: pending || missing }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-ids-'))
  const file = join(dir, 'peak-hours-state.json')
  try {
    const store = storeMod.createModeStore({ file, logger: { info() {}, warn() {} } })
    await store.read()
    const atCap = 'a'.repeat(128)
    const overCap = 'a'.repeat(129)
    let threwAtCap = false
    try { await store.setMode('idle-only', atCap) } catch { threwAtCap = true }
    const sessionsOf = () => onDisk(file).sessions ?? {}
    console.log(`[observation] R6: 128-char id ${threwAtCap || !Object.hasOwn(sessionsOf(), atCap) ? 'refused' : 'accepted'}`)
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      let threw = false
      try { await store.setMode('idle-only', id) } catch { threw = true }
      assert.ok(threw || !Object.hasOwn(sessionsOf(), id), `${id} must not be persisted`)
      assert.equal(store.modeFor(id).source, 'default', `${id} must not resolve as a session`)
    }
    let threwOver = false
    try { await store.setMode('idle-only', overCap) } catch { threwOver = true }
    assert.ok(threwOver || !Object.hasOwn(sessionsOf(), overCap), 'a 129-char id must be refused, not silently stored')
    assert.equal(Object.getPrototypeOf(sessionsOf()), Object.prototype, 'the file stays a plain JSON object')
    assert.equal({}.polluted, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------------------
// Acceptance-review cases: R5 (`__proto__`), B4 (`+` in a session id), R4 (real UUID shape)
// Session-id shape sampled by the Lead on this machine: 129 session directories, 100% UUID
// (36 chars, ^[0-9a-f]{8}-[0-9a-f]{4}-…), zero numeric-only ids, zero ids with `+`/space.
// ---------------------------------------------------------------------------------------
const REAL_SHAPE = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'   // 36-char UUID, the real shape

test('R5: a __proto__ session id must never be accepted-but-silently-lost', { skip: pending || missing }, async () => {
  await withStore({ version: 2, default: 'always', sessions: {} }, async ({ store, file }) => {
    await store.read()
    let threw = null
    try { await store.setMode('idle-only', '__proto__') } catch (error) { threw = error }
    const parsed = onDisk(file)
    const sessions = parsed.sessions ?? {}
    const persisted = Object.hasOwn(sessions, '__proto__')
    const resolved = store.modeFor('__proto__')

    if (threw) {
      assert.equal(resolved.source, 'default', 'a refused id must not resolve as a session')
      console.log(`[observation] R5: __proto__ was refused (${threw.message}) — acceptable`)
    } else if (resolved.source === 'session') {
      // the dangerous case: we REPORT a session override
      assert.ok(persisted,
        'R5 FAILURE: modeFor("__proto__") reports source "session" but the file has no such entry — ' +
        'the write was silently swallowed while the API reported success (200-with-no-write)')
      assert.equal(sessions['__proto__'], 'idle-only')
    } else {
      console.log('[observation] R5: __proto__ write was ignored (modeFor → default) — not silent ' +
        'corruption, but a caller asking for a session and getting default deserves a 4xx; see EVIDENCE §7')
    }
    // no prototype pollution either way
    assert.equal(Object.getPrototypeOf(sessions), Object.prototype, 'sessions must stay a plain object')
    assert.equal({}.polluted, undefined)
  })
})

test('B4: a `+` in a session id must not collide with a space, and UUID ids are unaffected', { skip: pending || missing }, async () => {
  await withStore({ version: 2, default: 'always', sessions: {} }, async ({ store, file }) => {
    await store.read()
    await store.setMode('idle-only', 'a+b')
    await store.setMode('always', 'a b')
    assert.deepEqual(store.modeFor('a+b'), { mode: 'idle-only', source: 'session' }, '`a+b` keeps its own choice')
    assert.deepEqual(store.modeFor('a b'), { mode: 'always', source: 'session' }, '`a b` is a different session')
    const sessions = onDisk(file).sessions
    assert.equal(Object.keys(sessions).length, 2, `the two ids must not collapse into one: ${JSON.stringify(sessions)}`)
    // the real shape is unaffected
    await store.setMode('idle-only', REAL_SHAPE)
    assert.deepEqual(store.modeFor(REAL_SHAPE), { mode: 'idle-only', source: 'session' })
    assert.equal(Object.keys(onDisk(file).sessions).length, 3)
  })
})

test('R4: with the real UUID id shape, eviction still removes the least-recently-SET session', { skip: pending || missing }, async () => {
  // `Object.keys` sorts integer-like keys numerically ahead of string keys, so an id scheme with
  // numeric ids could break insertion-order eviction. Real ids are UUIDs (sampled: 129/129), which
  // are not integer-like — this pins that the LRU-by-set order holds for the real shape.
  const uuids = Array.from({ length: 4 }, (_, i) =>
    `00000000-0000-4000-8000-00000000000${i}`)
  await withStore({ version: 2, default: 'always', sessions: {} }, async ({ store, file }) => {
    await store.read()
    for (const id of uuids) await store.setMode('idle-only', id)
    await store.setMode('always', uuids[0])            // refresh the first one → it must move to the back
    let keys = Object.keys(onDisk(file).sessions)
    assert.deepEqual(keys, [...uuids.slice(1), uuids[0]],
      `UUID keys must keep insertion order with the refreshed entry last: ${JSON.stringify(keys)}`)
    await store.setMode('always', 'ffffffff-ffff-4fff-8fff-ffffffffffff')
    keys = Object.keys(onDisk(file).sessions)
    assert.deepEqual(keys, [...uuids.slice(1), uuids[0], 'ffffffff-ffff-4fff-8fff-ffffffffffff'],
      'a genuinely newer session must go last, after the refreshed one')
  })
})
