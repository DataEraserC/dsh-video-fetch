// Pending-QR login state: one file per site under stateDir(), plus the QR
// PNG the surfaces show. Both the session tool and the web routes read and
// write through here so they cannot drift on the file layout.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { stateDir } from './state.js'

/** Pending-QR state file, one per site. @param {string} site */
export function loginStatePath(site) {
  return join(stateDir(), `login-${site}.json`)
}

/** QR PNG path, one per site. @param {string} site */
export function qrPath(site) {
  return join(stateDir(), `login-${site}-qr.png`)
}

/**
 * Read the pending login state.
 * @param {string} site
 * @returns {{key: string, url: string, createdAt: number} | null} null when absent.
 */
export function readLoginState(site) {
  try {
    return JSON.parse(readFileSync(loginStatePath(site), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Persist the pending login state (0600).
 * @param {string} site
 * @param {{key: string, url: string, createdAt: number}} state
 */
export function writeLoginState(site, state) {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(loginStatePath(site), JSON.stringify(state), { mode: 0o600 })
}

/**
 * Drop the pending login state; a missing file is not an error.
 * @param {string} site
 */
export function clearLoginState(site) {
  try {
    rmSync(loginStatePath(site))
  } catch { /* already gone */ }
}
