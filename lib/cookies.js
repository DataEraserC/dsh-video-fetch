// Cookie handling: the Netscape codec plus the per-site cookie-jar array.
//
// Storage layout under stateDir():
//   cookies/<site>.json      the jar array: [{source, createdAt, data}, …]
//   cookies/<site>.jar.txt   the selected jar, materialized for yt-dlp
//
// Secrets boundary: `data` (SESSDATA & co.) lives only in those 0600 files.
// Nothing here ever returns a cookie value to a tool result or a log line —
// only counts, indexes, and the provider's read-only login check leave this
// module.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { stateDir } from './state.js'

/** How many jars one site keeps before the oldest is dropped. */
export const MAX_JARS = 5

function cookiesDir() {
  return join(stateDir(), 'cookies')
}

/** The jar-array file for a site. @param {string} site */
export function jarPath(site) {
  return join(cookiesDir(), `${site}.json`)
}

/** The materialized jar handed to yt-dlp. @param {string} site */
function selectedJarPath(site) {
  return join(cookiesDir(), `${site}.jar.txt`)
}

/**
 * Read a site's jar array.
 * @param {string} site
 * @returns {Array<{source: string, createdAt: number, data: string}>}
 *   newest first; [] when the site has none (or the file is unreadable).
 */
export function readJars(site) {
  try {
    const jars = JSON.parse(readFileSync(jarPath(site), 'utf8'))
    return Array.isArray(jars) ? jars : []
  } catch {
    return []
  }
}

/**
 * Prepend a jar (newest first), enforcing MAX_JARS. An identical jar is not
 * stored twice.
 * @param {string} site
 * @param {{source: string, data: string}} jar - source: 'qr' | 'manual';
 *   data: Netscape file contents.
 * @returns {{index: number, total: number, trimmed: boolean, duplicate: boolean}}
 *   index is 1-based; duplicate means nothing was written.
 */
export function addJar(site, { source, data }) {
  const jars = readJars(site)
  const existing = jars.findIndex((jar) => jar.data === data)
  if (existing >= 0) return { index: existing + 1, total: jars.length, trimmed: false, duplicate: true }
  jars.unshift({ source, createdAt: Date.now(), data })
  const trimmed = jars.length > MAX_JARS
  while (jars.length > MAX_JARS) jars.pop()
  mkdirSync(cookiesDir(), { recursive: true, mode: 0o700 })
  writeFileSync(jarPath(site), JSON.stringify(jars), { mode: 0o600 })
  return { index: 1, total: jars.length, trimmed, duplicate: false }
}

/**
 * Delete a site's jar array and its materialized copy. Other sites are
 * untouched.
 * @param {string} site
 * @returns {number} jars removed (0 when the site had none).
 */
export function removeJars(site) {
  const removed = readJars(site).length
  for (const path of [jarPath(site), selectedJarPath(site)]) {
    try {
      rmSync(path)
    } catch { /* already gone */ }
  }
  return removed
}

/**
 * Materialize jar `index` (0-based) into the file yt-dlp reads.
 * @param {string} site
 * @param {number} index
 * @returns {string} absolute path of the 0600 Netscape file.
 */
export function materializeJar(site, index) {
  const jar = readJars(site)[index]
  if (!jar) throw new Error(`no cookie jar #${index + 1} for ${site}`)
  const path = selectedJarPath(site)
  mkdirSync(cookiesDir(), { recursive: true, mode: 0o700 })
  writeFileSync(path, jar.data, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

/**
 * Try jars in order until one attempt succeeds (fetch-time rotation): a jar
 * that the site rejects must not abort the download — the next jar is a
 * fresh chance. The deadline belongs to the caller, so stop() lets an
 * expired budget halt the rotation instead of starting another attempt.
 * @param {Array<{data: string}>} jars - from readJars.
 * @param {object} options
 * @param {(index: number) => string} options.useJar - materialize jar → path.
 * @param {(cookiesPath: string) => Promise<any>} options.attempt
 * @param {() => boolean} [options.stop] - checked before each attempt.
 * @returns {Promise<{value: any, index: number}>} index of the jar that worked.
 * @throws the last attempt's error when every jar fails or stop() halts first.
 */
export async function rotateJars(jars, { useJar, attempt, stop = () => false }) {
  let lastError = null
  for (let i = 0; i < jars.length; i += 1) {
    if (stop()) break
    try {
      return { value: await attempt(useJar(i)), index: i }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('no cookie jars available')
}

// ── Netscape codec ──────────────────────────────────────────────────────────

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
export function toNetscape(cookies, fallbackDomain) {
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
 * Count cookie rows in Netscape-format text (header/comments excluded).
 * @param {string} text - file contents.
 * @returns {number} 0 when the text carries no cookie rows at all.
 */
export function countNetscapeCookies(text) {
  let count = 0
  for (const line of String(text).split('\n')) {
    if (!line) continue
    if (line.startsWith('#HttpOnly_')) {
      if (line.split('\t').length >= 7) count += 1
      continue
    }
    if (line.startsWith('#')) continue
    if (line.split('\t').length >= 7) count += 1
  }
  return count
}

/**
 * Build a Cookie request header from Netscape-format text.
 * @param {string} text - file contents.
 * @returns {string} `a=b; c=d` or '' when there are no rows.
 */
export function headerFromNetscape(text) {
  const pairs = []
  for (const line of String(text).split('\n')) {
    if (!line) continue
    // #HttpOnly_ lines still hold real cookies; other comments do not.
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue
    const cols = line.replace(/^#HttpOnly_/, '').split('\t')
    if (cols.length >= 7) pairs.push(`${cols[5]}=${cols[6]}`)
  }
  return pairs.join('; ')
}
