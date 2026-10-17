// Bilibili QR login: generate → scan → poll → Netscape cookies.txt for yt-dlp.
//
// Secrets boundary: SESSDATA/bili_jct live only in `cookies.txt` (mode 0600)
// and in request Cookie headers this file builds. Nothing here ever returns a
// cookie value to a tool result or a log line — status reports isLogin/uname
// from the read-only nav API, nothing more.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 dsh-video-fetch/0.1.0'
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
 * Parse raw Set-Cookie header lines into cookie records.
 * @param {string[]} lines - Set-Cookie header values.
 * @returns {Array<{name: string, value: string, domain: string, path: string,
 *   expires: number, secure: boolean, httpOnly: boolean}>}
 */
export function parseSetCookies(lines) {
  const out = []
  for (const line of lines ?? []) {
    const [pair, ...attrs] = String(line).split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const record = {
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      domain: '',
      path: '/',
      expires: 0,
      secure: false,
      httpOnly: false,
    }
    let maxAge = null
    for (const attr of attrs) {
      const [rawKey, ...rest] = attr.split('=')
      const key = rawKey.trim().toLowerCase()
      const value = rest.join('=').trim()
      if (key === 'domain') record.domain = value
      else if (key === 'path') record.path = value || '/'
      else if (key === 'expires') record.expires = Math.max(0, Math.floor(Date.parse(value) / 1000) || 0)
      else if (key === 'max-age') maxAge = Number(value)
      else if (key === 'secure') record.secure = true
      else if (key === 'httponly') record.httpOnly = true
    }
    if (maxAge !== null && Number.isFinite(maxAge)) record.expires = Math.max(0, Math.floor(Date.now() / 1000) + maxAge)
    if (!record.name) continue
    out.push(record)
  }
  return out
}

/**
 * Serialize cookies to the Netscape format yt-dlp's `--cookies` reads.
 * @param {Array<object>} cookies - records from parseSetCookies.
 * @param {string} fallbackDomain - request host when a cookie carries no Domain.
 * @returns {string} file contents (ends with a newline).
 */
export function toNetscape(cookies, fallbackDomain = 'bilibili.com') {
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies) {
    const domain = c.domain || fallbackDomain
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const prefix = c.httpOnly ? '#HttpOnly_' : ''
    lines.push([`${prefix}${domain}`, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', c.expires ?? 0, c.name, c.value].join('\t'))
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write cookies.txt (mode 0600).
 * @param {string} path - target file path.
 * @param {string} contents - Netscape file contents.
 * @returns {void}
 */
export function writeCookies(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/**
 * Read cookies.txt as a Cookie request header.
 * @param {string} path - cookie file path.
 * @returns {string} `a=b; c=d` or '' when absent/empty.
 */
export function cookieHeader(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return ''
  }
  const pairs = []
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) {
      // #HttpOnly_ lines still hold real cookies.
      if (!line.startsWith('#HttpOnly_')) continue
    }
    const cols = line.replace(/^#HttpOnly_/, '').split('\t')
    if (cols.length >= 7) pairs.push(`${cols[5]}=${cols[6]}`)
  }
  return pairs.join('; ')
}

/**
 * Read-only login check against the nav API.
 * @param {string} cookieHeader_ - Cookie header from cookieHeader().
 * @returns {Promise<{loggedIn: boolean, uname: string, level: number}>}
 */
export async function navStatus(cookieHeader_) {
  if (!cookieHeader_) return { loggedIn: false, uname: '', level: 0 }
  try {
    const res = await apiGet(NAV_URL, { cookie: cookieHeader_ })
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
