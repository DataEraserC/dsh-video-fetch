// ffmpeg compression: QQ-sendable MP4 out of any yt-dlp (or local) file.
//
// The filter caps HEIGHT, not width: QQ re-encode targets stay portrait-safe.
// `scale=-2:'min(<cap>,ih)'` keeps aspect and forces even dimensions.

import { basename, dirname, extname, join } from 'node:path'
import { resolveBin, runBin, stderrTail } from './proc.js'

/**
 * Build the ffmpeg argv for one compression.
 * @param {object} options - compression options.
 * @param {string} options.input - source file.
 * @param {string} options.output - target file.
 * @param {number} options.crf - x264 CRF (lower = better quality, bigger file).
 * @param {number} options.maxHeight - height cap in pixels (0 = no scaling).
 * @param {string} [options.audioBitrate] - AAC bitrate.
 * @param {string} [options.preset] - x264 preset.
 * @returns {string[]} argv.
 */
export function buildCompressArgs({ input, output, crf, maxHeight, audioBitrate = '128k', preset = 'medium' }) {
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
  ]
  if (maxHeight > 0) args.push('-vf', `scale=-2:'min(${maxHeight},ih)'`)
  args.push(
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', audioBitrate,
    '-movflags', '+faststart',
    output,
  )
  return args
}

/**
 * Derive an output path next to the input: `<name>.small.<ext>`.
 * @param {string} input - source file path.
 * @returns {string} target path (never equal to the input).
 */
export function compressOutputPath(input) {
  const ext = extname(input) || '.mp4'
  const stem = basename(input, extname(input))
  return join(dirname(input), `${stem}.small${ext}`)
}

/**
 * Compress one file with ffmpeg.
 * @param {object} options - see buildCompressArgs plus timeoutMs/binary.
 * @param {string} [options.binary] - ffmpeg binary name/path (default `ffmpeg`).
 * @param {number} options.timeoutMs - hard deadline.
 * @returns {Promise<{path: string}>} the output path.
 * @throws on non-zero exit or timeout.
 */
export async function compressFile({ input, output, crf, maxHeight, audioBitrate = '128k', preset = 'medium', binary = 'ffmpeg', timeoutMs }) {
  const args = buildCompressArgs({ input, output, crf, maxHeight, audioBitrate, preset })
  const result = await runBin(resolveBin(binary), args, { timeoutMs })
  if (result.timedOut) throw new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`)
  if (result.code !== 0) throw new Error(`ffmpeg exited ${result.code}: ${stderrTail(result.stderr) || '(no error output)'}`)
  return { path: output }
}
