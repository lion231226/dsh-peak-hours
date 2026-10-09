/**
 * `dsh-peak-hours` core: frozen re-exports (SPEC.md §2.2).
 * Pure logic only — safe to import from the host half, tests and tooling.
 */

export {
  BJ_OFFSET_MS,
  PEAK_WINDOWS,
  PEAK_WINDOW_LABELS,
  bjFields,
  bjDateKey,
  bjMinuteOfDay,
  bjWeekday,
  formatBeijing,
  classify,
  isPeak,
  nextTransition,
  phaseSegments,
} from './schedule.js'

export {
  HOLIDAY_YEARS,
  HOLIDAY_SOURCE,
  HOLIDAY_SOURCE_DETAIL,
  builtInYears,
  createCalendar,
  defaultCalendar,
  loadCalendarFile,
} from './holidays.js'
