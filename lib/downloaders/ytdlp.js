// yt-dlp downloader — the `Downloader` implementation that actually runs today.
//
// This is a thin adapter: argument construction and process handling already
// live in `lib/ytdlp.js` (pure, unit-tested), so this file only maps the
// generic downloader contract onto them.
//
// The binary is spawned by bare name (`yt-dlp`), so the packaged runtimeDeps
// PATH decides which one runs; no absolute path is hard-coded here.

import { buildFetchArgs, fetchVideo } from '../ytdlp.js'

/** The yt-dlp engine, in the `Downloader` shape. */
export const ytdlpDownloader = {
  id: 'ytdlp',
  label: 'yt-dlp',

  /**
   * Whether the engine can plausibly run.
   *
   * A bare-name spawn is what yt-dlp itself does, so "available" here means
   * "the plugin is configured to try it" — a missing binary surfaces as a
   * normal fetch failure with the shell's error text attached.
   * @returns {Promise<boolean>} always true.
   */
  async available() {
    return true
  },

  /**
   * Download one URL.
   * @param {object} options - generic download options.
   * @param {string} options.url - video page URL (http/https).
   * @param {string} options.outDir - absolute output directory.
   * @param {string} options.format - yt-dlp format selector.
   * @param {string} [options.cookiesPath] - Netscape cookie file.
   * @param {number} options.timeoutMs - hard deadline.
   * @returns {Promise<{path: string, engine: string}>} the downloaded file.
   */
  async fetch({ url, outDir, format, cookiesPath = '', timeoutMs }) {
    const value = await fetchVideo({ url, outDir, format, cookiesPath, timeoutMs })
    return { ...value, engine: 'ytdlp' }
  },
}

/** Re-exported so callers can build and inspect args without going through FFI-ish indirection. */
export { buildFetchArgs }
