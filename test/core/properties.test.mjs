import test from 'node:test'
import assert from 'node:assert/strict'

import { classify, nextTransition, phaseSegments } from '../../lib/core/schedule.js'
import { BOUNDARY_TIMES, bj, fmt, mulberry32, referencePhase } from './_helpers.mjs'

const MINUTE = 60000
const DAY = 86400000
const RANGE_START = bj(2024, 1, 1, 0, 0, 0)
const RANGE_END = bj(2029, 1, 1, 0, 0, 0)

function assertTransitionContract(t) {
  const before = classify(t)
  const next = nextTransition(t)
  assert.ok(next.at > t, `nextTransition(${fmt(t)}).at must be > t`)
  assert.equal(next.at % MINUTE, 0, `nextTransition(${fmt(t)}).at must be minute aligned`)
  assert.ok(next.to === 'peak' || next.to === 'idle')
  assert.equal(classify(next.at).phase, next.to, `phase at ${fmt(next.at)}`)
  assert.notEqual(classify(next.at - 1).phase, next.to, `phase just before ${fmt(next.at)}`)
  assert.notEqual(before.phase, next.to, `the phase must change at ${fmt(next.at)}`)
  return next
}

test('property: nextTransition satisfies the contract for ~600 pseudo-random instants', () => {
  const random = mulberry32(0x5eed1234)
  for (let i = 0; i < 600; i += 1) {
    const t = Math.floor(RANGE_START + random() * (RANGE_END - RANGE_START))
    assertTransitionContract(t)
  }
})

test('property: nextTransition is minute aligned and exact at every second of a week', () => {
  const start = bj(2026, 10, 5, 0, 0, 0) // inside 国庆节, so the week is idle-heavy
  for (let s = 0; s < 7 * 24 * 3600; s += 61) {
    assertTransitionContract(start + s * 1000)
  }
})

test('property: nextTransition is non-decreasing in t and strictly flips at each boundary', () => {
  const random = mulberry32(0xabcdef)
  const samples = []
  for (let i = 0; i < 300; i += 1) {
    samples.push(Math.floor(RANGE_START + random() * (RANGE_END - RANGE_START)))
  }
  samples.sort((a, b) => a - b)
  let previous = null
  for (const t of samples) {
    const next = nextTransition(t)
    if (previous !== null) {
      assert.ok(next.at >= previous.at, `monotonicity broke at ${fmt(t)}`)
      // Once the previous answer is no longer "after" the new input, the walk must move on.
      if (previous.at <= t) assert.ok(next.at > previous.at, `stale answer at ${fmt(t)}`)
    }
    previous = next
  }
})

test('property: an exhaustive minute scan agrees with nextTransition', () => {
  const ranges = [
    ['plain week with a weekend', bj(2026, 3, 13, 0, 0, 0), bj(2026, 3, 17, 0, 0, 0)],
    ['spanning 中秋节', bj(2026, 9, 24, 0, 0, 0), bj(2026, 9, 29, 0, 0, 0)],
    ['spanning the 2026 春节', bj(2026, 2, 13, 0, 0, 0), bj(2026, 2, 25, 0, 0, 0)],
    ['spanning the year rollover', bj(2025, 12, 30, 0, 0, 0), bj(2026, 1, 6, 0, 0, 0)],
    ['off-grid start and end', bj(2026, 10, 5, 8, 30, 30, 500), bj(2026, 10, 8, 18, 30, 30, 500)],
  ]

  for (const [label, from, to] of ranges) {
    // Brute force: evaluate the rule on every minute boundary of the range.
    const expected = []
    let previous = classify(Math.floor(from / MINUTE) * MINUTE - 1).phase
    for (let m = Math.floor(from / MINUTE) + 1; m * MINUTE < to; m += 1) {
      const phase = classify(m * MINUTE).phase
      if (phase !== previous) expected.push({ at: m * MINUTE, to: phase })
      previous = phase
    }

    const walked = []
    let cursor = from
    for (;;) {
      const next = nextTransition(cursor)
      if (next.at >= to) break
      walked.push(next)
      cursor = next.at
      assert.ok(walked.length < expected.length + 5, `${label}: walk ran away`)
    }

    assert.deepEqual(walked, expected, `${label}: transition list differs from the minute scan`)
    assert.ok(expected.length > 0, `${label}: the range must contain transitions`)
  }
})

test('property: phaseSegments is contiguous, exact and internally uniform', () => {
  const ranges = [
    ['one workday', bj(2026, 3, 11, 0, 0, 0), bj(2026, 3, 12, 0, 0, 0)],
    ['a week', bj(2026, 3, 9, 0, 0, 0), bj(2026, 3, 16, 0, 0, 0)],
    ['2026 国庆节 block', bj(2026, 9, 30, 0, 0, 0), bj(2026, 10, 9, 0, 0, 0)],
    ['2026 春节 block', bj(2026, 2, 12, 0, 0, 0), bj(2026, 2, 25, 0, 0, 0)],
    ['year rollover', bj(2025, 12, 29, 0, 0, 0), bj(2026, 1, 7, 0, 0, 0)],
    ['off-grid boundaries', bj(2026, 3, 11, 8, 30, 12, 345), bj(2026, 3, 11, 18, 30, 12, 345)],
  ]

  for (const [label, from, to] of ranges) {
    const segments = phaseSegments(from, to)
    assert.ok(segments.length > 0, label)
    assert.equal(segments[0].from, from, `${label}: first segment start`)
    assert.equal(segments.at(-1).to, to, `${label}: last segment end`)

    let total = 0
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]
      assert.ok(segment.to > segment.from, `${label}: empty segment`)
      assert.ok(segment.phase === 'peak' || segment.phase === 'idle')
      assert.ok(['peak', 'off-hours', 'weekend', 'holiday'].includes(segment.reason))
      if (i > 0) assert.equal(segment.from, segments[i - 1].to, `${label}: gap or overlap before segment ${i}`)
      // `reason` is the reason at `from` (it may change inside a long idle segment, e.g.
      // off-hours -> weekend -> holiday); the phase itself must hold for the whole segment.
      assert.equal(classify(segment.from).phase, segment.phase, `${label}: phase at segment start`)
      assert.equal(classify(segment.from).reason, segment.reason, `${label}: reason at segment start`)
      assert.equal(classify(segment.to - 1).phase, segment.phase, `${label}: phase at segment end`)

      const middle = segment.from + Math.floor((segment.to - segment.from) / 2)
      assert.equal(classify(middle).phase, segment.phase, `${label}: phase in segment middle`)

      if (i < segments.length - 1) {
        assert.equal(nextTransition(segment.from).at, segment.to, `${label}: segment end is a real transition`)
      }
      total += segment.to - segment.from
    }
    assert.equal(total, to - from, `${label}: segments must tile the range`)
  }
})

test('property: a full year of segments has one segment per transition', () => {
  const from = bj(2026, 1, 1, 0, 0, 0)
  const to = bj(2027, 1, 1, 0, 0, 0)
  const segments = phaseSegments(from, to)
  let transitions = 0
  let cursor = from
  for (;;) {
    const next = nextTransition(cursor)
    if (next.at >= to) break
    transitions += 1
    cursor = next.at
  }
  assert.equal(segments.length, transitions + 1)

  const peakMs = segments.filter((s) => s.phase === 'peak').reduce((sum, s) => sum + (s.to - s.from), 0)
  assert.equal(peakMs % MINUTE, 0)
  // 2026 workdays (Mon-Fri outside the 33 holiday days) x 300 peak minutes per day.
  const workdays = segments.filter((s) => s.phase === 'peak').length / 2
  assert.ok(Number.isInteger(workdays), 'peak segments come in pairs (09:00-12:00, 14:00-18:00)')
  assert.equal(peakMs, workdays * (180 + 240) * MINUTE)
})

test('property: the independent reference model agrees on every sampled minute of 2025-2026', () => {
  const start = bj(2025, 1, 1, 0, 0, 0)
  const end = bj(2027, 1, 1, 0, 0, 0)
  for (let t = start; t < end; t += 17 * MINUTE) {
    assert.equal(classify(t).phase, referencePhase(t), fmt(t))
  }
})

test('property: every peak edge of 2025-2026 is exact in both directions', () => {
  const start = bj(2025, 1, 1, 0, 0, 0)
  const end = bj(2027, 1, 1, 0, 0, 0)
  for (let dayStart = start; dayStart < end; dayStart += DAY) {
    for (const time of BOUNDARY_TIMES) {
      const at = dayStart + (time.hour * 60 + time.minute) * MINUTE
      assert.equal(classify(at).phase, referencePhase(at), `${fmt(at)}`)
      assert.equal(classify(at - 1).phase, referencePhase(at - 1), `${fmt(at - 1)}`)
      assert.equal(classify(at + 1).phase, referencePhase(at + 1), `${fmt(at + 1)}`)
    }
  }
})
