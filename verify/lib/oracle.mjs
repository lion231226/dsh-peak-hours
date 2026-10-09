// verify/lib/oracle.mjs — verifier-owned INDEPENDENT reference implementation.
//
// Independence rules honoured here:
//  * The holiday lists below were typed out by the verifier, day by day, from the official
//    State Council notices downloaded into verify/raw/ (see verify/EVIDENCE.md §1).
//    They are NOT read from lib/core/holidays.js.
//  * The phase rule is transcribed straight from SPEC.md §1.
//  * nextTransition uses a CANDIDATE-SET derivation (all phase-change instants of a day are
//    among 00:00/09:00/12:00/14:00/18:00 Beijing), which is algorithmically different from the
//    minute-by-minute forward scan the implementation is allowed to use.
import { readFileSync } from 'node:fs'

export const BJ_OFFSET_MS = 8 * 3600 * 1000

// --- transcribed from 国办发明电〔2024〕12号 (2025 年部分节假日安排) -----------------
export const H2025 = [
  // 元旦：1月1日放假1天，不调休
  '2025-01-01',
  // 春节：1月28日至2月4日放假调休，共8天
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  // 清明节：4月4日至6日放假，共3天
  '2025-04-04', '2025-04-05', '2025-04-06',
  // 劳动节：5月1日至5日放假调休，共5天
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  // 端午节：5月31日至6月2日放假，共3天
  '2025-05-31', '2025-06-01', '2025-06-02',
  // 国庆节、中秋节：10月1日至8日放假调休，共8天
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04',
  '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
]

// --- transcribed from 国办发明电〔2025〕7号 (2026 年部分节假日安排) -----------------
export const H2026 = [
  // 元旦：1月1日至3日放假调休，共3天（1月4日周日上班）
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节：2月15日至23日放假调休，共9天
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节：4月4日至6日放假，共3天
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节：5月1日至5日放假调休，共5天
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节：6月19日至21日放假，共3天
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节：9月25日至27日放假，共3天
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节：10月1日至7日放假调休，共7天（9月20日周日、10月10日周六上班）
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

// 调休上班日 (make-up workdays). SPEC §1: these stay IDLE because they are weekends;
// they must NOT be in the holiday set, so `reason` must be 'weekend' — never 'holiday'.
export const MAKEUP_2025 = ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11']
export const MAKEUP_2026 = ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']

export const HOLIDAY_SET = new Set([...H2025, ...H2026])
export const KNOWN_YEARS = new Set([2025, 2026])

// --- helpers ---------------------------------------------------------------------------
const pad = (n, w = 2) => String(n).padStart(w, '0')

/** epoch ms of a Beijing wall-clock instant. Independent of the implementation. */
export function bjEpoch(y, mo, da, h = 0, mi = 0, s = 0, ms = 0) {
  return Date.UTC(y, mo - 1, da, h, mi, s, ms) - BJ_OFFSET_MS
}

/** Beijing wall-clock parts from epoch ms. */
export function bjParts(epochMs) {
  const d = new Date(epochMs + BJ_OFFSET_MS)
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate()
  return {
    y, mo, da,
    dateKey: `${pad(y, 4)}-${pad(mo)}-${pad(da)}`,
    weekday: d.getUTCDay(),
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    secondOfDay: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
    text: `${pad(y, 4)}-${pad(mo)}-${pad(da)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  }
}

/** epoch ms of 00:00 Beijing on the Beijing date containing `epochMs`. */
export function bjDayStart(epochMs) {
  const d = new Date(epochMs + BJ_OFFSET_MS)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BJ_OFFSET_MS
}

/**
 * SPEC §1 classifier. `holidays` is a Set of dateKeys, `knownYears` a Set of years.
 * Years absent from `knownYears` contribute no holidays and report coverage 'unknown'.
 */
export function classifyOracle(epochMs, holidays = HOLIDAY_SET, knownYears = KNOWN_YEARS) {
  const p = bjParts(epochMs)
  const year = Number(p.dateKey.slice(0, 4))
  const known = knownYears.has(year)
  const isHoliday = known && holidays.has(p.dateKey)
  const inWindow = (p.minuteOfDay >= 540 && p.minuteOfDay < 720) ||
                   (p.minuteOfDay >= 840 && p.minuteOfDay < 1080)
  const isWorkday = p.weekday >= 1 && p.weekday <= 5
  if (isWorkday && !isHoliday && inWindow) {
    return { phase: 'peak', reason: 'peak', ...p, holidayCoverage: known ? 'known' : 'unknown' }
  }
  const reason = isHoliday ? 'holiday' : (p.weekday === 0 || p.weekday === 6) ? 'weekend' : 'off-hours'
  return { phase: 'idle', reason, ...p, holidayCoverage: known ? 'known' : 'unknown' }
}

const DAY_OFFSETS = [0, 9 * 3600e3, 12 * 3600e3, 14 * 3600e3, 18 * 3600e3] // 00:00,09:00,12:00,14:00,18:00

/**
 * Candidate-set derivation of the next phase change strictly after `epochMs`.
 * Phase is constant between consecutive candidates, so the answer is the smallest
 * candidate > epochMs whose phase differs. Returns { at, to } or null if none found
 * within `days` days.
 */
export function nextTransitionOracle(epochMs, holidays = HOLIDAY_SET, knownYears = KNOWN_YEARS, days = 400) {
  const cur = classifyOracle(epochMs, holidays, knownYears).phase
  const base = bjDayStart(epochMs)
  for (let i = -1; i <= days; i++) {
    const dayStart = base + i * 86400e3
    for (const off of DAY_OFFSETS) {
      const at = dayStart + off
      if (at <= epochMs) continue
      const to = classifyOracle(at, holidays, knownYears).phase
      if (to !== cur) return { at, to }
    }
  }
  return null
}

/** SPEC §2.1 phaseSegments oracle: contiguous [from,to) cover built from candidates. */
export function phaseSegmentsOracle(fromMs, toMs, holidays = HOLIDAY_SET, knownYears = KNOWN_YEARS) {
  const out = []
  let cur = fromMs
  while (cur < toMs) {
    const c = classifyOracle(cur, holidays, knownYears)
    const nx = nextTransitionOracle(cur, holidays, knownYears)
    const end = nx ? Math.min(nx.at, toMs) : toMs
    out.push({ from: cur, to: end, phase: c.phase, reason: c.reason })
    if (end <= cur) throw new Error('oracle: non-advancing segment')
    cur = end
  }
  return out
}

/** Compare a module result envelope against the oracle on the fields SPEC freezes. */
export function diffClassify(got, exp) {
  const keys = ['phase', 'reason', 'dateKey', 'minuteOfDay', 'weekday']
  const bad = []
  for (const k of keys) if (got?.[k] !== exp?.[k]) bad.push(`${k}: got=${JSON.stringify(got?.[k])} want=${JSON.stringify(exp?.[k])}`)
  return bad
}

/** Raw text of a downloaded source, for evidence cross-checks in tests. */
export function rawSourceText(id) {
  const url = new URL(`../raw/${id}.txt`, import.meta.url)
  return readFileSync(url, 'utf8')
}
