/**
 * Per-session mode persistence (SPEC §9.1): v2 schema, v1 migration, corrupt
 * fallback (never throws, logs once), atomic serialized writes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_MODE,
  MAX_SESSIONS,
  MAX_SESSION_ID_LENGTH,
  RESERVED_SESSION_IDS,
  STATE_FILE_NAME,
  STATE_VERSION,
  createModeStore,
  isMode,
  normalizeSessionId,
  normalizeState,
  resolveDshHome,
  resolveStatePath,
  sanitizeSessionId,
} from '../../lib/host/store.js'
import { createMemoryFs } from './helpers.mjs'

const FILE = 'C:\\dsh-home\\peak-hours-state.json'

/**
 * The snapshot's session table is deliberately prototype-less (R5), so spread
 * it before comparing against an object literal.
 */
const sessionsOf = (store) => ({ ...store.snapshot().sessions })

/** A logger double counting calls per level. */
function countingLogger() {
  const counts = { info: 0, warn: 0, error: 0 }
  const messages = []
  return {
    counts,
    messages,
    logger: {
      info: (...args) => {
        counts.info += 1
        messages.push(['info', ...args])
      },
      warn: (...args) => {
        counts.warn += 1
        messages.push(['warn', ...args])
      },
      error: (...args) => {
        counts.error += 1
        messages.push(['error', ...args])
      },
    },
  }
}

test('a missing file defaults to the v2 empty state, logs once and never throws', async () => {
  const { logger, counts } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs() })
  const state = await store.read()
  assert.equal(state.version, STATE_VERSION)
  assert.deepEqual(store.snapshot().version, STATE_VERSION); assert.equal(store.snapshot().default, 'always'); assert.deepEqual(sessionsOf(store), {})
  assert.equal(await store.read(), state, 'a second read serves the cache')
  assert.equal(counts.warn, 0, 'a first run is not a warning')
  assert.equal(counts.info, 1, 'the fallback is announced exactly once')
  assert.equal(store.defaultMode, 'always')
})

test('a corrupt file falls back to the v2 empty state and warns exactly once', async () => {
  const { logger, counts, messages } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: '{ this is not json' }) })
  await store.read()
  assert.deepEqual(store.snapshot().version, STATE_VERSION); assert.equal(store.snapshot().default, 'always'); assert.deepEqual(sessionsOf(store), {})
  await store.read()
  assert.equal(counts.warn, 1, 'corruption is reported once, not per read')
  assert.match(messages[0][1], /corrupt/)
})

test('an unrecognized mode value falls back and warns once', async () => {
  const { logger, counts } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: JSON.stringify({ mode: 'often' }) }) })
  assert.equal((await store.read()).default, 'always')
  await store.read()
  assert.equal(counts.warn, 1)
})

test('a v2 file with a bad default degrades but keeps usable session overrides', async () => {
  const { logger, counts } = countingLogger()
  const file = JSON.stringify({ version: 2, default: 'sometimes', sessions: { a: 'idle-only', b: 'nonsense' } })
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: file }) })
  await store.read()
  assert.equal(store.defaultMode, 'always')
  assert.deepEqual(sessionsOf(store), { a: 'idle-only' }, 'only recognized overrides survive')
  assert.equal(counts.warn, 1)
})

test('an unreadable file (non-ENOENT) falls back and warns once', async () => {
  const { logger, counts } = countingLogger()
  const fs = {
    readFile: async () => {
      const error = new Error('EACCES: permission denied')
      error.code = 'EACCES'
      throw error
    },
  }
  const store = createModeStore({ file: FILE, logger, fs })
  assert.equal((await store.read()).default, 'always')
  await store.read()
  assert.equal(counts.warn, 1)
})

test('a v1 file migrates to v2: mode becomes default, sessions empty, one log, upgrade written back', async () => {
  const { logger, counts, messages } = countingLogger()
  const fs = createMemoryFs({ [FILE]: JSON.stringify({ mode: 'idle-only' }) })
  const store = createModeStore({ file: FILE, logger, fs })
  await store.read()
  assert.deepEqual(store.snapshot().version, STATE_VERSION); assert.equal(store.snapshot().default, 'idle-only'); assert.deepEqual(sessionsOf(store), {})
  assert.equal(counts.info, 1, 'the migration is announced once')
  assert.equal(counts.warn, 0)
  assert.match(messages[0][1], /v1/)
  const persisted = JSON.parse(fs.files.get(FILE))
  assert.deepEqual(persisted, { version: 2, default: 'idle-only', sessions: {} }, 'the upgrade is persisted')
})

test('a v2 file round-trips unchanged', async () => {
  const { logger, counts } = countingLogger()
  const file = JSON.stringify({ version: 2, default: 'idle-only', sessions: { 'session-a': 'always' } })
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: file }) })
  await store.read()
  assert.equal(store.snapshot().version, 2); assert.equal(store.snapshot().default, 'idle-only'); assert.deepEqual(sessionsOf(store), { 'session-a': 'always' })
  assert.equal(counts.warn + counts.info, 0, 'a healthy file is silent')
})

test('modeFor resolves sessions[id] then default', async () => {
  const { logger } = countingLogger()
  const file = JSON.stringify({ version: 2, default: 'idle-only', sessions: { a: 'always', ' session-b ': 'always' } })
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: file }) })
  await store.read()
  assert.deepEqual(store.modeFor('a'), { mode: 'always', source: 'session' })
  assert.deepEqual(store.modeFor('session-b'), { mode: 'always', source: 'session' }, 'ids are trimmed')
  assert.deepEqual(store.modeFor('unknown'), { mode: 'idle-only', source: 'default' })
  assert.deepEqual(store.modeFor(undefined), { mode: 'idle-only', source: 'default' }, 'an unresolvable id uses default')
  assert.deepEqual(store.modeFor(''), { mode: 'idle-only', source: 'default' })
  assert.deepEqual(store.modeFor(null), { mode: 'idle-only', source: 'default' })
  assert.equal(store.defaultMode, 'idle-only')
})

test('setMode writes the default or one session override, and is visible immediately', async () => {
  const { logger } = countingLogger()
  const fs = createMemoryFs()
  const store = createModeStore({ file: FILE, logger, fs })
  await store.read()

  await store.setMode('idle-only')
  assert.equal(store.defaultMode, 'idle-only', 'the default changed synchronously')
  assert.deepEqual(store.modeFor('a'), { mode: 'idle-only', source: 'default' })

  await store.setMode('always', 'session-a')
  assert.deepEqual(store.modeFor('session-a'), { mode: 'always', source: 'session' })
  assert.equal(store.defaultMode, 'idle-only', 'a session write leaves the default alone')

  const persisted = JSON.parse(fs.files.get(FILE))
  assert.deepEqual(persisted, { version: 2, default: 'idle-only', sessions: { 'session-a': 'always' } })
  assert.equal(fs.files.has(`${FILE}.tmp`), false, 'no shared temp path is used')

  assert.equal(await store.setMode('sometimes', 'session-a'), false)
  assert.equal(store.modeFor('session-a').mode, 'always', 'an invalid mode changes nothing')
})

test('clearSession drops an override so the session follows the default again', async () => {
  const { logger } = countingLogger()
  const fs = createMemoryFs()
  const store = createModeStore({ file: FILE, logger, fs })
  await store.read()
  await store.setMode('idle-only')
  await store.setMode('always', 'a')
  assert.equal(store.modeFor('a').source, 'session')

  assert.equal(await store.clearSession('a'), true)
  assert.deepEqual(store.modeFor('a'), { mode: 'idle-only', source: 'default' })
  assert.deepEqual(JSON.parse(fs.files.get(FILE)).sessions, {})
  assert.equal(await store.clearSession(''), false, 'a blank id is not a session')
})

test('the session table is capped and evicts the oldest overrides', async () => {
  const { logger } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs(), maxSessions: 2 })
  await store.read()
  await store.setMode('always', 'a')
  await store.setMode('always', 'b')
  await store.setMode('always', 'c')
  const sessions = store.snapshot().sessions
  assert.deepEqual(Object.keys(sessions), ['b', 'c'], 'the oldest entry is evicted')
})

test('rapid concurrent writes serialize: no corruption, last write wins, no temp litter', async () => {
  const { logger } = countingLogger()
  const fs = createMemoryFs({}, { latencyMs: 1 })
  const store = createModeStore({ file: FILE, logger, fs })
  await store.read()

  const modes = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 'idle-only' : 'always'))
  const results = await Promise.all(modes.map((mode) => store.setMode(mode, 'session-a')))
  assert.deepEqual(results, modes.map(() => true), 'every queued write lands')
  assert.equal(JSON.parse(fs.files.get(FILE)).sessions['session-a'], modes.at(-1))
  assert.equal(store.modeFor('session-a').mode, modes.at(-1))
  assert.deepEqual(
    [...fs.files.keys()].filter((key) => key.endsWith('.tmp')),
    [],
    'no temporary file is left behind',
  )
})

test('rapid per-session toggles against the real filesystem never corrupt the state file', async () => {
  const { logger, counts } = countingLogger()
  const home = await mkdtemp(join(tmpdir(), 'peak-hours-store-'))
  const file = join(home, STATE_FILE_NAME)
  try {
    const store = createModeStore({ file, logger })
    await store.read()
    const modes = Array.from({ length: 25 }, (_, index) => (index % 2 === 0 ? 'idle-only' : 'always'))
    await Promise.all(modes.map((mode, index) => store.setMode(mode, `session-${index % 3}`)))
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(parsed.version, 2)
    assert.equal(parsed.sessions['session-0'], modes[modes.length - 3])
    assert.deepEqual(
      (await readdir(home)).filter((name) => name.endsWith('.tmp')),
      [],
    )
    assert.equal(counts.warn, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a failing write is contained: the mode still changes in memory', async () => {
  const { logger, counts } = countingLogger()
  const fs = {
    readFile: async () => {
      const error = new Error('ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    mkdir: async () => {},
    writeFile: async () => {
      throw new Error('disk full')
    },
    rename: async () => {},
    rm: async () => {},
  }
  const store = createModeStore({ file: FILE, logger, fs })
  await store.read()
  assert.equal(await store.setMode('idle-only', 'a'), false)
  assert.equal(store.modeFor('a').mode, 'idle-only')
  assert.equal(counts.warn, 1)
})

test('a store without a logger still never throws', async () => {
  const store = createModeStore({ file: FILE, fs: createMemoryFs({ [FILE]: 'garbage' }) })
  assert.equal((await store.read()).default, 'always')
  assert.equal(await store.setMode('always'), true)
})

test('normalizeState covers v1, v2, and junk', () => {
  const v1 = normalizeState({ mode: 'always' })
  assert.equal(v1.migrated, true)
  assert.equal(v1.degraded, false)
  assert.equal(v1.note, 'v1 mode "always" migrated to default')
  assert.equal(v1.state.version, 2)
  assert.equal(v1.state.default, 'always')
  assert.deepEqual([...v1.state.sessions], [])

  const v2 = normalizeState({ version: 2, default: 'idle-only', sessions: { a: 'always' } })
  assert.equal(v2.migrated, false)
  assert.equal(v2.degraded, false)
  assert.deepEqual([...v2.state.sessions], [['a', 'always']])

  assert.equal(normalizeState(null).degraded, true)
  assert.equal(normalizeState([1, 2]).degraded, true)
  assert.equal(normalizeState({}).degraded, true)
  assert.equal(normalizeState({ hello: 'world' }).degraded, true)
})

test('normalizeSessionId trims and rejects non-sessions', () => {
  assert.equal(normalizeSessionId('abc'), 'abc')
  assert.equal(normalizeSessionId('  abc  '), 'abc')
  assert.equal(normalizeSessionId(''), null)
  assert.equal(normalizeSessionId('   '), null)
  assert.equal(normalizeSessionId(null), null)
  assert.equal(normalizeSessionId(undefined), null)
  assert.equal(normalizeSessionId(42), null)
  assert.equal(normalizeSessionId({}), null)
})

test('DSH_HOME resolution follows the SPEC', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\custom' }, 'C:\\Users\\x'), 'C:\\custom')
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }, 'C:\\Users\\x'), 'C:\\Users\\x\\.dsh')
  assert.equal(resolveDshHome({}, 'C:\\Users\\x'), 'C:\\Users\\x\\.dsh')
  assert.equal(resolveStatePath({ env: {}, home: 'C:\\Users\\x' }).endsWith(STATE_FILE_NAME), true)
  assert.equal(resolveStatePath({ env: { DSH_HOME: 'C:\\custom' }, home: 'C:\\Users\\x' }), `C:\\custom\\${STATE_FILE_NAME}`)
  assert.equal(DEFAULT_MODE, 'always')
})

test('isMode accepts only the two literals', () => {
  assert.equal(isMode('always'), true)
  assert.equal(isMode('idle-only'), true)
  assert.equal(isMode('ALWAYS'), false)
  assert.equal(isMode(undefined), false)
  assert.equal(isMode(null), false)
  assert.equal(isMode(1), false)
})

// ── R4: eviction follows the real write order (SPEC §9.6 LRU-by-set) ─────────

test('the cap evicts the least recently written session, not the smallest numeric id', async () => {
  const { logger } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs(), maxSessions: 2 })
  await store.read()
  // Integer-like ids are the trap: a plain object enumerates them ascending, so
  // `Object.keys(sessions)[0]` would drop '1' — the *most recently* written here.
  await store.setMode('always', '3')
  await store.setMode('always', '1')
  await store.setMode('always', '2')
  assert.deepEqual(Object.keys(sessionsOf(store)), ['1', '2'], 'the least recently written id (3) is the one evicted')
  assert.equal(store.modeFor('3').source, 'default', 'the evicted session falls back to the default')
  assert.equal(store.modeFor('2').source, 'session')
})

test('an ascending write order is unaffected', async () => {
  const { logger } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs(), maxSessions: 2 })
  await store.read()
  await store.setMode('always', '1')
  await store.setMode('always', '2')
  await store.setMode('always', '3')
  assert.deepEqual(Object.keys(sessionsOf(store)), ['2', '3'])
})

test('re-writing a session refreshes its recency', async () => {
  const { logger } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs(), maxSessions: 2 })
  await store.read()
  await store.setMode('always', 'a')
  await store.setMode('always', 'b')
  await store.setMode('idle-only', 'a') // touch: 'b' is now the least recent
  await store.setMode('always', 'c')
  assert.deepEqual(Object.keys(sessionsOf(store)), ['a', 'c'])
})

test('every eviction is logged once, and the cap defaults to 500', async () => {
  const { logger, messages } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs(), maxSessions: 1 })
  await store.read()
  await store.setMode('always', 'first')
  await store.setMode('always', 'second')
  await store.setMode('always', 'third')
  const evictions = messages.filter(([, message]) => String(message).includes('evicted'))
  assert.equal(evictions.length, 2, 'one line per evicted session')
  assert.match(evictions[0][1], /capped at 1/)
  assert.equal(MAX_SESSIONS, 500)
})

// ── R5: reserved ids and prototype safety ───────────────────────────────────

test('reserved session ids are refused instead of silently dropped', async () => {
  const { logger } = countingLogger()
  const fs = createMemoryFs()
  const store = createModeStore({ file: FILE, logger, fs })
  await store.read()
  for (const id of RESERVED_SESSION_IDS) {
    assert.equal(await store.setMode('always', id), false, `${id} must be refused`)
    assert.equal(store.modeFor(id).source, 'default')
  }
  assert.deepEqual(sessionsOf(store), {})
  assert.equal(fs.files.size, 0, 'nothing was written for a refused id')
  for (const id of RESERVED_SESSION_IDS) {
    const { id: parsed, error } = sanitizeSessionId(id)
    assert.equal(parsed, null)
    assert.match(error, /reserved/)
  }
})

test('the session table can never pollute Object.prototype', async () => {
  const { logger } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs() })
  await store.read()
  await store.setMode('always', 'ok')
  assert.equal(Object.getPrototypeOf(store.snapshot().sessions), null, 'the table is prototype-less')
  await store.setMode('always', '__proto__')
  assert.equal({}.mode, undefined, 'Object.prototype is untouched')
  assert.equal({}.polluted, undefined)
  assert.equal(Object.getPrototypeOf(store.snapshot().sessions), null)
})

test('a poisoned file cannot smuggle a reserved key into the table', async () => {
  const { logger } = countingLogger()
  const file = '{"version":2,"default":"always","sessions":{"__proto__":"idle-only","ok":"idle-only"}}'
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: file }) })
  await store.read()
  assert.deepEqual(Object.keys(sessionsOf(store)), ['ok'], 'the reserved key is dropped on load')
  assert.equal(Object.getPrototypeOf(store.snapshot().sessions), null)
})

// ── R6 / SEC-7: id length ───────────────────────────────────────────────────

test('session ids are capped at 128 characters, on write and on load', async () => {
  const { logger } = countingLogger()
  const fs = createMemoryFs()
  const store = createModeStore({ file: FILE, logger, fs })
  await store.read()
  const tooLong = 'x'.repeat(MAX_SESSION_ID_LENGTH + 1)
  const exact = 'y'.repeat(MAX_SESSION_ID_LENGTH)
  assert.equal(await store.setMode('always', tooLong), false, 'an over-long id is refused')
  assert.equal(await store.setMode('always', exact), true, 'the boundary itself is accepted')
  assert.deepEqual(Object.keys(sessionsOf(store)), [exact])

  const file = JSON.stringify({ version: 2, default: 'always', sessions: { [tooLong]: 'idle-only', short: 'idle-only' } })
  const reopened = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: file }) })
  await reopened.read()
  assert.deepEqual(Object.keys(sessionsOf(reopened)), ['short'], 'an over-long id is dropped while loading')
  assert.equal(MAX_SESSION_ID_LENGTH, 128)
})
