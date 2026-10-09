// verify/repro-f5.mjs — minimal reproduction for FINDING F5 (store.js temp-file race).
//
// `createModeStore().write()` writes to a SHARED `${file}.tmp` and then renames. Two overlapping
// writes therefore clobber each other's temp file, and the rename can publish a half-written file.
// Run: node verify/repro-f5.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createModeStore } = await import('../lib/host/store.js')

async function attempt(concurrency) {
  const dir = mkdtempSync(join(tmpdir(), 'f5-'))
  const file = join(dir, 'peak-hours-state.json')
  const s = createModeStore({ file })
  await s.read()
  const modes = Array.from({ length: concurrency }, (_, i) => (i % 2 === 0 ? 'idle-only' : 'always'))
  await Promise.all(modes.map((m) => s.write(m)))
  let text
  try { text = readFileSync(file, 'utf8') } catch (e) { text = `<unreadable: ${e.code}>` }
  let ok = false, err = null
  try { JSON.parse(text); ok = true } catch (e) { err = e.message }
  const litter = readdirSync(dir)
  const result = { concurrency, ok, err, text, litter, memMode: s.peek(), lastWanted: modes[modes.length - 1] }
  rmSync(dir, { recursive: true, force: true })
  return result
}

let reproduced = 0
for (const concurrency of [2, 4, 8, 16, 32, 64, 200]) {
  for (let i = 1; i <= 12; i++) {
    const r = await attempt(concurrency)
    const bad = !r.ok || r.litter.length !== 1 || (r.ok && JSON.parse(r.text).mode !== r.lastWanted)
    if (bad) {
      reproduced++
      console.log(`REPRODUCED  concurrency=${r.concurrency} attempt=${i}`)
      console.log(`  dir contents      : ${JSON.stringify(r.litter)}`)
      console.log(`  JSON.parse        : ${r.ok ? 'ok' : `FAIL — ${r.err}`}`)
      console.log(`  file content      : ${JSON.stringify(r.text)}`)
      console.log(`  in-memory mode    : ${r.memMode}   last write wanted: ${r.lastWanted}`)
      if (reproduced >= 3) break
    }
  }
  if (reproduced >= 3) break
}
if (!reproduced) {
  console.log('F5 NOT REPRODUCED in 84 attempts (2..200 concurrent writes) — the fix holds.')
  console.log('PASS: exit 0 means no corruption and last-write-wins observed; exit 1 means the defect is present.')
  process.exit(0)
}
console.log(`\nF5 reproduced ${reproduced} time(s): concurrent write() can corrupt ${'<DSH_HOME>/peak-hours-state.json'} or lose the last mode.`)
process.exit(1)
