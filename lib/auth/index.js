// Provider registry: site × method is the extension seam.
//
// Adding a site = drop a module in this directory and list it here; the
// video_login schema (site enum), URL→cookie routing, and the jar layout
// pick it up automatically. Methods stay reserved in the global enum before
// a site implements them — callers get a structured "reserved, not
// implemented" error instead of a silently missing capability.

import * as bilibili from './bilibili.js'

/** Every provider, in registration order. */
const providers = Object.freeze([bilibili])

/** Global method dimension: implemented per site + reserved placeholders. */
export const ALL_METHODS = Object.freeze(['qr', 'manual', 'password', 'sms'])

/** Which actions each method drives; status/logout are credential-agnostic. */
export const METHOD_ACTIONS = Object.freeze({
  qr: Object.freeze(['start', 'poll', 'status', 'logout']),
  manual: Object.freeze(['import', 'status', 'logout']),
})

/** @returns {string[]} site enum for the tool schema. */
export function siteNames() {
  return providers.map((provider) => provider.site)
}

/**
 * @param {string} site
 * @returns {object | null} the provider registered under that site.
 */
export function providerBySite(site) {
  return providers.find((provider) => provider.site === site) ?? null
}

/**
 * Route a URL to its provider by hostname (exact or dot-suffix match).
 * @param {string} url
 * @returns {object | null} null for sites without a provider (plain fetch).
 */
export function providerByUrl(url) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  return providers.find(
    (provider) => provider.hosts.some((h) => host === h || host.endsWith(`.${h}`)),
  ) ?? null
}
