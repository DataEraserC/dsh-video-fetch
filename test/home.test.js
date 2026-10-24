// Where video-fetch state lands, and who decides.
//
// The login library is harness-independent: it resolves its root from
// VLOGIN_HOME, then XDG, and it must never learn that DSH_HOME exists — a
// fallback there would be inherited by every other caller that happens to run
// with the variable set. So the dsh location belongs to this plugin, which
// exports it into VLOGIN_HOME.
//
// These checks assert the file lands in the right directory on both sides of
// that seam, which is the only way to know the setting really reaches Rust: a
// test of the JavaScript side alone would pass even if the library ignored it.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One valid Netscape row, tab-separated, so `import` has something to store. */
const JAR = '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tabc123\n'

const checks = []
/** @param {string} name - check label. @param {() => Promise<void>} body - assertions. */
async function check(name, body) {
  try {
    await body()
    checks.push(`ok   ${name}`)
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/**
 * A separate module instance per case.
 *
 * native.js caches the loaded library and exports the home exactly once, so the
 * two cases cannot share an instance. The query string busts the ESM cache.
 * @param {string} tag - unique per case.
 * @returns {Promise<object>} the module.
 */
function loadNative(tag) {
  return import(`../lib/native.js?case=${tag}`)
}

/** @param {string} parent - parent directory. @returns {string} a fresh temp dir. */
function tempIn(parent) {
  return mkdtempSync(join(parent, 'case-'))
}

const scratch = mkdtempSync(join(tmpdir(), 'vf-home-'))
const dshHome = tempIn(scratch)
const plainHome = tempIn(scratch)
const xdgData = join(plainHome, 'xdg')

const dshAccounts = join(dshHome, 'video-fetch', 'accounts', 'bilibili.json')
const plainAccounts = join(xdgData, 'video-login', 'accounts', 'bilibili.json')

// ── the harness names a home ────────────────────────────────────────────────

process.env.DSH_HOME = dshHome
const withHome = await loadNative('dsh-home')
const status = withHome.nativeStatus()

if (!status.available) {
  console.log(`skip: ${status.error}`)
  process.exit(0)
}

await check('with DSH_HOME set, accounts land in the dsh video-fetch directory', async () => {
  await withHome.call('import', { channel: 'bilibili', cookies: JAR, label: 'probe' })
  assert.equal(process.env.VLOGIN_HOME, join(dshHome, 'video-fetch'))
  assert.ok(existsSync(dshAccounts), `the account file is at ${dshAccounts}`)
})

// ── the harness names none ──────────────────────────────────────────────────

delete process.env.DSH_HOME
delete process.env.VLOGIN_HOME
process.env.HOME = plainHome
process.env.XDG_DATA_HOME = xdgData
const noHome = await loadNative('no-dsh-home')

await check('with no DSH_HOME, the library uses its own default', async () => {
  await noHome.call('import', { channel: 'bilibili', cookies: JAR, label: 'probe' })
  assert.equal(
    process.env.VLOGIN_HOME,
    undefined,
    'the adapter stays silent instead of inventing a dsh path',
  )
  assert.ok(existsSync(plainAccounts), `the account file is at ${plainAccounts}`)
  assert.ok(
    !existsSync(join(plainHome, '.dsh')),
    'nothing was written to a dsh directory the user never used',
  )
})

await check('the same operation landed in two different places', async () => {
  // Both files existing, in two trees that share no prefix, is what proves the
  // location came from the export and not from the environment.
  assert.ok(existsSync(dshAccounts) && existsSync(plainAccounts))
  assert.notEqual(dshAccounts, plainAccounts)
  assert.ok(!dshAccounts.startsWith(plainHome), 'the dsh tree is not inside the plain one')
  assert.ok(!plainAccounts.startsWith(dshHome), 'the plain tree is not inside the dsh one')
})

console.log(checks.join('\n'))
console.log(`\nState home: ${checks.length} checks`)
