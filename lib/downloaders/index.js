// Download engines — the seam between "download this URL" and "how".
//
// ## Why this indirection exists
//
// yt-dlp is the only engine wired up today. It is a good default: one binary,
// hundreds of sites, no per-site code here. But it is also a single upstream
// that reverse-engineers every site it supports, so a site that changes its
// player breaks the whole plugin until upstream ships a fix.
//
// So the plugin talks to a `Downloader` instead of to yt-dlp. The contract is
// deliberately tiny — small enough that a second engine is one file plus one
// registry entry, and small enough that it will survive the next engine too.
//
//     {
//       id:    string,                 // stable key, used in config and logs
//       label: string,                 // human label for pickers
//       available(): Promise<boolean>, // can this engine run here?
//       fetch(opts): Promise<{ path, engine }>,
//     }
//
// `fetch` gets `{ url, outDir, format, cookiesPath, timeoutMs }` and resolves
// to an absolute `path`. Two rules it must keep:
//
//   * the file lands inside `outDir` (the plugin confines downloads to the
//     session workspace upstream of here, and a new engine must not widen it);
//   * cookie text is read from `cookiesPath` and never echoed into the result —
//     only the path and the file.
//
// ## The reserved engine
//
// `native.js` is an intentionally empty slot for a yt-dlp-independent engine.
// It is unused, and it must stay. See the header comment in that file for the
// reasoning and for what filling it in requires.

import { nativeDownloader } from './native.js'
import { ytdlpDownloader } from './ytdlp.js'

/** Every engine, in the order `download` tries them. */
const ENGINES = [ytdlpDownloader, nativeDownloader]

/** Machine ids of every engine, for the config enum and the web picker. */
export const ENGINE_IDS = Object.freeze(ENGINES.map((engine) => engine.id))

/** @returns {object} the engine registered under `id`. @throws when unknown. */
export function engineOf(id) {
  const engine = ENGINES.filter((candidate) => candidate.id === id)[0]
  if (!engine) {
    throw new Error(`unknown download engine "${id}" (known: ${ENGINES.map((e) => e.id).join(', ')})`)
  }
  return engine
}

/**
 * The engines, with availability resolved, for a picker or a status line.
 * @returns {Promise<Array<{id: string, label: string, available: boolean}>>}
 */
export async function listDownloaders() {
  const rows = []
  for (const engine of ENGINES) {
    let available = false
    try {
      available = await engine.available()
    } catch {
      available = false
    }
    rows.push({ id: engine.id, label: engine.label, available })
  }
  return rows
}

/**
 * Download with one engine, rotating through the channel's accounts.
 *
 * Accounts arrive pinned-first (see `Hub::accounts`), so the normal path is a
 * single attempt with the account the user chose; the rest are the fallback
 * when that account has expired upstream and the site rejects the download.
 * Only the account is varied — never the URL and never the output directory.
 *
 * @param {object} options - download options.
 * @param {object} options.engine - the `Downloader` to run.
 * @param {string} options.url - video page URL.
 * @param {string} options.outDir - absolute output directory.
 * @param {string} options.format - format selector.
 * @param {Array<{id: string}>} [options.accounts] - accounts to try, pinned first.
 * @param {(accountId: string) => Promise<string>} [options.materialize] - writes one
 *   account's cookies to a 0600 file and returns its path.
 * @param {number} options.timeoutMs - hard deadline spanning every attempt.
 * @returns {Promise<{path: string, engine: string, accountId: string|null, attempt: number}>}
 * @throws the LAST error when every account was rejected.
 */
export async function download({ engine, url, outDir, format, accounts = [], materialize, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  let last = null
  // No stored account is still one attempt — just without cookies.
  const order = accounts.length > 0 ? accounts : [null]
  for (let index = 0; index < order.length; index += 1) {
    const account = order[index]
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const cookiesPath = account === null || !materialize ? '' : await materialize(account.id)
      const value = await engine.fetch({ url, outDir, format, cookiesPath, timeoutMs: remaining })
      return {
        path: value.path,
        engine: value.engine ?? engine.id,
        accountId: account === null ? null : account.id,
        attempt: index,
      }
    } catch (error) {
      last = error
    }
  }
  throw last ?? new Error('download had nothing to try')
}
