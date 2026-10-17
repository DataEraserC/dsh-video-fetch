// Bilibili provider: QR login API + read-only login check.
//
// One provider = one site in the registry (lib/auth/index.js). It owns the
// HTTP surface (generate → scan → poll → nav check); the cookie codec and
// the per-site jar storage live in lib/cookies.js.
//
// Secrets boundary: set-cookie lines from pollQr are secrets for the caller
// to store — this module returns them as-is and never logs a value; status
// reports isLogin/uname from the read-only nav API, nothing more.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Registry key; also the cookie-jar file name. */
export const site = 'bilibili'
/** URL host suffixes this provider owns (exact or dot-suffix match). */
export const hosts = ['bilibili.com', 'b23.tv']
/** Credential methods implemented today; the global enum reserves more. */
export const methods = ['qr', 'manual']
/** Fallback Netscape domain for cookies that arrive without Domain=. */
export const cookieDomain = 'bilibili.com'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 dsh-video-fetch'
const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

/** Poll codes returned in data.code by the bilibili qrcode poll endpoint. */
export const POLL = {
  OK: 0,
  WAITING: 86101, // 未扫码
  SCANNED: 86090, // 已扫码，待确认
  EXPIRED: 86038, // 已过期
}

/**
 * GET a bilibili API endpoint.
 * @param {string} url - request URL.
 * @param {{cookie?: string}} [options] - optional Cookie header.
 * @returns {Promise<Response>} the fetch Response (not yet parsed).
 */
async function apiGet(url, options = {}) {
  const headers = { 'user-agent': UA, accept: 'application/json' }
  if (options.cookie) headers.cookie = options.cookie
  return fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) })
}

/**
 * Request a fresh login QR code.
 * @returns {Promise<{url: string, key: string}>} scan URL and qrcode_key.
 */
export async function generateQr() {
  const res = await apiGet(GENERATE_URL)
  if (!res.ok) throw new Error(`bilibili qrcode generate: HTTP ${res.status}`)
  const body = await res.json()
  if (body.code !== 0) throw new Error(`bilibili qrcode generate: ${body.message ?? body.code}`)
  return { url: body.data.url, key: body.data.qrcode_key }
}

/**
 * Poll one login attempt once.
 * @param {string} key - qrcode_key from generateQr.
 * @returns {Promise<{code: number, message: string, setCookies: string[], redirectUrl: string}>}
 *   code is one of POLL.*; setCookies carries raw Set-Cookie header lines (callers
 *   must treat them as secrets).
 */
export async function pollQr(key) {
  const res = await apiGet(`${POLL_URL}?qrcode_key=${encodeURIComponent(key)}`)
  if (!res.ok) throw new Error(`bilibili qrcode poll: HTTP ${res.status}`)
  const body = await res.json()
  const data = body.data ?? {}
  let setCookies = res.headers.getSetCookie?.() ?? []
  // Some flows put the auth cookies on the redirect instead of the poll
  // response itself — harvest that too when the poll one is empty.
  if (setCookies.length === 0 && data.code === POLL.OK && data.url) {
    try {
      const hop = await apiGet(data.url)
      setCookies = hop.headers.getSetCookie?.() ?? []
    } catch { /* cookie harvest is best-effort; status API decides the truth */ }
  }
  return {
    code: Number(data.code ?? -1),
    message: String(data.message ?? ''),
    setCookies,
    redirectUrl: String(data.url ?? ''),
  }
}

/**
 * Read-only login check against the nav API.
 * @param {string} cookieHeader - Cookie header built by headerFromNetscape().
 * @returns {Promise<{loggedIn: boolean, uname: string, level: number}>}
 */
export async function checkLogin(cookieHeader) {
  if (!cookieHeader) return { loggedIn: false, uname: '', level: 0 }
  try {
    const res = await apiGet(NAV_URL, { cookie: cookieHeader })
    const body = await res.json()
    const data = body.data ?? {}
    return {
      loggedIn: Boolean(data.isLogin),
      uname: String(data.uname ?? ''),
      level: Number(data.level_info?.current_level ?? 0),
    }
  } catch {
    return { loggedIn: false, uname: '', level: 0 }
  }
}

/**
 * Render the login QR code to a PNG file.
 * @param {string} path - target PNG path.
 * @param {string} text - payload (the scan URL).
 * @returns {Promise<void>}
 */
export async function renderQrPng(path, text) {
  const { default: QRCode } = await import('qrcode')
  mkdirSync(dirname(path), { recursive: true })
  await QRCode.toFile(path, text, {
    margin: 1,
    width: 512,
    color: { dark: '#000000', light: '#ffffff' },
  })
}
