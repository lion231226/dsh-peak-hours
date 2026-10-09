/**
 * Mode persistence (SPEC §2.4): corrupt/missing never throws, logs once, and
 * falls back to `always`; writes are atomic and equally non-throwing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_MODE, STATE_FILE_NAME, createModeStore, isMode, resolveDshHome, resolveStatePath } from '../../lib/host/store.js'
import { createMemoryFs } from './helpers.mjs'

const FILE = 'C:\\dsh-home\\peak-hours-state.json'

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

test('a missing file defaults to always, logs once and never throws', async () => {
  const { logger, counts } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs() })
  assert.equal(await store.read(), DEFAULT_MODE)
  assert.equal(await store.read(), DEFAULT_MODE)
  assert.equal(await store.read(), DEFAULT_MODE)
  assert.equal(counts.warn, 0, 'a first run is not a warning')
  assert.equal(counts.info, 1, 'the fallback is announced exactly once')
  assert.equal(store.peek(), 'always')
})

test('a corrupt file falls back to always and logs a warning exactly once', async () => {
  const { logger, counts, messages } = countingLogger()
  const fs = createMemoryFs({ [FILE]: '{ this is not json' })
  const store = createModeStore({ file: FILE, logger, fs })
  assert.equal(await store.read(), 'always')
  assert.equal(await store.read(), 'always')
  assert.equal(counts.warn, 1, 'corruption is reported once, not per read')
  assert.match(messages[0][1], /corrupt/)
})

test('an unrecognized mode value falls back to always and logs once', async () => {
  const { logger, counts } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: JSON.stringify({ mode: 'often' }) }) })
  assert.equal(await store.read(), 'always')
  assert.equal(await store.read(), 'always')
  assert.equal(counts.warn, 1)
})

test('an unreadable file (non-ENOENT) falls back to always and logs once', async () => {
  const { logger, counts } = countingLogger()
  const fs = {
    readFile: async () => {
      const error = new Error('EACCES: permission denied')
      error.code = 'EACCES'
      throw error
    },
  }
  const store = createModeStore({ file: FILE, logger, fs })
  assert.equal(await store.read(), 'always')
  assert.equal(await store.read(), 'always')
  assert.equal(counts.warn, 1)
})

test('a valid persisted mode round-trips', async () => {
  const { logger, counts } = countingLogger()
  const store = createModeStore({ file: FILE, logger, fs: createMemoryFs({ [FILE]: JSON.stringify({ mode: 'idle-only' }) }) })
  assert.equal(await store.read(), 'idle-only')
  assert.equal(store.peek(), 'idle-only')
  assert.equal(counts.warn + counts.info, 0, 'a healthy file is silent')
})

test('writes are atomic (temp + rename), readable, and reflected immediately', async () => {
  const { logger } = countingLogger()
  const fs = createMemoryFs()
  const store = createModeStore({ file: FILE, logger, fs })
  assert.equal(await store.read(), 'always')

  assert.equal(await store.write('idle-only'), true)
  assert.equal(store.peek(), 'idle-only', 'the in-memory mode is already in force')
  assert.equal(fs.files.has(`${FILE}.tmp`), false, 'the temp file is renamed away')
  const persisted = JSON.parse(fs.files.get(FILE))
  assert.equal(persisted.mode, 'idle-only')
  assert.equal(typeof persisted.updatedAt, 'string')

  // A fresh store over the same bytes reads the persisted value.
  const reopened = createModeStore({ file: FILE, logger, fs })
  assert.equal(await reopened.read(), 'idle-only')
})

test('an invalid mode is refused without touching the disk', async () => {
  const { logger } = countingLogger()
  const fs = createMemoryFs()
  const store = createModeStore({ file: FILE, logger, fs })
  assert.equal(await store.write('sometimes'), false)
  assert.equal(fs.files.size, 0)
  assert.equal(store.peek(), 'always')
})

test('rapid concurrent writes serialize: no corruption, last write wins, no temp litter', async () => {
  const { logger } = countingLogger()
  // A latency makes the write overlap real: without serialization the shared
  // temp path would truncate or publish a half-written file.
  const fs = createMemoryFs({}, { latencyMs: 1 })
  const store = createModeStore({ file: FILE, logger, fs })
  await store.read()

  const modes = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 'idle-only' : 'always'))
  const results = await Promise.all(modes.map((mode) => store.write(mode)))
  assert.deepEqual(results, modes.map(() => true), 'every queued write lands')

  const text = fs.files.get(FILE)
  assert.equal(typeof text, 'string')
  const parsed = JSON.parse(text)
  assert.equal(parsed.mode, modes.at(-1), 'the last write wins on disk')
  assert.equal(store.peek(), modes.at(-1), 'and in memory')
  assert.deepEqual(
    [...fs.files.keys()].filter((key) => key.endsWith('.tmp')),
    [],
    'no temporary file is left behind',
  )
})

test('the in-memory mode advances synchronously even while writes are queued', async () => {
  const { logger } = countingLogger()
  const fs = createMemoryFs({}, { latencyMs: 2 })
  const store = createModeStore({ file: FILE, logger, fs })
  const first = store.write('idle-only')
  assert.equal(store.peek(), 'idle-only', 'the running gate sees the new mode immediately')
  const second = store.write('always')
  assert.equal(store.peek(), 'always')
  await Promise.all([first, second])
  assert.equal(JSON.parse(fs.files.get(FILE)).mode, 'always')
  assert.equal(store.peek(), 'always')
})

test('rapid mode toggles against the real filesystem never corrupt the state file', async () => {
  const { logger, counts } = countingLogger()
  const home = await mkdtemp(join(tmpdir(), 'peak-hours-store-'))
  const file = join(home, STATE_FILE_NAME)
  try {
    const store = createModeStore({ file, logger })
    assert.equal(await store.read(), 'always')
    const modes = Array.from({ length: 25 }, (_, index) => (index % 2 === 0 ? 'idle-only' : 'always'))
    await Promise.all(modes.map((mode) => store.write(mode)))
    const raw = await readFile(file, 'utf8')
    assert.equal(JSON.parse(raw).mode, modes.at(-1))
    const leftovers = (await readdir(home)).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
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
  }
  const store = createModeStore({ file: FILE, logger, fs })
  assert.equal(await store.read(), 'always')
  assert.equal(await store.write('idle-only'), false)
  assert.equal(store.peek(), 'idle-only')
  assert.equal(counts.warn, 1)
})

test('a store without a logger still never throws', async () => {
  const store = createModeStore({ file: FILE, fs: createMemoryFs({ [FILE]: 'garbage' }) })
  assert.equal(await store.read(), 'always')
  assert.equal(await store.write('always'), true)
})

test('DSH_HOME resolution follows the SPEC', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\custom' }, 'C:\\Users\\x'), 'C:\\custom')
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }, 'C:\\Users\\x'), 'C:\\Users\\x\\.dsh')
  assert.equal(resolveDshHome({}, 'C:\\Users\\x'), 'C:\\Users\\x\\.dsh')
  assert.equal(resolveStatePath({ env: {}, home: 'C:\\Users\\x' }).endsWith(STATE_FILE_NAME), true)
  assert.equal(resolveStatePath({ env: { DSH_HOME: 'C:\\custom' }, home: 'C:\\Users\\x' }), `C:\\custom\\${STATE_FILE_NAME}`)
})

test('isMode accepts only the two literals', () => {
  assert.equal(isMode('always'), true)
  assert.equal(isMode('idle-only'), true)
  assert.equal(isMode('ALWAYS'), false)
  assert.equal(isMode(undefined), false)
  assert.equal(isMode(null), false)
  assert.equal(isMode(1), false)
})
