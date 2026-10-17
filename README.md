# dsh-video-fetch

Video downloading for [DeepSeek Harness](https://github.com/deepseek-ai/dsh): yt-dlp
downloads with optional ffmpeg compression to a QQ-sendable MP4, plus bilibili
QR login so downloads reach the logged-in quality tier.

## Tools

| Tool | What it does |
| --- | --- |
| `video_fetch` | Download any URL yt-dlp supports (bilibili, YouTube, …) with `yt-dlp`; returns the local file path. `compress: true` re-encodes the result in the same call. An already-downloaded URL returns the existing file. |
| `video_login` | Bilibili QR login (`start` / `poll` / `status` / `logout`). Logged-in cookies raise the reachable quality (e.g. 1080P+). |
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

- Bilibili session cookies are written to `DSH_HOME/video-fetch/cookies.txt`
  with mode `0600` and are **never** included in tool results, logs, or commits.
- `video_fetch` accepts `http(s)` URLs only; `video_compress` accepts absolute
  local paths only. Both binaries are spawned with argv arrays (no shell).
- Every external process has a hard deadline (SIGTERM, then SIGKILL).

## Development

```bash
npm test         # unit tests: arg building, cookie handling, registration (offline)
npm run test:live  # real bilibili download + ffmpeg + QR start/poll (needs network)
```
