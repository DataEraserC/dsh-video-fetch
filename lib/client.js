// dsh-video-fetch — client half (browser).
//
// One page, mounted twice: as the configure card on the official Plugins page
// (`plugins.row.config`, keyed by bundle#rowId) and as a tab in Settings →
// Built-in plugins (`settings.plugins.tab`). Both read and write the same
// profile row through the plugin's host routes, so the page and the
// `video_settings` session tool can never disagree.
//
// Written as a classic script following the dsh-settings-persist pattern
// (window.__ModuleLoader__.load / require('react') / inline styles with
// --dsw-alias-* tokens) — no bundler, no build step.

window.__ModuleLoader__.load({
  id: 'dsh-video-fetch',
  factory: (require) => {
    var React = require('react')
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var NS = 'dsh-video-fetch'
    var boundTr = null

    // ── i18n ──────────────────────────────────────────────────────────────

    var L = {
      zh: {
        'nav': '视频下载',
        'title': '视频下载设置',
        'intro': '这些设置与会话里的 video_settings 工具写同一份 profile 配置，改完立即对运行中的插件生效。',
        'summary': '下载目录、压缩参数与 B 站登录。',
        'loading': '加载中…',
        'save': '保存',
        'saving': '保存中…',
        'reset': '恢复默认',
        'resetHint': '删除本 profile 的覆盖值，回到 nix 里声明的默认值。',
        'saved': '已保存并生效',
        'resetDone': '已恢复默认值',
        'err': '出错了',
        'login': '登录',
        'loginIntro': '登录后 video_fetch 能拿到更高画质。二维码用手机 App 扫。',
        'loginState': '登录状态',
        'loggedIn': '已登录：@{name}（等级 {level}）',
        'loggedOut': '未登录',
        'jars': '已存 {n} 份 cookie',
        'start': '生成二维码',
        'poll': '我已扫码',
        'logout': '退出登录',
        'scan': '用手机扫码',
        'expired': '二维码已过期，重新生成。',
        'scanned': '已扫码，请在手机上确认。',
        'waiting': '等待扫码…',
        'none': '还没有二维码。',
        'advanced': '服务端启动参数（二进制路径、超时）需重启才生效，不在此页。',
      },
      en: {
        'nav': 'Video download',
        'title': 'Video download settings',
        'intro': 'These settings and the video_settings session tool write the same profile row, and apply to the running plugin immediately.',
        'summary': 'Download directory, compression, and bilibili login.',
        'loading': 'Loading…',
        'save': 'Save',
        'saving': 'Saving…',
        'reset': 'Reset to defaults',
        'resetHint': 'Drop this profile’s override and fall back to the value declared in nix.',
        'saved': 'Saved and applied',
        'resetDone': 'Defaults restored',
        'err': 'Error',
        'login': 'Login',
        'loginIntro': 'Logging in gives video_fetch the higher-quality tier. Scan the QR with the phone app.',
        'loginState': 'Login state',
        'loggedIn': 'Logged in: @{name} (level {level})',
        'loggedOut': 'Not logged in',
        'jars': '{n} cookie jar(s) stored',
        'start': 'Generate QR',
        'poll': 'I scanned it',
        'logout': 'Log out',
        'scan': 'Scan with your phone',
        'expired': 'QR expired — generate a new one.',
        'scanned': 'Scanned — confirm on your phone.',
        'waiting': 'Waiting for the scan…',
        'none': 'No QR code yet.',
        'advanced': 'Server-side launch settings (binary paths, timeouts) need a restart and stay off this page.',
      },
    }

    function tr(key, params) {
      var dict = L.zh
      var raw = dict[key] !== undefined ? dict[key] : key
      if (!params) return raw
      return raw.replace(/\{(\w+)\}/g, function (_, name) {
        return params[name] === undefined ? '{' + name + '}' : String(params[name])
      })
    }

    function wireLocale(ctx) {
      var locale = ctx && ctx.get && ctx.get('locale')
      if (!locale || typeof locale.register !== 'function') return
      try {
        locale.register(NS, { zh: L.zh, en: L.en })
        var bound = locale.bind(NS)
        boundTr = function (key, params) {
          var value = bound(key, params)
          return value === undefined ? tr(key, params) : value
        }
      } catch { /* locale is optional */ }
    }

    function t(key, params) {
      return boundTr ? boundTr(key, params) : tr(key, params)
    }

    // ── tokens ────────────────────────────────────────────────────────────

    function v(name, fallback) {
      return 'var(' + name + ', ' + fallback + ')'
    }

    var T = {
      bg: v('--dsw-alias-bg-layer-1', 'transparent'),
      border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
      text: v('--dsw-alias-label-primary', '#e0e0e0'),
      textMuted: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.75)'),
      danger: v('--dsw-static-red-500', '#e06c75'),
      ok: v('--dsw-static-green-500', '#4caf7d'),
      radius: 8,
    }

    // ── api ───────────────────────────────────────────────────────────────

    function apiPath(path) {
      return window.location && window.location.protocol === 'dsh-app:' ? '/api' + path : path
    }

    async function api(method, path, body) {
      var opts = { method: method, headers: {} }
      if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json'
        opts.body = JSON.stringify(body)
      }
      var res = await fetch(apiPath(path), opts)
      var data = await res.json().catch(function () { return {} })
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
      return data
    }

    // ── small components ──────────────────────────────────────────────────

    function Button(props) {
      var primary = props.variant === 'primary'
      return React.createElement('button', {
        type: 'button',
        disabled: props.disabled === true,
        onClick: props.onClick,
        style: {
          font: 'inherit',
          fontSize: 13,
          padding: '5px 12px',
          borderRadius: 6,
          cursor: props.disabled === true ? 'default' : 'pointer',
          opacity: props.disabled === true ? 0.5 : 1,
          color: primary ? '#fff' : T.text,
          background: primary ? v('--dsw-alias-state-business-primary', '#4c6ef5') : 'transparent',
          border: '1px solid ' + (primary ? 'transparent' : T.border),
        },
      }, props.children)
    }

    function Field(props) {
      return React.createElement('label', {
        style: { display: 'block', marginBottom: 12 },
      },
        React.createElement('div', {
          style: { fontSize: 12, color: T.text, marginBottom: 4 },
        }, props.label),
        props.hint
          ? React.createElement('div', { style: { fontSize: 11, color: T.textMuted, marginBottom: 4 } }, props.hint)
          : null,
        props.options
          ? React.createElement('select', {
              value: props.value,
              disabled: props.disabled === true,
              onChange: function (event) { props.onChange(event.target.value) },
              style: {
                font: 'inherit', fontSize: 13, padding: '4px 8px', minWidth: 200,
                color: T.text, background: T.bg, border: '1px solid ' + T.border, borderRadius: 6,
              },
            }, props.options.map(function (option) {
              return React.createElement('option', { key: option, value: option }, option)
            }))
          : React.createElement('input', {
              type: props.type === 'integer' ? 'number' : 'text',
              value: props.value === undefined || props.value === null ? '' : String(props.value),
              min: props.min,
              max: props.max,
              disabled: props.disabled === true,
              onChange: function (event) { props.onChange(event.target.value) },
              style: {
                font: 'inherit', fontSize: 13, padding: '4px 8px', minWidth: 260,
                color: T.text, background: T.bg, border: '1px solid ' + T.border, borderRadius: 6,
              },
            }),
      )
    }

    function Card(props) {
      return React.createElement('div', {
        style: {
          background: T.bg, border: '1px solid ' + T.border, borderRadius: T.radius,
          padding: '10px 12px', marginBottom: 12,
        },
      },
        React.createElement('div', {
          style: { fontWeight: 600, fontSize: 13, color: T.text, marginBottom: 8 },
        }, props.title),
        props.children,
      )
    }

    // ── the page ──────────────────────────────────────────────────────────

    function SettingsPage() {
      var st = React.useState(null)
      var state = st[0]
      var setState = st[1]
      var df = React.useState({})
      var draft = df[0]
      var setDraft = df[1]
      var bf = React.useState(false)
      var busy = bf[0]
      var setBusy = bf[1]
      var ff = React.useState(null)
      var feedback = ff[0]
      var setFeedback = ff[1]

      var lf = React.useState(null)
      var login = lf[0]
      var setLogin = lf[1]
      var qf = React.useState(null)
      var qr = qf[0]
      var setQr = qf[1]
      var pf = React.useState(null)
      var pollNote = pf[0]
      var setPollNote = pf[1]

      var refresh = React.useCallback(async function () {
        var next = await api('GET', '/video-fetch/state')
        setState(next)
        setDraft(next.settings || {})
        return next
      }, [])

      var refreshLogin = React.useCallback(async function () {
        try {
          var next = await api('GET', '/video-fetch/login/status')
          setLogin(next)
        } catch { /* host offline; keep the last view */ }
      }, [])

      React.useEffect(function () {
        var active = true
        refresh().catch(function (error) {
          if (active) setFeedback({ ok: false, text: t('err') + ': ' + error.message })
        })
        refreshLogin()
        return function () { active = false }
      }, [refresh, refreshLogin])

      function run(fn, okText) {
        setBusy(true)
        setFeedback(null)
        return fn()
          .then(function () {
            setFeedback({ ok: true, text: okText })
          })
          .catch(function (error) {
            setFeedback({ ok: false, text: t('err') + ': ' + error.message })
          })
          .finally(function () { setBusy(false) })
      }

      function save() {
        var patch = {}
        Object.keys(draft).forEach(function (key) {
          if (state && state.settings && String(state.settings[key]) === String(draft[key])) return
          patch[key] = draft[key]
        })
        if (Object.keys(patch).length === 0) {
          setFeedback({ ok: true, text: t('saved') })
          return
        }
        run(async function () {
          await api('POST', '/video-fetch/set', { patch: patch })
          await refresh()
        }, t('saved'))
      }

      function reset() {
        if (!window.confirm(t('resetHint'))) return
        run(async function () {
          await api('POST', '/video-fetch/reset', {})
          await refresh()
        }, t('resetDone'))
      }

      function startLogin() {
        setPollNote(null)
        run(async function () {
          var next = await api('POST', '/video-fetch/login/start', {})
          setQr(next.qr + '&t=' + Date.now())
        }, '')
      }

      function pollLogin() {
        setBusy(true)
        api('POST', '/video-fetch/login/poll', {})
          .then(function (next) {
            if (next.state === 'ok') {
              setQr(null)
              setPollNote({ ok: true, text: next.loggedIn ? t('loggedIn', { name: next.uname, level: next.level }) : t('loggedOut') })
              return refreshLogin()
            }
            if (next.state === 'expired') {
              setQr(null)
              setPollNote({ ok: false, text: t('expired') })
              return undefined
            }
            if (next.state === 'none') {
              setPollNote({ ok: false, text: t('none') })
              return undefined
            }
            setPollNote({ ok: true, text: next.state === 'scanned' ? t('scanned') : t('waiting') })
            return undefined
          })
          .catch(function (error) {
            setPollNote({ ok: false, text: t('err') + ': ' + error.message })
          })
          .finally(function () { setBusy(false) })
      }

      function logout() {
        run(async function () {
          await api('POST', '/video-fetch/login/logout', {})
          setQr(null)
          setPollNote(null)
          await refreshLogin()
          await refresh()
        }, t('resetDone'))
      }

      var sections = []

      sections.push(React.createElement('h2', {
        key: 'title',
        style: { margin: '0 0 4px', fontSize: 18, fontWeight: 600, color: T.text },
      }, t('title')))

      sections.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 12px', fontSize: 13, color: T.textMuted, maxWidth: 640 },
      }, t('intro')))

      if (state === null) {
        sections.push(React.createElement('div', {
          key: 'loading',
          style: { fontSize: 12, color: T.textMuted },
        }, t('loading')))
        return React.createElement('div', { style: { maxWidth: 720 } }, sections)
      }

      var fields = (state.fields || []).map(function (field) {
        return React.createElement(Field, {
          key: field.key,
          label: (field.label && (field.label.zh || field.label.en)) || field.key,
          hint: field.hint && (field.hint.zh || field.hint.en),
          type: field.type,
          min: field.min,
          max: field.max,
          options: field.enum,
          value: draft[field.key],
          disabled: busy,
          onChange: function (value) {
            setDraft(function (previous) {
              var next = Object.assign({}, previous)
              next[field.key] = value
              return next
            })
          },
        })
      })

      sections.push(React.createElement(Card, { key: 'settings', title: t('summary') },
        fields,
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
          React.createElement(Button, { variant: 'primary', disabled: busy, onClick: save },
            busy ? t('saving') : t('save')),
          React.createElement(Button, { disabled: busy, onClick: reset }, t('reset')),
        ),
        React.createElement('div', {
          style: { fontSize: 11, color: T.textMuted, marginTop: 8 },
        }, t('advanced')),
      ))

      var site = (state.sites && state.sites[0]) || null
      var loginChildren = [
        React.createElement('p', {
          key: 'intro',
          style: { margin: '0 0 8px', fontSize: 12, color: T.textMuted },
        }, t('loginIntro')),
        React.createElement('div', {
          key: 'state',
          style: { fontSize: 12, color: login && login.loggedIn ? T.ok : T.textMuted, marginBottom: 6 },
        }, login === null
          ? t('loading')
          : login.loggedIn
            ? t('loggedIn', { name: login.uname, level: login.level })
            : t('loggedOut')),
      ]

      if (site) {
        loginChildren.push(React.createElement('div', {
          key: 'jars',
          style: { fontSize: 11, color: T.textMuted, marginBottom: 8 },
        }, t('jars', { n: site.jars })))
      }

      loginChildren.push(React.createElement('div', {
        key: 'actions',
        style: { display: 'flex', gap: 8 },
      },
        React.createElement(Button, { disabled: busy, onClick: startLogin }, t('start')),
        React.createElement(Button, { disabled: busy, onClick: pollLogin }, t('poll')),
        login && login.loggedIn
          ? React.createElement(Button, { disabled: busy, onClick: logout }, t('logout'))
          : null,
      ))

      if (qr !== null) {
        loginChildren.push(React.createElement('div', { key: 'qr', style: { marginTop: 10 } },
          React.createElement('div', { style: { fontSize: 12, color: T.textMuted, marginBottom: 6 } }, t('scan')),
          React.createElement('img', {
            src: apiPath(qr),
            alt: t('scan'),
            style: { width: 180, height: 180, background: '#fff', borderRadius: 6 },
          }),
        ))
      }

      if (pollNote !== null) {
        loginChildren.push(React.createElement('div', {
          key: 'note',
          style: { fontSize: 12, color: pollNote.ok ? T.ok : T.danger, marginTop: 8 },
        }, pollNote.text))
      }

      sections.push(React.createElement(Card, { key: 'login', title: t('login') }, loginChildren))

      if (feedback !== null) {
        sections.push(React.createElement('div', {
          key: 'feedback',
          style: { fontSize: 12, color: feedback.ok ? T.ok : T.danger },
        }, feedback.text))
      }

      return React.createElement('div', { style: { maxWidth: 720 } }, sections)
    }

    // The Plugins-page card: summary text on the row, the page in its detail
    // view. The slot's `form` payload is unused — settings ride the plugin's
    // own routes so the session tool and this page share one writer.
    function PluginCard(props) {
      if (props && props.view === 'page') return React.createElement(SettingsPage, null)
      return React.createElement('span', {
        style: { color: T.textMuted, fontSize: 12 },
      }, t('summary'))
    }

    function SettingsTab() {
      return React.createElement(SettingsPage, null)
    }

    // ── apply ─────────────────────────────────────────────────────────────

    function apply(ctx) {
      wireLocale(ctx)
      var slots = ctx.get('slots')
      if (!slots) return

      // Configure card on the official Plugins page. The key is
      // `<bundle>#<rowId>`; the bundle's patch declares the row as
      // `dsh-video-fetch`, so both spellings are registered the same way
      // dsh-settings-persist does.
      slots.inject('plugins.row.config', function () {
        return slots.register(
          { name: 'plugins.row.config', key: NS + '#' + NS, locale: NS },
          PluginCard,
        )
      })

      // Settings → Built-in plugins tab, for hosts where the Plugins page is
      // not the surface the user reaches first.
      slots.inject('settings.plugins.tab', function () {
        return slots.register(
          { name: 'settings.plugins.tab', id: NS, order: 60, label: function () { return t('nav') }, locale: NS },
          SettingsTab,
        )
      })
    }

    exports.NS = NS
    exports.apply = apply
    return module.exports
  },
})
