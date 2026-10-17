// Shared state-directory layout: one place computes the DSH_HOME-aware path
// so no two modules can drift apart on where video-fetch state lives.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH_HOME-aware state directory (cookie jars, QR login state). */
export function stateDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'video-fetch')
}
