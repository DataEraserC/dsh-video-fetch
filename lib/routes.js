// Web routes behind the Plugins-page card: settings form state is served by
// the official `plugins.row.config` form (no route needed), while login and the
// QR image need their own endpoints because they are not configuration.
//
// Two carriers, same handlers: the browser reaches them as /video-fetch/* on
// the web host, and as /api/video-fetch/* through the desktop connection.
//
// ## What changed
//
// The old route table had one login endpoint and it hard-coded a single
// provider's `generateQr()`, so the page could only ever offer "bilibili, by QR
// code" — and `state.sites[0]` was rendered without ever saying *which* site it
// was. Both problems came from the login surface being a single method instead
// of a **channel × method** product:
//
//   * channel — which site (bilibili, douyin, youtube, tencent, iqiyi, youku);
//   * method  — how the credential arrives (`qr`, `manual`, `sms`, `password`,
//     `browser`).
//
// Every route now takes a channel, and the picker the page renders is built from
// the registry's own advertisement — each channel carries its display name and
// the full method list with `implemented` flags, so an unsupported method is a
// structured refusal rather than a missing button.
//
// Secret boundary: no cookie value ever leaves these handlers. Login state, the
// account label, the identity the site reported, and a cookie *count* are all a
// caller gets. The one route that accepts cookie text is `import`, inbound only.

import QRCode from 'qrcode'

import { call, nativeStatus } from './native.js'
import { EDITABLE, EDITABLE_KEYS, applyPatch, coercePatch, plain, resetFields, snapshot } from './settings.js'

/** Longest QR payload we will rasterise, so a hostile URL cannot make us churn. */
const MAX_QR_INPUT = 4096

/**
 * Read a JSON request body.
 * @param {object} req - node request or the connection shim.
 * @returns {Promise<object>} parsed body, {} when absent or unparseable.
 */
async function jsonBody(req) {
  if (req.body !== undefined && req.body !== null) return req.body
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Write a JSON response.
 * @param {object} res - node response or the connection shim.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable value.
 */
function json(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Map a failure onto an HTTP status.
 *
 * `unavailable` is its own class because it is not the caller's fault and not a
 * crash — it means the native library is missing, and the page says so with the
 * remedy attached instead of a bare 400.
 * @param {object} error - a `NativeError` or anything else.
 * @returns {number} HTTP status.
 */
function statusOf(error) {
  const code = error && error.code
  if (code === 'unavailable') return 503
  if (code === 'bad_body' || code === 'internal') return 500
  return 400
}

/**
 * Write one failure response.
 * @param {object} res - node response or the connection shim.
 * @param {object} error - the thrown error.
 * @param {string} op - operation name, for the log line.
 */
function fail(res, error, op) {
  json(res, statusOf(error), { ok: false, error: error.message, code: error.code ?? 'other', op })
}

/**
 * Build the route table.
 * @param {object} ctx - host plugin context.
 * @param {object} config - live resolved config (volatile refs).
 * @returns {Array<{path: string, handler: (req: object, res: object) => Promise<void>}>}
 */
export function buildRoutes(ctx, config) {
  /**
   * Everything the page needs for one paint: the editable settings, the field
   * table, and each channel's advertisement plus its account pool.
   */
  const stateHandler = async (_req, res) => {
    const native = nativeStatus()
    let channels = []
    // A missing library must not blank the whole page: settings still render,
    // and the login card explains why it cannot be used.
    if (!native.available) {
      json(res, 200, { settings: snapshot(config), fields: fieldTable(), channels: [], native })
      return
    }
    try {
      channels = (await call('status')) ?? []
    } catch (error) {
      fail(res, error, 'status')
      return
    }
    json(res, 200, { settings: snapshot(config), fields: fieldTable(), channels, native })
  }

  const setHandler = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const patch = coercePatch(body.patch)
      await applyPatch(ctx, patch)
      json(res, 200, { ok: true, applied: patch, settings: snapshot(config) })
    } catch (error) {
      fail(res, error, 'set')
    }
  }

  const resetHandler = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const fields = Array.isArray(body.fields) && body.fields.length > 0
        ? body.fields.map(String)
        : [...EDITABLE_KEYS]
      await resetFields(ctx, fields)
      json(res, 200, { ok: true, reset: fields, settings: snapshot(config) })
    } catch (error) {
      fail(res, error, 'reset')
    }
  }

  /**
   * One channel's pool. `channel` is optional; without it the caller gets the
   * first advertised channel, which is what a page asks for before the user has
   * picked anything.
   */
  const loginStatus = async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const channel = url.searchParams.get('channel')
    try {
      const all = (await call('status')) ?? []
      const found = channel === null ? all[0] : all.find((entry) => entry.channel.id === channel)
      if (!found) {
        json(res, 400, { ok: false, error: `unknown channel "${channel}"` })
        return
      }
      json(res, 200, { ok: true, channel: found.channel, accounts: found.accounts, active: found.active })
    } catch (error) {
      fail(res, error, 'status')
    }
  }

  /**
   * Begin a login. `method` decides what comes back: a QR challenge to render
   * and poll, a field list to fill and submit, or a browser to open.
   */
  const loginStart = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const result = await call('start', {
        channel: String(body.channel ?? ''),
        method: String(body.method ?? 'qr'),
        params: body.params ?? {},
        label: body.label === undefined ? null : String(body.label),
      })
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      fail(res, error, 'start')
    }
  }

  /** Open a real browser for the channel and wait for the user to sign in. */
  const loginBrowse = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const result = await call('browse', { channel: String(body.channel ?? '') })
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      fail(res, error, 'browse')
    }
  }

  /** Advance a login that needs no further input (a QR scan). */
  const loginPoll = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const result = await call('poll', { sessionId: String(body.sessionId ?? '') })
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      fail(res, error, 'poll')
    }
  }

  /** Advance a login with user-supplied input (an SMS code, a password). */
  const loginSubmit = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const result = await call('submit', {
        sessionId: String(body.sessionId ?? ''),
        params: body.params ?? {},
      })
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      fail(res, error, 'submit')
    }
  }

  /**
   * Import a finished credential: a pasted Netscape cookie file or a `Cookie:`
   * header. Inbound only — nothing here ever echoes cookie text back.
   */
  const loginImport = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const text = String(body.cookies ?? '')
      if (text.trim() === '') throw Object.assign(new Error('cookies is empty'), { code: 'bad_request' })
      if (text.length > 512 * 1024) {
        throw Object.assign(new Error('cookies too large (max 512 KB)'), { code: 'bad_request' })
      }
      const account = await call('import', {
        channel: String(body.channel ?? ''),
        method: 'manual',
        cookies: text,
        label: String(body.label ?? ''),
      })
      json(res, 200, { ok: true, account })
    } catch (error) {
      fail(res, error, 'import')
    }
  }

  /** Pin an account as the credential a download will use. */
  const loginPin = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const account = await call('pin', {
        channel: String(body.channel ?? ''),
        account: String(body.account ?? ''),
      })
      json(res, 200, { ok: true, account })
    } catch (error) {
      fail(res, error, 'pin')
    }
  }

  /** Drop one account's cookies. */
  const loginLogout = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const removed = await call('logout', {
        channel: String(body.channel ?? ''),
        account: String(body.account ?? ''),
      })
      json(res, 200, { ok: true, removed })
    } catch (error) {
      fail(res, error, 'logout')
    }
  }

  /** Probe one account and record whether the site still accepts it. */
  const loginCheck = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const account = await call('check', {
        channel: String(body.channel ?? ''),
        account: body.account === undefined ? null : String(body.account),
      })
      json(res, 200, { ok: true, account })
    } catch (error) {
      fail(res, error, 'check')
    }
  }

  /** Abandon a login in flight, killing its browser if it owns one. */
  const loginCancel = async (req, res) => {
    try {
      const body = await jsonBody(req)
      await call('cancel', { sessionId: String(body.sessionId ?? '') })
      json(res, 200, { ok: true, cancelled: true })
    } catch (error) {
      fail(res, error, 'cancel')
    }
  }

  /**
   * Rasterise a QR payload to PNG for channels that hand back a URL rather
   * than a pre-rendered image (bilibili, douyin, iQiyi). Channels that return an
   * image (Tencent's `ptqrshow`) skip this entirely — the data URL they return
   * goes straight into an `<img>`.
   */
  const challengeImage = async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const data = url.searchParams.get('data') ?? ''
    try {
      if (data === '' || data.length > MAX_QR_INPUT) {
        throw Object.assign(new Error('missing or oversized QR payload'), { code: 'bad_request' })
      }
      const png = await QRCode.toBuffer(data, { width: 360, margin: 1 })
      res.statusCode = 200
      res.setHeader('content-type', 'image/png')
      res.setHeader('cache-control', 'no-store')
      res.end(png)
    } catch {
      json(res, 400, { ok: false, error: 'no scannable QR payload' })
    }
  }

  return [
    { path: '/video-fetch/state', handler: stateHandler },
    { path: '/video-fetch/set', handler: setHandler },
    { path: '/video-fetch/reset', handler: resetHandler },
    { path: '/video-fetch/login/status', handler: loginStatus },
    { path: '/video-fetch/login/start', handler: loginStart },
    { path: '/video-fetch/login/browse', handler: loginBrowse },
    { path: '/video-fetch/login/poll', handler: loginPoll },
    { path: '/video-fetch/login/submit', handler: loginSubmit },
    { path: '/video-fetch/login/import', handler: loginImport },
    { path: '/video-fetch/login/pin', handler: loginPin },
    { path: '/video-fetch/login/logout', handler: loginLogout },
    { path: '/video-fetch/login/check', handler: loginCheck },
    { path: '/video-fetch/login/cancel', handler: loginCancel },
    { path: '/video-fetch/challenge', handler: challengeImage },
  ]
}

/**
 * The editable-field table the page renders.
 * @returns {Array<object>} key/type/enum/min/max/label/hint rows.
 */
function fieldTable() {
  return EDITABLE_KEYS.map((key) => ({
    key,
    type: EDITABLE[key].type,
    enum: EDITABLE[key].enum,
    min: EDITABLE[key].min,
    max: EDITABLE[key].max,
    label: EDITABLE[key].label,
    hint: EDITABLE[key].hint,
  }))
}

/** Volatile-field read helper shared with the client copy. */
export { plain }
