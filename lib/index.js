// dsh-video-fetch — video downloading for DeepSeek Harness.
//
// Three model tools:
//   video_fetch    yt-dlp download (any site yt-dlp supports), optional
//                  ffmpeg post-compress to a QQ-sendable MP4; a URL owned by
//                  a login provider also gets that site's cookie jars, tried
//                  in order when one fails;
//   video_login    per-site login on a site × method contract (bilibili QR
//                  and manual cookie-file import implemented; password/sms
//                  reserved) — credentials live in
//                  DSH_HOME/video-fetch/cookies/<site>.json (0600) and never
//                  enter a tool result;
//   video_compress ffmpeg re-encode of any local file (CRF / height cap from
//                  plugin config, not from Nix).
//
// Binaries are spawned by bare name (`yt-dlp`, `ffmpeg`) so the packaged
// runtimeDeps PATH decides which one runs; nothing is hard-coded.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { ALL_METHODS, METHOD_ACTIONS, providerBySite, providerByUrl, siteNames } from './auth/index.js'
import {
  MAX_JARS,
  addJar,
  countNetscapeCookies,
  headerFromNetscape,
  materializeJar,
  parseSetCookies,
  readJars,
  removeJars,
  rotateJars,
  toNetscape,
} from './cookies.js'
import { compressFile, compressOutputPath } from './ffmpeg.js'
import { isRegularFile } from './proc.js'
import { stateDir } from './state.js'
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
  /** Hard deadline for one download (spans all cookie-jar rotation attempts). */
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

/** Resolve the download directory from config, creating it. */
function downloadDirOf(config) {
  const dir = config.downloadDir || join(homedir(), 'Videos', 'dsh-video-fetch')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Pending-QR state file, one per site. @param {string} site */
function loginStatePath(site) {
  return join(stateDir(), `login-${site}.json`)
}

/** QR PNG path, one per site. @param {string} site */
function qrPath(site) {
  return join(stateDir(), `login-${site}-qr.png`)
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

function readLoginState(site) {
  try {
    return JSON.parse(readFileSync(loginStatePath(site), 'utf8'))
  } catch {
    return null
  }
}

function writeLoginState(site, state) {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(loginStatePath(site), JSON.stringify(state), { mode: 0o600 })
}

function clearLoginState(site) {
  try {
    rmSync(loginStatePath(site))
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
   * @param {string} site - provider/registry key.
   * @param {object} provider - the site's provider module.
   * @returns {Promise<string>} user-facing status line.
   */
  async function pollLogin(key, waitMs, site, provider) {
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      const r = await provider.pollQr(key)
      if (r.code === provider.POLL.OK) {
        if (r.setCookies.length > 0) {
          addJar(site, {
            source: 'qr',
            data: toNetscape(parseSetCookies(r.setCookies), provider.cookieDomain),
          })
        }
        clearLoginState(site)
        const jars = readJars(site)
        const status = await provider.checkLogin(jars.length > 0 ? headerFromNetscape(jars[0].data) : '')
        if (status.loggedIn) {
          return `Login confirmed; cookies saved. ${site}: @${status.uname} (level ${status.level}) — video_fetch now uses logged-in quality.`
        }
        if (r.setCookies.length > 0) {
          return 'Login confirmed and cookies saved, but the nav check did not report a login — re-run video_login action=status.'
        }
        return `Login confirmed but no cookies arrived (empty Set-Cookie${r.redirectUrl ? ', redirect present' : ''}) — run video_login action=start.`
      }
      if (r.code === provider.POLL.EXPIRED) {
        clearLoginState(site)
        return 'QR code expired — run video_login action=start for a fresh one.'
      }
      if (r.code === provider.POLL.SCANNED && Date.now() >= deadline) {
        return 'Scanned, waiting for confirmation in the app. Poll again (or pass waitMs).'
      }
      if (Date.now() >= deadline) {
        const hint = r.code === provider.POLL.SCANNED ? 'scanned, not confirmed' : 'not scanned yet'
        return `Still waiting (${hint}). Poll again with waitMs, or video_login start for a new QR.`
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, deadline - Date.now())))
    }
  }

  const tools = [
    defineTool({
      name: 'video_fetch',
      description:
        'Download a video with yt-dlp and return its local file path. Works on any site yt-dlp supports (bilibili, YouTube, …). ' +
        'For sites with a video_login (e.g. bilibili), logged-in cookies are applied automatically and each stored cookie jar is tried in order if one fails. ' +
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
        const deadline = Date.now() + config.fetchTimeoutMs
        const provider = providerByUrl(url)
        const jars = provider ? readJars(provider.site) : []
        const run = (cookiesPath) => fetchVideo({
          url,
          outDir,
          format: config.format,
          cookiesPath,
          binary: config.ytdlpBinary,
          timeoutMs: Math.max(1000, deadline - Date.now()),
        })
        // Rotation only exists when the site has a login provider with jars;
        // a plain site (or an empty store) is a single no-cookie attempt.
        const { value: fetched, index } = jars.length > 0
          ? await rotateJars(jars, {
              useJar: (i) => materializeJar(provider.site, i),
              attempt: run,
              stop: () => Date.now() >= deadline,
            })
          : { value: await run(''), index: 0 }
        const lines = [`Downloaded: ${fetched.path}`, `Size: ${mb(statOf(fetched.path).size)}`]
        if (jars.length > 1 && index > 0) {
          lines.push(`Cookie jar: ${index + 1} of ${jars.length} (earlier jars were rejected)`)
        }
        if (args.compress) {
          const out = compressOutputPath(fetched.path)
          await compressFile({
            input: fetched.path,
            output: out,
            crf: config.crf,
            maxHeight: config.maxHeight,
            audioBitrate: config.audioBitrate,
            preset: config.preset,
            binary: config.ffmpegBinary,
            timeoutMs: config.compressTimeoutMs,
          })
          lines.push(`Compressed: ${out} (${mb(statOf(fetched.path).size)} → ${mb(statOf(out).size)})`)
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'video_login',
      description:
        'Per-site login so video_fetch reaches the logged-in quality tier. ' +
        'site selects the channel (currently bilibili); method selects how credentials arrive: ' +
        'qr = action=start returns a QR PNG to show the user, then action=poll waits for their scan; ' +
        'manual = action=import with path set to an absolute Netscape cookies file already on disk (cookie values must never be pasted into chat). ' +
        'password/sms are reserved for future sites and currently fail with a structured not-implemented error. ' +
        'action=status reports stored cookies without a QR round-trip; action=logout clears only this site’s cookies. ' +
        'Cookies are stored per site as an array in DSH_HOME/video-fetch/cookies/<site>.json (0600), and ' +
        'video_fetch tries the jars in order when one fails; cookie values are never included in results.',
      parameters: {
        site: { type: 'string', enum: siteNames(), default: 'bilibili', description: 'Channel to log in to (currently only bilibili)' },
        method: { type: 'string', enum: [...ALL_METHODS], default: 'qr', description: 'How credentials arrive: qr (scan a code), manual (import a cookie file from disk); password/sms are reserved and error' },
        action: { type: 'string', enum: ['start', 'poll', 'import', 'status', 'logout'], required: true, description: 'What to do' },
        path: { type: 'string', description: 'import only: absolute path of a Netscape cookies file already on disk' },
        waitMs: { type: 'integer', description: 'poll only: block up to this many ms for the scan to confirm (0 = single check, default 0)' },
      },
      output,
      timeoutMs: 300000,
      async execute(args) {
        const site = String(args.site ?? 'bilibili')
        const method = String(args.method ?? 'qr')
        const action = String(args.action)
        const provider = providerBySite(site)
        if (!provider) throw new Error(`unknown site "${site}" (known: ${siteNames().join(', ')})`)
        if (!ALL_METHODS.includes(method)) throw new Error(`unknown method "${method}" (known: ${ALL_METHODS.join(', ')})`)
        if (!provider.methods.includes(method)) {
          throw new Error(
            `method=${method} is reserved but not implemented for site=${site} (implemented: ${provider.methods.join(', ')})`,
          )
        }
        const allowed = METHOD_ACTIONS[method]
        if (!allowed.includes(action)) {
          throw new Error(
            `action=${action} is not valid for method=${method} on site=${site} (allowed: ${allowed.join(', ')})` +
            (action === 'import' ? ' — use method=manual for action=import' : ''),
          )
        }

        if (action === 'start') {
          const { url, key } = await provider.generateQr()
          const png = qrPath(site)
          await provider.renderQrPng(png, url)
          writeLoginState(site, { key, url, createdAt: Date.now() })
          return {
            text: [
              `QR code generated. Show this PNG to the user to scan in the ${site} app:`,
              png,
              `Or open the URL on a phone: ${url}`,
              'After they scan and confirm, run video_login action=poll with waitMs=120000.',
            ].join('\n'),
          }
        }
        if (action === 'poll') {
          const state = readLoginState(site)
          if (!state?.key) return { text: 'No pending QR login — run video_login action=start first.' }
          const waitMs = Math.min(240000, Math.max(0, Number(args.waitMs ?? 0)))
          return { text: await pollLogin(state.key, waitMs, site, provider) }
        }
        if (action === 'import') {
          const file = String(args.path ?? '')
          if (!isAbsolute(file)) throw new Error(`path must be an absolute path: ${file.slice(0, 120)}`)
          if (!isRegularFile(file)) throw new Error(`not a file: ${file.slice(0, 120)}`)
          if (statSync(file).size > 512 * 1024) throw new Error(`cookie file too large (max 512 KB): ${file.slice(0, 120)}`)
          const data = readFileSync(file, 'utf8')
          const count = countNetscapeCookies(data)
          if (count === 0) throw new Error(`no cookie rows found — not a Netscape cookies file: ${file.slice(0, 120)}`)
          const added = addJar(site, { source: 'manual', data })
          if (added.duplicate) {
            return { text: `Already stored as jar ${added.index} of ${added.total} for ${site} — nothing added.` }
          }
          const cap = added.trimmed ? ` (cap ${MAX_JARS} reached; oldest jar dropped)` : ''
          return { text: `Imported ${count} cookie(s) for ${site} as jar ${added.index} of ${added.total}${cap}.` }
        }
        if (action === 'status') {
          const jars = readJars(site)
          if (jars.length === 0) return { text: `Not logged in (no cookies for ${site}).` }
          for (let i = 0; i < jars.length; i += 1) {
            const status = await provider.checkLogin(headerFromNetscape(jars[i].data))
            if (status.loggedIn) {
              const rotation = jars.length > 1 ? ` video_fetch rotates through ${jars.length} jars when one fails.` : ''
              return { text: `Logged in: @${status.uname} (level ${status.level}) — jar ${i + 1} of ${jars.length} for ${site}.${rotation}` }
            }
          }
          return {
            text: `${jars.length} cookie jar(s) stored for ${site}, but none reports a login (expired?) — ` +
              'run action=start, or action=import with fresh cookies.',
          }
        }
        // logout
        const removed = removeJars(site)
        clearLoginState(site)
        return {
          text: removed > 0
            ? `Cookies deleted for ${site} (${removed} jar(s)); logged out.`
            : `Already logged out (no cookies for ${site}).`,
        }
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
