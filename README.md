# dsh-video-fetch — **moved**

This repository has been merged into
[video-login](https://github.com/DataEraserC/video-login) and is **archived**.
Nothing here will be updated again.

## Where it went

The DeepSeek Harness half now lives in the `video-login` repository, adopting
the same layout [bas-remote](https://github.com/DataEraserC/bas-remote) uses —
the library first, one host directory per harness:

```
video-login/
  crates/vlogin-core/   protocol layer (channels, cookie codec, CDP conversation)
  crates/vlogin-abi/    C ABI over the core; owns every effect
  crates/vlogin-cli/    `vlogin` — the same operations from a shell, no harness
  hosts/dsh/            the DeepSeek Harness host (this repository's former contents)
```

## Use it instead

```nix
# flake input
video-login.url = "github:DataEraserC/video-login";

# the DSH bundle
inputs.video-login.packages.${system}.dsh
```

A Nix package re-export also exists in
[nur-packages](https://github.com/DataEraserC/nur-packages) as
`dsh-video-fetch`, which follows `video-login` and installs the matching
`libvlogin.so` beside the plugin.

## Why

Keeping the Rust library and its harness host in one repository means the
library behind the C ABI and the host that links it cannot drift apart, and a
release no longer needs a separately refreshed source hash. `vlogin-core` also
gained a purity test that keeps it a stateless protocol layer, matching the
same guard in bas-remote and oray-tools.

History up to `8744a44` remains readable here; the code continues at
https://github.com/DataEraserC/video-login
