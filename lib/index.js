// dsh-video-fetch — video downloading for DeepSeek Harness.
//
// Three model tools:
//   video_fetch   yt-dlp download (any site yt-dlp supports), optional
//                 ffmpeg post-compress to a QQ-sendable MP4;
//   video_login   bilibili QR login — raises fetch quality to the logged-in
//                 tier; credentials live in DSH_HOME/video-fetch/cookies.txt
//                 (0600) and never enter a tool result;
//   video_compress ffmpeg re-encode of any local file (CRF / height cap from
//                 plugin config, not from Nix).
//
// Binaries are spawned by bare name (`yt-dlp`, `ffmpeg`) so the packaged
// runtimeDeps PATH decides which one runs; nothing is hard-coded.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  POLL,
  cookieHeader,
  generateQr,
  navStatus,
  parseSetCookies,
  pollQr,
  renderQrPng,
  toNetscape,
  writeCookies,
} from './bili.js'
import { compressFile, compressOutputPath } from './ffmpeg.js'
import { isRegularFile } from './proc.js'
import { fetchVideo } from './ytdlp.js'

export const name = 'dsh-video-fetch'

export const inject = ['tools']

export const Config = z.object({
  /** Download directory (`~/Videos/dsh-video-fetch` when empty). */
  downloadDir: z.string().default(''),
  /** yt-dlp format selector. */
  format: z.string().default('bv*+ba/b'),
  /** yt-dlp binary: bare name resolves through PATH (packaged runtimeDeps). */
  ytdlpBinary: z.string().default('yt-dlp'),
  /** ffmpeg binary: same PATH rule. */
  ffmpegBinary: z.string().default('ffmpeg'),
  /** Hard deadline for one download. */
  fetchTimeoutMs: z.number().step(1).min(10000).default(600000),
  /** Hard deadline for one compression. */
  compressTimeoutMs: z.number().step(1).min(10000).default(900000),
  /** x264 CRF for compression (0=lossless … 51=worst). */
  crf: z.number().step(1).min(0).max(51).default(26),
  /** Height cap in pixels for compression; 0 disables scaling. */
  maxHeight: z.number().step(1).min(0).max(8192).default(720),
  /** AAC audio bitrate for compression. */
  audioBitrate: z.string().default('128k'),
  /** x264 preset for compression. */
  preset: z.string().default('medium'),
})

/** DSH_HOME-aware state directory (cookies, QR login state). */
function stateDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'video-fetch')
}

/** Resolve the download directory from config, creating it. */
function downloadDirOf(config) {
  const dir = config.downloadDir || join(homedir(), 'Videos', 'dsh-video-fetch')
  mkdirSync(dir, { recursive: true })
  return dir
}

function cookiesPath() {
  return join(stateDir(), 'cookies.txt')
}

function loginStatePath() {
  return join(stateDir(), 'login.json')
}

/** Human-readable byte size. @param {number} n */
function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** @param {string} p @returns {{size: number}} */
function statOf(p) {
  try {
    return { size: statSync(p).size }
  } catch {
    return { size: 0 }
  }
}

function readLoginState() {
  try {
    return JSON.parse(readFileSync(loginStatePath(), 'utf8'))
  } catch {
    return null
  }
}

function writeLoginState(state) {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(loginStatePath(), JSON.stringify(state), { mode: 0o600 })
}

function clearLoginState() {
  try {
    rmSync(loginStatePath())
  } catch { /* already gone */ }
}

function textTool() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
}

export function apply(ctx, config) {
  const output = textTool()

  /**
   * Poll once, or loop until a terminal QR state or the deadline.
   * @param {string} key - qrcode_key.
   * @param {number} waitMs - 0 = single poll.
   * @returns {Promise<{text: string, done: boolean}>}
   */
  async function pollLogin(key, waitMs) {
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      const r = await pollQr(key)
      if (r.code === POLL.OK) {
        if (r.setCookies.length > 0) {
          writeCookies(cookiesPath(), toNetscape(parseSetCookies(r.setCookies)))
        }
        clearLoginState()
        const header = cookieHeader(cookiesPath())
        const status = await navStatus(header)
        return {
          text: status.loggedIn
            ? `Login confirmed; cookies saved. bilibili: @${status.uname} (level ${status.level}) — video_fetch now uses logged-in quality.`
            : r.setCookies.length > 0
              ? 'Login confirmed and cookies saved, but the nav check did not report a login — re-run video_login status.'
              : `Login confirmed but no cookies arrived (empty Set-Cookie${r.redirectUrl ? ', redirect present' : ''}) — re-run video_login start.`,
          done: true,
        }
      }
      if (r.code === POLL.EXPIRED) {
        clearLoginState()
        return { text: 'QR code expired — run video_login start for a fresh one.', done: true }
      }
      if (r.code === POLL.SCANNED && Date.now() >= deadline) {
        return { text: 'Scanned, waiting for confirmation in the app. Poll again (or pass waitMs).', done: false }
      }
      if (Date.now() >= deadline) {
        const hint = r.code === POLL.SCANNED ? 'scanned, not confirmed' : 'not scanned yet'
        return { text: `Still waiting (${hint}). Poll again with waitMs, or video_login start for a new QR.`, done: false }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, deadline - Date.now())))
    }
  }

  const tools = [
    defineTool({
      name: 'video_fetch',
      description:
        'Download a video with yt-dlp and return its local file path. Works on any site yt-dlp supports (bilibili, YouTube, …). ' +
        'For bilibili, run video_login first — logged-in quality raises the ceiling (e.g. 1080P+). ' +
        'Pass compress: true to re-encode the download to a QQ-sendable MP4 (height cap / CRF come from plugin config) in the same call. ' +
        'URL must be http(s). Re-running an already-downloaded URL returns the existing file instead of re-downloading.',
      parameters: {
        url: { type: 'string', required: true, description: 'Video page URL (http/https), e.g. https://www.bilibili.com/video/BV1xx411c7mD' },
        compress: { type: 'boolean', description: 'Also re-encode to a QQ-sendable MP4 after downloading (default false)' },
      },
      output,
      timeoutMs: config.fetchTimeoutMs + 30000,
      async execute(args) {
        const url = String(args.url)
        if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported URL scheme (need http/https): ${url.slice(0, 60)}`)
        const outDir = downloadDirOf(config)
        const cookieFile = cookiesPath()
        const { path } = await fetchVideo({
          url,
          outDir,
          format: config.format,
          cookiesPath: isRegularFile(cookieFile) ? cookieFile : '',
          binary: config.ytdlpBinary,
          timeoutMs: config.fetchTimeoutMs,
        })
        const lines = [`Downloaded: ${path}`, `Size: ${mb(statOf(path).size)}`]
        if (args.compress) {
          const out = compressOutputPath(path)
          await compressFile({
            input: path,
            output: out,
            crf: config.crf,
            maxHeight: config.maxHeight,
            audioBitrate: config.audioBitrate,
            preset: config.preset,
            binary: config.ffmpegBinary,
            timeoutMs: config.compressTimeoutMs,
          })
          lines.push(`Compressed: ${out} (${mb(statOf(path).size)} → ${mb(statOf(out).size)})`)
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'video_login',
      description:
        'Bilibili QR login, which raises video_fetch quality to the logged-in tier. ' +
        'action=start generates a QR code and returns its PNG path + scan URL (show the PNG to the user, they scan it in the bilibili app). ' +
        'action=poll checks the scan result — pass waitMs (max 240000) to block until confirmed/expire; do this after start. ' +
        'action=status shows the current login without a QR round-trip. action=logout deletes the stored cookies. ' +
        'Cookies are stored in DSH_HOME/video-fetch/cookies.txt (0600) and are never included in results.',
      parameters: {
        action: { type: 'string', enum: ['start', 'poll', 'status', 'logout'], required: true, description: 'What to do' },
        waitMs: { type: 'integer', description: 'poll only: block up to this many ms for the scan to confirm (0 = single check, default 0)' },
      },
      output,
      timeoutMs: 300000,
      async execute(args) {
        const action = String(args.action)
        if (action === 'start') {
          const { url, key } = await generateQr()
          const qrPath = join(stateDir(), 'login-qr.png')
          await renderQrPng(qrPath, url)
          writeLoginState({ key, url, createdAt: Date.now() })
          return {
            text: [
              'QR code generated. Show this PNG to the user to scan in the bilibili app:',
              qrPath,
              `Or open the URL on a phone: ${url}`,
              'After they scan and confirm, run video_login action=poll with waitMs=120000.',
            ].join('\n'),
          }
        }
        if (action === 'poll') {
          const state = readLoginState()
          if (!state?.key) return { text: 'No pending QR login — run video_login action=start first.' }
          const waitMs = Math.min(240000, Math.max(0, Number(args.waitMs ?? 0)))
          const r = await pollLogin(state.key, waitMs)
          return { text: r.text }
        }
        if (action === 'status') {
          const header = cookieHeader(cookiesPath())
          if (!header) return { text: 'Not logged in (no cookies file).' }
          const status = await navStatus(header)
          return {
            text: status.loggedIn
              ? `Logged in: @${status.uname} (level ${status.level}).`
              : 'Cookies file exists but bilibili reports no login (expired?) — run video_login action=start again.',
          }
        }
        // logout
        const before = isRegularFile(cookiesPath())
        try {
          rmSync(cookiesPath())
        } catch { /* already gone */ }
        clearLoginState()
        return { text: before ? 'Cookies deleted; logged out.' : 'Already logged out (no cookies file).' }
      },
    }),

    defineTool({
      name: 'video_compress',
      description:
        'Re-encode a local video to a QQ-sendable MP4 with ffmpeg (H.264 + AAC, faststart). ' +
        'Height is capped (plugin config, default 720) and quality is CRF (default 26). ' +
        'Use this on any local file — including one that did not come from video_fetch. ' +
        'The output is written next to the input as <name>.small.<ext>; the input is never modified.',
      parameters: {
        file: { type: 'string', required: true, description: 'Absolute path of the source video' },
        crf: { type: 'integer', description: 'Override CRF (0-51, lower = better quality/larger; default from plugin config)' },
        maxHeight: { type: 'integer', description: 'Override height cap in pixels (0 = no scaling; default from plugin config)' },
      },
      output,
      timeoutMs: config.compressTimeoutMs + 30000,
      async execute(args) {
        const input = String(args.file)
        if (!isAbsolute(input)) throw new Error(`file must be an absolute path: ${input}`)
        if (!isRegularFile(input)) throw new Error(`not a file: ${input}`)
        const crf = args.crf === undefined ? config.crf : Number(args.crf)
        const maxHeight = args.maxHeight === undefined ? config.maxHeight : Number(args.maxHeight)
        if (!Number.isFinite(crf) || crf < 0 || crf > 51) throw new Error(`crf must be 0-51: ${args.crf}`)
        if (!Number.isFinite(maxHeight) || maxHeight < 0) throw new Error(`maxHeight must be >= 0: ${args.maxHeight}`)
        const output = compressOutputPath(input)
        await compressFile({
          input,
          output,
          crf,
          maxHeight,
          audioBitrate: config.audioBitrate,
          preset: config.preset,
          binary: config.ffmpegBinary,
          timeoutMs: config.compressTimeoutMs,
        })
        const before = statOf(input).size
        const after = statOf(output).size
        return {
          text: `Compressed: ${output}\nSize: ${mb(before)} → ${mb(after)} (${Math.round((after / before) * 100)}% of original)`,
        }
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)
}
