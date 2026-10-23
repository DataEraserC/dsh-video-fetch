# dsh-video-fetch

Video downloading for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): yt-dlp
downloads with optional ffmpeg compression to a QQ-sendable MP4, plus per-channel
login so downloads reach the logged-in quality tier.

Login is **channel × method**: pick the site (bilibili, douyin, YouTube, Tencent
Video, iQiyi, Youku), then pick how the credential arrives *within* that
channel (QR scan, paste a cookie file, SMS code, password, or drive a real
browser). Not every channel implements every method — the registry advertises
the full set with `implemented` flags, so the picker is complete and asking for
an unsupported method returns a structured refusal instead of quietly doing
nothing.

The engine that does the work is the separate, harness-independent
[`video-login`](https://github.com/DataEraserC/video-login) tool: a Rust core, a
C ABI, and a CLI. This plugin is only the integration shell — routes, tools, and
the page — that loads that library and calls it.

Settings are editable **two ways that write the same profile row**: the
`video_settings` session tool and the plugin's page in the web GUI. A change
applies to the running plugin immediately and survives a restart.

## Tools

| Tool | What it does |
| --- | --- |
| `video_fetch` | Download any URL yt-dlp supports (bilibili, YouTube, …) with `yt-dlp`; returns the local file path. Files land inside the session workspace only (see Security). A URL owned by a login site gets its cookie jars, tried in order when one fails. `compress: true` re-encodes the result in the same call; `crf` / `maxHeight` override the settings for that call only. An already-downloaded URL returns the existing file. |
| `video_login` | Per-channel login on a `channel` × `method` contract. `channel` is the site (`bilibili`, `douyin`, `youtube`, `tencent`, `iqiyi`, `youku`); `method` is how the credential arrives (`qr`, `manual`, `sms`, `password`, `browser`); each channel advertises which methods it implements. Actions: `channels` (list channels with display names + methods), `start` (begin a login, returns `sessionId` + a challenge to render), `browse` (open a browser on the server, then `poll`), `poll` (advance a login; `waitMs` blocks), `submit` (send this step's inputs), `import` (store a cookie file from disk via `path`), `status` (probe an account), `pin` (choose the active account), `logout`, `clear`, `cancel`. |
| `video_compress` | Re-encode any local video to H.264 + AAC + faststart with a height cap, writing `<name>.small.<ext>` next to the input. |
| `video_settings` | `get` reads the live values, `set patch={…}` writes them into the active profile's Cordis patch and applies them immediately, `reset` drops the override and restores the inherited value. Same fields and the same validation as the web page. |

## Web page

The package ships a browser half (`lib/client.js`, declared as `dsh.client`), so
it appears in the web GUI in two places:

- **Plugins page** — a configure card on the `dsh-video-fetch` row
  (`plugins.row.config`), showing the summary on the row and the full page in
  its detail view.
- **Settings → Built-in plugins** — a "Video download" tab
  (`settings.plugins.tab`).

The page edits the seven tunable settings and drives login for whichever
channel is selected: a labeled **渠道** picker, then a **方式** picker showing only
that channel's methods, then the surface the chosen method needs (a QR image to
scan, a cookie-file box, phone + SMS code, username + password, or a browser
link). Stored accounts for the channel are listed with their status and can be
pinned or removed.

It talks to the plugin's own host routes (`/video-fetch/state|set|reset|login/*|
challenge`, mirrored under `/api` on the desktop connection) rather than the
generic settings form, because login is not configuration and the session tool
must share one writer with the page.

## Configuration

Tunable at runtime (volatile: a write updates the running plugin in place):

| Key | Default | Meaning |
| --- | --- | --- |
| `downloadDir` | `dsh-video-fetch` | Download subdir, resolved inside the session workspace (absolute paths rejected) |
| `format` | `bv*+ba/b` | yt-dlp format selector |
| `crf` / `maxHeight` / `audioBitrate` / `preset` | 26 / 720 / `128k` / `medium` | ffmpeg re-encode settings |
| `downloadEngine` | `ytdlp` | Which downloader `video_fetch` uses; `native` is a reserved slot (see below) |

Restart-only (they change the process environment, so they are ordinary fields):

| Key | Default | Meaning |
| --- | --- | --- |
| `ytdlpBinary` / `ffmpegBinary` | `yt-dlp` / `ffmpeg` | Bare names resolve through `PATH` |
| `fetchTimeoutMs` / `compressTimeoutMs` | 600000 / 900000 | Hard per-invocation deadlines |

## Download engines

`video_fetch` does not call yt-dlp directly — it calls a *downloader*, and yt-dlp
is the engine behind it today. The indirection is deliberate and small:

| Engine | Status |
| --- | --- |
| `ytdlp` | The only implementation today. Spawns `yt-dlp --cookies <file>` with an argv array. |
| `native` | **Reserved.** Intentionally empty. |

**`native` is a reserved slot for a downloader that does not depend on yt-dlp, and
it must not be deleted.** yt-dlp tracks hundreds of sites by reverse-engineering
them, which makes it an excellent default and a single upstream that can break
every site at once. When a site changes its player, the whole plugin waits on an
upstream release. The reserved slot is where an independent path — a direct
HLS/DASH fetcher, a site-specific client, an ffmpeg-driven pull — lands without
reshaping the plugin: `lib/downloaders/index.js` already dispatches by id and
already rotates cookie jars per engine, so adding one is one file plus one registry
entry. Removing the empty slot means the next person re-derives the seam from
scratch, probably mid-incident.

An engine is `{ id, label, available(), fetch({ url, outDir, format, cookiesPath,
timeoutMs }) }` resolving to `{ path, engine }`. It must keep two rules: the file
lands inside `outDir` (the plugin's workspace confinement is enforced upstream and
a new engine must not widen it), and cookie text is read from `cookiesPath` and never
echoed into a result.

## Packaging notes (NUR)

The wrapper must carry `runtimeDeps = [ yt-dlp ffmpeg ]` — the plugin spawns both
by bare name and relies on the wrapper's `PATH`. No paths are hard-coded, so a
user override via `ytdlpBinary` / `ffmpegBinary` still wins.

## Security

- Login cookies are stored **per channel** in
  `DSH_HOME/video-fetch/accounts/<channel>.json` (mode `0600`, at most 10
  accounts) and are **never** included in tool results, logs, HTTP responses,
  or commits. `video_fetch` materializes one account's cookies to a `0600` file,
  hands the *path* to the engine, and rotates to the next account when the site
  rejects one. `logout` removes one account; `clear` removes the channel's.
- The web routes return login state, account labels and identities, and cookie
  **counts** — never a cookie value.
- `video_login action=import` takes an absolute path to a cookie file already on
  disk — cookie values are never pasted into chat. The web page's paste box
  posts straight to that route and is never echoed back.
- Login sessions (a pending QR poll, an SMS step) are `0600` files under
  `sessions/`, each keyed by a random hex id that is checked before it touches
  the filesystem, so a hostile id cannot be used to walk directories.
- `video_fetch` accepts `http(s)` URLs only; `video_compress` accepts absolute
  local paths only. Both binaries are spawned with argv arrays (no shell).
- `video_fetch` downloads **only inside the session workspace**: `downloadDir`
  is a workspace-relative subdir (default `dsh-video-fetch`), absolute paths and
  `..` are rejected on write and again at use, and the resolved directory's
  nearest existing ancestor is realpath-checked against the workspace so a
  symlink planted inside it cannot redirect a download out. A call with no
  session workspace fails closed before touching the filesystem.
- Every external process has a hard deadline (SIGTERM, then SIGKILL).

## Development

```bash
npm test         # unit tests: args, cookies, settings, routes, registration (offline)
npm run test:live  # real bilibili download + ffmpeg + QR start/poll (needs network)
```
