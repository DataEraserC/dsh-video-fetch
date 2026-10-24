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

    /** How often the page re-checks a login that is waiting on the user. */
    var POLL_MS = 2000

    // ── i18n ──────────────────────────────────────────────────────────────

    var L = {
      zh: {
        'nav': '视频下载',
        'title': '视频下载设置',
        'intro': '这些设置与会话里的 video_settings 工具写同一份 profile 配置，改完立即对运行中的插件生效。',
        'summary': '下载目录、压缩参数，以及按渠道登录。',
        'loading': '加载中…',
        'save': '保存',
        'saving': '保存中…',
        'reset': '恢复默认',
        'resetHint': '删除本 profile 的覆盖值，回到 nix 里声明的默认值。',
        'saved': '已保存并生效',
        'resetDone': '已恢复默认值',
        'err': '出错了',
        'login': '登录',
        'loginIntro': '先选渠道，再选登录方式。登录后 video_fetch 能拿到更高画质；一个渠道可以存多个账号，当前账号被拒时会自动轮换。',
        'loginState': '登录状态',
        'loggedIn': '已登录：@{name}（等级 {level}）',
        'loggedOut': '未登录',
        'jars': '已存 {n} 份 cookie',
        'channelLabel': '渠道',
        'methodLabel': '方式',
        'accountsLabel': '账号',
        'noAccounts': '此渠道还没有账号。',
        'cookieLabel': 'Cookie 文本',
        'cookieHint': '粘贴 Netscape cookies.txt 的内容，或浏览器里复制的 Cookie 请求头。文本只用于写入本地凭据文件，不会回显。',
        'cookiePlaceholder': '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\t…',
        'labelPlaceholder': '备注（可选）',
        'start': '开始登录',
        'poll': '我已扫码',
        'cancel': '取消',
        'submit': '提交',
        'import': '导入',
        'check': '检查',
        'setActive': '设为当前',
        'logout': '退出登录',
        'scan': '用手机扫码',
        'expired': '二维码已过期，请重新开始。',
        'scanned': '已扫码，请在手机上确认。',
        'waiting': '等待扫码…',
        'none': '还没有进行中的登录。',
        'enterCode': '请输入下一步需要的信息。',
        'browseHint': '已在服务端打开浏览器，请在其中完成登录后回到这里。',
        'unavailable': '登录后端不可用。',
        'loginDone': '登录成功：{name}',
        'imported': '已导入：{name}',
        'cookieEmpty': '请先粘贴 cookie 文本。',
        'checkResult': '检查结果：{status}',
        'status_unknown': '未检查',
        'status_active': '有效',
        'status_expired': '已过期',
        'status_unreachable': '无法连接',
        'advanced': '服务端启动参数（二进制路径、超时）需重启才生效，不在此页。',
      },
      en: {
        'nav': 'Video download',
        'title': 'Video download settings',
        'intro': 'These settings and the video_settings session tool write the same profile row, and apply to the running plugin immediately.',
        'summary': 'Download directory, compression, and per-channel login.',
        'loading': 'Loading…',
        'save': 'Save',
        'saving': 'Saving…',
        'reset': 'Reset to defaults',
        'resetHint': 'Drop this profile’s override and fall back to the value declared in nix.',
        'saved': 'Saved and applied',
        'resetDone': 'Defaults restored',
        'err': 'Error',
        'login': 'Login',
        'loginIntro': 'Pick a channel, then a login method. Logging in gives video_fetch the higher-quality tier; a channel can hold several accounts, and the active one rotates when it is rejected.',
        'loginState': 'Login state',
        'loggedIn': 'Logged in: @{name} (level {level})',
        'loggedOut': 'Not logged in',
        'jars': '{n} cookie jar(s) stored',
        'channelLabel': 'Channel',
        'methodLabel': 'Method',
        'accountsLabel': 'Accounts',
        'noAccounts': 'No accounts for this channel yet.',
        'cookieLabel': 'Cookie text',
        'cookieHint': 'Paste the contents of a Netscape cookies.txt, or a Cookie request header copied from the browser. The text only ever goes into the local credential file — it is never echoed back.',
        'cookiePlaceholder': '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\t…',
        'labelPlaceholder': 'Label (optional)',
        'start': 'Start login',
        'poll': 'I scanned it',
        'cancel': 'Cancel',
        'submit': 'Submit',
        'import': 'Import',
        'check': 'Check',
        'setActive': 'Set active',
        'logout': 'Log out',
        'scan': 'Scan with your phone',
        'expired': 'QR expired — start again.',
        'scanned': 'Scanned — confirm on your phone.',
        'waiting': 'Waiting for the scan…',
        'none': 'No login in flight.',
        'enterCode': 'Enter what the next step asks for.',
        'browseHint': 'A browser was opened on the server — sign in there, then come back.',
        'unavailable': 'The login backend is unavailable.',
        'loginDone': 'Logged in: {name}',
        'imported': 'Imported: {name}',
        'cookieEmpty': 'Paste the cookie text first.',
        'checkResult': 'Check result: {status}',
        'status_unknown': 'not checked',
        'status_active': 'active',
        'status_expired': 'expired',
        'status_unreachable': 'unreachable',
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

    /**
     * A labeled `<select>`.
     *
     * `options` carries `{ value, label }` pairs rather than bare strings
     * because the two pickers are exactly where the missing label mattered: a
     * channel id like `bilibili` is not what a user should have to read in order
     * to pick their site.
     * @param {object} props - component props.
     * @param {string} props.label - text shown beside the control.
     * @param {string} props.value - selected value.
     * @param {Array<{value: string, label: string}>} props.options - choices.
     * @param {(value: string) => void} props.onChange - selection handler.
     * @param {boolean} [props.disabled] - disable the control.
     */
    function Picker(props) {
      return React.createElement('label', {
        style: { display: 'flex', alignItems: 'center', gap: 6 },
      },
        React.createElement('span', { style: { fontSize: 12, color: T.textMuted } }, props.label),
        React.createElement('select', {
          value: props.value,
          disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.value) },
          style: {
            font: 'inherit', fontSize: 13, padding: '4px 8px', minWidth: 140,
            color: T.text, background: T.bg, border: '1px solid ' + T.border, borderRadius: 6,
          },
        }, (props.options || []).map(function (option) {
          return React.createElement('option', { key: option.value, value: option.value }, option.label)
        })),
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

      // Which channel the card is showing. Defaults to the first advertised
      // channel and is always rendered with that channel's display name — the
      // previous version took `state.sites[0]` and printed no label at all.
      var cf = React.useState('')
      var selChannel = cf[0]
      var setSelChannel = cf[1]
      // Which login method within that channel. Resolved against the channel's
      // own `implemented` flags whenever the channel changes.
      var mf = React.useState('')
      var selMethod = mf[0]
      var setSelMethod = mf[1]

      // The login in flight: { id, challenge }.
      var sf = React.useState(null)
      var session = sf[0]
      var setSession = sf[1]
      // Fields the current step wants, plus what the user has typed.
      var ff2 = React.useState([])
      var fields = ff2[0]
      var setFields = ff2[1]
      var vf = React.useState({})
      var values = vf[0]
      var setValues = vf[1]
      var tf = React.useState('')
      var cookieText = tf[0]
      var setCookieText = tf[1]
      var lbf = React.useState('')
      var labelText = lbf[0]
      var setLabelText = lbf[1]

      // Inline note for the login card; separate from `feedback`, which is the
      // settings form's.
      var nf = React.useState(null)
      var note = nf[0]
      var setNote = nf[1]
      // Handle of the running poll interval, so switching channel or starting
      // a new login cancels the old loop instead of racing it.
      var tf2 = React.useRef(null)
      var timer = tf2
      // Latest `pollOnce`, re-assigned every render — see its comment.
      var pf2 = React.useRef(function () { return Promise.resolve(true) })
      var pollRef = pf2
      pollRef.current = pollOnce

      var refresh = React.useCallback(async function () {
        var next = await api('GET', '/video-fetch/state')
        setState(next)
        setDraft(next.settings || {})
        return next
      }, [])

      // `channels` in the state payload already carries each channel's account
      // pool and pinned id, so there is no separate login-status fetch: one
      // refresh repaints settings and every channel at once.
      var refreshLogin = refresh

      React.useEffect(function () {
        var active = true
        refresh().catch(function (error) {
          if (active) setFeedback({ ok: false, text: t('err') + ': ' + error.message })
        })
        return function () {
          active = false
          if (timer.current !== null) clearInterval(timer.current)
        }
      }, [refresh])

      // ── derived login-card state ────────────────────────────────────────
      //
      // This block, and the two coherence effects under it, are computed
      // *here* rather than down where the login card is built, because every
      // hook must run on every render. The page returns early while `state` is
      // still null; a hook sitting below that return would be skipped on the
      // loading render and called on the loaded one, which React rejects with
      // "Rendered more hooks than during the previous render" — and that
      // unmounts the whole card, leaving the page blank.
      //
      // Two pickers, in order: channel, then method. The channel picker is
      // labeled with each channel's display name (the bit that was missing),
      // and the method picker is built from the selected channel's own
      // advertisement so it can only ever offer what that channel implements.
      var chans = (state && state.channels) || []
      var chan = chans.filter(function (entry) { return entry.channel.id === selChannel })[0] || chans[0] || null
      var chanInfo = chan ? chan.channel : null
      var chanId = chanInfo ? chanInfo.id : ''
      var allMethods = chanInfo ? chanInfo.methods : []
      var liveMethods = allMethods.filter(function (method) { return method.implemented })
      var methodInfo = liveMethods.filter(function (method) { return method.id === selMethod })[0]
        || allMethods.filter(function (method) { return method.id === selMethod })[0]
        || liveMethods[0]
        || null
      var methodId = methodInfo ? methodInfo.id : ''
      var accounts = chan ? chan.accounts : []
      var activeId = chan ? chan.active : null

      // Keep the pickers coherent: a channel with no method selected, or a
      // method the new channel does not implement, resolves to its first live
      // method. Done as an effect so the very first paint can disagree.
      React.useEffect(function () {
        if (chanId !== '' && selChannel !== chanId) setSelChannel(chanId)
      }, [chanId, selChannel])
      React.useEffect(function () {
        if (methodId !== '' && selMethod !== methodId) setSelMethod(methodId)
      }, [methodId, selMethod])

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

      /** @param {string} tone - 'ok' | 'bad' | 'muted'. @param {string} text - copy. */
      function setTone(tone, text) {
        setNote({ tone: tone, text: text })
      }

      /**
       * Switch channel, tearing down whatever login was in flight.
       *
       * A session belongs to the channel that minted it — a bilibili QR poll
       * means nothing to douyin — so the previous one is cancelled rather than
       * left running against a channel the page is no longer showing.
       * @param {string} value - the new channel id.
       */
      function onChannelChange(value) {
        stopPolling()
        setSession(null)
        setFields([])
        setValues({})
        setNote(null)
        setSelChannel(value)
      }

      /**
       * Run one login action, routing failure into the card's own note rather
       * than the settings form's feedback line.
       * @param {() => Promise<void>} fn - the action.
       * @returns {Promise<void>}
       */
      function runLogin(fn) {
        setBusy(true)
        return fn()
          .catch(function (error) {
            setTone('bad', t('err') + ': ' + error.message)
          })
          .finally(function () { setBusy(false) })
      }

      /** Stop the poll loop, if one is running. */
      function stopPolling() {
        if (timer.current !== null) {
          clearInterval(timer.current)
          timer.current = null
        }
      }

      /**
       * Advance the login in flight by one step.
       *
       * The loop lives in a ref that every render re-assigns, so a `setInterval`
       * started before the latest state change still calls a closure that sees
       * it. A plain closure captured at `startLogin` time would keep polling a
       * session id that has already moved on.
       * @returns {Promise<boolean>} true once the login reached a terminal state.
       */
      async function pollOnce() {
        if (session === null) return true
        var next = await api('POST', '/video-fetch/login/poll', { sessionId: session.id })
        var result = next.result || {}
        if (result.status === 'done') {
          stopPolling()
          setSession(null)
          setFields([])
          var who = next.account && (next.account.label || next.account.identity)
          setTone('ok', who ? t('loginDone', { name: who }) : t('loginDone', { name: '' }))
          await refresh()
          return true
        }
        if (result.status === 'need_input') {
          stopPolling()
          setFields(result.fields || [])
          setTone('muted', result.prompt || t('enterCode'))
          return true
        }
        if (result.status === 'expired') {
          stopPolling()
          setSession(null)
          setFields([])
          setTone('bad', result.message || t('expired'))
          return true
        }
        setTone('muted', result.message || t('waiting'))
        return false
      }

      /**
       * Poll every `POLL_MS` until a terminal state. A QR waits on a human, so
       * this runs unbounded; `cancelLogin` and switching channel are what stop it.
       */
      function startPolling() {
        stopPolling()
        timer.current = setInterval(function () {
          pollRef.current().catch(function () { stopPolling() })
        }, POLL_MS)
      }

      /**
       * Begin a login on the selected channel with the selected method.
       * @param {string} [method] - overrides the picker; used by `browser`, which
       *   has its own route.
       */
      function startLogin(method) {
        var chosen = method || selMethod
        stopPolling()
        setSession(null)
        setFields([])
        setValues({})
        setNote(null)
        runLogin(async function () {
          var next = await api('POST', '/video-fetch/login/start', {
            channel: selChannel,
            method: chosen,
            label: labelText,
          })
          var challenge = next.challenge || {}
          setSession({ id: next.session_id, challenge: challenge })
          if (challenge.kind === 'fields') setFields(challenge.fields || [])
          if (challenge.kind === 'qr') {
            setTone('muted', t('waiting'))
            startPolling()
          }
        })
      }

      /** Open a browser for the selected channel, then poll until signed in. */
      function browseLogin() {
        stopPolling()
        setSession(null)
        setFields([])
        setValues({})
        setNote(null)
        runLogin(async function () {
          var next = await api('POST', '/video-fetch/login/browse', { channel: selChannel })
          var challenge = next.challenge || {}
          setSession({ id: next.session_id, challenge: challenge })
          setTone('muted', challenge.prompt || t('browseHint'))
          startPolling()
        })
      }

      /**
       * Send the current step's inputs: an SMS phone number or code, or a
       * password. `need_input` re-renders the fields for the next step.
       */
      function submitLogin() {
        if (session === null) return
        runLogin(async function () {
          var next = await api('POST', '/video-fetch/login/submit', {
            sessionId: session.id,
            params: values,
          })
          var result = next.result || {}
          if (result.status === 'done') {
            setSession(null)
            setFields([])
            var who = next.account && (next.account.label || next.account.identity)
            setTone('ok', t('loginDone', { name: who || '' }))
            await refresh()
            return
          }
          if (result.status === 'need_input') {
            setFields(result.fields || [])
            setValues({})
            setTone('muted', result.prompt || t('enterCode'))
            return
          }
          if (result.status === 'expired') {
            setSession(null)
            setFields([])
            setTone('bad', result.message || t('expired'))
            return
          }
          setTone(result.status === 'pending' ? 'muted' : 'bad', result.message || t('waiting'))
        })
      }

      /** Import a pasted cookie file / header as a finished credential. */
      function importCookies() {
        if (cookieText.trim() === '') {
          setTone('bad', t('cookieEmpty'))
          return
        }
        runLogin(async function () {
          var next = await api('POST', '/video-fetch/login/import', {
            channel: selChannel,
            cookies: cookieText,
            label: labelText,
          })
          setCookieText('')
          setLabelText('')
          var who = next.account && (next.account.label || next.account.identity)
          setTone('ok', t('imported', { name: who || '' }))
          await refresh()
        })
      }

      /** Abandon the login in flight and stop its poll loop. */
      function cancelLogin() {
        if (session === null) return
        var id = session.id
        stopPolling()
        setSession(null)
        setFields([])
        setValues({})
        setNote(null)
        runLogin(async function () {
          await api('POST', '/video-fetch/login/cancel', { sessionId: id })
        })
      }

      /** @param {string} accountId - account to pin. */
      function pinAccount(accountId) {
        runLogin(async function () {
          await api('POST', '/video-fetch/login/pin', { channel: selChannel, account: accountId })
          await refresh()
        })
      }

      /** @param {string} accountId - account to drop. */
      function logoutAccount(accountId) {
        runLogin(async function () {
          await api('POST', '/video-fetch/login/logout', { channel: selChannel, account: accountId })
          await refresh()
        })
      }

      /** @param {string} accountId - account to probe. */
      function checkAccount(accountId) {
        runLogin(async function () {
          var next = await api('POST', '/video-fetch/login/check', { channel: selChannel, account: accountId })
          var status = next.account && next.account.status
          setTone(status === 'active' ? 'ok' : 'bad', t('checkResult', { status: status || 'unknown' }))
          await refresh()
        })
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

      // ── the login card ──────────────────────────────────────────────────
      //
      // `chans` / `chanId` / `methodId` / `accounts` were derived above, next
      // to the hooks that keep them coherent.

      var loginChildren = []

      loginChildren.push(React.createElement('p', {
        key: 'intro',
        style: { margin: '0 0 10px', fontSize: 12, color: T.textMuted },
      }, t('loginIntro')))

      if (chans.length === 0) {
        loginChildren.push(React.createElement('div', {
          key: 'unavailable',
          style: { fontSize: 12, color: T.danger },
        }, (state.native && state.native.error) || t('unavailable')))
      } else {
        // ── pickers ────────────────────────────────────────────────────
        var channelOptions = chans.map(function (entry) {
          return { value: entry.channel.id, label: entry.channel.name }
        })
        var methodSource = methodInfo && !methodInfo.implemented ? [methodInfo] : liveMethods
        var methodOptions = methodSource.map(function (method) {
          return { value: method.id, label: method.label }
        })

        var pickers = React.createElement('div', {
          key: 'pickers',
          style: { display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10 },
        },
          React.createElement(Picker, {
            key: 'channel',
            label: t('channelLabel'),
            value: chanId,
            disabled: busy,
            options: channelOptions,
            onChange: onChannelChange,
          }),
          React.createElement(Picker, {
            key: 'method',
            label: t('methodLabel'),
            value: methodId,
            disabled: busy || liveMethods.length === 0,
            options: methodOptions,
            onChange: setSelMethod,
          }),
        )
        loginChildren.push(pickers)

        // ── actions ───────────────────────────────────────────────────
        //
        // `manual` renders no start button — its own import button is the
        // action. `browser` routes to `browseLogin`, which opens a browser
        // instead of minting a challenge server-side.
        var canStart = methodId !== '' && methodId !== 'manual' && methodInfo !== null && methodInfo.implemented
        var startButton = session !== null
          ? React.createElement(Button, { key: 'cancel', disabled: busy, onClick: cancelLogin }, t('cancel'))
          : (canStart
            ? React.createElement(Button, {
                key: 'start',
                variant: 'primary',
                disabled: busy,
                onClick: function () { methodId === 'browser' ? browseLogin() : startLogin() },
              }, t('start'))
            : null)
        var pollButton = session !== null && session.challenge.kind === 'qr'
          ? React.createElement(Button, {
              key: 'poll',
              disabled: busy,
              onClick: function () { pollRef.current() },
            }, t('poll'))
          : null
        var actionRow = React.createElement('div', {
          key: 'actions',
          style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
        }, startButton, pollButton)
        loginChildren.push(actionRow)

        // ── per-method surface ────────────────────────────────────────
        //
        // Driven by `kind`, not by the method's name, so adding a method to a
        // provider needs no change here.

        if (session !== null && session.challenge.kind === 'qr') {
          var qrSrc = session.challenge.image || (apiPath('/video-fetch/challenge?data=' + encodeURIComponent(session.challenge.url)) + '&t=' + Date.now())
          var qrBlock = React.createElement('div', { key: 'qr', style: { marginTop: 10 } },
            React.createElement('div', { style: { fontSize: 12, color: T.textMuted, marginBottom: 6 } }, t('scan')),
            React.createElement('img', {
              src: qrSrc,
              alt: t('scan'),
              style: { width: 180, height: 180, background: '#fff', borderRadius: 6 },
            }),
          )
          loginChildren.push(qrBlock)
        }

        if (session !== null && session.challenge.kind === 'browse') {
          var browseBlock = React.createElement('div', { key: 'browse', style: { marginTop: 10 } },
            React.createElement('div', { style: { fontSize: 12, color: T.textMuted, marginBottom: 6 } },
              session.challenge.prompt || t('browseHint')),
            React.createElement('a', {
              href: session.challenge.url,
              target: '_blank',
              rel: 'noreferrer',
              style: {
                fontSize: 12,
                color: v('--dsw-alias-state-business-primary', '#4c6ef5'),
                wordBreak: 'break-all',
              },
            }, session.challenge.url),
          )
          loginChildren.push(browseBlock)
        }

        // `manual` needs no session: it is a one-shot import.
        if (methodId === 'manual' && session === null) {
          var textarea = React.createElement('textarea', {
            value: cookieText,
            disabled: busy,
            rows: 6,
            placeholder: t('cookiePlaceholder'),
            onChange: function (event) { setCookieText(event.target.value) },
            style: {
              font: 'inherit', fontSize: 12, width: '100%', maxWidth: 520, padding: '6px 8px',
              color: T.text, background: T.bg, border: '1px solid ' + T.border, borderRadius: 6,
              resize: 'vertical',
            },
          })
          var labelInput = React.createElement('input', {
            value: labelText,
            disabled: busy,
            placeholder: t('labelPlaceholder'),
            onChange: function (event) { setLabelText(event.target.value) },
            style: {
              font: 'inherit', fontSize: 12, padding: '4px 8px', minWidth: 160,
              color: T.text, background: T.bg, border: '1px solid ' + T.border, borderRadius: 6,
            },
          })
          var importRow = React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
            React.createElement(Button, { variant: 'primary', disabled: busy, onClick: importCookies }, t('import')),
            labelInput,
          )
          var importBlock = React.createElement('div', { key: 'import', style: { marginTop: 10 } },
            React.createElement('div', { style: { fontSize: 12, color: T.text, marginBottom: 4 } }, t('cookieLabel')),
            React.createElement('div', { style: { fontSize: 11, color: T.textMuted, marginBottom: 6 } }, t('cookieHint')),
            textarea,
            importRow,
          )
          loginChildren.push(importBlock)
        }

        // `sms` / `password`: a credential flow, one step at a time.
        if (session !== null && fields.length > 0) {
          var fieldInputs = fields.map(function (field) {
            var label = React.createElement('div', {
              style: { fontSize: 12, color: T.text, marginBottom: 4 },
            }, field.label)
            var input = React.createElement('input', {
              type: field.secret ? 'password' : 'text',
              value: values[field.name] === undefined ? '' : String(values[field.name]),
              disabled: busy,
              onChange: function (event) {
                var name = field.name
                var next = event.target.value
                setValues(function (previous) {
                  var merged = Object.assign({}, previous)
                  merged[name] = next
                  return merged
                })
              },
              style: {
                font: 'inherit', fontSize: 13, padding: '4px 8px', minWidth: 260,
                color: T.text, background: T.bg, border: '1px solid ' + T.border, borderRadius: 6,
              },
            })
            return React.createElement('label', {
              key: field.name,
              style: { display: 'block', marginBottom: 8 },
            }, label, input)
          })
          var fieldsBlock = React.createElement('div', { key: 'fields', style: { marginTop: 10 } }, fieldInputs)
          loginChildren.push(fieldsBlock)
          loginChildren.push(React.createElement('div', { key: 'submit', style: { display: 'flex', gap: 8 } },
            React.createElement(Button, { variant: 'primary', disabled: busy, onClick: submitLogin }, t('submit')),
          ))
        }
      }

      // ── the account pool ────────────────────────────────────────────────
      //
      // One channel can hold several accounts, captured by any method. The
      // pinned one is what a download uses; the rest are the rotation fallback
      // when the pinned account is rejected.

      loginChildren.push(React.createElement('div', {
        key: 'accountsHead',
        style: { fontSize: 12, color: T.text, marginTop: 12, marginBottom: 6 },
      }, t('accountsLabel') + ' (' + accounts.length + ')'))

      if (accounts.length === 0) {
        loginChildren.push(React.createElement('div', {
          key: 'noAccounts',
          style: { fontSize: 11, color: T.textMuted },
        }, t('noAccounts')))
      } else {
        loginChildren.push(React.createElement('div', { key: 'accounts' },
          accounts.map(function (account) {
            var active = account.id === activeId
            var who = account.label || account.identity
            return React.createElement('div', {
              key: account.id,
              style: {
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                padding: '6px 8px', marginBottom: 6,
                border: '1px solid ' + (active ? v('--dsw-alias-state-business-primary', '#4c6ef5') : T.border),
                borderRadius: 6,
              },
            },
              React.createElement('span', {
                style: { fontSize: 12, color: active ? T.ok : T.textMuted, minWidth: 8 },
              }, active ? '●' : '○'),
              React.createElement('span', { style: { fontSize: 12, color: T.text, minWidth: 96 } },
                who || account.id.slice(0, 8)),
              React.createElement('span', { style: { fontSize: 11, color: T.textMuted } },
                account.method),
              React.createElement('span', {
                style: { fontSize: 11, color: account.status === 'active' ? T.ok : T.textMuted },
              }, t('status_' + account.status)),
              React.createElement('span', { style: { fontSize: 11, color: T.textMuted } },
                t('cookieCount', { n: account.cookie_count })),
              active
                ? null
                : React.createElement(Button, {
                    disabled: busy,
                    onClick: function () { pinAccount(account.id) },
                  }, t('setActive')),
              React.createElement(Button, {
                disabled: busy,
                onClick: function () { checkAccount(account.id) },
              }, t('check')),
              React.createElement(Button, {
                disabled: busy,
                onClick: function () { logoutAccount(account.id) },
              }, t('logout')),
            )
          }),
        ))
      }

      if (note !== null) {
        loginChildren.push(React.createElement('div', {
          key: 'note',
          style: {
            fontSize: 12,
            color: note.tone === 'ok' ? T.ok : note.tone === 'bad' ? T.danger : T.textMuted,
            marginTop: 8,
          },
        }, note.text))
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
