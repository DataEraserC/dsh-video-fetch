// =============================================================================
//  RESERVED SLOT — an engine that downloads WITHOUT yt-dlp.
//
//  DO NOT DELETE THIS FILE.
//
//  This is a deliberate, load-bearing placeholder. It is the seam where a
//  downloader that does not depend on yt-dlp belongs: a direct HLS/DASH
//  fetcher, a site-specific API client, an ffmpeg-driven stream pull — any
//  engine that takes a URL plus a Netscape cookie file and returns a local
//  file path. It is intentionally unused and intentionally empty of logic.
//
//  Why it exists at all:
//
//    yt-dlp is the only engine wired up today, and it is an excellent
//    default. But it is also a single upstream that tracks hundreds of sites
//    by reverse-engineering them. Sites break it, and it breaks sites; when a
//    site changes, the whole plugin waits on an upstream release. This slot
//    is where a second, independent path lands without restructuring the
//    plugin: `downloaders/index.js` already dispatches by id and already
//    rotates cookie jars per engine, so a new engine is one file plus one
//    registry entry.
//
//  What is required to fill it:
//
//    1. Implement `available()` and `fetch()` below. `fetch` receives
//       `{ url, outDir, format, cookiesPath, timeoutMs }` and resolves to
//       `{ path, engine }`. `path` must be an absolute path to a file that
//       exists, and it must live inside the directory `downloadDirOf()`
//       returned (see lib/index.js) — the plugin's workspace confinement is
//       enforced upstream of here and must not be undone by a new engine.
//    2. Register it in `downloaders/index.js`.
//    3. Add tests alongside the existing ones in test/.
//    4. Update README.md's "Download engines" section.
//
//  Until then: it is not dead code, it is an interface with no
//  implementations. Removing it means the next person re-derives the seam
//  from scratch, probably mid-incident.
// =============================================================================

/**
 * Placeholder for a yt-dlp-independent engine.
 *
 * Deliberately throws: this engine is reserved and not implemented. Callers
 * that get it asked for it explicitly, so a hard failure is the honest answer
 * — silently falling back to yt-dlp would hide a misconfiguration.
 */
export const nativeDownloader = {
  id: 'native',
  label: 'native (reserved — not implemented)',

  /**
   * Reserved engines are never available, so a picker shows it greyed out
   * rather than offering something that cannot run.
   * @returns {Promise<boolean>} always false.
   */
  async available() {
    return false
  },

  /**
   * @returns {Promise<never>} always rejects.
   * @throws {Error} always — the engine is reserved.
   */
  async fetch() {
    throw new Error(
      'the "native" download engine is reserved and not implemented yet; ' +
      'use engine=ytdlp, or fill in lib/downloaders/native.js',
    )
  },
}
