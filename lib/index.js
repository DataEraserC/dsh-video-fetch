// dsh-video-fetch — video downloading for DeepSeek Harness.
//
// Three model tools:
//   video_fetch    yt-dlp download (any site yt-dlp supports), optional
//                  ffmpeg post-compress to a QQ-sendable MP4; a URL owned by
//                  a login provider also gets that site's cookie jars, tried
//                  in order when one fails; output lands inside the session
//                  workspace only (see downloadDirOf);
//   video_login    per-channel login on a channel × method contract —
//                  credentials live in DSH_HOME/video-fetch/accounts/<channel>
//                  .json (0600) and never enter a tool result;
//   video_compress ffmpeg re-encode of any local file (CRF / height cap from
//                  plugin config, not from Nix).
//
// Binaries are spawned by bare name (`yt-dlp`, `ffmpeg`) so the packaged
// runtimeDeps PATH decides which one runs; nothing is hard-coded.
//
// Three surfaces, one implementation each (see lib/commands.js): the tools
// above are what the model calls, `lib/client.js` is the web page, and
// `/video-settings` + `/video-login` are what a person types. The web page and
// the commands both write the same profile row, so they cannot disagree.

import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { registerCommands } from './commands.js'
import { download, engineOf } from './downloaders/index.js'
import { compressFile, compressOutputPath } from './ffmpeg.js'
import { call, nativeStatus } from './native.js'
import { isRegularFile } from './proc.js'
import { buildRoutes } from './routes.js'
import { EDITABLE_KEYS, applyPatch, coercePatch, plain, resetFields, snapshot } from './settings.js'

export const name = 'dsh-video-fetch'

export const inject = ['tools']

export const Config = z.object({
  // The six fields below are `.volatile()`: a Settings-UI or video_settings
  // write updates the RUNNING plugin in place (Loader commits volatile refs
  // and emits `loader/volatile-update`). Binaries and deadlines are ordinary
  // fields on purpose — changing them needs a restart.
  /** Download subdir, resolved INSIDE the session workspace (`dsh-video-fetch` when empty). */
  downloadDir: z.string().default('').volatile(),
  /** yt-dlp format selector. */
  format: z.string().default('bv*+ba/b').volatile(),
  /** yt-dlp binary: bare name resolves through PATH (packaged runtimeDeps). */
  ytdlpBinary: z.string().default('yt-dlp'),
  /** ffmpeg binary: same PATH rule. */
  ffmpegBinary: z.string().default('ffmpeg'),
  /** Hard deadline for one download (spans all cookie-jar rotation attempts). */
  fetchTimeoutMs: z.number().step(1).min(10000).default(600000),
  /** Hard deadline for one compression. */
  compressTimeoutMs: z.number().step(1).min(10000).default(900000),
  /** x264 CRF for compression (0=lossless … 51=worst). */
  crf: z.number().step(1).min(0).max(51).default(26).volatile(),
  /** Height cap in pixels for compression; 0 disables scaling. */
  maxHeight: z.number().step(1).min(0).max(8192).default(720).volatile(),
  /** AAC audio bitrate for compression. */
  audioBitrate: z.string().default('128k').volatile(),
  /**
   * Which download engine `video_fetch` uses.
   *
   * `ytdlp` is the only implemented engine today; `native` is a reserved slot
   * for a yt-dlp-independent fetcher (see lib/downloaders/native.js) and
   * currently fails with a clear error rather than silently doing something
   * else. See lib/downloaders/index.js for the contract.
   */
  downloadEngine: z.string().default('ytdlp').volatile(),
  /** x264 preset for compression. */
  preset: z.string().default('medium').volatile(),
})

/**
 * The session workspace (its header cwd) of this tool execution.
 * @param {object} [exec] - tool run context from defineTool's execute.
 * @returns {string | undefined} the absolute cwd, or undefined when there is none.
 */
function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Is `target` the same directory as `base` or below it? Both must be realpath'd.
 * @param {string} base - allowed root.
 * @param {string} target - directory to test.
 * @returns {boolean}
 */
function isInside(base, target) {
  const rel = relative(base, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * realpath of `p`, or of its nearest existing ancestor while `p` does not exist yet.
 * @param {string} p - path that may not exist yet.
 * @returns {string | undefined} resolved path, undefined at a filesystem root mismatch.
 */
function nearestReal(p) {
  let cur = p
  for (;;) {
    try {
      return realpathSync(cur)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return undefined
      cur = parent
    }
  }
}

/**
 * Resolve the download directory — always INSIDE the session workspace.
 * `downloadDir` is workspace-relative (`dsh-video-fetch` when empty); absolute
 * paths and `..` are rejected before touching the filesystem, and the nearest
 * existing ancestor is realpath-checked so a symlink planted in the workspace
 * cannot redirect a download out of it.
 * @param {object} config - live resolved plugin config.
 * @param {object} [exec] - tool run context carrying the session workspace.
 * @returns {string} absolute directory inside the workspace (created).
 * @throws when there is no session workspace or the path would escape it.
 */
export function downloadDirOf(config, exec) {
  const workspace = workspaceOf(exec)
  if (workspace === undefined) {
    throw new Error('no session workspace (session header cwd missing) — video_fetch only downloads inside the session workspace')
  }
  const configured = String(plain(config.downloadDir) ?? '')
  if (configured !== '' && (isAbsolute(configured) || configured.split(/[/\\]+/).includes('..'))) {
    throw new Error(`downloadDir must stay inside the session workspace (workspace-relative, no ".."): ${configured}`)
  }
  mkdirSync(workspace, { recursive: true })
  const realBase = realpathSync(workspace)
  const dir = configured === '' ? join(workspace, 'dsh-video-fetch') : resolve(workspace, configured)
  const ancestor = nearestReal(dir)
  if (ancestor === undefined || !isInside(realBase, ancestor)) {
    throw new Error(`download dir resolves outside the session workspace: ${dir}`)
  }
  mkdirSync(dir, { recursive: true })
  return dir
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

/** Gap between polls while waiting on a human to scan a QR code. */
const POLL_BACKOFF_MS = 2000

/**
 * Which channel owns `url`.
 *
 * Asked of the native registry rather than a local host table, because the
 * registry is where `hosts` actually lives — duplicating it here would silently
 * drift the moment a provider gains a domain.
 * @param {string} url - video page URL.
 * @returns {Promise<string | null>} the channel id, or null when only the
 *   `generic` fallback matches (it has no accounts, so there is nothing to
 *   resolve).
 */
async function channelForUrl(url) {
  const result = await call('route', { url })
  const id = result?.channel
  return typeof id === 'string' && id !== '' && id !== 'generic' ? id : null
}

/**
 * Describe a freshly-started login for the model.
 *
 * The challenge is what the host has to put in front of the user; this turns it
 * into text the model can act on (show a QR, open a link, ask for fields).
 * @param {object} response - a `start` / `browse` result.
 * @returns {string} user-facing copy.
 */
function renderChallenge(response) {
  const challenge = response.challenge ?? {}
  const lines = [`Login started. sessionId: ${response.session_id}`]
  if (challenge.kind === 'qr') {
    lines.push('Show the user this QR code to scan in the site\'s app:')
    // Some sites (Tencent/QQ) return a pre-rendered PNG as a data URL; others
    // only return the payload, which the web page rasterises itself.
    lines.push(challenge.image ? `QR image (data URL): ${challenge.image}` : `QR payload: ${challenge.url}`)
    lines.push('Then run video_login action=poll with waitMs=120000.')
    return lines.join('\n')
  }
}

/**
 * Describe one poll / submit result.
 * @param {object} response - a `poll` / `submit` result.
 * @returns {string} user-facing copy.
 */
function renderPoll(response) {
  const result = response.result ?? {}
  const account = response.account ?? null
  if (result.status === 'done') {
    const who = account ? (account.identity || account.label || account.id) : ''
    return `Logged in${account ? ` as ${who}` : ''}; ${account ? `${account.cookie_count} cookie(s) stored` : 'cookies stored'}. video_fetch now uses the logged-in tier.`
  }
  if (result.status === 'need_input') {
    const names = (result.fields ?? []).map((field) => field.name).join(', ')
    return `${result.prompt ?? 'More input is needed.'} Then run video_login action=submit with params {${names}}.`
  }
  if (result.status === 'expired') return result.message || 'That login expired — start a new one.'
  if (result.status === 'scanned') return result.message || 'Scanned — confirm in the app.'
  return result.message || 'Waiting for the user…'
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
   * Poll a login until it resolves, or the deadline passes.
   *
   * Sessions live in the native layer, so each tick is a fresh `poll` call and
   * the loop is just a bounded backoff over it — the core decides what
   * "pending" and "done" mean per channel.
   * @param {string} sessionId - session minted by `start` / `browse`.
   * @param {number} waitMs - 0 = a single poll.
   * @returns {Promise<{result: object, account: object|null}>} last observed state.
   */
  async function pollLogin(sessionId, waitMs) {
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      const next = await call('poll', { sessionId })
      const status = next.result?.status
      if (status === 'done' || status === 'expired' || status === 'need_input') return next
      if (Date.now() >= deadline) return next
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_BACKOFF_MS, Math.max(0, deadline - Date.now()))))
    }
  }

  const tools = [
    defineTool({
      name: 'video_fetch',
      description:
        'Download a video with yt-dlp and return its local file path. Works on any site yt-dlp supports (bilibili, YouTube, …). ' +
        'For sites with a video_login (e.g. bilibili), logged-in cookies are applied automatically and each stored cookie jar is tried in order if one fails. ' +
        'Pass compress: true to re-encode the download to a QQ-sendable MP4 in the same call; crf / maxHeight override the plugin settings for this call only. ' +
        'URL must be http(s). Re-running an already-downloaded URL returns the existing file instead of re-downloading. ' +
        'Files always land inside the session workspace (downloadDir is a workspace-relative subdir; absolute paths are rejected).',
      parameters: {
        url: { type: 'string', required: true, description: 'Video page URL (http/https), e.g. https://www.bilibili.com/video/BV1xx411c7mD' },
        compress: { type: 'boolean', description: 'Also re-encode to a QQ-sendable MP4 after downloading (default false)' },
        crf: { type: 'integer', description: 'compress only: override CRF for this call (0-51; default from settings)' },
        maxHeight: { type: 'integer', description: 'compress only: override height cap for this call (0 = no scaling; default from settings)' },
      },
      output,
      timeoutMs: config.fetchTimeoutMs + 30000,
      async execute(args, exec) {
        const url = String(args.url)
        if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported URL scheme (need http/https): ${url.slice(0, 60)}`)
        const outDir = downloadDirOf(config, exec)
        const deadline = Date.now() + config.fetchTimeoutMs
        const engine = engineOf(String(plain(config.downloadEngine) ?? 'ytdlp'))
        // Route the URL to its channel so the download can use that channel's
        // accounts; `generic` matches anything and simply has none.
        const picked = await channelForUrl(url)
        const accounts = picked === null ? [] : (await call('accounts', { channel: picked })) ?? []
        const fetched = await download({
          engine,
          url,
          outDir,
          format: plain(config.format),
          accounts,
          materialize: picked === null
            ? null
            : (accountId) => call('materialize', { channel: picked, account: accountId }).then((r) => r.path),
          timeoutMs: Math.max(1000, deadline - Date.now()),
        })
        const lines = [`Downloaded: ${fetched.path}`, `Size: ${mb(statOf(fetched.path).size)}`]
        if (accounts.length > 1 && fetched.attempt > 0) {
          lines.push(`Account: ${fetched.attempt + 1} of ${accounts.length} (earlier accounts were rejected)`)
        }
        if (args.compress) {
          // Per-call overrides win over the live settings; both are validated
          // here so a bad number fails before ffmpeg starts.
          const crf = args.crf === undefined ? plain(config.crf) : Number(args.crf)
          const maxHeight = args.maxHeight === undefined ? plain(config.maxHeight) : Number(args.maxHeight)
          if (!Number.isFinite(crf) || crf < 0 || crf > 51) throw new Error(`crf must be 0-51: ${args.crf}`)
          if (!Number.isFinite(maxHeight) || maxHeight < 0) throw new Error(`maxHeight must be >= 0: ${args.maxHeight}`)
          const out = compressOutputPath(fetched.path)
          await compressFile({
            input: fetched.path,
            output: out,
            crf,
            maxHeight,
            audioBitrate: plain(config.audioBitrate),
            preset: plain(config.preset),
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
        'Per-channel login so video_fetch reaches the logged-in quality tier. ' +
        'Two orthogonal dimensions: channel selects the site (bilibili, douyin, youtube, ' +
        'tencent, iqiyi, youku); method selects how credentials arrive within that channel ' +
        '(qr, manual, sms, password, browser). Not every channel implements every method — ' +
        'ask `channels` for the advertisement, and an unsupported method fails with a structured ' +
        '"not implemented" error rather than doing something surprising. ' +
        'Actions: start (begin a login, returns a sessionId plus a challenge to render), ' +
        'browse (open a real browser on the server for the channel, then poll), ' +
        'poll (advance a login that needs no input; waitMs blocks up to that long), ' +
        'submit (send this step\'s inputs: an SMS number/code, a password; params is a JSON object), ' +
        'import (store a Netscape cookies file from disk: path), ' +
        'status (probe an account without a login round-trip), ' +
        'pin (choose which account a download uses), ' +
        'logout (drop one account), clear (drop every account of the channel), ' +
        'cancel (abandon a login in flight). ' +
        'A channel holds many accounts, captured by any method: the pinned one is what a download ' +
        'uses and the rest are the rotation fallback when it is rejected. ' +
        'Accounts live in DSH_HOME/video-fetch/accounts/<channel>.json (0600); cookie values are ' +
        'never included in a result — only counts, labels, and identities.',
      parameters: {
        channel: { type: 'string', description: 'Channel id, e.g. bilibili; omit to use the first advertised channel' },
        method: { type: 'string', description: 'Login method within the channel: qr, manual, sms, password, browser (default qr)' },
        action: {
          type: 'string',
          enum: ['channels', 'start', 'browse', 'poll', 'submit', 'import', 'status', 'pin', 'logout', 'clear', 'cancel'],
          required: true,
          description: 'What to do; channels lists every channel with its display name and implemented methods',
        },
        sessionId: { type: 'string', description: 'poll / submit / cancel only: the session returned by start' },
        params: { type: 'json', description: 'submit only: object of field name → value' },
        path: { type: 'string', description: 'import only: absolute path of a Netscape cookies file already on disk' },
        account: { type: 'string', description: 'status / pin / logout only: account id' },
        waitMs: { type: 'integer', description: 'poll only: block up to this many ms for the scan to confirm (0 = single check, default 0)' },
      },
      output,
      timeoutMs: 300000,
      async execute(args) {
        const action = String(args.action)
        const channel = args.channel === undefined || args.channel === null || String(args.channel) === ''
          ? null
          : String(args.channel)

        if (action === 'channels') {
          const channels = (await call('channels')) ?? []
          const lines = channels.map((entry) => {
            const live = entry.methods.filter((method) => method.implemented).map((method) => method.id)
            const reserved = entry.methods.filter((method) => !method.implemented).map((method) => method.id)
            return `${entry.id} (${entry.name}) — methods: ${live.join(', ')}${reserved.length > 0 ? `; not implemented: ${reserved.join(', ')}` : ''}`
          })
          return { text: lines.join('\n') }
        }

        if (action === 'start') {
          const next = await call('start', {
            channel: channel ?? '',
            method: String(args.method ?? 'qr'),
            params: args.params ?? {},
            label: args.label === undefined ? null : String(args.label),
          })
          return { text: renderChallenge(next) }
        }

        if (action === 'browse') {
          const next = await call('browse', { channel: channel ?? '' })
          return { text: renderChallenge(next) }
        }

        if (action === 'poll') {
          const waitMs = Math.min(240000, Math.max(0, Number(args.waitMs ?? 0)))
          const next = await pollLogin(String(args.sessionId ?? ''), waitMs)
          return { text: renderPoll(next) }
        }

        if (action === 'submit') {
          const next = await call('submit', {
            sessionId: String(args.sessionId ?? ''),
            params: args.params ?? {},
          })
          return { text: renderPoll(next) }
        }

        if (action === 'import') {
          const file = String(args.path ?? '')
          if (!isAbsolute(file)) throw new Error(`path must be an absolute path: ${file.slice(0, 120)}`)
          if (!isRegularFile(file)) throw new Error(`not a file: ${file.slice(0, 120)}`)
          if (statSync(file).size > 512 * 1024) {
            throw new Error(`cookie file too large (max 512 KB): ${file.slice(0, 120)}`)
          }
          const account = await call('import', {
            channel: channel ?? '',
            method: 'manual',
            cookies: readFileSync(file, 'utf8'),
            label: String(args.label ?? ''),
          })
          return { text: `Imported ${account.cookie_count} cookie(s) for ${channel} as ${account.identity || account.label || account.id}.` }
        }

        if (action === 'status') {
          const view = await call('check', {
            channel: channel ?? '',
            account: args.account === undefined ? null : String(args.account),
          })
          return { text: `${channel}: ${view.status} — ${view.identity || view.label || view.id} (${view.cookie_count} cookie(s)).` }
        }

        if (action === 'pin') {
          const view = await call('pin', { channel: channel ?? '', account: String(args.account ?? '') })
          return { text: `Active account for ${channel}: ${view.identity || view.label || view.id}.` }
        }

        if (action === 'logout') {
          const removed = await call('logout', { channel: channel ?? '', account: String(args.account ?? '') })
          return {
            text: removed
              ? `Account removed from ${channel}.`
              : `No such account for ${channel}.`,
          }
        }

        if (action === 'clear') {
          const removed = await call('clear', { channel: channel ?? '' })
          return { text: `Removed ${removed} account(s) from ${channel}.` }
        }

        if (action === 'cancel') {
          await call('cancel', { sessionId: String(args.sessionId ?? '') })
          return { text: 'Login cancelled.' }
        }

        throw new Error(`unknown action "${action}"`)
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
        const crf = args.crf === undefined ? plain(config.crf) : Number(args.crf)
        const maxHeight = args.maxHeight === undefined ? plain(config.maxHeight) : Number(args.maxHeight)
        if (!Number.isFinite(crf) || crf < 0 || crf > 51) throw new Error(`crf must be 0-51: ${args.crf}`)
        if (!Number.isFinite(maxHeight) || maxHeight < 0) throw new Error(`maxHeight must be >= 0: ${args.maxHeight}`)
        const output = compressOutputPath(input)
        await compressFile({
          input,
          output,
          crf,
          maxHeight,
          audioBitrate: plain(config.audioBitrate),
          preset: plain(config.preset),
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

    defineTool({
      name: 'video_settings',
      description:
        'Read or change this plugin’s tunable settings from the session. ' +
        'action=get returns the current effective values; action=set writes the given fields into the active profile’s Cordis patch ' +
        'and applies them to the running plugin immediately (no restart); action=reset drops the profile override and restores the inherited value. ' +
        'Fields: ' + EDITABLE_KEYS.join(', ') + '. ' +
        'The same settings are editable on the web Plugins page — both write the same profile row, so they never diverge. ' +
        'Login is not here: use video_login. Binaries and deadlines need a restart, so they stay out of this contract.',
      parameters: {
        action: { type: 'string', enum: ['get', 'set', 'reset'], required: true, description: 'get = read; set = write the patch; reset = drop the override' },
        patch: { type: 'json', description: 'set only: field → value object, e.g. {"crf": 22, "maxHeight": 480}' },
        fields: { type: 'array', items: { type: 'string' }, description: 'reset only: field names to restore (omit for every editable field)' },
      },
      output,
      timeoutMs: 30000,
      async execute(args) {
        const action = String(args.action)
        if (action === 'get') {
          const current = snapshot(config)
          return {
            text: [
              `Settings for ${name} (live values):`,
              ...EDITABLE_KEYS.map((key) => `  ${key} = ${JSON.stringify(current[key])}`),
              'Change them with action=set patch={...}, or on the web Plugins page.',
            ].join('\n'),
          }
        }
        if (action === 'set') {
          const patch = coercePatch(args.patch)
          await applyPatch(ctx, patch)
          return {
            text: `Applied ${Object.keys(patch).length} setting(s) and saved them to the profile:\n` +
              Object.entries(patch).map(([key, value]) => `  ${key} = ${JSON.stringify(value)}`).join('\n') +
              '\nThe running plugin uses them now; the value survives a restart.',
          }
        }
        // reset
        const requested = args.fields === undefined || args.fields === null || args.fields.length === 0
          ? [...EDITABLE_KEYS]
          : args.fields.map((field) => String(field))
        await resetFields(ctx, requested)
        return { text: `Dropped the profile override for ${requested.length} field(s): ${requested.join(', ')}.` }
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)

  // Slash commands. Reached through `ctx.reflect.get` rather than `ctx.commands`
  // so a composition without the registry still loads the plugin — see the
  // header of lib/commands.js. This is the only surface the TUI has.
  const commands = registerCommands(ctx, config)
  if (commands === 0) {
    ctx.logger?.debug?.('dsh-video-fetch: no command registry in this composition; /video-settings and /video-login are unavailable')
  }

  // Web surfaces. The Plugins-page card is a `plugins.row.config` slot in the
  // client half and reads its state from these routes; a TUI or headless
  // composition has no webServer, so this child simply never activates and
  // the session tool stays the only surface.
  if (typeof ctx.inject === 'function') {
    const routes = buildRoutes(ctx, config)
    const attach = (getServer, prefix) => (inner) => {
      const server = getServer(inner)
      if (server === null || server === undefined || typeof server.register !== 'function') return
      const disposers = routes.map((route) =>
        server.register({ kind: 'exact', path: `${prefix}${route.path}`, handler: route.handler }),
      )
      inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-video-fetch.web-routes')
    }
    ctx.inject(['webServer'], attach((inner) => inner.get('webServer'), ''))
    // Desktop/web-over-connection carrier: same handlers under /api.
    ctx.inject(['connection'], (inner) => {
      const connection = inner.get('connection')
      if (connection === null || connection === undefined || typeof connection.fetch?.register !== 'function') return
      const disposers = []
      for (const route of routes) {
        try {
          disposers.push(connection.fetch.register({
            path: `/api${route.path}`,
            methods: ['GET', 'POST'],
            requestBody: 'buffered',
            async fetch(request) {
              const url = new URL(request.url)
              const body = request.body === undefined || request.body === null ? '' : await request.text()
              const req = Object.assign(
                (function* () { if (body) yield Buffer.from(body) })(),
                { method: request.method, url: `${route.path}${url.search}`, headers: request.headers },
              )
              const headers = new Headers()
              let status = 200
              let payload = ''
              const res = {
                setHeader(key, value) { headers.set(key, value) },
                end(value) { payload = value === undefined ? '' : String(value) },
                get statusCode() { return status },
                set statusCode(value) { status = value },
              }
              await route.handler(req, res)
              return new Response(payload, { status, headers })
            },
          }))
        } catch (error) {
          ctx.logger?.warn?.(`dsh-video-fetch: route ${route.path} was not registered: ${error.message}`)
        }
      }
      inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-video-fetch.fetch-routes')
    })
  }
}
