/**
 * 复现用户截图那一刻的弹层数值（Lead 诊断用）。
 * 场景：服务器快照来自"模拟 11:59:50"（高峰），浏览器又过了 15 秒才渲染，
 * 此时模拟时间已到 12:00:05 —— 跨过了 12:00:00 这个空闲边界。
 */
import { loadBundleExports } from '../test/client/helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { describePopover, formatOffset, formatCountdown, remainingMs } = internals

const T = (h, m, s) => Date.UTC(2026, 9, 12, h - 8, m, s) // 北京时间 -> epoch

const baseState = {
  mode: 'idle-only',
  phase: 'peak',
  reason: 'peak',
  now: T(11, 59, 50),
  nowText: '2026-10-12 11:59:50',
  nextTransitionAt: T(12, 0, 0),
  nextTransitionText: '2026-10-12 12:00:00',
  nextPhase: 'idle',
  msUntilTransition: 10000,
  paused: true,
  waitingTasks: 2,
  holidayToday: null,
  holidayCoverage: 'known',
  unknownHolidayYear: null,
  timeZone: 'Asia/Shanghai (UTC+8)',
  peakWindows: ['09:00-12:00', '14:00-18:00'],
  clockOverride: { offsetMs: 223080000, expiresAt: Date.now() + 600000, ttlMs: 600000 },
  config: { allowClockOverride: true },
}

// 快照拉取时刻（浏览器真实时钟）
const fetchedAtMs = Date.now()

function show(label, browserNowMs) {
  const snapshot = { state: baseState, fetchedAtMs, error: null }
  const model = describePopover(snapshot, browserNowMs)
  console.log(`--- ${label} ---`)
  console.log(`  剩余毫秒      : ${model.remaining}  (${JSON.stringify(remainingMs(snapshot, browserNowMs))})`)
  console.log(`  倒计时文案    : ${JSON.stringify(model.countdown)}`)
  console.log(`  相位(phaseKey): ${model.phaseKey}`)
  console.log(`  reason(原因)  : ${model.reasonKey}`)
  console.log(`  下一相位      : ${model.nextPhaseKey}`)
  console.log(`  宿主估算时间  : ${model.hostNow === null ? 'null' : new Date(model.hostNow + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)}`)
  console.log(`  排队任务      : ${model.waitingTasks}`)
}

console.log('=== 复现：快照来自 11:59:50，渲染时刻不同 ===')
show('渲染于 11:59:50（刚拉到快照）', fetchedAtMs)
show('渲染于 12:00:05（15 秒后，已过边界）← 用户截图那一刻', fetchedAtMs + 15000)

console.log('\n=== 覆盖文案与格式化 ===')
console.log(`  formatOffset(223080000) = ${JSON.stringify(formatOffset(223080000))}   (期望 +2d 13h 58m)`)
console.log(`  formatCountdown(-5000)  = ${JSON.stringify(formatCountdown(-5000))}  (负数被原样带负号)`)
console.log(`  formatCountdown(0)      = ${JSON.stringify(formatCountdown(0))}`)

console.log('\n=== 快照里若 phase 已是 idle（对照组） ===')
const idleState = { ...baseState, phase: 'idle', reason: 'off-hours', now: T(12, 0, 5), nowText: '2026-10-12 12:00:05', msUntilTransition: -5000, paused: false }
const m2 = describePopover({ state: idleState, fetchedAtMs, error: null }, fetchedAtMs)
console.log(`  phaseKey=${m2.phaseKey} reason=${m2.reasonKey} countdown=${JSON.stringify(m2.countdown)} hostNow=${new Date(m2.hostNow + 8 * 3600 * 1000).toISOString().slice(0, 19)}`)
