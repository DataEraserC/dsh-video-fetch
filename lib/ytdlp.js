// yt-dlp download invocation: pure arg-building plus one bounded run.
//
// Argument shape is built by buildFetchArgs (pure, unit-tested); the binary
// name comes from config as a bare `yt-dlp` so the NUR wrapper's runtimeDeps
// PATH resolution decides the actual binary — no paths are hard-coded here.

import { join } from 'node:path'
import { parseFetchedPath, resolveBin, runBin, stderrTail } from './proc.js'

/**
 * Build the yt-dlp argv for one fetch.
 * @param {object} options - fetch options.
 * @param {string} options.url - video page URL.
 * @param {string} options.outDir - download directory.
 * @param {string} options.format - yt-dlp -f format selector.
 * @param {boolean} [options.merging] - add --merge-output-format mp4.
 * @param {string} [options.cookiesPath] - Netscape cookie file (logged-in quality).
 * @param {boolean} [options.noPlaylist] - add --no-playlist.
 * @returns {string[]} argv.
 */
export function buildFetchArgs({ url, outDir, format, merging = true, cookiesPath = '', noPlaylist = true }) {
  const template = join(outDir, '%(title).80s [%(id)s].%(ext)s')
  const args = [
    '--no-progress',
    '--newline',
    '--print', 'after_move:filepath',
    '--output', template,
    '--format', format,
  ]
  if (merging) args.push('--merge-output-format', 'mp4')
  if (noPlaylist) args.push('--no-playlist')
  if (cookiesPath) args.push('--cookies', cookiesPath)
  args.push('--', url) // `--` keeps a URL that starts with '-' from becoming a flag
  return args
}

/**
 * Download one URL with yt-dlp.
 * @param {object} options - see buildFetchArgs plus timeoutMs/binary.
 * @param {string} [options.binary] - yt-dlp binary name/path (default `yt-dlp`).
 * @param {number} options.timeoutMs - hard deadline.
 * @returns {Promise<{path: string}>} absolute file path (a fresh download and
 *   a skip — file already present — look identical under --print, which is
 *   fine: either way this is the usable file and nothing was re-downloaded).
 * @throws on non-zero exit, timeout, or an unparseable result.
 */
export async function fetchVideo({ url, outDir, format, merging = true, cookiesPath = '', noPlaylist = true, binary = 'yt-dlp', timeoutMs }) {
  const args = buildFetchArgs({ url, outDir, format, merging, cookiesPath, noPlaylist })
  const result = await runBin(resolveBin(binary), args, { timeoutMs })
  if (result.timedOut) throw new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`)
  const path = parseFetchedPath(result.stdout)
  if (result.code !== 0) {
    if (path) return { path } // partial log noise but a usable file
    throw new Error(`yt-dlp exited ${result.code}: ${stderrTail(result.stderr) || stderrTail(result.stdout) || 'no output'}`)
  }
  if (!path) throw new Error(`yt-dlp produced no output path: ${stderrTail(result.stdout) || '(empty stdout)'}`)
  return { path }
}
