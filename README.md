# dsh-video-fetch

Video downloading for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): yt-dlp
downloads with optional ffmpeg compression to a QQ-sendable MP4, plus per-site
login (bilibili QR or a manually exported cookie file) so downloads reach the
logged-in quality tier.

## Tools

| Tool | What it does |
| --- | --- |
| `video_fetch` | Download any URL yt-dlp supports (bilibili, YouTube, …) with `yt-dlp`; returns the local file path. A URL owned by a login site gets its cookie jars, tried in order when one fails. `compress: true` re-encodes the result in the same call. An already-downloaded URL returns the existing file. |
| `video_login` | Per-site login on a `site` × `method` contract: `site` (currently `bilibili`), `method` = `qr` (`start` → show the PNG → `poll`), `manual` (`import` a Netscape cookie file from disk), or `password`/`sms` (reserved for future sites, currently a structured not-implemented error); plus `status` and `logout`. |
| `video_compress` | Re-encode any local video to H.264 + AAC + faststart with a height cap, writing `<name>.small.<ext>` next to the input. |

## Configuration

All knobs live in plugin config (not Nix):

| Key | Default | Meaning |
| --- | --- | --- |
| `downloadDir` | `~/Videos/dsh-video-fetch` | Where downloads land |
| `format` | `bv*+ba/b` | yt-dlp format selector |
| `ytdlpBinary` / `ffmpegBinary` | `yt-dlp` / `ffmpeg` | Bare names resolve through `PATH` |
| `fetchTimeoutMs` / `compressTimeoutMs` | 600000 / 900000 | Hard per-invocation deadlines |
| `crf` / `maxHeight` / `audioBitrate` / `preset` | 26 / 720 / `128k` / `medium` | ffmpeg re-encode settings |

## Packaging notes (NUR)

The wrapper must carry `runtimeDeps = [ yt-dlp ffmpeg ]` — the plugin spawns both
by bare name and relies on the wrapper's `PATH`. No paths are hard-coded, so a
user override via `ytdlpBinary` / `ffmpegBinary` still wins.

## Security

- Login cookies are stored **per site** as an array in
  `DSH_HOME/video-fetch/cookies/<site>.json` (mode `0600`, newest first, at
  most 5 jars per site) and are **never** included in tool results, logs, or
  commits; `video_fetch` materializes the jar it hands to yt-dlp and rotates
  to the next when one fails. `logout` clears only the named site.
- `video_login action=import` takes an absolute path to a cookie file already
  on disk — cookie values are never pasted into chat.
- `video_fetch` accepts `http(s)` URLs only; `video_compress` accepts absolute
  local paths only. Both binaries are spawned with argv arrays (no shell).
- Every external process has a hard deadline (SIGTERM, then SIGKILL).

## Development

```bash
npm test         # unit tests: arg building, cookie handling, registration (offline)
npm run test:live  # real bilibili download + ffmpeg + QR start/poll (needs network)
```
