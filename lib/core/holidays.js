/**
 * China statutory holiday dataset (Beijing time) plus the calendar object consumed by
 * `lib/core/schedule.js`.
 *
 * Contents: every day that is actually a day OFF ("放假") according to the State Council
 * notice for that year. Make-up workdays (调休上班的周末) are deliberately NOT listed — per
 * SPEC.md §1 a make-up Saturday/Sunday is still idle, so it needs no entry and adding one
 * would be wrong.
 *
 * The notices are transcribed as their own date blocks so the table can be re-checked against
 * the notice text line by line; `HOLIDAY_YEARS` is the flattened `dateKey -> holiday name` map
 * that SPEC.md §2.2 freezes.
 *
 * 2027 is intentionally absent: as of 2026-10-09 the State Council has not published the 2027
 * arrangement notice ("2027年放假安排尚未官宣"), so there is nothing to transcribe. A date in a
 * year with no dataset entry is handled per SPEC.md §1: treated as a non-holiday, reported as
 * `holidayCoverage: 'unknown'` with `unknownHolidayYear: <year>`.
 */

import { readFileSync } from 'node:fs'

const DAY_MS = 86400000
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 'YYYY-MM-DD' -> days since 1970-01-01 (UTC arithmetic only, no local time involved). */
function dayNumber(dateKey) {
  const y = Number(dateKey.slice(0, 4))
  const m = Number(dateKey.slice(5, 7))
  const d = Number(dateKey.slice(8, 10))
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
}

function keyOfDayNumber(n) {
  const d = new Date(n * DAY_MS)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** Inclusive list of dateKeys from `startKey` to `endKey`. */
function rangeKeys(startKey, endKey) {
  const out = []
  for (let n = dayNumber(startKey); n <= dayNumber(endKey); n += 1) out.push(keyOfDayNumber(n))
  return out
}

function yearOfKey(dateKey) {
  if (typeof dateKey !== 'string' || !DATE_KEY_RE.test(dateKey)) return null
  return Number(dateKey.slice(0, 4))
}

/* --------------------------------------------------------------------------------------- *
 * Transcribed State Council notices.
 * `text` lines are copied verbatim from the notice so a reviewer can diff them against the URL.
 * --------------------------------------------------------------------------------------- */

const NOTICES = [
  {
    year: 2025,
    published: '2024-11-12',
    official: {
      title: '国务院办公厅关于2025年部分节假日安排的通知',
      url: 'https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm',
      publisher: '中国政府网 · 国务院政策文件库',
    },
    crossChecks: [
      {
        title: '受权发布丨国务院办公厅关于2025年部分节假日安排的通知',
        url: 'http://www.news.cn/20241112/87875d15b31442709def6d1cca169ab3/c.html',
        publisher: '新华网（新华社北京11月12日电）',
        published: '2024-11-12',
      },
      {
        title: '国务院办公厅关于2025年部分节假日安排的通知',
        url: 'https://cpc.people.com.cn/GB/n1/2024/1113/c64387-40360003.html',
        publisher: '人民网（《人民日报》2024年11月13日第03版）',
        published: '2024-11-13',
      },
      {
        title: '春节和劳动节各增1天！2025年放假安排来了',
        url: 'https://m.gmw.cn/2024-11/12/content_1303894988.htm',
        publisher: '光明网',
        published: '2024-11-12',
      },
    ],
    notice: [
      '一、元旦：1月1日（周三）放假1天，不调休。',
      '二、春节：1月28日（农历除夕、周二）至2月4日（农历正月初七、周二）放假调休，共8天。1月26日（周日）、2月8日（周六）上班。',
      '三、清明节：4月4日（周五）至6日（周日）放假，共3天。',
      '四、劳动节：5月1日（周四）至5日（周一）放假调休，共5天。4月27日（周日）上班。',
      '五、端午节：5月31日（周六）至6月2日（周一）放假，共3天。',
      '六、国庆节、中秋节：10月1日（周三）至8日（周三）放假调休，共8天。9月28日（周日）、10月11日（周六）上班。',
    ],
    blocks: [
      { clause: '一、元旦', name: '元旦', start: '2025-01-01', end: '2025-01-01' },
      { clause: '二、春节', name: '春节', start: '2025-01-28', end: '2025-02-04' },
      { clause: '三、清明节', name: '清明节', start: '2025-04-04', end: '2025-04-06' },
      { clause: '四、劳动节', name: '劳动节', start: '2025-05-01', end: '2025-05-05' },
      { clause: '五、端午节', name: '端午节', start: '2025-05-31', end: '2025-06-02' },
      {
        clause: '六、国庆节、中秋节',
        name: '国庆节',
        start: '2025-10-01',
        end: '2025-10-08',
        // The notice merges 国庆节 and 中秋节 into one 8-day block because 中秋节 (农历八月十五)
        // falls on 2025-10-06; that single statutory day is labelled separately.
        dayNames: { '2025-10-06': '中秋节' },
      },
    ],
  },
  {
    year: 2026,
    published: '2025-11-04',
    official: {
      title: '国务院办公厅关于2026年部分节假日安排的通知',
      url: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
      publisher: '中国政府网 · 国务院政策文件库',
    },
    crossChecks: [
      {
        title: '国务院办公厅关于2026年部分节假日安排的通知（2025年第32号国务院公报）',
        url: 'https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html',
        publisher: '中国政府网 · 国务院公报',
        published: '2025-11-04',
      },
      {
        title: '国务院办公厅关于二〇二六年部分节假日安排的通知',
        url: 'http://politics.people.com.cn/n1/2025/1105/c1001-40596810.html',
        publisher: '人民网（新华社北京11月4日电，《人民日报》2025年11月5日第04版）',
        published: '2025-11-05',
      },
      {
        title: '2026年放假安排，来了！',
        url: 'https://m.gmw.cn/2025-11/04/content_1304211342.htm',
        publisher: '光明网',
        published: '2025-11-04',
      },
    ],
    notice: [
      '一、元旦：1月1日（周四）至3日（周六）放假调休，共3天。1月4日（周日）上班。',
      '二、春节：2月15日（农历腊月二十八、周日）至23日（农历正月初七、周一）放假调休，共9天。2月14日（周六）、2月28日（周六）上班。',
      '三、清明节：4月4日（周六）至6日（周一）放假，共3天。',
      '四、劳动节：5月1日（周五）至5日（周二）放假调休，共5天。5月9日（周六）上班。',
      '五、端午节：6月19日（周五）至21日（周日）放假，共3天。',
      '六、中秋节：9月25日（周五）至27日（周日）放假，共3天。',
      '七、国庆节：10月1日（周四）至7日（周三）放假调休，共7天。9月20日（周日）、10月10日（周六）上班。',
    ],
    blocks: [
      { clause: '一、元旦', name: '元旦', start: '2026-01-01', end: '2026-01-03' },
      { clause: '二、春节', name: '春节', start: '2026-02-15', end: '2026-02-23' },
      { clause: '三、清明节', name: '清明节', start: '2026-04-04', end: '2026-04-06' },
      { clause: '四、劳动节', name: '劳动节', start: '2026-05-01', end: '2026-05-05' },
      { clause: '五、端午节', name: '端午节', start: '2026-06-19', end: '2026-06-21' },
      { clause: '六、中秋节', name: '中秋节', start: '2026-09-25', end: '2026-09-27' },
      { clause: '七、国庆节', name: '国庆节', start: '2026-10-01', end: '2026-10-07' },
    ],
  },
]

function flattenBlocks(blocks) {
  const table = {}
  for (const block of blocks) {
    for (const key of rangeKeys(block.start, block.end)) {
      table[key] = (block.dayNames && block.dayNames[key]) || block.name
    }
  }
  return Object.freeze(table)
}

/** `{ 2025: { '2025-01-01': '元旦', ... }, 2026: { ... } }` — days off only. */
export const HOLIDAY_YEARS = Object.freeze(
  Object.fromEntries(NOTICES.map((n) => [n.year, flattenBlocks(n.blocks)])),
)

/**
 * `{ year: '<notice title> — <url>' }` for every year in `HOLIDAY_YEARS`.
 * The full cross-check list (every URL that was actually retrieved and compared) is in
 * `HOLIDAY_SOURCE_DETAIL`.
 */
export const HOLIDAY_SOURCE = Object.freeze(
  Object.fromEntries(NOTICES.map((n) => [n.year, `${n.official.title} — ${n.official.url}`])),
)

/** Per-year audit record: official notice, independent cross-checks, verbatim notice text. */
export const HOLIDAY_SOURCE_DETAIL = Object.freeze(
  Object.fromEntries(
    NOTICES.map((n) => [
      n.year,
      Object.freeze({
        year: n.year,
        published: n.published,
        official: Object.freeze({ ...n.official }),
        crossChecks: Object.freeze(n.crossChecks.map((c) => Object.freeze({ ...c }))),
        notice: Object.freeze([...n.notice]),
      }),
    ]),
  ),
)

/** Years present in the built-in dataset, ascending. */
export function builtInYears() {
  return Object.keys(HOLIDAY_YEARS)
    .map(Number)
    .sort((a, b) => a - b)
}

/* --------------------------------------------------------------------------------------- *
 * Extra-days file / overlay normalisation
 * --------------------------------------------------------------------------------------- */

/**
 * Accepts any of:
 *   { '2027-01-01': '元旦', '2027-05-01': { name: '劳动节' } }
 *   [{ dateKey: '2027-01-01', name: '元旦' }]
 *   { years: [2027], holidays: { '2027-01-01': '元旦' } }   // 'days' also accepted
 * A `null`/`false`/empty-string value removes a built-in day (an overlay may correct the
 * dataset away, it may not silently ignore a key).
 * Returns { days: Map<dateKey, {dateKey,name}|null>, years: number[] }.
 */
function normalizeExtraSource(raw) {
  const days = new Map()
  let years = []

  const readYears = (value) => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      const y = typeof item === 'number' ? item : Number(item)
      if (Number.isInteger(y)) years.push(y)
    }
  }

  const readDay = (key, value) => {
    if (typeof key !== 'string' || !DATE_KEY_RE.test(key)) return
    if (value === null || value === false || value === '') {
      days.set(key, null)
      return
    }
    if (typeof value === 'string') {
      days.set(key, { dateKey: key, name: value })
      return
    }
    if (value && typeof value === 'object') {
      const name = value.name ?? value.label ?? value.title
      if (typeof name === 'string' && name.length > 0) {
        const dk = typeof value.dateKey === 'string' && DATE_KEY_RE.test(value.dateKey) ? value.dateKey : key
        days.set(key, { dateKey: dk, name })
        return
      }
    }
    // Unusable value: ignore it rather than poisoning the calendar.
  }

  const readRecord = (record) => {
    if (!record || typeof record !== 'object') return
    for (const [key, value] of Object.entries(record)) readDay(key, value)
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const key = item.dateKey ?? item.date ?? item.day
      readDay(typeof key === 'string' ? key : '', item)
    }
    return { days, years }
  }

  if (raw && typeof raw === 'object') {
    readYears(raw.years ?? raw.coveredYears)
    const nested = raw.holidays ?? raw.days ?? raw.extra
    if (nested !== undefined) {
      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (!item || typeof item !== 'object') continue
          const key = item.dateKey ?? item.date ?? item.day
          readDay(typeof key === 'string' ? key : '', item)
        }
      } else {
        readRecord(nested)
      }
    }
    // Top-level dateKeys are read too, so a flat map and a wrapper object both work.
    readRecord(raw)
  }

  return { days, years }
}

function normalizeYearList(value) {
  if (value === undefined || value === null) return null
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    const y = typeof item === 'number' ? item : Number(item)
    if (Number.isInteger(y)) out.push(y)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/* --------------------------------------------------------------------------------------- *
 * Calendar
 * --------------------------------------------------------------------------------------- */

/**
 * Build a calendar.
 *
 * @param {object} [options]
 * @param {number[]} [options.years] Explicit coverage list. When omitted, coverage is the
 *   built-in dataset years plus every year that appears in `extra`. A year outside the covered
 *   set is unknown in both directions: `coverage()` says `'unknown'` **and** `holidayOn()`
 *   returns `undefined` for that year's dataset days, so callers never see "holiday name +
 *   unknown coverage" for the same day.
 * @param {object|Array} [options.extra] Overlay days; they win over the built-in dataset
 *   (including by removing a built-in day with a `null` value). `extra` is **not** gated by
 *   `years`: the caller supplied those days explicitly, so they apply directly, and a supplied
 *   day counts as known coverage.
 * @returns {{ holidayOn(dateKey): {dateKey: string, name: string}|undefined,
 *             coverage(dateKey): 'known'|'unknown',
 *             years: number[], source: object }}
 */
export function createCalendar({ years, extra = {} } = {}) {
  const parsed = normalizeExtraSource(extra)
  const builtIn = builtInYears()
  const extraYears = [...parsed.days.keys()].map((k) => Number(k.slice(0, 4)))
  const explicitYears = normalizeYearList(years)
  const covered = explicitYears ?? [...new Set([...builtIn, ...parsed.years, ...extraYears])].sort((a, b) => a - b)
  const coveredSet = new Set(covered)

  function holidayOn(dateKey) {
    if (typeof dateKey !== 'string') return undefined
    // `extra` is caller-supplied data and takes effect directly, so it is not gated by `years`.
    if (parsed.days.has(dateKey)) {
      const overlay = parsed.days.get(dateKey)
      return overlay === null ? undefined : { dateKey: overlay.dateKey, name: overlay.name }
    }
    const year = yearOfKey(dateKey)
    if (year === null) return undefined
    // Year gate: a year outside `years` is "not known by this calendar", so its dataset days are
    // withheld. Without this, `coverage()` would report 'unknown' while `holidayOn()` still
    // returned an authoritative holiday name for the same day.
    if (!coveredSet.has(year)) return undefined
    const table = HOLIDAY_YEARS[year]
    const name = table ? table[dateKey] : undefined
    return name ? { dateKey, name } : undefined
  }

  function coverage(dateKey) {
    const year = yearOfKey(dateKey)
    if (year === null) return 'unknown'
    if (coveredSet.has(year)) return 'known'
    // An explicit `extra` day is known data even when its year is outside `years`, which keeps
    // the invariant "coverage() === 'unknown' implies holidayOn() === undefined".
    const overlay = parsed.days.get(dateKey)
    return overlay ? 'known' : 'unknown'
  }

  return { holidayOn, coverage, years: covered, source: HOLIDAY_SOURCE }
}

/** Calendar backed by the built-in dataset only. */
export const defaultCalendar = createCalendar()

/**
 * Best-effort extras file loader: never throws, always returns a usable calendar.
 * A missing/unreadable/invalid file yields the built-in calendar and carries `loadError`, so a
 * caller (host state builder, UI warning) can tell that the extras were not applied.
 * Returns the `createCalendar()` shape plus `{ sourceFile, loadError }`.
 */
export function loadCalendarFile(path) {
  const withMeta = (calendar, sourceFile, loadError) =>
    Object.assign({}, calendar, { sourceFile, loadError })

  if (typeof path !== 'string' || path.length === 0) {
    return withMeta(defaultCalendar, null, 'no path given')
  }

  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return withMeta(defaultCalendar, path, `cannot read file: ${err && err.code ? err.code : String(err)}`)
  }

  let json
  try {
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch (err) {
    return withMeta(defaultCalendar, path, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  const parsed = normalizeExtraSource(json)
  if (parsed.days.size === 0 && parsed.years.length === 0) {
    return withMeta(defaultCalendar, path, 'no holiday entries found')
  }

  return withMeta(createCalendar({ extra: json }), path, null)
}
