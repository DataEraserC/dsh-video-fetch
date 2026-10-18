// Web routes behind the Plugins-page card: settings form state is served by
// the official `plugins.row.config` form (no route needed), while login and
// the QR image need their own endpoints because they are not configuration.
//
// Two carriers, same handlers: the browser reaches them as /video-fetch/* on
// the web host, and as /api/video-fetch/* through the desktop connection.
// Secret boundary: no cookie value ever leaves these handlers — only login
// state, the account name, and jar counts.

import { readFileSync } from 'node:fs'

import { ALL_METHODS, METHOD_ACTIONS, providerBySite, siteNames } from './auth/index.js'
import { addJar, headerFromNetscape, parseSetCookies, readJars, removeJars, toNetscape } from './cookies.js'
import { clearLoginState, qrPath, readLoginState, writeLoginState } from './loginstate.js'
import { EDITABLE, EDITABLE_KEYS, applyPatch, coercePatch, plain, resetFields, snapshot } from './settings.js'

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
 * Build the route table.
 * @param {object} ctx - host plugin context.
 * @param {object} config - live resolved config (volatile refs).
 * @returns {Array<{path: string, handler: (req: object, res: object) => Promise<void>}>}
 */
export function buildRoutes(ctx, config) {
  /** Current editable values plus the field table the page renders. */
  const stateHandler = async (_req, res) => {
    json(res, 200, {
      settings: snapshot(config),
      fields: EDITABLE_KEYS.map((key) => ({
        key,
        type: EDITABLE[key].type,
        enum: EDITABLE[key].enum,
        min: EDITABLE[key].min,
        max: EDITABLE[key].max,
        label: EDITABLE[key].label,
        hint: EDITABLE[key].hint,
      })),
      sites: siteNames().map((site) => {
        const jars = readJars(site)
        return { site, jars: jars.length, newest: jars[0]?.createdAt }
      }),
    })
  }

  const setHandler = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const patch = coercePatch(body.patch)
      await applyPatch(ctx, patch)
      json(res, 200, { ok: true, applied: patch, settings: snapshot(config) })
    } catch (error) {
      json(res, 400, { ok: false, error: error.message })
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
      json(res, 400, { ok: false, error: error.message })
    }
  }

  const loginStatus = async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const site = url.searchParams.get('site') ?? siteNames()[0]
    const provider = providerBySite(site)
    if (provider === null) {
      json(res, 400, { ok: false, error: `unknown site "${site}"` })
      return
    }
    const jars = readJars(site)
    if (jars.length === 0) {
      json(res, 200, { ok: true, site, loggedIn: false, jars: 0, methods: provider.methods })
      return
    }
    const status = await provider.checkLogin(headerFromNetscape(jars[0].data))
    json(res, 200, {
      ok: true,
      site,
      loggedIn: status.loggedIn,
      uname: status.uname,
      level: status.level,
      jars: jars.length,
      pending: readLoginState(site) !== null,
      methods: provider.methods,
    })
  }

  const loginStart = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const site = String(body.site ?? siteNames()[0])
      const provider = providerBySite(site)
      if (provider === null) throw new Error(`unknown site "${site}"`)
      const { url, key } = await provider.generateQr()
      const png = qrPath(site)
      await provider.renderQrPng(png, url)
      writeLoginState(site, { key, url, createdAt: Date.now() })
      json(res, 200, { ok: true, site, qr: `/video-fetch/qr?site=${encodeURIComponent(site)}&t=${Date.now()}`, url })
    } catch (error) {
      json(res, 400, { ok: false, error: error.message })
    }
  }

  const loginPoll = async (req, res) => {
    try {
      const body = await jsonBody(req)
      const site = String(body.site ?? siteNames()[0])
      const provider = providerBySite(site)
      if (provider === null) throw new Error(`unknown site "${site}"`)
      const state = readLoginState(site)
      if (state?.key === undefined) {
        json(res, 200, { ok: true, state: 'none', message: 'no pending QR — start a new login' })
        return
      }
      const result = await provider.pollQr(state.key)
      if (result.code === provider.POLL.OK) {
        if (result.setCookies.length > 0) {
          addJar(site, {
            source: 'qr',
            data: toNetscape(parseSetCookies(result.setCookies), provider.cookieDomain),
          })
        }
        clearLoginState(site)
        const jars = readJars(site)
        const status = await provider.checkLogin(jars.length > 0 ? headerFromNetscape(jars[0].data) : '')
        json(res, 200, {
          ok: true,
          state: 'ok',
          loggedIn: status.loggedIn,
          uname: status.uname,
          level: status.level,
          jars: jars.length,
        })
        return
      }
      if (result.code === provider.POLL.EXPIRED) {
        clearLoginState(site)
        json(res, 200, { ok: true, state: 'expired', message: 'QR expired — start a new login' })
        return
      }
      json(res, 200, {
        ok: true,
        state: result.code === provider.POLL.SCANNED ? 'scanned' : 'waiting',
        message: result.code === provider.POLL.SCANNED ? 'scanned, confirm in the app' : 'waiting for the scan',
      })
    } catch (error) {
      json(res, 400, { ok: false, error: error.message })
    }
  }

  const loginLogout = async (req, res) => {
    const body = await jsonBody(req)
    const site = String(body.site ?? siteNames()[0])
    const removed = removeJars(site)
    clearLoginState(site)
    json(res, 200, { ok: true, site, removed })
  }

  const qrImage = async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const site = url.searchParams.get('site') ?? siteNames()[0]
    try {
      const bytes = readFileSync(qrPath(site))
      res.statusCode = 200
      res.setHeader('content-type', 'image/png')
      res.setHeader('cache-control', 'no-store')
      res.end(bytes)
    } catch {
      json(res, 404, { ok: false, error: 'no QR code yet — start a login first' })
    }
  }

  return [
    { path: '/video-fetch/state', handler: stateHandler },
    { path: '/video-fetch/set', handler: setHandler },
    { path: '/video-fetch/reset', handler: resetHandler },
    { path: '/video-fetch/login/status', handler: loginStatus },
    { path: '/video-fetch/login/start', handler: loginStart },
    { path: '/video-fetch/login/poll', handler: loginPoll },
    { path: '/video-fetch/login/logout', handler: loginLogout },
    { path: '/video-fetch/qr', handler: qrImage },
  ]
}

/** Methods the page may offer, for documentation symmetry with video_login. */
export const LOGIN_METHODS = ALL_METHODS
/** Per-method action matrix, re-exported for the page's copy. */
export const LOGIN_ACTIONS = METHOD_ACTIONS
/** Volatile-field read helper shared with the client copy. */
export { plain }
