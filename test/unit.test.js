// Unit tests for the pure pieces: yt-dlp arg building, output parsing,
// ffmpeg arg building, the cookie-jar store, provider registry, login gating,
// and plugin registration. No network, no downloads — run with `npm test`.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseFetchedPath, stderrTail } from '../lib/proc.js'
import { buildFetchArgs } from '../lib/ytdlp.js'
import { buildCompressArgs, compressOutputPath } from '../lib/ffmpeg.js'
import { engineOf } from '../lib/downloaders/index.js'
import { nativeStatus } from '../lib/native.js'
import { EDITABLE_KEYS, coercePatch, coerceValue, plain, snapshot } from '../lib/settings.js'
import { buildRoutes } from '../lib/routes.js'

const checks = []
/** @param {string} name - check label. @param {() => Promise<void>|void} body - assertions. */
async function check(name, body) {
  try {
    await body()
    checks.push(`ok   ${name}`)
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** Fresh DSH_HOME for a check. @returns {string} the temp dir */
function freshHome() {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'vf-home-'))
  return process.env.DSH_HOME
}

/** Register all tools against the current DSH_HOME. @returns {Promise<object>} name → tool */
async function registeredTools() {
  const mod = await import('../lib/index.js')
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  mod.apply(ctx, mod.Config({}))
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]))
}

// ── yt-dlp args ─────────────────────────────────────────────────────────────

await check('buildFetchArgs: core shape, URL behind --', () => {
  const args = buildFetchArgs({ url: 'https://www.bilibili.com/video/BV1xx411c7mD', outDir: '/out', format: 'bv*+ba/b' })
  assert.ok(args.includes('--no-progress'))
  assert.ok(args.includes('--newline'))
  assert.deepEqual(args.slice(-2), ['--', 'https://www.bilibili.com/video/BV1xx411c7mD'])
  assert.ok(args.join(' ').includes('/out/%(title).80s'))
  assert.ok(args.includes('bv*+ba/b'))
  assert.ok(args.includes('mp4'), 'merge-output-format mp4 by default')
  assert.ok(args.includes('--no-playlist'))
  assert.ok(!args.includes('--cookies'), 'no cookies flag without a file')
})

await check('buildFetchArgs: cookies only when given, playlist flag toggleable', () => {
  const withCookies = buildFetchArgs({ url: 'https://x.test/v', outDir: '/o', format: 'f', cookiesPath: '/c/cookies.txt', noPlaylist: false })
  assert.ok(withCookies.includes('--cookies') && withCookies.includes('/c/cookies.txt'))
  assert.ok(!withCookies.includes('--no-playlist'))
})

await check('parseFetchedPath: after_move line, skip line, garbage', () => {
  assert.equal(parseFetchedPath('warn\n/out/a title [id123].mp4\n'), '/out/a title [id123].mp4')
  assert.equal(parseFetchedPath('[download] /out/dup.mp4 has already been downloaded\n'), '/out/dup.mp4')
  assert.equal(parseFetchedPath('nothing useful'), '')
})

await check('stderrTail: empty stays empty, long text keeps the tail', () => {
  assert.equal(stderrTail(''), '')
  const tail = stderrTail('x'.repeat(2000))
  assert.equal(tail.length, 801) // ellipsis + 800
  assert.ok(tail.startsWith('…'))
})

// ── ffmpeg args ─────────────────────────────────────────────────────────────

await check('buildCompressArgs: height cap filter + QQ-ready flags', () => {
  const args = buildCompressArgs({ input: '/in.mp4', output: '/out.mp4', crf: 26, maxHeight: 720 })
  const vf = args[args.indexOf('-vf') + 1]
  assert.equal(vf, "scale=-2:'min(720,ih)'")
  assert.equal(args[args.indexOf('-crf') + 1], '26')
  assert.equal(args[args.indexOf('-b:a') + 1], '128k')
  assert.ok(args.includes('+faststart'))
  assert.ok(args.includes('libx264'))
  assert.equal(args.at(-1), '/out.mp4')
})

await check('buildCompressArgs: maxHeight 0 means no -vf at all', () => {
  const args = buildCompressArgs({ input: '/in.mp4', output: '/out.mp4', crf: 30, maxHeight: 0 })
  assert.ok(!args.includes('-vf'))
})

await check('compressOutputPath: .small suffix, never equals input', () => {
  const out = compressOutputPath('/dir/my clip.webm')
  assert.equal(out, '/dir/my clip.small.webm')
  assert.notEqual(out, '/dir/my clip.webm')
})

// ── cookie codec ────────────────────────────────────────────────────────────

// ── cookie-jar array store ──────────────────────────────────────────────────

// ── provider registry ───────────────────────────────────────────────────────

// ── plugin registration ─────────────────────────────────────────────────────

await check('apply: registers 4 tools with the right names + config defaults', async () => {
  freshHome()
  const mod = await import('../lib/index.js')
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  const config = mod.Config({})
  // The tunable fields are volatile refs; plain() is the read side.
  assert.equal(plain(config.crf), 26)
  assert.equal(plain(config.maxHeight), 720)
  assert.equal(plain(config.format), 'bv*+ba/b')
  assert.equal(plain(config.audioBitrate), '128k')
  assert.equal(plain(config.preset), 'medium')
  assert.equal(config.ytdlpBinary, 'yt-dlp')
  mod.apply(ctx, config)
  assert.deepEqual(tools.map((t) => t.name), ['video_fetch', 'video_login', 'video_compress', 'video_settings'])
})

await check('video_fetch: rejects non-http(s) URL before touching the network', async () => {
  freshHome()
  const tools = await registeredTools()
  await assert.rejects(() => tools.video_fetch.execute({ url: 'file:///etc/passwd' }, {}), /unsupported URL scheme/)
})

await check('video_compress: rejects relative and missing paths', async () => {
  freshHome()
  const tools = await registeredTools()
  await assert.rejects(() => tools.video_compress.execute({ file: 'relative.mp4' }, {}), /absolute path/)
  await assert.rejects(() => tools.video_compress.execute({ file: '/nonexistent/file.mp4' }, {}), /not a file/)
})

// ── workspace containment (video_fetch downloads) ──────────────────────────

await check('downloadDir: resolves only inside the session workspace', async () => {
  const mod = await import('../lib/index.js')
  const ws = mkdtempSync(join(tmpdir(), 'vf-ws-'))
  const exec = { agent: { session: { header: { cwd: ws } } } }
  assert.equal(mod.downloadDirOf(mod.Config({}), exec), join(ws, 'dsh-video-fetch'))
  assert.equal(mod.downloadDirOf(mod.Config({ downloadDir: 'clips' }), exec), join(ws, 'clips'))
  assert.equal(mod.downloadDirOf(mod.Config({ downloadDir: '.' }), exec), resolve(ws))
  assert.throws(() => mod.downloadDirOf(mod.Config({ downloadDir: '/etc/videos' }), exec), /inside the session workspace/)
  assert.throws(() => mod.downloadDirOf(mod.Config({ downloadDir: '../evil' }), exec), /inside the session workspace/)
  rmSync(ws, { recursive: true, force: true })
})

await check('downloadDir: no session workspace → fail closed before any fs write', async () => {
  const mod = await import('../lib/index.js')
  const config = mod.Config({})
  assert.throws(() => mod.downloadDirOf(config, undefined), /no session workspace/)
  assert.throws(() => mod.downloadDirOf(config, {}), /no session workspace/)
  assert.throws(() => mod.downloadDirOf(config, { agent: { session: { header: {} } } }), /no session workspace/)
})

await check('downloadDir: a symlink in the workspace cannot redirect downloads out of it', async () => {
  const mod = await import('../lib/index.js')
  const ws = mkdtempSync(join(tmpdir(), 'vf-ws-'))
  const outside = mkdtempSync(join(tmpdir(), 'vf-out-'))
  symlinkSync(outside, join(ws, 'clips'))
  assert.throws(
    () => mod.downloadDirOf(mod.Config({ downloadDir: 'clips' }), { agent: { session: { header: { cwd: ws } } } }),
    /resolves outside/,
  )
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

await check('video_fetch: fails closed before the network when the session has no workspace', async () => {
  freshHome()
  const tools = await registeredTools()
  await assert.rejects(() => tools.video_fetch.execute({ url: 'https://example.com/v' }, {}), /no session workspace/)
})

// ── settings contract (shared by video_settings and the web page) ───────────

await check('settings: coerceValue enforces type, range, enum, and bitrate shape', () => {
  assert.equal(coerceValue('crf', '22'), 22)
  assert.equal(coerceValue('crf', 22), 22)
  assert.equal(coerceValue('maxHeight', 0), 0)
  assert.throws(() => coerceValue('crf', 60), /must be 0-51/)
  assert.throws(() => coerceValue('crf', 1.5), /must be an integer/)
  assert.throws(() => coerceValue('preset', 'nope'), /must be one of/)
  assert.equal(coerceValue('preset', 'veryfast'), 'veryfast')
  assert.equal(coerceValue('audioBitrate', '192k'), '192k')
  assert.throws(() => coerceValue('audioBitrate', 'loud'), /must look like/)
  assert.throws(() => coerceValue('format', '  '), /must not be empty/)
  assert.equal(coerceValue('downloadDir', ''), '')
  assert.equal(coerceValue('downloadDir', 'clips'), 'clips')
  assert.throws(() => coerceValue('downloadDir', '/etc/videos'), /inside the session workspace/)
  assert.throws(() => coerceValue('downloadDir', '../evil'), /inside the session workspace/)
  assert.throws(() => coerceValue('nope', 1), /unknown setting/)
})

await check('settings: coercePatch validates the whole patch before any write', () => {
  assert.deepEqual(coercePatch({ crf: '22', maxHeight: 480 }), { crf: 22, maxHeight: 480 })
  assert.throws(() => coercePatch({}), /is empty/)
  assert.throws(() => coercePatch(null), /must be an object/)
  assert.throws(() => coercePatch({ crf: 22, preset: 'nope' }), /must be one of/)
})

await check('settings: snapshot unwraps volatile refs and covers every editable key', () => {
  const config = {
    downloadDir: { get: () => 'clips' },
    format: { get: () => 'bv*+ba/b' },
    crf: { get: () => 20 },
    maxHeight: 720,
    audioBitrate: { get: () => '128k' },
    preset: { get: () => 'medium' },
  }
  const values = snapshot(config)
  assert.deepEqual(Object.keys(values), [...EDITABLE_KEYS])
  assert.equal(values.crf, 20)
  assert.equal(values.maxHeight, 720)
  assert.equal(values.downloadDir, 'clips')
})

await check('settings: video_settings action=get prints live values without writing', async () => {
  freshHome()
  const tools = await registeredTools()
  const result = await tools.video_settings.execute({ action: 'get' }, {})
  assert.match(result.text, /crf = 26/)
  assert.match(result.text, /maxHeight = 720/)
  assert.match(result.text, /preset = "medium"/)
})

await check('settings: action=set without configEditor fails loudly, never silently', async () => {
  freshHome()
  const tools = await registeredTools()
  await assert.rejects(
    () => tools.video_settings.execute({ action: 'set', patch: { crf: 22 } }, {}),
    /configEditor is unavailable/,
  )
  await assert.rejects(
    () => tools.video_settings.execute({ action: 'set', patch: { crf: 99 } }, {}),
    /must be 0-51/,
  )
})

await check('video_login: poll without a session says so', async () => {
  freshHome()
  if (!nativeStatus().available) return
  const tools = await registeredTools()
  await assert.rejects(
    () => tools.video_login.execute({ action: 'poll', sessionId: '' }, {}),
    /malformed session id/,
  )
})

await check('video_login: unknown channel is a structured channel error', async () => {
  freshHome()
  if (!nativeStatus().available) return
  const tools = await registeredTools()
  await assert.rejects(
    () => tools.video_login.execute({ action: 'start', channel: 'nope', method: 'qr' }, {}),
    /unknown channel 'nope'/,
  )
})

await check('video_login: reserved method refuses with the channel’s implemented list', async () => {
  freshHome()
  if (!nativeStatus().available) return
  const tools = await registeredTools()
  await assert.rejects(
    () => tools.video_login.execute({ action: 'start', channel: 'youku', method: 'qr' }, {}),
    /does not implement the 'qr' login method/,
  )
})

await check('video_login: unknown action is rejected', async () => {
  freshHome()
  if (!nativeStatus().available) return
  const tools = await registeredTools()
  await assert.rejects(
    () => tools.video_login.execute({ action: 'telepathy' }, {}),
    /"action" must be one of/,
  )
})

// ── web routes (the Plugins-page surface) ───────────────────────────────────

/** Drive one route with a fake request/response pair. @returns {Promise<{status: number, body: any}>} */
async function callRoute(routes, path, body) {
  const route = routes.find((entry) => entry.path === path.split('?')[0])
  assert.ok(route, `route ${path} exists`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Object.assign(
    (function* () { for (const chunk of chunks) yield chunk })(),
    { method: body === undefined ? 'GET' : 'POST', url: path },
  )
  let payload = ''
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value },
    end(value) { payload = value === undefined ? '' : String(value) },
  }
  await route.handler(req, res)
  let parsed
  try { parsed = JSON.parse(payload) } catch { parsed = payload }
  return { status: res.statusCode, body: parsed }
}

await check('routes: state reports live settings, the field table, and labeled channels', async () => {
  freshHome()
  const mod = await import('../lib/index.js')
  const config = mod.Config({})
  const routes = buildRoutes({ get: () => undefined }, config)
  const { status, body } = await callRoute(routes, '/video-fetch/state')
  assert.equal(status, 200)
  assert.equal(body.settings.crf, 26)
  assert.equal(body.settings.maxHeight, 720)
  assert.deepEqual(body.fields.map((field) => field.key), [...EDITABLE_KEYS])
  const crf = body.fields.find((field) => field.key === 'crf')
  assert.deepEqual({ min: crf.min, max: crf.max, type: crf.type }, { min: 0, max: 51, type: 'integer' })
  // The card needs a display name per channel — that label was the complaint.
  if (!nativeStatus().available) return
  const bilibili = body.channels.find((entry) => entry.channel.id === 'bilibili')
  assert.equal(bilibili.channel.name, '哔哩哔哩')
  assert.ok(bilibili.channel.methods.some((method) => method.id === 'qr' && method.implemented))
})

await check('routes: set rejects a bad value with 400 and never writes', async () => {
  freshHome()
  const mod = await import('../lib/index.js')
  const routes = buildRoutes({ get: () => undefined }, mod.Config({}))
  const bad = await callRoute(routes, '/video-fetch/set', { patch: { crf: 99 } })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /must be 0-51/)
  const unknown = await callRoute(routes, '/video-fetch/set', { patch: { nope: 1 } })
  assert.equal(unknown.status, 400)
  assert.match(unknown.body.error, /unknown setting/)
})

await check('routes: set/reset fail loudly when the host has no configEditor', async () => {
  freshHome()
  const mod = await import('../lib/index.js')
  const routes = buildRoutes({ get: () => undefined }, mod.Config({}))
  const set = await callRoute(routes, '/video-fetch/set', { patch: { crf: 22 } })
  assert.equal(set.status, 400)
  assert.match(set.body.error, /configEditor is unavailable/)
  const reset = await callRoute(routes, '/video-fetch/reset', {})
  assert.equal(reset.status, 400)
  assert.match(reset.body.error, /configEditor is unavailable/)
})

await check('routes: login status is offline-safe; challenge route rejects an empty payload', async () => {
  freshHome()
  const mod = await import('../lib/index.js')
  const routes = buildRoutes({ get: () => undefined }, mod.Config({}))
  const status = await callRoute(routes, '/video-fetch/login/status')
  assert.equal(status.status, 200)
  // Shape is the channel advertisement plus its pool, not a bare login flag.
  assert.equal(status.body.accounts.length, 0)
  assert.equal(status.body.active, null)
  const unknown = await callRoute(routes, '/video-fetch/login/status?channel=nope')
  assert.equal(unknown.status, 400)
  const blank = await callRoute(routes, '/video-fetch/challenge')
  assert.equal(blank.status, 400)
  assert.match(blank.body.error, /no scannable QR payload/)
})

await check('routes: logout of an unknown account is a no-op, not an error', async () => {
  freshHome()
  if (!nativeStatus().available) return
  const mod = await import('../lib/index.js')
  const routes = buildRoutes({ get: () => undefined }, mod.Config({}))
  const result = await callRoute(routes, '/video-fetch/login/logout', {
    channel: 'bilibili',
    account: 'deadbeefdeadbeef',
  })
  // Removing something that is not there succeeds and reports zero removals,
  // so a retry after a logout cannot be mistaken for a real deletion.
  assert.equal(result.status, 200)
  assert.equal(result.body.removed, false)
})

// ── slash commands ─────────────────────────────────────────────────────────

/**
 * A host context whose `reflect.get` resolves the command registry, the way
 * cordis does it for a service the plugin does not declare in `inject`.
 * @returns {object} `{ ctx, definitions, disposers }`
 */
function ctxWithCommands() {
  const definitions = []
  return {
    definitions,
    ctx: {
      tools: { register: () => {} },
      reflect: {
        get: (name) => (
          name === 'commands'
            ? { register: (definition) => { definitions.push(definition); return () => {} } }
            : undefined
        ),
      },
    },
  }
}

/** @param {object} definition - a registered command. @param {string} tail - text after the name. */
function runCommand(definition, tail) {
  return definition.handler({ rawInput: tail })
}

await check('commands: register into the registry, and are skipped when it is absent', async () => {
  freshHome()
  const mod = await import('../lib/index.js')

  const with_ = ctxWithCommands()
  mod.apply(with_.ctx, mod.Config({}))
  assert.deepEqual(with_.definitions.map((d) => d.name), ['video-settings', 'video-login'])
  // Discovery copy and the input hint are what a composer's slash menu shows.
  for (const definition of with_.definitions) {
    assert.ok(definition.description.length > 0, `${definition.name} needs a description`)
    assert.ok(definition.input.hint.length > 0, `${definition.name} needs an input hint`)
  }

  // No `reflect` at all: the plugin must still load, just without commands.
  const without = { tools: { register: () => {} } }
  mod.apply(without, mod.Config({}))
})

await check('commands: /video-settings reads, writes, and rejects a bad field', async () => {
  freshHome()
  const { ctx, definitions } = ctxWithCommands()
  const mod = await import('../lib/index.js')
  mod.apply(ctx, mod.Config({}))
  const settings = definitions.find((d) => d.name === 'video-settings')

  // `rawInput` keeps the separator whitespace; an empty tail is "" or " ".
  const read = await runCommand(settings, '')
  assert.equal(read.kind, 'success')
  assert.match(read.text, /crf = 26/)
  assert.match(read.text, /downloadEngine = "ytdlp"/)
  const spaced = await runCommand(settings, '   ')
  assert.equal(spaced.kind, 'success', 'a whitespace-only tail is still "no arguments"')

  // No configEditor in this composition: the write must fail as a result, not
  // as a thrown error an adapter would surface as a crash.
  const bad = await runCommand(settings, 'crf=99')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /must be 0-51/)
  const unknown = await runCommand(settings, 'nope=1')
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.text, /unknown setting/)
  const shapeless = await runCommand(settings, 'crf')
  assert.equal(shapeless.kind, 'error')
  assert.match(shapeless.text, /expected <field>=<value>/)
  const write = await runCommand(settings, 'crf=22')
  assert.equal(write.kind, 'error')
  assert.match(write.text, /configEditor is unavailable/)
})

await check('commands: /video-login reports the backend when it is missing', async () => {
  freshHome()
  const { ctx, definitions } = ctxWithCommands()
  const mod = await import('../lib/index.js')
  mod.apply(ctx, mod.Config({}))
  const login = definitions.find((d) => d.name === 'video-login')

  const result = await runCommand(login, '')
  if (nativeStatus().available) {
    assert.equal(result.kind, 'success')
    assert.match(result.text, /account\(s\)/, 'status lists each channel’s pool')
  } else {
    assert.equal(result.kind, 'error')
    assert.match(result.text, /login backend is unavailable/)
  }

  // Unknown subcommands and missing arguments are results, never throws.
  const bogus = await runCommand(login, 'frobnicate')
  if (nativeStatus().available) {
    assert.equal(bogus.kind, 'error')
    assert.match(bogus.text, /unknown subcommand/)
  }
  const nostart = await runCommand(login, 'start')
  assert.notEqual(nostart.kind, 'success')
})

await check('commands: /video-login start → poll carries the session across invocations', async () => {
  freshHome()
  if (!nativeStatus().available) return
  const { ctx, definitions } = ctxWithCommands()
  const mod = await import('../lib/index.js')
  mod.apply(ctx, mod.Config({}))
  const login = definitions.find((d) => d.name === 'video-login')

  const started = await runCommand(login, 'start bilibili qr')
  assert.equal(started.kind, 'success', started.text)
  const id = /sessionId: (\S+)/.exec(started.text)
  assert.ok(id, `start must name the session: ${started.text}`)
  assert.match(started.text, /\/video-login poll/, 'start must say what comes next')

  // A separate invocation — the session lives in the native layer, so the
  // command only has to remember the id.
  // Nobody scanned, so this must report still-waiting. Asserted without
  // matching the wording: the message comes from the provider's own copy,
  // which is Chinese for bilibili.
  const polled = await runCommand(login, 'poll')
  assert.equal(polled.kind, 'success', polled.text)
  assert.ok(polled.text.trim().length > 0, 'poll must say something')
  assert.doesNotMatch(polled.text, /Logged in/, 'an unscanned QR cannot be done')

  const cancelled = await runCommand(login, 'cancel')
  assert.equal(cancelled.kind, 'success')
  const after = await runCommand(login, 'poll')
  assert.equal(after.kind, 'error', 'after cancel there is nothing left to poll')
})

console.log(checks.join('\n'))
console.log(`\n${checks.filter((c) => c.startsWith('ok')).length}/${checks.length} passed`)
