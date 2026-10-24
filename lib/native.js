// dsh-video-fetch — native login layer (koffi FFI over `video-login`).
//
// This module is the plugin's only contact with the credential machinery.
// Everything that knows how a site's login actually works lives in the
// `video-login` Rust workspace behind the C ABI frozen in that repo's
// docs/abi.md; this file loads the library and calls it. Keeping the login
// logic out of the plugin is the point: the same library serves a CLI, a dsh
// plugin, or any other harness, and none of them has to know what a
// `qrcode_key` is.
//
// The ABI has two functions and one rule:
//
//     int64_t  vlogin_call(const char *request, char *out, uint64_t out_len);
//     const char *vlogin_version(void);
//
// The **caller owns the output buffer**. Rust only writes into it, and there is
// deliberately no `vlogin_free`. (The alternative — returning a Rust-allocated
// C string for the host to free — demands that the host's allocator and Rust's
// agree, and every forgetful binding leaks. A caller-owned buffer has neither
// problem; the only cost is one extra call if the first buffer was too small.)
//
// `vlogin_call` returns the size the response occupies **including** the
// trailing NUL, so:
//
//   * `> 0` — the response is this many bytes. It was copied into `out` only if
//     it fit; otherwise grow to this size and call again.
//   * `-1`  — `request` was null or not valid UTF-8.
//
// Nothing is loaded at import time. A plugin whose native library is missing
// still registers its tools, and every login call fails with
// `NativeError('unavailable', …)` naming what to build or where to point
// `VLOGIN_NATIVE_LIB` — never with a crash on import.
//
// ## Why the first buffer is 1 MiB
//
// A retry **re-runs the operation**. For `channels` that is harmless, but for
// `start` it would mint a second QR code and for `poll` it would double-poll
// the site's endpoint. So the opening buffer is deliberately generous: real
// responses are a few kilobytes, and the capped `export` payload (512 KB of
// cookie text) still fits. The retry path exists only so an unexpected giant
// response degrades into two calls instead of a wrong answer.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshStateDir } from './state.js'

const require = createRequire(import.meta.url)

/** `major.minor` of the ABI in docs/abi.md this host was written against. */
export const ABI_VERSION = '0.1'
const [ABI_MAJOR, ABI_MINOR] = ABI_VERSION.split('.').map((part) => Number.parseInt(part, 10))

/** Opening output-buffer size, in bytes. See the header comment. */
const INITIAL_BUFFER = 1 << 20
/** Hard ceiling, so a runaway response cannot make us allocate without end. */
const MAX_BUFFER = 32 << 20

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = dirname(LIB_DIR)

/**
 * One failure, either from the native layer or from this loader.
 *
 * `code` is the ABI's stable `error.kind` (`channel`, `cookie`, `http`, `io`,
 * `json`, `other`) so callers can branch without parsing prose. This loader
 * adds two of its own: `unavailable` for "the library could not be loaded or
 * does not speak this ABI", and `bad_body` for "the library answered, but not
 * with the envelope we expect".
 */
export class NativeError extends Error {
  /**
   * @param {string} code - stable, branchable failure class.
   * @param {string} message - human-readable prose.
   * @param {object} [options] - standard `Error` options (`cause`).
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'NativeError'
    /** @type {string} */
    this.code = code
  }
}

// koffi is loaded eagerly (it is a small native addon, not the login library)
// but a failure is remembered rather than thrown, so import stays harmless.
let koffi = null
let koffiError = null
try {
  koffi = require('koffi')
} catch (error) {
  koffiError = error
}

/** @type {{done: boolean, api: {path: string, version: string, call: Function}|null, error: Error|null}} */
const loader = { done: false, api: null, error: null }

/** @returns {string[]} candidate file names for the current platform. */
function libraryFileNames() {
  const own = process.platform === 'darwin'
    ? 'libvlogin.dylib'
    : process.platform === 'win32'
      ? 'vlogin.dll'
      : 'libvlogin.so'
  const all = [own, 'libvlogin.so', 'libvlogin.dylib', 'vlogin.dll', 'libvlogin.dll']
  return [...new Set(all)]
}

/**
 * Where the library may live, in the order the plugin documents:
 * `$VLOGIN_NATIVE_LIB`, then the packaged `native/` directory, then the
 * directory holding this file, then the package root.
 * @returns {string[]} absolute candidate paths.
 */
function bundledCandidates() {
  const paths = []
  for (const name of libraryFileNames()) {
    paths.push(join(PKG_DIR, 'native', name))
    paths.push(join(LIB_DIR, name))
    paths.push(join(PKG_DIR, name))
  }
  return paths
}

/**
 * Pick the library to load.
 * @returns {string} an absolute path, or a bare file name for the platform loader.
 * @throws {NativeError} when `VLOGIN_NATIVE_LIB` names a file that does not exist.
 */
function pickLibrary() {
  const explicit = String(process.env.VLOGIN_NATIVE_LIB ?? '').trim()
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new NativeError('unavailable', `VLOGIN_NATIVE_LIB points at ${explicit}, which does not exist`)
    }
    return explicit
  }
  for (const candidate of bundledCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  // Last resort: a bare name lets dlopen/LoadLibrary search the platform paths
  // (LD_LIBRARY_PATH, DYLD_LIBRARY_PATH, the Windows DLL search order).
  return libraryFileNames()[0]
}

/**
 * Load the library once and check the ABI version it reports.
 * @returns {{path: string, version: string, call: Function}} the loaded symbols.
 * @throws {NativeError} `unavailable` when the library is missing or mismatched.
 */
/**
 * Tell the library where this harness keeps its state, before it is asked for
 * anything.
 *
 * The library is harness-independent: it resolves its root from `VLOGIN_HOME`
 * and otherwise XDG, and it does not know `DSH_HOME` exists. The dsh-specific
 * knowledge therefore belongs here, in the adapter, and crosses the boundary as
 * an environment variable the library already understands. Silence when the
 * harness has named no home is deliberate — it leaves the library's own default
 * in place instead of inventing a dsh path the user never used.
 * @returns {void}
 */
function exportStateHome() {
  const dir = dshStateDir()
  if (dir) process.env.VLOGIN_HOME = dir
}

function ensureApi() {
  if (loader.done) {
    if (loader.error) throw loader.error
    return loader.api
  }
  loader.done = true
  exportStateHome()
  try {
    if (!koffi) {
      throw new NativeError(
        'unavailable',
        `koffi could not be loaded (${koffiError?.message ?? 'not installed'}); run \`npm install\` in the plugin directory`,
      )
    }
    const path = pickLibrary()
    let library
    try {
      library = koffi.load(path)
    } catch (error) {
      throw new NativeError(
        'unavailable',
        `cannot load libvlogin from ${path} (${error.message}); build the Rust half (cargo build --release -p vlogin-abi) or point VLOGIN_NATIVE_LIB at the library`,
      )
    }
    let versionSymbol
    let callSymbol
    try {
      versionSymbol = library.func('vlogin_version', 'const char *', [])
      // The output parameter is declared `void *` rather than `char *`: a
      // `char *` is a string to koffi, and it would try to copy a *string out
      // of* an uninitialized buffer. `void *` passes our allocation through
      // untouched, which is what a caller-allocated buffer needs.
      callSymbol = library.func('vlogin_call', 'int64', ['const char *', 'void *', 'uint64'])
    } catch (error) {
      throw new NativeError('unavailable', `${path} does not export the video-login ABI (${error.message})`)
    }
    const version = String(versionSymbol() ?? '').trim()
    const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10))
    if (major !== ABI_MAJOR || minor !== ABI_MINOR) {
      throw new NativeError(
        'unavailable',
        `${path} reports video-login ${version || '(no version)'}, but this plugin speaks ${ABI_VERSION}; install the matching library or set VLOGIN_NATIVE_LIB`,
      )
    }
    loader.api = { path, version, call: callSymbol }
  } catch (error) {
    loader.error = error instanceof NativeError
      ? error
      : new NativeError('unavailable', error.message, { cause: error })
    throw loader.error
  }
  return loader.api
}

/**
 * Unwrap one response envelope.
 * @param {string} text - the response body the ABI wrote.
 * @param {string} op - operation name, for error messages.
 * @returns {*} the `result` member of a successful envelope.
 * @throws {NativeError} with the envelope's own `error.kind`.
 */
function decode(text, op) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new NativeError(
      'bad_body',
      `${op} returned something that is not JSON (${error.message})`,
      { cause: error },
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NativeError('bad_body', `${op} returned a response that is not an envelope`)
  }
  if (parsed.ok === true) return parsed.result
  if (parsed.ok === false) {
    const error = parsed.error ?? {}
    throw new NativeError(
      String(error.kind ?? 'other'),
      String(error.message ?? `${op} failed without a message`),
    )
  }
  throw new NativeError('bad_body', `${op} returned an envelope without \`ok\``)
}

/**
 * Read back what `vlogin_call` wrote into `buffer`.
 *
 * `needed` is the byte count the ABI reports, NUL included; the text is the
 * part before the NUL. Note that it is a **byte** count while JS strings are
 * measured in code units, so `text.length` is routinely smaller than
 * `needed - 1` for a response containing non-ASCII labels.
 * @param {unknown} buffer - koffi-allocated memory.
 * @param {number|bigint} needed - what `vlogin_call` returned.
 * @param {string} op - operation name, for error messages.
 * @returns {string} the response text.
 */
function readBuffer(buffer, needed, op) {
  if (needed <= 0) throw new NativeError('internal', `${op} returned no response`)
  void needed
  try {
    return String(koffi.decode(buffer, 'char', -1))
  } catch (error) {
    throw new NativeError('bad_body', `${op} returned a response that is not text (${error.message})`)
  }
}

/**
 * Perform one call on a worker thread (koffi's `.async` member takes a
 * node-style callback last), so the event loop is never blocked. A QR poll can
 * sit for minutes.
 * @param {Function} fn - the `vlogin_call` symbol.
 * @param {string} op - operation name.
 * @param {string} requestJson - the whole request object as JSON text.
 * @returns {Promise<*>} the op's `result`.
 */
function invokeAsync(fn, op, requestJson) {
  return new Promise((resolve, reject) => {
    // Grow-and-retry: the ABI reports the size it needs, we come back with it.
    // Sized generously up front, so this loop runs its body once in practice.
    let size = INITIAL_BUFFER
    const attempt = () => {
      let buffer
      try {
        buffer = koffi.alloc('char', size)
      } catch (error) {
        reject(new NativeError('internal', `cannot allocate ${size} bytes for ${op}: ${error.message}`, { cause: error }))
        return
      }
      try {
        fn.async(requestJson, buffer, size, (error, needed) => {
          try {
            if (error) {
              reject(new NativeError('internal', `vlogin_call(${op}) failed: ${error.message}`, { cause: error }))
              return
            }
            const want = Number(needed)
            if (want > size) {
              // The buffer was too small; nothing was written. Try again bigger.
              koffi.free(buffer)
              if (want > MAX_BUFFER) {
                reject(new NativeError('internal', `${op} needs ${want} bytes, above the ${MAX_BUFFER}-byte ceiling`))
                return
              }
              size = want
              attempt()
              return
            }
            resolve(decode(readBuffer(buffer, want, op), op))
          } catch (failure) {
            reject(failure)
          } finally {
            // Safe after the resolve() above: koffi.decode already copied the
            // bytes into a JS string, so the native memory is no longer live.
            try {
              koffi.free(buffer)
            } catch { /* already freed by the retry path */ }
          }
        })
      } catch (error) {
        try {
          koffi.free(buffer)
        } catch { /* nothing to release */ }
        reject(new NativeError('internal', `vlogin_call(${op}) could not be started: ${error.message}`, { cause: error }))
      }
    }
    attempt()
  })
}

/**
 * Call one ABI operation and return its `result`.
 *
 * Runs on a koffi worker thread, so a slow op (a QR poll waits on the user)
 * does not stall the host.
 * @param {string} op - operation name from docs/abi.md, e.g. `start`.
 * @param {object} [args] - request fields alongside `op`; omitted when the op
 *   takes nothing.
 * @returns {Promise<*>} the op's `result` member.
 * @throws {NativeError} with the envelope's `error.kind`, or `unavailable`.
 */
export async function call(op, args) {
  const api = ensureApi()
  return invokeAsync(api.call, op, JSON.stringify({ op, ...(args ?? {}) }))
}

/**
 * Whether the native library loaded, and which one.
 *
 * Never throws: the plugin's status output uses it to explain why a login would
 * fail instead of failing while describing itself.
 * @returns {{available: boolean, path: string, version: string, abi: string, error: string}}
 */
export function nativeStatus() {
  try {
    const api = ensureApi()
    return { available: true, path: api.path, version: api.version, abi: ABI_VERSION, error: '' }
  } catch (error) {
    return {
      available: false,
      path: '',
      version: '',
      abi: ABI_VERSION,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * True when a login call can actually run.
 *
 * Cheap guard for route handlers that want to say "not configured" rather than
 * throw.
 * @returns {boolean} whether the library is loaded.
 */
export function isAvailable() {
  return nativeStatus().available
}
