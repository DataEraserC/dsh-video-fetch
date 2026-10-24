// Where this harness keeps video-fetch state, computed in one place so no two
// modules can drift apart on it.

import { join } from 'node:path'

/**
 * The directory dsh uses for video-fetch state, or `null` when the harness has
 * not named one.
 *
 * The login library is harness-independent: it resolves its own root from
 * `VLOGIN_HOME`, then XDG, and it must never learn that `DSH_HOME` exists —
 * a fallback to it there would be inherited by every other caller that happens
 * to run with the variable set, which is how a CLI's data ends up inside
 * someone else's directory. So the adapter exports this into `VLOGIN_HOME`
 * instead, and stays silent when there is nothing to say, leaving the library's
 * own default in place. That silence is also what keeps the two cases aligned:
 * with no `DSH_HOME`, the root is the same XDG path it has always been.
 *
 * @returns {string | null} the directory, or null to defer to the library.
 */
export function dshStateDir() {
  const home = String(process.env.DSH_HOME ?? '').trim()
  return home ? join(home, 'video-fetch') : null
}
