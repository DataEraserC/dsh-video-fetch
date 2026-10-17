// Process layer shared by the yt-dlp download and ffmpeg compress paths.
//
// Rules this file exists to enforce:
//   • binaries resolve from PATH first, then the standard NixOS per-user and
//     system profiles — the harness may have been started with a bare PATH;
//   • arguments always go to spawn() as an array, never through a shell;
//   • every wait is bounded: SIGTERM at the deadline, SIGKILL 5s later.

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve an external binary.
 * @param {string} configured - bare name (yt-dlp) or absolute path from config.
 * @returns {string} the binary to spawn (a bare name is returned as-is for PATH lookup).
 */
export function resolveBin(configured) {
  if (configured.includes('/')) return configured
  const dirs = [
    ...(String(process.env.PATH ?? '').split(':').filter(Boolean)),
    join(homedir(), '.nix-profile', 'bin'),
    `/etc/profiles/per-user/${process.env.USER ?? ''}/bin`,
    '/run/current-system/sw/bin',
  ]
  for (const dir of dirs) {
    const candidate = join(dir, configured)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* keep looking */ }
  }
  return configured
}

/**
 * Run one binary with a hard deadline.
 * @param {string} bin - binary path or PATH name.
 * @param {string[]} args - argv (never shell-quoted).
 * @param {{timeoutMs: number}} options - positive deadline enforced by the child wait itself.
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runBin(bin, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`cannot run ${bin}: ${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 5000).unref?.()
    }, timeoutMs)
    killTimer.unref?.()

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-16384)
    })
    child.on('error', (error) => {
      settled = true
      clearTimeout(killTimer)
      reject(new Error(`cannot run ${bin}: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      settled = true
      clearTimeout(killTimer)
      resolve({ code: code ?? (signal ? 137 : 1), stdout, stderr, timedOut })
    })
  })
}

/**
 * Extract the downloaded file path from yt-dlp output.
 * Fresh downloads print it via `--print after_move:filepath`; a skip (file
 * already present) instead logs `[download] <path> has already been downloaded`.
 * @param {string} stdout - combined yt-dlp stdout.
 * @returns {string} absolute path or ''.
 */
export function parseFetchedPath(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('/')) return lines[i]
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[download\] (.+?) has already been downloaded$/)
    if (m) return m[1]
  }
  return ''
}

/**
 * Trim a child stderr for a tool-facing error message.
 * @param {string} stderr - raw stderr.
 * @returns {string} last 800 characters, or a placeholder.
 */
export function stderrTail(stderr) {
  const text = String(stderr ?? '').trim()
  if (!text) return ''
  return text.length > 800 ? `…${text.slice(-800)}` : text
}

/**
 * Whether a path exists and is a regular file.
 * @param {string} path - candidate path.
 * @returns {boolean}
 */
export function isRegularFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}
