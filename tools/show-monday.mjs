/** 2026-10-12（周一）全天相位分段 + 关键时点判定（北京时间）。 */
import { classify, phaseSegments, formatBeijing } from '../lib/core/index.js'

const BJ = 8 * 3600 * 1000
const dayStart = Date.UTC(2026, 9, 11, 16, 0, 0) // 北京 10-12 00:00
const dayEnd = Date.UTC(2026, 9, 12, 16, 0, 0) // 北京 10-13 00:00

console.log('=== 2026-10-12（周一）全天相位分段 ===')
for (const seg of phaseSegments(dayStart, dayEnd)) {
  const len = (seg.to - seg.from) / 60000
  console.log(`  ${formatBeijing(seg.from)} → ${formatBeijing(seg.to)}  ${seg.phase.padEnd(4)} (${seg.reason})  ${len} 分钟`)
}

console.log('\n=== 关键时点 ===')
for (const [h, m, label] of [[9, 0, '09:00 高峰开始'], [10, 0, '10:00 ← 你问的时刻'], [12, 0, '12:00 午休（空闲）'], [13, 59, '13:59'], [14, 0, '14:00 下午高峰'], [18, 0, '18:00 下班（空闲）'], [22, 0, '22:00']]) {
  const t = Date.UTC(2026, 9, 12, h - 8, m, 0)
  const info = classify(t)
  const next = phaseSegments(t, t + 24 * 3600 * 1000)[0]
  console.log(`  ${label.padEnd(22)} → phase=${info.phase.padEnd(4)} reason=${info.reason.padEnd(9)} weekday=${info.weekday} 本段至 ${formatBeijing(next.to)}`)
}

console.log('\n=== 10:00 那一刻的下一次切换 ===')
const t10 = Date.UTC(2026, 9, 12, 2, 0, 0)
const seg = phaseSegments(t10, t10 + 24 * 3600 * 1000)[0]
console.log(`  ${formatBeijing(t10)} 处于 ${seg.phase}，将在 ${formatBeijing(seg.to)} 切换到空闲`)
console.log(`  即：10:00 扣住的任务最早在 ${formatBeijing(seg.to)} 恢复（再下一次扣住点在 14:00）`)
