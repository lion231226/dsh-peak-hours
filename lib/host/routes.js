/**
 * dsh-peak-hours — HTTP route core (SPEC §2.3).
 *
 * Two layers, deliberately separated:
 *  1. {@link createHandlers} — framework-free business handlers. Each returns
 *     `{ status, body }` and never touches `req`/`res`, so the whole contract
 *     (field set, 4xx + `{ok:false,error}`, clock-override fence) is unit
 *     testable without a webserver.
 *  2. {@link createWebRoutes} — the thin adapter that turns those handlers into
 *     the `{ kind, path, handler(req, res) }` records the host webserver
 *     registers (verified against dsh-host-webserver/lib/index.js: `register()`
 *     stores `route.handler` and `handle()` calls `await route.handler(req, res)`).
 */

/** Route family root. */
export const API_ROOT = '/api/peak-hours'

/** Exact paths of the frozen surface. */
export const ROUTE_PATHS = Object.freeze({
  state: `${API_ROOT}/state`,
  mode: `${API_ROOT}/mode`,
  clock: `${API_ROOT}/clock`,
  health: `${API_ROOT}/health`,
})

/** Accepted mode literals. */
export const VALID_MODES = Object.freeze(['always', 'idle-only'])

/** Cap on JSON request bodies (all bodies here are tiny). */
export const MAX_JSON_BODY_BYTES = 64 * 1024

/** Render one value for an error message without throwing. */
function show(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Whether a value is a plain JSON object (arrays are not bodies here). */
function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Human-readable error text. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the framework-free route handlers.
 * @param options.snapshot - `() => state` (already synchronous-safe).
 * @param options.setMode - `async (mode) => void`.
 * @param options.setClock - `async (offsetMs, ttlMs) => void`; `offsetMs === null` clears.
 * @param options.allowClockOverride - whether `POST /clock` is honored.
 * @param options.pluginName - reported plugin id.
 * @param options.version - reported version.
 * @returns `{ state, mode, clock, health }`, each `async () => { status, body }`.
 */
export function createHandlers({
  snapshot,
  setMode,
  setClock,
  allowClockOverride = true,
  pluginName = 'dsh-peak-hours',
  version = '0.0.0',
} = {}) {
  if (typeof snapshot !== 'function') throw new TypeError('createHandlers requires snapshot()')
  const envelope = async () => ({ status: 200, body: { ok: true, state: await snapshot() } })
  const fail = (status, error) => ({ status, body: { ok: false, error } })

  return {
    /** GET /state → the SPEC §2.3 envelope. */
    async state() {
      return envelope()
    },
    /** POST /mode → validate, persist, re-evaluate the gate, echo the envelope. */
    async mode(body) {
      if (typeof setMode !== 'function') return fail(500, 'mode writes are not wired')
      if (!isJsonObject(body)) return fail(400, 'invalid body: expected a JSON object')
      if (!Object.hasOwn(body, 'mode')) return fail(400, 'invalid body: "mode" is required')
      if (!VALID_MODES.includes(body.mode)) {
        return fail(400, `invalid mode: ${show(body.mode)} (expected "always" or "idle-only")`)
      }
      await setMode(body.mode)
      return envelope()
    },
    /**
     * POST /clock → install or clear the manual override. Refused (403) when
     * the override is disabled, and TTL-bounded when accepted: pretending "now"
     * is a peak window must never strand held tasks (SPEC §2.3 addendum).
     */
    async clock(body) {
      if (allowClockOverride !== true) {
        return fail(403, 'clock override is disabled (DSH_PEAK_HOURS_ALLOW_CLOCK=0)')
      }
      if (typeof setClock !== 'function') return fail(500, 'clock writes are not wired')
      if (!isJsonObject(body)) return fail(400, 'invalid body: expected a JSON object')
      if (!Object.hasOwn(body, 'offsetMs')) return fail(400, 'invalid body: "offsetMs" is required')
      const { offsetMs } = body
      if (offsetMs !== null && !Number.isInteger(offsetMs)) {
        return fail(400, `invalid offsetMs: ${show(offsetMs)} (expected an integer or null)`)
      }
      let ttlMs
      if (Object.hasOwn(body, 'ttlMs') && body.ttlMs !== null && body.ttlMs !== undefined) {
        if (!Number.isInteger(body.ttlMs) || body.ttlMs <= 0) {
          return fail(400, `invalid ttlMs: ${show(body.ttlMs)} (expected a positive integer)`)
        }
        ttlMs = body.ttlMs
      }
      await setClock(offsetMs, ttlMs)
      return envelope()
    },
    /** GET /health → liveness without the state snapshot. */
    async health() {
      return { status: 200, body: { ok: true, plugin: pluginName, version } }
    },
  }
}

/** Whether the request comes from the local machine (mirrors the shipped plugins' fence). */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress
  if (address === undefined || address === null) return true
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req?.headers?.host
  if (typeof host !== 'string') return true
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** Read a JSON object body, or `undefined` when too large / unparseable / not an object. */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Write one JSON response. */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/**
 * Wrap one handler as a webserver route record.
 * @param options.kind - `exact` (default) or `prefix`.
 * @param options.path - exact pathname.
 * @param options.method - the single accepted HTTP method.
 * @param options.run - `async (req, res) => { status, body }`.
 * @param options.logger - optional logger for unexpected failures.
 * @returns a route record for `ctx.webServer.register`.
 */
function makeRoute({ kind = 'exact', path, method, run, logger = null }) {
  return {
    kind,
    path,
    handler: async (req, res) => {
      try {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        if ((req?.method ?? 'GET') !== method) {
          res.setHeader?.('allow', method)
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req?.method ?? ''} (expected ${method})` })
          return
        }
        let body
        if (method === 'POST') {
          body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { ok: false, error: 'invalid JSON body' })
            return
          }
        }
        const result = await run(body)
        writeJson(res, result.status, result.body)
      } catch (error) {
        try {
          logger?.warn?.(`[peak-hours] route ${method} ${path} failed: ${errorText(error)}`)
        } catch {
          /* ignore */
        }
        if (res.headersSent === true) {
          res.end()
          return
        }
        writeJson(res, 400, { ok: false, error: errorText(error) })
      }
    },
  }
}

/**
 * Build the four webserver route records.
 * @param handlers - {@link createHandlers} result.
 * @param options.logger - optional logger.
 * @returns route records for `ctx.webServer.register`.
 */
export function createWebRoutes(handlers, { logger = null } = {}) {
  return [
    makeRoute({ path: ROUTE_PATHS.state, method: 'GET', run: () => handlers.state(), logger }),
    makeRoute({ path: ROUTE_PATHS.mode, method: 'POST', run: (body) => handlers.mode(body), logger }),
    makeRoute({ path: ROUTE_PATHS.clock, method: 'POST', run: (body) => handlers.clock(body), logger }),
    makeRoute({ path: ROUTE_PATHS.health, method: 'GET', run: () => handlers.health(), logger }),
  ]
}
