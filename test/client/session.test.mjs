/**
 * Per-session tests (SPEC 9.3/9.4).
 *
 * The user's defect: switching 「全天运行」 in one conversation changed every
 * conversation. The run window is now per session, resolved by the host and
 * reported per session; these tests pin the client's half of that contract —
 * which session a request speaks for, where the resolved mode comes from, and
 * that a session-less occupant does nothing at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundleExports } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { sessionIdOf, describePopover, describeBanner, stateUrl, modeTarget, translate, DICTS, API_STATE } = internals

const IDLE_ONLY = 'idle-only'
const ALWAYS = 'always'

const SESSION = 'session-abc'
const OTHER = 'session-xyz'
const CLOCK = Date.UTC(2026, 9, 12, 2, 0, 0) // 2026-10-12 10:00:00 Beijing

/** A SPEC 9.3 per-session envelope payload. */
function state(overrides = {}) {
  return {
    mode: 'idle-only',
    phase: 'peak',
    reason: 'peak',
    now: CLOCK,
    nowText: '2026-10-12 10:00:00',
    nextTransitionAt: CLOCK + 7_200_000,
    nextTransitionText: '2026-10-12 12:00:00',
    nextPhase: 'idle',
    msUntilTransition: 7_200_000,
    paused: true,
    waitingTasks: 2,
    waitingTasksTotal: 7,
    holidayToday: null,
    holidayCoverage: 'known',
    unknownHolidayYear: null,
    timeZone: 'Asia/Shanghai (UTC+8)',
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    clockOverride: null,
    config: { allowClockOverride: true },
    sessionId: SESSION,
    modeSource: 'session',
    defaultMode: 'always',
    ...overrides,
  }
}

const snap = (value, error = null) => ({ state: value, fetchedAtMs: 1000, error })
const modelFor = (value) => describePopover(snap(value), 1000)

test('9.4: the session id is read from the slot props; blank ids count as none', () => {
  assert.equal(sessionIdOf({ sessionId: SESSION }), SESSION)
  // The host rejects a blank or whitespace `session` with 400, so such a value
  // must never reach a URL or a body — it means "no session" here.
  assert.equal(sessionIdOf({ sessionId: '' }), null)
  assert.equal(sessionIdOf({ sessionId: '   ' }), null)
  assert.equal(sessionIdOf({ sessionId: '\t\n' }), null)
  assert.equal(sessionIdOf({ sessionId: '  ' + SESSION + '  ' }), SESSION, 'a padded real id is trimmed, not dropped')
  assert.equal(sessionIdOf({ sessionId: 42 }), null)
  assert.equal(sessionIdOf({ sessionId: null }), null)
  assert.equal(sessionIdOf({}), null)
  assert.equal(sessionIdOf(undefined), null)
})

test('9.3: reads name the session; writes name the session or the default', () => {
  assert.equal(stateUrl(SESSION), `${API_STATE}?session=${SESSION}`)
  assert.notEqual(stateUrl(SESSION), stateUrl(OTHER), 'two sessions must never share a read URL')
  assert.deepEqual({ ...modeTarget('session', SESSION) }, { scope: 'session', session: SESSION })
  assert.deepEqual({ ...modeTarget('default', SESSION) }, { scope: 'default', session: null })
})

/**
 * R8 follow-up: the polling URL must keep the session. Without it the host
 * answers about the DEFAULT mode, so the pill would show the wrong window and
 * the banner would count some other session's queue.
 */
test('9.3: the poll URL always carries ?session=, for every session shape', () => {
  for (const id of [SESSION, OTHER, 'a b', 'x/y?z', '0', '会话-1']) {
    const url = stateUrl(id)
    assert.equal(url.startsWith(`${API_STATE}?session=`), true, url)
    assert.equal(url.slice(`${API_STATE}?session=`.length), encodeURIComponent(id))
    assert.notEqual(url, API_STATE, 'a bare state URL reports the default mode')
  }
  assert.equal(stateUrl(SESSION).includes('?session='), true)
})

test('9.3: the model reports this session\'s resolved mode and where it came from', () => {
  const model = modelFor(state())
  assert.equal(model.view.mode, IDLE_ONLY)
  assert.equal(model.modeSource, 'session')
  assert.equal(model.sessionId, SESSION)
  assert.equal(model.defaultMode, ALWAYS)
  assert.equal(model.waitingTasks, 2, 'this session')
  assert.equal(model.waitingTasksTotal, 7, 'host-wide')
})

test('9.3: a mode inherited from the default is reported as such', () => {
  const model = modelFor(state({ modeSource: 'default', mode: 'always', paused: false, waitingTasks: 0 }))
  assert.equal(model.modeSource, 'default')
  assert.equal(model.view.mode, ALWAYS)
  assert.equal(translate(DICTS, 'zh', 'source.default'), '默认值')
  assert.equal(translate(DICTS, 'zh', 'source.session'), '本会话设置')
})

test('9.3/9.4: an envelope without the v2 fields is an OLD host → read-only', () => {
  for (const overrides of [{ modeSource: undefined }, { defaultMode: undefined }, { modeSource: 'global' }, { defaultMode: 'sometimes' }]) {
    const model = modelFor(state(overrides))
    assert.equal(model.incompatible, true, `${JSON.stringify(overrides)} must read as an old host`)
    assert.equal(model.view.available, false)
    assert.equal(model.view.status, 'unavailable')
    assert.equal(model.view.incompatible, true)
    assert.equal(model.modeSource, null, 'an old host has no per-session source to report')
    assert.equal(model.defaultMode, null)
    assert.equal(model.waitingTasksTotal, null)
    assert.equal(translate(DICTS, 'zh', 'version.mismatch'), '时段不可用（宿主版本不匹配，请刷新页面）')
  }
})

test('9.3/9.4: a v1-shaped envelope (the pre-§9 field set) is read-only too', () => {
  const v1 = {
    mode: 'idle-only',
    phase: 'peak',
    reason: 'peak',
    now: CLOCK,
    nowText: '2026-10-12 10:00:00',
    nextTransitionAt: CLOCK + 7_200_000,
    nextTransitionText: '2026-10-12 12:00:00',
    nextPhase: 'idle',
    msUntilTransition: 7_200_000,
    paused: true,
    waitingTasks: 2,
    holidayToday: null,
    holidayCoverage: 'known',
    unknownHolidayYear: null,
    timeZone: 'Asia/Shanghai (UTC+8)',
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    clockOverride: null,
    config: { allowClockOverride: true },
  }
  const model = modelFor(v1)
  assert.equal(model.incompatible, true)
  assert.equal(model.view.mode, null, 'the v1 mode is host-wide, not this session\'s')
  assert.equal(describeBanner(model).show, false, 'the banner must not claim a window from an old host')
})

test('9.3: a missing or unusable waitingTasksTotal stays null instead of inventing zero', () => {
  assert.equal(modelFor(state({ waitingTasksTotal: null })).waitingTasksTotal, null)
  assert.equal(modelFor(state({ waitingTasksTotal: 'many' })).waitingTasksTotal, null)
  assert.equal(modelFor(state({ waitingTasksTotal: 0 })).waitingTasksTotal, 0)
  assert.equal(modelFor(state({ waitingTasks: 'lots' })).waitingTasks, 0, 'an unusable per-session count reads as none')
})

test('9.3: the envelope may name a different session; the client keeps showing its own request', () => {
  // The store is keyed by the session we asked for; the echoed id is informational.
  const model = modelFor(state({ sessionId: OTHER }))
  assert.equal(model.sessionId, OTHER)
  assert.equal(model.view.mode, IDLE_ONLY)
})

test('9.4: a session-less model has no state at all', () => {
  const model = describePopover({ state: null, fetchedAtMs: 0, error: null }, 0)
  assert.equal(model.state, null)
  assert.equal(model.modeSource, null)
  assert.equal(model.sessionId, null)
  assert.equal(model.waitingTasksTotal, null)
})

test('9.3: the unresolved-session diagnostic is surfaced only when there is something to see', () => {
  assert.equal(modelFor(state({ waitingTasksUnresolved: 3 })).waitingUnresolved, 3)
  assert.equal(modelFor(state({ waitingTasksUnresolved: 0 })).waitingUnresolved, null)
  assert.equal(modelFor(state({ waitingTasksUnresolved: -1 })).waitingUnresolved, null)
  assert.equal(modelFor(state()).waitingUnresolved, null, 'absent field ⇒ nothing to report')
  assert.equal(modelFor(state({ waitingTasksUnresolved: 'many' })).waitingUnresolved, null)
  assert.equal(
    modelFor(state({ modeSource: undefined, waitingTasksUnresolved: 3 })).waitingUnresolved,
    null,
    'a v1 host gets no per-session diagnostics at all'
  )
  assert.equal(translate(DICTS, 'zh', 'row.waitingUnresolved'), '未识别会话的任务')
})

test('9.4: both scope wordings exist and say what they affect', () => {
  const sessionNote = translate(DICTS, 'zh', 'scope.sessionNote')
  assert.match(sessionNote, /只改本会话/)
  assert.match(sessionNote, /不影响其他会话/)
  assert.equal(sessionNote.includes('{source}'), false, 'the source lives in its own row, not in this sentence')
  const setDefault = translate(DICTS, 'zh', 'scope.setDefault', { mode: '全天运行' })
  assert.match(setDefault, /所有未单独设置的会话/)
  assert.match(setDefault, /全天运行/)
  const hint = translate(DICTS, 'zh', 'scope.setDefaultHint')
  assert.match(hint, /本会话的设置保持不变/)
  // English mirrors both.
  assert.match(translate(DICTS, 'en', 'scope.sessionNote'), /THIS session only/)
  assert.match(translate(DICTS, 'en', 'scope.setDefault', { mode: 'Always on' }), /sessions that never chose/)
})

test('9.4: the two scope labels are distinguishable and neither implies a global switch', () => {
  const sessionText = translate(DICTS, 'zh', 'scope.sessionNote')
  const defaultText = translate(DICTS, 'zh', 'scope.setDefault', { mode: translate(DICTS, 'zh', 'option.always') })
  assert.notEqual(sessionText, defaultText)
  assert.equal(/所有会话的默认|全部会话的默认/.test(sessionText), false, 'a session write must not read as global')
  assert.equal(/所有未单独设置的会话/.test(defaultText), true)
})

test('9.4: the default badge copy exists in both languages and is not a mode name', () => {
  assert.equal(translate(DICTS, 'zh', 'option.defaultBadge'), '（默认）')
  assert.equal(translate(DICTS, 'en', 'option.defaultBadge'), '(default)')
  assert.equal(translate(DICTS, 'zh', 'option.follow'), 'option.follow', 'the removed option key must not resurrect')
})
