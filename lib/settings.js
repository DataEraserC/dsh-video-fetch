// Tunable settings: one field table drives validation, the `video_settings`
// session tool, and the web page's form. Every field declared here is
// `.volatile()` in the Config schema, so a write through ConfigEditor reaches
// the RUNNING plugin (Loader commits volatile refs in place and emits
// `loader/volatile-update`) instead of restarting it.
//
// Binaries and deadlines are deliberately absent: they change the process
// environment, so they stay ordinary fields that need a restart.

/** One editable field: type, bounds, and the copy both surfaces show. */
export const EDITABLE = Object.freeze({
  downloadDir: Object.freeze({
    type: 'string',
    label: { zh: '下载目录', en: 'Download directory' },
    hint: { zh: '留空则用 ~/Videos/dsh-video-fetch', en: 'Empty uses ~/Videos/dsh-video-fetch' },
  }),
  format: Object.freeze({
    type: 'string',
    label: { zh: 'yt-dlp 格式选择', en: 'yt-dlp format selector' },
    hint: { zh: '例如 bv*+ba/b（默认）', en: 'e.g. bv*+ba/b (default)' },
  }),
  crf: Object.freeze({
    type: 'integer',
    min: 0,
    max: 51,
    label: { zh: 'CRF 质量', en: 'CRF quality' },
    hint: { zh: '0 无损 … 51 最差；默认 26', en: '0 lossless … 51 worst; default 26' },
  }),
  maxHeight: Object.freeze({
    type: 'integer',
    min: 0,
    max: 8192,
    label: { zh: '高度上限（像素）', en: 'Height cap (px)' },
    hint: { zh: '0 表示不缩放；默认 720', en: '0 disables scaling; default 720' },
  }),
  audioBitrate: Object.freeze({
    type: 'string',
    label: { zh: 'AAC 音频码率', en: 'AAC audio bitrate' },
    hint: { zh: '例如 128k（默认）', en: 'e.g. 128k (default)' },
  }),
  preset: Object.freeze({
    type: 'string',
    enum: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
    label: { zh: 'x264 预设', en: 'x264 preset' },
    hint: { zh: '默认 medium', en: 'Default medium' },
  }),
})

/** Every editable key, in table order. */
export const EDITABLE_KEYS = Object.freeze(Object.keys(EDITABLE))

/**
 * Unwrap a volatile config reference.
 * @param {unknown} field - resolved config field (ref object or plain value).
 * @returns {unknown} the current value.
 */
export function plain(field) {
  return field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field
}

/**
 * Validate and coerce one field value.
 * @param {string} key - editable field name.
 * @param {unknown} raw - caller value.
 * @returns {string | number} the value to write.
 * @throws on an unknown field or a value outside the declared contract.
 */
export function coerceValue(key, raw) {
  const spec = EDITABLE[key]
  if (spec === undefined) throw new Error(`unknown setting "${key}" (known: ${EDITABLE_KEYS.join(', ')})`)
  if (spec.type === 'integer') {
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (!Number.isInteger(value)) throw new Error(`${key} must be an integer: ${String(raw)}`)
    if (value < spec.min || value > spec.max) throw new Error(`${key} must be ${spec.min}-${spec.max}: ${value}`)
    return value
  }
  const text = String(raw ?? '')
  if (spec.enum !== undefined && !spec.enum.includes(text)) {
    throw new Error(`${key} must be one of ${spec.enum.join(', ')}: ${text}`)
  }
  if (key === 'format' && text.trim() === '') throw new Error('format must not be empty')
  if (key === 'audioBitrate' && !/^\d+k?$/i.test(text.trim())) {
    throw new Error(`audioBitrate must look like 128k: ${text}`)
  }
  return text
}

/**
 * Validate a whole patch before anything is written.
 * @param {Record<string, unknown>} patch - caller-supplied field values.
 * @returns {Record<string, string | number>} coerced values.
 */
export function coercePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('settings patch must be an object of field → value')
  }
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new Error('settings patch is empty')
  const out = {}
  for (const key of keys) out[key] = coerceValue(key, patch[key])
  return out
}

/**
 * Current effective values of the editable fields.
 * @param {Record<string, unknown>} config - live resolved config (volatile refs).
 * @returns {Record<string, unknown>} plain values keyed by field.
 */
export function snapshot(config) {
  const out = {}
  for (const key of EDITABLE_KEYS) out[key] = plain(config[key])
  return out
}

/**
 * Read the ConfigEditor service, or undefined in a composition without it.
 * @param {object} ctx - host plugin context.
 * @returns {object | undefined} the service.
 */
export function editorOf(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
}

/**
 * The profile row this plugin's settings are written to.
 * @param {object} ctx - host plugin context.
 * @returns {object} the ConfigEditor entry.
 * @throws when the service is absent or the row is not addressable.
 */
export function settingsEntry(ctx) {
  const editor = editorOf(ctx)
  if (editor === undefined || editor === null) {
    throw new Error('configEditor is unavailable in this composition — settings cannot be persisted here')
  }
  const entry = editor.entries().find(
    (row) => row.options.id === 'dsh-video-fetch' || row.options.name === 'dsh-video-fetch',
  )
  if (entry === undefined) {
    throw new Error('the dsh-video-fetch profile row is not addressable — reinstall the bundle and restart')
  }
  return entry
}

/**
 * Persist a validated patch through ConfigEditor (the official hot-apply path:
 * file lock, reconcile, atomic write, rollback on failure).
 * @param {object} ctx - host plugin context.
 * @param {Record<string, string | number>} patch - already coerced values.
 * @returns {Promise<void>} fulfillment after Loader reconciliation.
 */
export async function applyPatch(ctx, patch) {
  const editor = editorOf(ctx)
  const entry = settingsEntry(ctx)
  await editor.edit(entry, (current) => ({ ...current, ...patch }))
}

/**
 * Drop the profile override for the given fields, restoring inherited values.
 * @param {object} ctx - host plugin context.
 * @param {string[]} keys - editable field names.
 * @returns {Promise<void>} fulfillment after Loader reconciliation.
 */
export async function resetFields(ctx, keys) {
  for (const key of keys) {
    if (EDITABLE[key] === undefined) throw new Error(`unknown setting "${key}" (known: ${EDITABLE_KEYS.join(', ')})`)
  }
  const editor = editorOf(ctx)
  const entry = settingsEntry(ctx)
  await editor.edit(entry, (current) => {
    const next = { ...current }
    for (const key of keys) delete next[key]
    return next
  })
}
