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
} from '../lib/cookies.js'
import { providerBySite, providerByUrl, siteNames } from '../lib/auth/index.js'
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

await check('parseSetCookies: attributes, defaults, max-age override', () => {
  const cookies = parseSetCookies([
    'SESSDATA=abc%2C1; Domain=.bilibili.com; Expires=Wed, 01 Jan 2027 00:00:00 GMT; Path=/; HttpOnly; Secure',
    'sid=plainvalue; Path=/; Max-Age=60',
  ])
  assert.equal(cookies.length, 2)
  assert.equal(cookies[0].name, 'SESSDATA')
  assert.equal(cookies[0].domain, '.bilibili.com')
  assert.equal(cookies[0].secure, true)
  assert.equal(cookies[0].httpOnly, true)
  assert.ok(cookies[0].expires > 1_700_000_000)
  assert.equal(cookies[1].domain, '', 'no Domain → empty')
  assert.ok(Math.abs(cookies[1].expires - (Math.floor(Date.now() / 1000) + 60)) <= 5)
})

await check('toNetscape + headerFromNetscape: round-trip incl. HttpOnly lines', () => {
  const cookies = parseSetCookies([
    'SESSDATA=abc,1; Domain=.bilibili.com; Path=/; HttpOnly; Secure',
    'bili_jct=tok; Domain=.bilibili.com; Path=/',
  ])
  const file = toNetscape(cookies, 'bilibili.com')
  assert.equal(file.split('\n')[0], '# Netscape HTTP Cookie File')
  assert.ok(file.includes('#HttpOnly_.bilibili.com'), 'HttpOnly marker kept')
  assert.equal(headerFromNetscape(file), 'SESSDATA=abc,1; bili_jct=tok')
  assert.equal(headerFromNetscape(''), '')
})

await check('countNetscapeCookies: header/comments skipped, HttpOnly rows counted', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    '# a comment, not a cookie',
    '.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tv1',
    '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tbili_jct\tv2',
    '',
  ].join('\n')
  assert.equal(countNetscapeCookies(text), 2)
  assert.equal(countNetscapeCookies('hello world'), 0)
  assert.equal(countNetscapeCookies(''), 0)
})

// ── cookie-jar array store ──────────────────────────────────────────────────

await check('jar store: add → materialize round-trips Netscape at 0600', () => {
  freshHome()
  const data = toNetscape(parseSetCookies(['SESSDATA=abc,1; Domain=.bilibili.com; Path=/; HttpOnly']), 'bilibili.com')
  const added = addJar('bilibili', { source: 'qr', data })
  assert.deepEqual({ index: added.index, total: added.total, duplicate: added.duplicate }, { index: 1, total: 1, duplicate: false })
  const path = materializeJar('bilibili', 0)
  assert.equal(statSync(path).mode & 0o777, 0o600, 'materialized jar must be 0600')
  assert.equal(readFileSync(path, 'utf8'), data)
  assert.throws(() => materializeJar('bilibili', 1), /no cookie jar #2/)
})

await check('jar store: dedupe, newest first, MAX_JARS cap, per-site removal', () => {
  freshHome()
  addJar('bilibili', { source: 'manual', data: 'A' })
  const dup = addJar('bilibili', { source: 'qr', data: 'A' })
  assert.equal(dup.duplicate, true)
  assert.equal(dup.index, 1, 'duplicate reports the existing jar position')
  let last = null
  for (const data of ['B', 'C', 'D', 'E']) last = addJar('bilibili', { source: 'manual', data })
  assert.equal(last.trimmed, false, 'cap not reached yet')
  const overflow = addJar('bilibili', { source: 'manual', data: 'F' })
  assert.equal(overflow.trimmed, true)
  const jars = readJars('bilibili')
  assert.equal(jars.length, MAX_JARS)
  assert.equal(jars[0].data, 'F', 'newest first')
  assert.equal(readJars('other-site').length, 0, 'sites do not share jars')
  assert.equal(removeJars('bilibili'), MAX_JARS)
  assert.equal(readJars('bilibili').length, 0)
  assert.equal(removeJars('bilibili'), 0, 'second removal is a no-op')
})

await check('rotateJars: rotates past failures and reports the jar that worked', async () => {
  const jars = [{ data: '1' }, { data: '2' }, { data: '3' }]
  const seen = []
  const result = await rotateJars(jars, {
    useJar: (i) => { seen.push(i); return `/jar${i}` },
    attempt: async (p) => {
      if (p === '/jar0') throw new Error('jar rejected')
      return `kept:${p}`
    },
  })
  assert.deepEqual(seen, [0, 1], 'second jar tried after the first failed')
  assert.equal(result.value, 'kept:/jar1')
  assert.equal(result.index, 1)
})

await check('rotateJars: throws the LAST error; stop() halts before attempting', async () => {
  await assert.rejects(
    () => rotateJars([{}, {}], { useJar: (i) => `/j${i}`, attempt: async (p) => { throw new Error(`fail:${p}`) } }),
    /fail:\/j1/,
    'the last attempt’s error is what surfaces',
  )
  let attempts = 0
  await assert.rejects(
    () => rotateJars([{}, {}], { useJar: (i) => `/j${i}`, attempt: async () => { attempts += 1 }, stop: () => true }),
    /no cookie jars available/,
  )
  assert.equal(attempts, 0, 'stop() before the first attempt runs nothing')
})

// ── provider registry ───────────────────────────────────────────────────────

await check('registry: bilibili routing by host; unknown site/url → null', () => {
  assert.deepEqual(siteNames(), ['bilibili'])
  assert.equal(providerByUrl('https://www.bilibili.com/video/BV1xx411c7mD')?.site, 'bilibili')
  assert.equal(providerByUrl('https://b23.tv/abc')?.site, 'bilibili')
  assert.equal(providerByUrl('https://youtube.com/watch?v=x'), null)
  assert.equal(providerByUrl('not a url'), null)
  assert.equal(providerBySite('bilibili')?.methods.includes('qr'), true)
  assert.equal(providerBySite('bilibili')?.methods.includes('manual'), true)
  assert.equal(providerBySite('youtube'), null)
})

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

await check('video_login: poll without pending state says so', async () => {
  freshHome()
  const tools = await registeredTools()
  const result = await tools.video_login.execute({ action: 'poll' }, {})
  assert.match(result.text, /action=start first/)
})

await check('video_login: site × method contract — unknowns, reserved methods, wrong action', async () => {
  freshHome()
  const tools = await registeredTools()
  // Schema layer rejects unknown enum values before execute runs.
  await assert.rejects(
    () => tools.video_login.execute({ action: 'start', site: 'youtube' }, {}),
    /"site" must be one of \["bilibili"\]/,
  )
  await assert.rejects(
    () => tools.video_login.execute({ action: 'start', method: 'magic' }, {}),
    /"method" must be one of/,
  )
  // Reserved-but-listed methods reach execute and fail with the contract error.
  await assert.rejects(
    () => tools.video_login.execute({ action: 'start', method: 'password' }, {}),
    /method=password is reserved but not implemented for site=bilibili \(implemented: qr, manual\)/,
  )
  await assert.rejects(
    () => tools.video_login.execute({ action: 'import' }, {}),
    /action=import is not valid for method=qr.*use method=manual/,
  )
  await assert.rejects(
    () => tools.video_login.execute({ action: 'start', method: 'manual' }, {}),
    /action=start is not valid for method=manual/,
  )
})

await check('video_login: manual import stores a jar; logout clears only that site', async () => {
  freshHome()
  const exportDir = mkdtempSync(join(tmpdir(), 'vf-export-'))
  const cookieFile = join(exportDir, 'export.txt')
  writeFileSync(cookieFile, toNetscape(parseSetCookies(['SESSDATA=secret; Domain=.bilibili.com; Path=/; HttpOnly']), 'bilibili.com'))
  const tools = await registeredTools()

  const imported = await tools.video_login.execute({ action: 'import', method: 'manual', path: cookieFile }, {})
  assert.match(imported.text, /Imported 1 cookie\(s\) for bilibili as jar 1 of 1/)
  assert.ok(!imported.text.includes('secret'), 'cookie value must never reach the result')

  const again = await tools.video_login.execute({ action: 'import', method: 'manual', path: cookieFile }, {})
  assert.match(again.text, /Already stored as jar 1 of 1/)

  await assert.rejects(
    () => tools.video_login.execute({ action: 'import', method: 'manual', path: 'relative.txt' }, {}),
    /absolute path/,
  )
  const junk = join(exportDir, 'junk.txt')
  writeFileSync(junk, 'hello world')
  await assert.rejects(
    () => tools.video_login.execute({ action: 'import', method: 'manual', path: junk }, {}),
    /no cookie rows/,
  )

  const loggedOut = await tools.video_login.execute({ action: 'logout' }, {}) // default method=qr
  assert.match(loggedOut.text, /Cookies deleted for bilibili \(1 jar\(s\)\)/)
  assert.equal(readJars('bilibili').length, 0)
  const againOut = await tools.video_login.execute({ action: 'logout' }, {})
  assert.match(againOut.text, /Already logged out/)
})

await check('video_login: status with no cookies is offline and says so', async () => {
  freshHome()
  const tools = await registeredTools()
  const result = await tools.video_login.execute({ action: 'status' }, {})
  assert.equal(result.text, 'Not logged in (no cookies for bilibili).')
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

await check('routes: state reports live settings, the field table, and jar counts', async () => {
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
  assert.deepEqual(body.sites, [{ site: 'bilibili', jars: 0 }])
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

await check('routes: login status is offline-safe; QR route 404s before a login', async () => {
  freshHome()
  const mod = await import('../lib/index.js')
  const routes = buildRoutes({ get: () => undefined }, mod.Config({}))
  const status = await callRoute(routes, '/video-fetch/login/status')
  assert.equal(status.status, 200)
  assert.equal(status.body.loggedIn, false)
  assert.equal(status.body.jars, 0)
  assert.deepEqual(status.body.methods, ['qr', 'manual'])
  const unknown = await callRoute(routes, '/video-fetch/login/status?site=youtube')
  assert.equal(unknown.status, 400)
  const qr = await callRoute(routes, '/video-fetch/qr')
  assert.equal(qr.status, 404)
  assert.match(qr.body.error, /no QR code yet/)
})

await check('routes: logout clears jars and is idempotent', async () => {
  freshHome()
  const mod = await import('../lib/index.js')
  const routes = buildRoutes({ get: () => undefined }, mod.Config({}))
  addJar('bilibili', { source: 'manual', data: 'A' })
  const first = await callRoute(routes, '/video-fetch/login/logout', {})
  assert.deepEqual(first.body, { ok: true, site: 'bilibili', removed: 1 })
  const second = await callRoute(routes, '/video-fetch/login/logout', {})
  assert.equal(second.body.removed, 0)
})

console.log(checks.join('\n'))
console.log(`\n${checks.filter((c) => c.startsWith('ok')).length}/${checks.length} passed`)
