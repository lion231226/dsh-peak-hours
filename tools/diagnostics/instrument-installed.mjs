/**
 * One-off diagnostic: instrument the INSTALLED copy of the host half with
 * breadcrumbs so a live reconcile failure reports where it died and why.
 * The installed copy is a deploy artifact; the project sources stay untouched.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const file = 'C:\\Users\\81521\\.dsh\\profiles\\desktop\\node_modules\\dsh-peak-hours\\lib\\host\\index.js'
copyFileSync(file, file + '.pre-instrument')
let text = readFileSync(file, 'utf8')

const replacements = [
  {
    label: 'module scope',
    from: "import { createModeStore, resolveStatePath } from './store.js'",
    to:
      "import { createModeStore, resolveStatePath } from './store.js'\n" +
      "import { appendFileSync as __bcAppend } from 'node:fs'\n" +
      "const __bcFile = 'C:\\\\Users\\\\81521\\\\.dsh\\\\_probe\\\\entry-boot.txt'\n" +
      "const __bc = (m) => { try { __bcAppend(__bcFile, `${new Date().toISOString()} ${m}\\n`) } catch {} }\n" +
      "__bc('MODULE EVALUATED')",
  },
  {
    label: 'apply entered',
    from: 'export async function apply(ctx, config = {}) {\n  const logger = ctx?.logger ?? null',
    to: "export async function apply(ctx, config = {}) {\n  __bc('APPLY ENTERED')\n  const logger = ctx?.logger ?? null",
  },
  {
    label: 'apply caught',
    from: '  } catch (error) {\n    try {\n      logger?.error?.(`[peak-hours] mount failed: ${errorText(error)}`)',
    to: '  } catch (error) {\n    __bc(`APPLY CAUGHT: ${errorText(error)}`)\n    try {\n      logger?.error?.(`[peak-hours] mount failed: ${errorText(error)}`)',
  },
  {
    label: 'core loaded',
    from: '  const core = await loadCore({ logger })',
    to: "  const core = await loadCore({ logger })\n  __bc(`CORE LOADED source=${core.source}`)",
  },
  {
    label: 'store read',
    from: '  const initialMode = await store.read()',
    to: "  const initialMode = await store.read()\n  __bc(`STORE READ mode=${initialMode}`)",
  },
  {
    label: 'pre-step listener',
    from: "  own('peak-hours: agent/pre-step gate', () => ctx.on('agent/pre-step', onPreStep, { global: true, prepend: true }))",
    to: "  __bc('registering listeners')\n  own('peak-hours: agent/pre-step gate', () => ctx.on('agent/pre-step', onPreStep, { global: true, prepend: true }))\n  __bc('pre-step listener ok')\n  own('peak-hours: tools/pre-execute gate', () => ctx.on('tools/pre-execute', onPreExecute, { global: true, prepend: true }))\n  __bc('tool listener ok')",
    dropNext: true,
  },
  {
    label: 'routes',
    from: "  own('peak-hours: routes', () => {",
    to: "  __bc('registering routes')\n  own('peak-hours: routes', () => {",
  },
  {
    label: 'mount complete',
    from: '  return { gate, clock, store, handlers, core: core.source, version, allowClockOverride }',
    to: "  __bc('MOUNT COMPLETE')\n  return { gate, clock, store, handlers, core: core.source, version, allowClockOverride }",
  },
]

const missing = []
for (const { label, from, to, dropNext } of replacements) {
  if (!text.includes(from)) {
    missing.push(label)
    continue
  }
  text = text.replace(from, to)
  if (dropNext) {
    // remove the now-duplicated original tools/pre-execute line that followed
    const dup = "  __bc('pre-step listener ok')\n  own('peak-hours: tools/pre-execute gate', () => ctx.on('tools/pre-execute', onPreExecute, { global: true, prepend: true }))\n  __bc('tool listener ok')\n  own('peak-hours: tools/pre-execute gate', () => ctx.on('tools/pre-execute', onPreExecute, { global: true, prepend: true }))"
    const fixed = "  __bc('pre-step listener ok')\n  own('peak-hours: tools/pre-execute gate', () => ctx.on('tools/pre-execute', onPreExecute, { global: true, prepend: true }))\n  __bc('tool listener ok')"
    text = text.replace(dup, fixed)
  }
}

writeFileSync(file, text)
console.log(missing.length === 0 ? 'INSTRUMENTED OK' : `MISSING PATTERNS: ${missing.join(', ')}`)
