/**
 * 一次性诊断（v2）：把项目 lib 复制成 dsh-peak-hours-3（新目录 => 全新 ESM URL =>
 * 强制重新求值），插桩 lib/host/index.js：
 *   - 每个 own(label, run) 的 run() 返回值类型（找出"非法 effect 值"到底是谁）
 *   - apply / mount 各阶段面包屑
 * 同时把 profile patch 里的 -2 行换成 -3 行。锚点缺失只跳过并报告，不中断。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROF = 'C:\\Users\\81521\\.dsh\\profiles\\desktop'
const PROJECT = 'C:\\Users\\81521\\.dsh\\dsh-peak-hours'
const TARGET = join(PROF, 'node_modules', 'dsh-peak-hours-3')
const BC = 'C:\\\\Users\\\\81521\\\\.dsh\\\\_probe\\\\entry-boot3.txt'

rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })
cpSync(join(PROJECT, 'lib'), join(TARGET, 'lib'), { recursive: true })
writeFileSync(join(TARGET, 'package.json'), readFileSync(join(PROJECT, 'package.json'), 'utf8'))

const entry = join(TARGET, 'lib', 'host', 'index.js')
let text = readFileSync(entry, 'utf8')
const applied = []
const missing = []

const patch = (label, from, to) => {
  if (!text.includes(from)) {
    missing.push(label)
    return
  }
  text = text.replace(from, to)
  applied.push(label)
}

patch(
  'module-scope breadcrumbs',
  "import { createModeStore, resolveStatePath } from './store.js'",
  "import { createModeStore, resolveStatePath } from './store.js'\n" +
    "import { appendFileSync as __bcAppend } from 'node:fs'\n" +
    `const __bcFile = '${BC}'\n` +
    'const __bc = (m) => { try { __bcAppend(__bcFile, `${new Date().toISOString()} ${m}\\n`) } catch {} }\n' +
    "__bc('MODULE EVALUATED (dsh-peak-hours-3)')",
)

patch(
  'own() return-type logging',
  '  const own = (label, run) => {\n    const dispose = ctx.effect(run, label)',
  '  const own = (label, run) => {\n' +
    '    const wrapped = () => {\n' +
    '      let value\n' +
    '      try { value = run() } catch (error) { __bc(`own(${label}) THREW ${error?.message}`); throw error }\n' +
    "      __bc(`own(${label}) -> ${value === null ? 'null' : typeof value}${typeof value === 'function' ? ' (fn)' : ''}`)\n" +
    '      return value\n' +
    '    }\n' +
    '    const dispose = ctx.effect(wrapped, label)',
)

patch('apply entered', 'export async function apply(ctx, config = {}) {', "export async function apply(ctx, config = {}) {\n  __bc('APPLY ENTERED')")
patch(
  'apply catch',
  '  } catch (error) {\n    for (const dispose of registry.reverse()) {',
  "  } catch (error) {\n    __bc(`APPLY CAUGHT ${error?.stack?.slice(0, 700)}`)\n    for (const dispose of registry.reverse()) {",
)
patch('apply resolves', '\n  return undefined\n}', "\n  __bc('APPLY RESOLVES UNDEFINED')\n  return undefined\n}")
patch('core loaded', '  const core = await loadCore({ logger })', "  const core = await loadCore({ logger })\n  __bc(`CORE LOADED ${core.source}`)")
patch('store read', '  const initialMode = await store.read()', "  const initialMode = await store.read()\n  __bc(`STORE READ ${initialMode}`)")
patch('before owns', "  own('peak-hours: gate'", "  __bc('registering owns')\n  own('peak-hours: gate'")
patch(
  'mount complete',
  '  return { gate, clock, store, handlers, core: core.source, version, allowClockOverride }',
  "  __bc('MOUNT COMPLETE')\n  return { gate, clock, store, handlers, core: core.source, version, allowClockOverride }",
)

writeFileSync(entry, text)

// patch: 用 -3 行替换 -2 段
const patchFile = join(PROF, 'cordis.patch.yml')
let yml = readFileSync(patchFile, 'utf8')
const block = /# dsh-peak-hours \(fresh-directory activation\)\n- insert:\n {4}- id: peak-hours\n {6}name: 'dsh-peak-hours-2'\n?/
if (!block.test(yml)) throw new Error('旧 -2 patch 段未找到')
yml = yml.replace(block, '')
yml = yml.trimEnd() + "\n\n# dsh-peak-hours (instrumented activation)\n- insert:\n    - id: peak-hours-3\n      name: 'dsh-peak-hours-3'\n"
writeFileSync(patchFile, yml)

console.log('applied:', applied.join(', '))
console.log('missing:', missing.length === 0 ? '(none)' : missing.join(', '))
console.log('patch tail:\n' + yml.split('\n').slice(-7).join('\n'))
