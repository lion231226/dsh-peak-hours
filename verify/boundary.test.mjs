// verify/boundary.test.mjs — verifier-owned boundary matrix at 1 s resolution + transition
// instants. Every expectation below is hand-written (verifier-authored), then ALSO cross-checked
// against the independent candidate-set oracle in ./lib/oracle.mjs; the implementation is never
// used to produce an expectation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bjEpoch, classifyOracle, nextTransitionOracle, diffClassify } from './lib/oracle.mjs'

let core = null, loadErr = null
try { core = await import('../lib/core/index.js') } catch (e) { loadErr = e }
const missing = core ? false : `lib/core/index.js unavailable: ${loadErr?.message}`

const TIMES = ['08:59:59', '09:00:00', '11:59:59', '12:00:00', '13:59:59', '14:00:00', '17:59:59', '18:00:00']
const OFF = {
  '08:59:59': ['idle', 'off-hours'], '09:00:00': ['peak', 'peak'],
  '11:59:59': ['peak', 'peak'], '12:00:00': ['idle', 'off-hours'],
  '13:59:59': ['idle', 'off-hours'], '14:00:00': ['peak', 'peak'],
  '17:59:59': ['peak', 'peak'], '18:00:00': ['idle', 'off-hours'],
}
const ALL_IDLE = (reason) => Object.fromEntries(TIMES.map((t) => [t, ['idle', reason]]))

// Hand-authored expectation table (no code derives these).
const MATRIX = [
  { label: '(a) ordinary Wednesday', dateKey: '2026-10-14', expect: OFF },
  { label: '(b) ordinary Saturday', dateKey: '2026-10-17', expect: ALL_IDLE('weekend') },
  { label: '(c) ordinary Sunday', dateKey: '2026-10-18', expect: ALL_IDLE('weekend') },
  { label: '(d) statutory holiday Tuesday (2026 国庆)', dateKey: '2026-10-06', expect: ALL_IDLE('holiday') },
  { label: '(e) 2026-10-10 make-up workday Saturday', dateKey: '2026-10-10', expect: ALL_IDLE('weekend') },
  // extra rows the verifier added for the same matrix shape
  { label: '(f) holiday Wednesday (2026-10-07, 国庆最後一天)', dateKey: '2026-10-07', expect: ALL_IDLE('holiday') },
  { label: '(g) 2026-01-04 make-up workday Sunday', dateKey: '2026-01-04', expect: ALL_IDLE('weekend') },
  { label: '(h) 2026-02-14 make-up workday Saturday', dateKey: '2026-02-14', expect: ALL_IDLE('weekend') },
  { label: '(i) holiday Friday (2026-01-02, 元旦调休)', dateKey: '2026-01-02', expect: ALL_IDLE('holiday') },
  { label: '(j) ordinary Thursday after 2025 国庆 (2025-10-09)', dateKey: '2025-10-09', expect: OFF },
  { label: '(k) 2025-10-11 make-up workday Saturday', dateKey: '2025-10-11', expect: ALL_IDLE('weekend') },
  { label: '(l) ordinary Friday before the weekend (2026-10-16)', dateKey: '2026-10-16', expect: OFF },
]

const at = (dateKey, time) => {
  const [y, mo, da] = dateKey.split('-').map(Number)
  const [h, mi, s] = time.split(':').map(Number)
  return bjEpoch(y, mo, da, h, mi, s)
}

test('subject module present (lib/core/index.js)', () => {
  assert.ok(core, missing)
})

// Runs even before the implementation exists: proves the hand table and the independent oracle
// agree, so a later mismatch can only come from the implementation.
test('self-check: hand-authored table agrees with the independent oracle', () => {
  for (const row of MATRIX) {
    for (const t of TIMES) {
      const o = classifyOracle(at(row.dateKey, t))
      assert.deepEqual([o.phase, o.reason], row.expect[t],
        `hand table wrong or oracle wrong at ${row.dateKey} ${t}`)
    }
  }
  for (const [label, from, wantAt, wantTo] of TRANSITIONS) {
    const t = bjEpoch(...from)
    const o = nextTransitionOracle(t)
    assert.equal(o?.at, bjEpoch(...wantAt), `hand transition wrong or oracle wrong for "${label}"`)
    assert.equal(o?.to, wantTo, `hand transition wrong or oracle wrong for "${label}"`)
  }
})

for (const row of MATRIX) {
  test(`boundary matrix ${row.label} [${row.dateKey}]`, { skip: missing }, () => {
    for (const t of TIMES) {
      const epoch = at(row.dateKey, t)
      const [wantPhase, wantReason] = row.expect[t]
      // independent sanity check of the hand table itself
      const o = classifyOracle(epoch)
      assert.deepEqual([o.phase, o.reason], [wantPhase, wantReason],
        `HAND TABLE/ORACLE DISAGREEMENT at ${row.dateKey} ${t} — fix the test`)
      const got = core.classify(epoch)
      assert.deepEqual([got.phase, got.reason], [wantPhase, wantReason],
        `${row.dateKey} ${t}: ${JSON.stringify({ got: [got.phase, got.reason], want: [wantPhase, wantReason] })}`)
      assert.equal(got.dateKey, row.dateKey)
      assert.equal(got.weekday, o.weekday)
      assert.equal(got.minuteOfDay, o.minuteOfDay)
      assert.equal(got.holidayCoverage, 'known')
      assert.equal(got.unknownHolidayYear, null)
      // holiday object present exactly on 'holiday' days
      if (wantReason === 'holiday') {
        assert.ok(got.holiday && got.holiday.dateKey === row.dateKey && got.holiday.name.length > 0,
          `${row.dateKey} ${t}: holiday object expected, got ${JSON.stringify(got.holiday)}`)
      } else {
        assert.equal(got.holiday ?? null, null, `${row.dateKey} ${t}: holiday must be null`)
      }
      // isPeak must agree with classify
      assert.equal(core.isPeak(epoch), wantPhase === 'peak', `isPeak(${row.dateKey} ${t})`)
    }
  })
}

// ---------------------------------------------------------------------------------------
// Transition instants — hand-computed, then cross-checked with the oracle.
// ---------------------------------------------------------------------------------------
const TRANSITIONS = [
  ['during morning peak → lunch break', [2026, 10, 14, 9, 30, 0], [2026, 10, 14, 12, 0, 0], 'idle'],
  ['1 s before lunch break', [2026, 10, 14, 11, 59, 59], [2026, 10, 14, 12, 0, 0], 'idle'],
  ['start of lunch break → afternoon peak', [2026, 10, 14, 12, 0, 0], [2026, 10, 14, 14, 0, 0], 'peak'],
  ['1 s before afternoon peak', [2026, 10, 14, 13, 59, 59], [2026, 10, 14, 14, 0, 0], 'peak'],
  ['1 s before end of workday', [2026, 10, 14, 17, 59, 59], [2026, 10, 14, 18, 0, 0], 'idle'],
  ['end of workday → next weekday 09:00', [2026, 10, 14, 18, 0, 0], [2026, 10, 15, 9, 0, 0], 'peak'],
  ['Friday 18:00 crosses the weekend', [2026, 10, 16, 18, 0, 0], [2026, 10, 19, 9, 0, 0], 'peak'],
  ['Saturday all day stays idle', [2026, 10, 17, 10, 0, 0], [2026, 10, 19, 9, 0, 0], 'peak'],
  ['Sunday evening crosses into Monday', [2026, 10, 18, 20, 0, 0], [2026, 10, 19, 9, 0, 0], 'peak'],
  ['eve of 国庆 crosses the whole holiday', [2026, 9, 30, 18, 0, 0], [2026, 10, 8, 9, 0, 0], 'peak'],
  ['inside 国庆 at a would-be peak minute', [2026, 10, 6, 9, 30, 0], [2026, 10, 8, 9, 0, 0], 'peak'],
  ['start of 国庆 09:00 is not a peak', [2026, 10, 1, 9, 0, 0], [2026, 10, 8, 9, 0, 0], 'peak'],
  ['last holiday evening', [2026, 10, 7, 18, 0, 0], [2026, 10, 8, 9, 0, 0], 'peak'],
  ['year rollover THU peak → lunch', [2026, 12, 31, 10, 0, 0], [2026, 12, 31, 12, 0, 0], 'idle'],
  ['year rollover into unknown 2027 (Fri 09:00 is peak)', [2026, 12, 31, 18, 0, 0], [2027, 1, 1, 9, 0, 0], 'peak'],
  ['2025→2026 rollover crosses 元旦 holidays', [2025, 12, 31, 18, 0, 0], [2026, 1, 5, 9, 0, 0], 'peak'],
  ['2025 春节 eve → first working day', [2025, 1, 27, 18, 0, 0], [2025, 2, 5, 9, 0, 0], 'peak'],
]

for (const [label, from, wantAt, wantTo] of TRANSITIONS) {
  test(`nextTransition: ${label}`, { skip: missing }, () => {
    const t = bjEpoch(...from)
    const exp = bjEpoch(...wantAt)
    const o = nextTransitionOracle(t)
    assert.equal(o?.at, exp, `oracle disagrees with the hand table for "${label}" — fix the test`)
    const got = core.nextTransition(t)
    assert.equal(got.at, exp,
      `${label}: got ${got.at} (${new Date(got.at + 8 * 3600e3).toISOString().slice(0, 19)}Z-bj) want ${exp}`)
    assert.equal(got.to, wantTo)
    assert.ok(got.at > t, 'at must be strictly after the input')
    assert.notEqual(core.classify(got.at - 1).phase, core.classify(got.at).phase,
      `${label}: at must land exactly on a phase change`)
  })
}

test('1 ms either side of every window edge flips the phase', { skip: missing }, () => {
  const edges = [9, 12, 14, 18].map((h) => bjEpoch(2026, 10, 14, h, 0, 0))
  for (const e of edges) {
    assert.notEqual(core.classify(e - 1).phase, core.classify(e).phase, `edge ${new Date(e + 8 * 3600e3).toISOString()}`)
  }
  assert.notEqual(core.classify(edges[0] - 1).phase, 'peak')
  assert.equal(core.classify(edges[0] - 1).reason, 'off-hours')
  assert.equal(core.classify(edges[3] - 1).reason, 'peak')
  assert.equal(core.classify(edges[3]).reason, 'off-hours')
})

test('classify tolerates a custom calendar argument', { skip: missing }, async () => {
  const { createCalendar } = await import('../lib/core/holidays.js')
  const cal = createCalendar({ extra: { '2026-10-14': '验证用假日' } })
  const t = bjEpoch(2026, 10, 14, 10, 0, 0)
  assert.equal(core.classify(t).phase, 'peak', 'default calendar: ordinary Wednesday is peak')
  const s = core.classify(t, cal)
  assert.equal(s.phase, 'idle')
  assert.equal(s.reason, 'holiday')
  assert.equal(s.holiday?.name, '验证用假日')
})
