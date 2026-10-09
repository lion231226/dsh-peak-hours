/**
 * 把运行态收敛到"干净交付代码"：
 *   1. 用项目源码（无插桩）铺一个新目录 dsh-peak-hours-live
 *   2. patch 删除插桩行 (-3)，改为指向 live 目录
 *   3. 删掉诊断用的 -2 / -3 目录
 * 新目录 => 全新 ESM URL => 不受 Node 模块缓存影响。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROF = 'C:\\Users\\81521\\.dsh\\profiles\\desktop'
const PROJECT = 'C:\\Users\\81521\\.dsh\\dsh-peak-hours'
const LIVE = join(PROF, 'node_modules', 'dsh-peak-hours-live')

rmSync(LIVE, { recursive: true, force: true })
mkdirSync(LIVE, { recursive: true })
cpSync(join(PROJECT, 'lib'), join(LIVE, 'lib'), { recursive: true })
for (const file of ['package.json', 'cordis.patch.yml', 'README.md']) {
  const src = join(PROJECT, file)
  if (existsSync(src)) cpSync(src, join(LIVE, file))
}

const patchFile = join(PROF, 'cordis.patch.yml')
let yml = readFileSync(patchFile, 'utf8')
const block = /# dsh-peak-hours \(instrumented activation\)\n- insert:\n {4}- id: peak-hours-3\n {6}name: 'dsh-peak-hours-3'\n?/
if (!block.test(yml)) throw new Error('插桩 patch 段未找到')
yml = yml.replace(block, '')
yml = yml.trimEnd() + "\n\n# dsh-peak-hours (live activation)\n- insert:\n    - id: peak-hours-live\n      name: 'dsh-peak-hours-live'\n"
writeFileSync(patchFile, yml)

for (const dir of ['dsh-peak-hours-2', 'dsh-peak-hours-3']) {
  rmSync(join(PROF, 'node_modules', dir), { recursive: true, force: true })
}

console.log('live copy ready (clean, uninstrumented):', LIVE)
console.log('patch tail:\n' + yml.split('\n').slice(-7).join('\n'))
