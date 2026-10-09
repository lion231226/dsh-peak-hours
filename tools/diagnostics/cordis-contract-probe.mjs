/**
 * Empirically settle the real cordis contracts from INSIDE the shipped runtime
 * (app.asar), instead of a re-implemented harness:
 *   - what does ctx.on(...) return?
 *   - what does ctx.effect(cb) return, and what does it do with cb's return value?
 *   - does the "apply returns an object" pattern actually throw Invalid effect?
 */

const ASAR = 'C:/Users/81521/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'

const cordis = await import(`file:///${ASAR}/cordis/lib/index.js`)

const log = (...args) => console.log(...args)

async function mountPlugin(plugin, label) {
  const root = new cordis.Context()
  try {
    const fiber = root.plugin(plugin)
    await fiber.await()
    log(`${label}: fiber state = ${fiber.state ?? 'n/a'}`)
    return { ok: true }
  } catch (error) {
    log(`${label}: THREW ${error?.name}: ${error?.message}`)
    return { ok: false, error }
  }
}

// 1) What does ctx.on return?
await mountPlugin({
  name: 'probe-on',
  apply(ctx) {
    const fromOn = ctx.on('probe/event', () => {})
    log(`ctx.on -> typeof=${typeof fromOn} value=${String(fromOn)?.slice(0, 60)}`)
    const list = ctx.on('probe/event', () => {}, { global: true, prepend: true })
    log(`ctx.on(global) -> typeof=${typeof list} value=${String(list)?.slice(0, 60)}`)
    const fromEffect = ctx.effect(() => ctx.on('probe/event', () => {}), 'wrapped listener')
    log(`ctx.effect(() => ctx.on(...)) -> typeof=${typeof fromEffect} value=${String(fromEffect)?.slice(0, 60)}`)
    const fromEffectFn = ctx.effect(() => () => {}, 'plain disposer')
    log(`ctx.effect(() => () => {}) -> typeof=${typeof fromEffectFn}`)
    const fromEffectObj = ctx.effect(() => ({ dispose() {} }), 'object value')
    log(`ctx.effect(() => ({dispose(){}})) -> typeof=${typeof fromEffectObj} value=${String(fromEffectObj)?.slice(0, 60)}`)
  },
}, 'probe-on')

// 2) Does an async apply that resolves to an object break the FIRST mount?
await mountPlugin({
  name: 'probe-async-object',
  async apply() {
    return { surface: true }
  },
}, 'async apply -> object (first mount)')

// 3) And what about resolving to undefined?
await mountPlugin({
  name: 'probe-async-undefined',
  async apply() {
    return undefined
  },
}, 'async apply -> undefined')
