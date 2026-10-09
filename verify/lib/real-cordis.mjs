// verify/lib/real-cordis.mjs — boot the REAL cordis runtime extracted from the shipped app.
//
// `_recon/src/cordis/lib/index.js` is the vendored @deepseek-ai/cordis 4.0.4 bundle with exactly
// one external import: `@deepseek-ai/cosmokit`. We copy it VERBATIM (byte-identical) into a
// throwaway directory and place a one-line re-export shim for cosmokit beside it, so the bare
// specifier resolves and nothing else about the runtime changes. This lets the verifier drive the
// plugin with real fiber/inject/effect/event semantics instead of a hand-written ctx mock.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const RECON_CORDIS = new URL('../../_recon/src/cordis/lib/index.js', import.meta.url)
const COSMOKIT_ENTRY = 'C:/Users/81521/.dsh/profiles/desktop/node_modules/@deepseek-ai/cosmokit/lib/index.js'

/** Path of the vendored runtime we boot, for evidence. */
export const cordisSourcePath = RECON_CORDIS.pathname.replace(/^\//, '')

export async function loadRealCordis() {
  const dir = mkdtempSync(join(tmpdir(), 'peak-real-cordis-'))
  const cordisDir = join(dir, 'cordis')
  const shimDir = join(cordisDir, 'node_modules', '@deepseek-ai', 'cosmokit')
  mkdirSync(join(shimDir, 'lib'), { recursive: true })

  const original = readFileSync(RECON_CORDIS, 'utf8')
  const codisCopy = join(cordisDir, 'cordis.mjs')
  copyFileSync(RECON_CORDIS, codisCopy)
  const copied = readFileSync(codisCopy, 'utf8')
  if (copied !== original) throw new Error('real-cordis: the copy is not byte-identical to the shipped bundle')

  writeFileSync(join(shimDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/cosmokit', version: '1.8.5', type: 'module', main: 'lib/index.js',
  }), 'utf8')
  writeFileSync(join(shimDir, 'lib', 'index.js'),
    `export * from ${JSON.stringify(pathToFileURL(COSMOKIT_ENTRY).href)}\n`, 'utf8')

  const mod = await import(pathToFileURL(codisCopy).href)
  // The copy is fully evaluated by now, so the throwaway directory can go when the process ends.
  // Registered on 'exit' so it also runs for `process.exit()`, so runs never leak temp litter.
  process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } })
  return { ...mod, __dir: dir, __shim: shimDir, __byteIdentical: true }
}

/**
 * A `webServer` stub that mirrors the shipped implementation's contract, including the
 * duplicate-(kind,path) throw at _recon/src/dsh-host-webserver/lib/index.js:179.
 */
export function makeWebServerStub() {
  const exact = new Map()
  const prefixes = new Map()
  const disposed = []
  return {
    exact, prefixes, disposed,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      const dispose = () => { table.delete(route.path); disposed.push(route.path) }
      return dispose
    },
    /** Invoke a registered route handler the way the shipped server would. */
    async call(path, { method = 'GET', body } = {}) {
      const route = exact.get(path)
      if (!route) return { status: 401, body: { error: 'unauthorized (unregistered route fallback)' } }
      if (method !== undefined && route.method && route.method !== method) return { status: 405, body: {} }
      let status = 200
      let payload = null
      const res = {
        headersSent: false,
        setHeader() {},
        writeHead(code) { status = code; this.headersSent = true },
        end(text) { if (text !== undefined) payload = JSON.parse(text) },
      }
      const req = { method, headers: {}, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
      await route.handler(req, res)
      return { status, body: payload }
    },
  }
}

/** A `timer` stub with the shipped service's `timeout(callback, delay) => cancel` contract. */
export function makeTimerStub() {
  const live = new Set()
  return {
    live,
    timeout(callback, delay) {
      const handle = setTimeout(() => { live.delete(handle); callback() }, delay)
      const cancel = () => { clearTimeout(handle); live.delete(handle) }
      live.add(handle)
      return cancel
    },
  }
}
