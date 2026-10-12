/** 从解压后的会话 jsonl 里重建今天的时间线（用于验证闸门行为）。 */
const fs = require('fs')

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
const start = Date.parse('2026-10-12T09:00:00+08:00')
const end = Date.parse('2026-10-12T12:00:00+08:00')
const boundary = Date.parse('2026-10-12T12:00:00+08:00')

const fmt = (t) => new Date(t + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 23)

let total = 0
const inWindow = []
const turns = []
let firstAfterBoundary = null
let lastBeforeBoundary = null

for (const line of lines) {
  let o
  try { o = JSON.parse(line) } catch { continue }
  if (typeof o.time !== 'number') continue
  total += 1
  if (o.type === 'turn/start' || o.type === 'turn/end') {
    turns.push({ type: o.type, time: o.time, data: o.data })
  }
  if (o.time >= start && o.time < end) inWindow.push({ type: o.type, time: o.time })
  if (o.time < boundary && (lastBeforeBoundary === null || o.time > lastBeforeBoundary.time)) lastBeforeBoundary = { type: o.type, time: o.time }
  if (o.time >= boundary && (firstAfterBoundary === null || o.time < firstAfterBoundary.time)) firstAfterBoundary = { type: o.type, time: o.time }
}

console.log('总事件数:', total)
console.log('今天 09:00–12:00 窗口内的事件数:', inWindow.length)
if (inWindow.length > 0) inWindow.slice(0, 10).forEach((e) => console.log('   ', e.type, '@', fmt(e.time)))
console.log('')
console.log('边界前最后一条事件:', lastBeforeBoundary ? `${lastBeforeBoundary.type} @ ${fmt(lastBeforeBoundary.time)}` : '(无)')
console.log('边界后第一条事件  :', firstAfterBoundary ? `${firstAfterBoundary.type} @ ${fmt(firstAfterBoundary.time)}` : '(无)')
console.log('')
console.log('最近 8 个 turn 事件:')
turns.slice(-8).forEach((t) => console.log('   ', t.type.padEnd(12), '@', fmt(t.time), ' turn=', t.data && t.data.turn !== undefined ? t.data.turn : '-'))
