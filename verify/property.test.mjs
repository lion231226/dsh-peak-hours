// verify/property.test.mjs — verifier-owned property tests for lib/core/schedule.js.
//
// Three independent oracles are used, none of them derived from the implementation:
//  * candidate-set transition oracle (verify/lib/oracle.mjs) — algorithmically different from a
//    forward minute scan;
//  * the converse property "a phase change may only happen at 00:00/09:00/12:00/14:00/18:00";
//  * hand-checked phaseSegments expectations.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bjEpoch, bjParts, classifyOracle, nextTransitionOracle, phaseSegmentsOracle, diffClassify,
} from './lib/oracle.mjs'

let core = null, loadErr = null
try { core = await import('../lib/core/index.js') } catch (e) { loadErr = e }
const missing = core ? false : `lib/core/index.js unavailable: ${loadErr?.message}`

const BJ = 8 * 3600e3
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
// Phase changes may only occur at these Beijing wall-clock instants (SPEC §1 windows).
const CANDIDATE_SECONDS = new Set([0, 9 * 3600, 12 * 3600, 14 * 3600, 18 * 3600])

const RANGE_FROM = bjEpoch(2025, 1, 1)
const RANGE_TO = bjEpoch(2027, 1, 10)

function* samples() {
  // coarse but exhaustive-in-aggregate sweep of the whole 2025-01-01 .. 2027-01-10 range
  for (let t = RANGE_FROM; t < RANGE_TO; t += 97 * 60e3) yield t
  // dense 1 s sweep around every window edge on a weekday, a Saturday and a holiday
  const days = [[2026, 10, 14], [2026, 10, 17], [2026, 10, 6], [2026, 1, 2], [2025, 10, 9]]
  for (const [y, mo, da] of days) {
    for (const h of [9, 12, 14, 18]) {
      for (let s = -20 * 60; s <= 20 * 60; s++) yield bjEpoch(y, mo, da, h, 0, 0) + s * 1000
    }
  }
  // deterministic pseudo-random instants (seeded ⇒ reproducible)
  const rnd = mulberry32(20261009)
  const span = RANGE_TO - RANGE_FROM
  for (let i = 0; i < 8000; i++) yield RANGE_FROM + Math.floor(rnd() * span)
}

test('subject module present (lib/core/index.js)', () => {
  assert.ok(core, missing)
})

test('snapshot: boundary sweep over 2025, 2026, 2027', { skip: missing }, () => {
  let n = 0
  for (const t of samples()) n++
  assert.ok(n > 50000, `expected a substantial sample set, got ${n}`)
})

test('nextTransition properties on every sampled instant', { skip: missing }, () => {
  let n = 0
  const bad = []
  for (const t of samples()) {
    n++
    const r = core.nextTransition(t)
    const p1 = core.classify(r.at - 1)
    const p2 = core.classify(r.at)
    const problems = []
    if (!(r.at > t)) problems.push(`not strictly after input (at=${r.at} t=${t})`)
    if (r.to !== p2.phase) problems.push(`to=${r.to} but phase(at)=${p2.phase}`)
    if (p1.phase === p2.phase) problems.push(`no phase change at ${r.at}`)
    if (r.at !== nextTransitionOracle(t)?.at) {
      problems.push(`oracle mismatch: got ${r.at} want ${nextTransitionOracle(t)?.at}`)
    }
    if (problems.length && bad.length < 12) bad.push({ t, at: r.at, text: bjParts(t).text, problems })
  }
  assert.deepEqual(bad, [], `failures in ${bad.length}+ of ${n} samples`)
  assert.ok(n > 50000, `expected a substantial sample set, got ${n}`)
})

test('classify matches the independent oracle across 2025-2026', { skip: missing }, () => {
  const bad = []
  let n = 0
  for (const t of samples()) {
    if (t >= bjEpoch(2027, 1, 1)) continue
    n++
    const d = diffClassify(core.classify(t), classifyOracle(t))
    if (d.length && bad.length < 12) bad.push({ text: bjParts(t).text, d })
  }
  assert.deepEqual(bad, [], `${bad.length}+ mismatches of ${n} samples`)
})

test('converse: a phase change may only happen at 00:00/09:00/12:00/14:00/18:00 exactly', { skip: missing }, () => {
  const rnd = mulberry32(424242)
  const span = bjEpoch(2027, 1, 5) - RANGE_FROM
  const bad = []
  for (let i = 0; i < 20000; i++) {
    const t = RANGE_FROM + 1 + Math.floor(rnd() * span)
    if (core.classify(t - 1).phase === core.classify(t).phase) continue
    const p = bjParts(t)
    const ok = CANDIDATE_SECONDS.has(p.secondOfDay) && (t + BJ) % 1000 === 0
    if (!ok && bad.length < 12) bad.push({ text: p.text, secondOfDay: p.secondOfDay })
  }
  assert.deepEqual(bad, [], 'phase changed at a non-boundary instant')
})

test('nextTransition is monotone non-decreasing in t', { skip: missing }, () => {
  const pts = []
  const rnd = mulberry32(777)
  const span = bjEpoch(2027, 1, 5) - RANGE_FROM
  for (let i = 0; i < 4000; i++) pts.push(RANGE_FROM + Math.floor(rnd() * span))
  pts.sort((a, b) => a - b)
  let prev = -Infinity
  for (const t of pts) {
    const r = core.nextTransition(t)
    assert.ok(r.at >= prev, `monotonicity violated: t=${bjParts(t).text} at=${r.at} prev=${prev}`)
    prev = r.at
  }
})

test('nextTransition(at) advances past at (no fixed point)', { skip: missing }, () => {
  for (const [y, mo, da, h, mi] of [[2026, 10, 14, 9, 0], [2026, 10, 14, 11, 59], [2026, 10, 1, 9, 0], [2026, 12, 31, 23, 59]]) {
    const t = bjEpoch(y, mo, da, h, mi, 0)
    const a = core.nextTransition(t)
    const b = core.nextTransition(a.at)
    assert.ok(b.at > a.at, `nextTransition must advance from ${a.at}`)
    assert.equal(a.to, core.classify(a.at).phase)
    assert.equal(b.to, core.classify(b.at).phase)
  }
})

test('reason and coverage invariants', { skip: missing }, () => {
  const rnd = mulberry32(31337)
  const span = RANGE_TO - RANGE_FROM
  for (let i = 0; i < 5000; i++) {
    const t = RANGE_FROM + Math.floor(rnd() * span)
    const s = core.classify(t)
    assert.ok(['peak', 'idle'].includes(s.phase), `phase ${s.phase}`)
    assert.ok(['peak', 'off-hours', 'weekend', 'holiday'].includes(s.reason), `reason ${s.reason}`)
    assert.ok(['known', 'unknown'].includes(s.holidayCoverage), `coverage ${s.holidayCoverage}`)
    assert.match(s.dateKey, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(s.minuteOfDay >= 0 && s.minuteOfDay < 1440)
    assert.ok(s.weekday >= 0 && s.weekday <= 6)
    if (s.holidayCoverage === 'known') assert.equal(s.unknownHolidayYear, null)
    else assert.equal(s.unknownHolidayYear, Number(s.dateKey.slice(0, 4)))
    if (s.reason === 'peak') assert.equal(s.phase, 'peak')
    if (s.reason === 'holiday') assert.equal(s.phase, 'idle')
    if (s.weekday === 0 || s.weekday === 6) assert.notEqual(s.phase, 'peak', `${s.dateKey} weekend must be idle`)
    if (s.minuteOfDay < 540 || (s.minuteOfDay >= 720 && s.minuteOfDay < 840) || s.minuteOfDay >= 1080) {
      assert.notEqual(s.phase, 'peak', `${s.dateKey} outside windows must be idle`)
    }
  }
})

test('phaseSegments: hand-checked single day 2026-10-14 (Wednesday)', { skip: missing }, () => {
  const from = bjEpoch(2026, 10, 14), to = bjEpoch(2026, 10, 15)
  const segs = core.phaseSegments(from, to)
  const hand = [
    [bjEpoch(2026, 10, 14, 0), bjEpoch(2026, 10, 14, 9), 'idle', 'off-hours'],
    [bjEpoch(2026, 10, 14, 9), bjEpoch(2026, 10, 14, 12), 'peak', 'peak'],
    [bjEpoch(2026, 10, 14, 12), bjEpoch(2026, 10, 14, 14), 'idle', 'off-hours'],
    [bjEpoch(2026, 10, 14, 14), bjEpoch(2026, 10, 14, 18), 'peak', 'peak'],
    [bjEpoch(2026, 10, 14, 18), bjEpoch(2026, 10, 15, 0), 'idle', 'off-hours'],
  ]
  assert.deepEqual(segs.map((s) => [s.from, s.to, s.phase, s.reason]), hand)
})

test('phaseSegments: holiday rollover 2026-09-30 → 2026-10-08 12:00', { skip: missing }, () => {
  const from = bjEpoch(2026, 9, 30), to = bjEpoch(2026, 10, 8, 12)
  const segs = core.phaseSegments(from, to)
  // Segments split at PHASE changes only (SPEC §2.1 says "contiguous, covering [from,to)"); the
  // `reason` carried by a segment is the reason at its start. So the 9-day 国庆 idle stretch is one
  // segment whose reason is 'off-hours' (the label at 2026-09-30 18:00), NOT 'holiday'.
  // FINDING F3 (reported to Lead 2026-10-09): that label does not describe the span. SPEC does not
  // mandate reason-granularity splitting, so this is recorded as an ambiguity, not a failure.
  const hand = [
    [bjEpoch(2026, 9, 30, 0), bjEpoch(2026, 9, 30, 9), 'idle', 'off-hours'],
    [bjEpoch(2026, 9, 30, 9), bjEpoch(2026, 9, 30, 12), 'peak', 'peak'],
    [bjEpoch(2026, 9, 30, 12), bjEpoch(2026, 9, 30, 14), 'idle', 'off-hours'],
    [bjEpoch(2026, 9, 30, 14), bjEpoch(2026, 9, 30, 18), 'peak', 'peak'],
    [bjEpoch(2026, 9, 30, 18), bjEpoch(2026, 10, 8, 9), 'idle', 'off-hours'],
    [bjEpoch(2026, 10, 8, 9), bjEpoch(2026, 10, 8, 12), 'peak', 'peak'],
  ]
  assert.deepEqual(segs.map((s) => [s.from, s.to, s.phase, s.reason]), hand)
  // whatever the granularity, every instant inside the holiday must classify as idle/holiday
  for (const t of [bjEpoch(2026, 10, 1, 10), bjEpoch(2026, 10, 5, 15), bjEpoch(2026, 10, 7, 10)]) {
    const onSeg = segs.find((s) => t >= s.from && t < s.to)
    assert.equal(core.classify(t).reason, 'holiday', `${bjParts(t).text} must be a holiday`)
    assert.equal(onSeg.phase, 'idle')
  }
})

test('phaseSegments: structural invariants + oracle agreement', { skip: missing }, () => {
  const cases = [
    [bjEpoch(2026, 10, 14), bjEpoch(2026, 10, 14)],
    [bjEpoch(2026, 10, 14, 10), bjEpoch(2026, 10, 14, 11)],
    [bjEpoch(2026, 9, 28), bjEpoch(2026, 10, 10)],
    [bjEpoch(2025, 12, 30), bjEpoch(2026, 1, 6)],
    [bjEpoch(2026, 10, 14, 9), bjEpoch(2026, 10, 14, 9)],
  ]
  for (const [from, to] of cases) {
    const segs = core.phaseSegments(from, to)
    if (from === to) { assert.deepEqual(segs, []); continue }
    assert.equal(segs[0].from, from, `first segment must start at from (${from})`)
    assert.equal(segs.at(-1).to, to, `last segment must end at to (${to})`)
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      assert.ok(s.to > s.from, 'segments must be non-empty')
      assert.equal(core.classify(s.from).phase, s.phase, `segment ${i} phase must match classify(from)`)
      assert.equal(core.classify(s.to - 1).phase, s.phase, `segment ${i} must hold until its end`)
      if (i > 0) assert.equal(segs[i - 1].to, s.from, `segments must be contiguous at ${i}`)
    }
    if (to <= bjEpoch(2027, 1, 1)) {
      const o = phaseSegmentsOracle(from, to)
      assert.deepEqual(segs.map((s) => [s.from, s.to, s.phase, s.reason]), o.map((s) => [s.from, s.to, s.phase, s.reason]))
    }
  }
})
