// Slash commands: the surface a person types into.
//
// The plugin has three surfaces, and they are not interchangeable:
//
//   * the web settings page — `lib/client.js`, registered into the Plugins page
//     and the Settings tab. Needs a browser; the TUI never renders it, because
//     the client half declares `platform: "web"`.
//   * the model-facing tools — `video_settings` / `video_login`. Something the
//     model calls, not something the user types.
//   * these two commands — `/video-settings` and `/video-login`, dispatched by
//     whatever interactive UI adapter the user is in: the web composer and the
//     TUI both merge the kernel's `@deepseek-ai/dsh-commands` registry into
//     their slash menu and dispatch through it.
//
// ## Why `ctx.reflect.get('commands')` and not `ctx.commands`
//
// Cordis resolves `ctx.<service>` through its proxy, and reading a service that
// is not in the plugin's `inject` **throws** `cannot get property "commands"
// without inject`. Declaring it would work, but it also makes the registry a
// hard dependency: on a composition without `@deepseek-ai/dsh-commands` the
// plugin would not load at all — no downloading, no web page, over a
// convenience surface. `ctx.reflect.get(name)` is the documented bypass: it
// resolves the service when it is provided and returns `undefined` when it is
// not, without throwing. Verified against cordis 4.0.5.
//
// ## Secret boundary
//
// The same rule as everywhere else: a command result carries account labels,
// identities, and cookie *counts*. It never carries a cookie value.

import { call, nativeStatus } from './native.js'
import { EDITABLE_KEYS, applyPatch, coercePatch, resetFields, snapshot } from './settings.js'

/** Command names, without the leading slash. */
export const COMMAND_NAMES = Object.freeze(['video-settings', 'video-login'])

/**
 * Reach the command registry, or undefined in a composition without it.
 * @param {object} ctx - host plugin context.
 * @returns {object | undefined} the `commands` service.
 */
export function commandsOf(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx.reflect?.get !== 'function') return undefined
  return ctx.reflect.get('commands')
}

/**
 * Split a command's trailing input into whitespace-separated words.
 *
 * `invocation.rawInput` keeps the separator whitespace, so an empty tail is
 * `''` or `' '` — both must mean "no arguments", not one empty argument.
 * @param {object} invocation - what the registry hands a handler.
 * @returns {string[]} the words.
 */
function words(invocation) {
  return String(invocation?.rawInput ?? '').trim().split(/\s+/).filter((word) => word !== '')
}

/** @param {string} text - failure copy. @returns {{kind: string, text: string}} */
function failure(text) {
  return { kind: 'error', text }
}

/** @param {string} text - success copy. @returns {{kind: string, text: string}} */
function ok(text) {
  return { kind: 'success', text }
}

/**
 * Render one channel's account pool.
 * @param {object} entry - a `status` row: `{ channel, accounts, active }`.
 * @param {boolean} verbose - include every account, not just the active one.
 * @returns {string[]} lines.
 */
function channelLines(entry, verbose) {
  const channel = entry.channel ?? {}
  const accounts = entry.accounts ?? []
  const head = `${channel.id} (${channel.name ?? channel.id}) — ${accounts.length} account(s)`
  if (accounts.length === 0) return [`${head}, none stored`]
  const lines = [head]
  for (const account of accounts) {
    const who = account.identity || account.label || account.id
    const active = account.id === entry.active ? ' [active]' : ''
    if (verbose || active !== '') {
      lines.push(`  ${who} — ${account.status ?? 'unknown'}, ${account.cookie_count} cookie(s)${active}`)
    }
  }
  return lines
}

/**
 * Register `/video-settings` and `/video-login`.
 *
 * Returns the number of commands registered so the caller can log or assert on
 * it; both handlers are safe to call from any UI adapter.
 * @param {object} ctx - host plugin context.
 * @param {object} config - live resolved config (volatile refs).
 * @returns {number} how many commands were registered (0 or 2).
 */
export function registerCommands(ctx, config) {
  const registry = commandsOf(ctx)
  if (registry === undefined || typeof registry.register !== 'function') return 0

  // The session `start` minted most recently. A login is a multi-step
  // conversation (start → scan → poll) and each step is its own command line,
  // so the id has to outlive one invocation. `poll <sessionId>` overrides it
  // for the rare case of two logins in flight.
  let lastSession = ''

  const disposers = [
    registry.register({
      // A plain string is what `CommandDefinitionId()` returns at runtime; the
      // brand is type-only, and importing it would add a peer dependency for
      // an identity function.
      definitionId: 'dsh-video-fetch/settings',
      name: 'video-settings',
      description: 'View or change the video download settings',
      input: { hint: '[<field>=<value> … | reset [<field> …]]' },
      async handler(invocation) {
        const args = words(invocation)

        if (args.length === 0) {
          const current = snapshot(config)
          return ok(
            [
              'Video settings (live values):',
              ...EDITABLE_KEYS.map((key) => `  ${key} = ${JSON.stringify(current[key])}`),
              `Change one with /video-settings ${EDITABLE_KEYS[0]}=…; drop an override with /video-settings reset <field>.`,
            ].join('\n'),
          )
        }

        if (args[0] === 'reset') {
          const fields = args.slice(1)
          try {
            await resetFields(ctx, fields.length === 0 ? [...EDITABLE_KEYS] : fields)
          } catch (error) {
            return failure(error.message)
          }
          const current = snapshot(config)
          const touched = fields.length === 0 ? EDITABLE_KEYS : fields
          return ok(
            [
              `Restored the inherited value for ${touched.length} field(s): ${touched.join(', ')}.`,
              ...touched.map((key) => `  ${key} = ${JSON.stringify(current[key])}`),
            ].join('\n'),
          )
        }

        const patch = {}
        for (const token of args) {
          const at = token.indexOf('=')
          if (at <= 0) return failure(`expected <field>=<value>, got "${token}"`)
          patch[token.slice(0, at)] = token.slice(at + 1)
        }
        try {
          await applyPatch(ctx, coercePatch(patch))
        } catch (error) {
          return failure(error.message)
        }
        const current = snapshot(config)
        return ok(
          [
            `Applied ${Object.keys(patch).length} setting(s) to the profile:`,
            ...Object.keys(patch).map((key) => `  ${key} = ${JSON.stringify(current[key])}`),
          ].join('\n'),
        )
      },
    }),

    registry.register({
      definitionId: 'dsh-video-fetch/login',
      name: 'video-login',
      description: 'Video site login: view accounts, start a login, confirm it',
      input: { hint: '[status [<channel>] | channels | start <channel> [<method>] | poll | cancel | pin <channel> <account> | logout <channel> <account> | check [<channel>]]' },
      async handler(invocation) {
        const native = nativeStatus()
        if (!native.available) return failure(`the login backend is unavailable: ${native.error}`)

        const args = words(invocation)
        const verb = args.length === 0 ? 'status' : args[0]

        try {
          if (verb === 'channels') {
            const channels = (await call('channels')) ?? []
            return ok(
              channels
                .map((entry) => {
                  const live = (entry.methods ?? []).filter((method) => method.implemented).map((method) => method.id)
                  return `${entry.id} (${entry.name}) — ${live.join(', ')}`
                })
                .join('\n'),
            )
          }

          if (verb === 'status') {
            const all = (await call('status')) ?? []
            const channel = args[1]
            const rows = channel === undefined ? all : all.filter((entry) => entry.channel?.id === channel)
            if (rows.length === 0) return failure(`no such channel: ${channel}`)
            return ok(rows.map((entry) => channelLines(entry, true).join('\n')).join('\n'))
          }

          if (verb === 'start') {
            const channel = args[1]
            if (channel === undefined) return failure('start needs a channel: /video-login start <channel> [<method>]')
            const started = await call('start', {
              channel,
              method: args[2] ?? 'qr',
              params: {},
              label: null,
            })
            lastSession = String(started.session_id ?? '')
            const challenge = started.challenge ?? {}
            const lines = [`Login started for ${channel}. sessionId: ${lastSession}`]
            if (challenge.kind === 'qr') {
              // A terminal prints text, not a PNG: the payload is what the user
              // can open in a browser or paste into a QR generator. A provider
              // that only hands back an image has no text to show, so say so.
              if (challenge.url) lines.push(`Scan this in the ${channel} app, or open it: ${challenge.url}`)
              else lines.push('This channel returns a QR image rather than a URL — use the web settings page to scan it.')
              lines.push('After scanning: /video-login poll')
            } else if (challenge.kind === 'fields') {
              const names = (challenge.fields ?? []).map((field) => field.name).join(', ')
              lines.push(`${challenge.prompt ?? 'More input is needed:'} ${names}`)
            } else if (challenge.kind === 'browse') {
              lines.push(challenge.message ?? 'A browser was opened on the server — sign in there, then: /video-login poll')
            }
            return ok(lines.join('\n'))
          }

          if (verb === 'poll') {
            const sessionId = args[1] ?? lastSession
            if (sessionId === '') return failure('nothing to poll — /video-login start <channel> first')
            const polled = await call('poll', { sessionId })
            const result = polled.result ?? {}
            const account = polled.account ?? null
            if (result.status === 'done') {
              lastSession = ''
              const who = account ? (account.identity || account.label || account.id) : ''
              return ok(
                `Logged in${account ? ` as ${who}` : ''}${account ? `, ${account.cookie_count} cookie(s) stored` : ''}. ` +
                'video_fetch now uses the logged-in tier.',
              )
            }
            if (result.status === 'need_input') {
              const names = (result.fields ?? []).map((field) => field.name).join(', ')
              return ok(`${result.prompt ?? 'More input is needed.'} (${names})`)
            }
            if (result.status === 'expired') {
              lastSession = ''
              return failure(result.message || 'That login expired — start a new one.')
            }
            return ok(result.message || 'Waiting for the scan…')
          }

          if (verb === 'cancel') {
            const sessionId = args[1] ?? lastSession
            if (sessionId === '') return failure('nothing to cancel')
            await call('cancel', { sessionId })
            lastSession = ''
            return ok('Login cancelled.')
          }

          if (verb === 'pin' || verb === 'logout') {
            const channel = args[1]
            const account = args[2]
            if (channel === undefined || account === undefined) {
              return failure(`${verb} needs a channel and an account: /video-login ${verb} <channel> <account>`)
            }
            if (verb === 'pin') {
              const view = await call('pin', { channel, account })
              return ok(`Active account for ${channel}: ${view.identity || view.label || view.id}.`)
            }
            const removed = await call('logout', { channel, account })
            return ok(removed ? `Account removed from ${channel}.` : `No such account for ${channel}.`)
          }

          if (verb === 'check') {
            const view = await call('check', {
              channel: args[1] ?? '',
              account: args[2] ?? null,
            })
            const who = view.identity || view.label || view.id
            return ok(`${view.channel ?? args[1] ?? ''}: ${view.status} — ${who} (${view.cookie_count} cookie(s)).`)
          }

          return failure(`unknown subcommand "${verb}"`)
        } catch (error) {
          // A login op can fail on the network, on the site, or on a channel
          // that does not implement the method; none of that should surface as
          // an unhandled rejection in the UI adapter.
          return failure(error.message)
        }
      },
    }),
  ]

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-video-fetch.commands')
  }
  return disposers.length
}
