// Unit tests for the pure pieces: yt-dlp arg building, output parsing,
// ffmpeg arg building, cookie serialization, and plugin registration.
// No network, no downloads — run with `npm test`.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFetchedPath, stderrTail } from '../lib/proc.js'
import { buildFetchArgs } from '../lib/ytdlp.js'
import { buildCompressArgs, compressOutputPath } from '../lib/ffmpeg.js'
import { parseSetCookies, toNetscape, cookieHeader, writeCookies } from '../lib/bili.js'

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

// ── cookies ─────────────────────────────────────────────────────────────────

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

await check('toNetscape + cookieHeader: round-trip incl. HttpOnly lines', () => {
  const cookies = parseSetCookies([
    'SESSDATA=abc,1; Domain=.bilibili.com; Path=/; HttpOnly; Secure',
    'bili_jct=tok; Domain=.bilibili.com; Path=/',
  ])
  const file = toNetscape(cookies)
  const dir = mkdtempSync(join(tmpdir(), 'vf-cookie-'))
  const path = join(dir, 'cookies.txt')
  writeCookies(path, file)
  assert.equal(statSync(path).mode & 0o777, 0o600, 'cookies.txt must be 0600')
  const header = cookieHeader(path)
  assert.equal(header, 'SESSDATA=abc,1; bili_jct=tok')
  const lines = readFileSync(path, 'utf8').split('\n')
  assert.ok(lines.some((l) => l.startsWith('#HttpOnly_.bilibili.com')), 'HttpOnly marker kept')
  assert.equal(lines[0], '# Netscape HTTP Cookie File')
})

await check('cookieHeader: missing file → empty string', () => {
  assert.equal(cookieHeader('/nonexistent/cookies.txt'), '')
})

// ── plugin registration ─────────────────────────────────────────────────────

await check('apply: registers 3 tools with the right names + config defaults', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'vf-home-'))
  const mod = await import('../lib/index.js')
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  const config = mod.Config({})
  assert.equal(config.crf, 26)
  assert.equal(config.maxHeight, 720)
  assert.equal(config.format, 'bv*+ba/b')
  assert.equal(config.ytdlpBinary, 'yt-dlp')
  mod.apply(ctx, config)
  assert.deepEqual(tools.map((t) => t.name), ['video_fetch', 'video_login', 'video_compress'])
})

await check('video_fetch: rejects non-http(s) URL before touching the network', async () => {
  const mod = await import('../lib/index.js')
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  mod.apply(ctx, mod.Config({}))
  const fetchTool = tools.find((t) => t.name === 'video_fetch')
  await assert.rejects(() => fetchTool.execute({ url: 'file:///etc/passwd' }, {}), /unsupported URL scheme/)
})

await check('video_compress: rejects relative and missing paths', async () => {
  const mod = await import('../lib/index.js')
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  mod.apply(ctx, mod.Config({}))
  const compressTool = tools.find((t) => t.name === 'video_compress')
  await assert.rejects(() => compressTool.execute({ file: 'relative.mp4' }, {}), /absolute path/)
  await assert.rejects(() => compressTool.execute({ file: '/nonexistent/file.mp4' }, {}), /not a file/)
})

await check('video_login: poll without pending state says so', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'vf-home2-'))
  const mod = await import('../lib/index.js')
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  mod.apply(ctx, mod.Config({}))
  const loginTool = tools.find((t) => t.name === 'video_login')
  const result = await loginTool.execute({ action: 'poll' }, {})
  assert.match(result.text, /action=start first/)
})

console.log(checks.join('\n'))
console.log(`\n${checks.filter((c) => c.startsWith('ok')).length}/${checks.length} passed`)
