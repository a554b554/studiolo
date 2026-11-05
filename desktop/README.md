# Studiolo desktop client

A Tauri 2 shell around the Studiolo web UI. The bundled `launcher/` page keeps the
server list and probes each server's `/api/identity`; opening a server loads that server's own
UI in the window, so UI changes ship with the server (git deploy), not with the client.

Rust adds the tray (Show, Switch server…, Start at login, Quit), autostart (`--hidden` starts
in the tray), a single instance, close-to-tray, and notifications for `public/notify.js`.

## Build

Windows (Rust MSVC toolchain and Visual Studio Build Tools):

```bash
cd desktop && npm install && npx tauri build
```

Output: `src-tauri/target/release/bundle/msi/*.msi` and `bundle/nsis/*-setup.exe`.

macOS (works over SSH, from a separate clone of the repo, not a server's checkout).
`CI=true` skips the Finder layout step of the DMG, which cannot run without a GUI session:

```bash
export PATH=/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH CI=true
cd <clone>/desktop && git pull && npm install && npx tauri build --bundles app,dmg
```

Output: `bundle/macos/Studiolo.app` and `bundle/dmg/*.dmg`, ad-hoc signed (no notarization).
On another Mac, the first launch needs right-click → Open, because the app is not notarized.

Icons: `npm run icons` regenerates `src-tauri/icons/` from `../assets/icon/studiolo-icon-rounded.svg`, the iOS `s.` with
macOS margins. Delete the `android/` and `ios/` folders it also writes.

## Microphone over the tailnet

Voice input needs a secure origin, and a server opened by its tailnet name is plain http. WebView2 treats
the servers in the list as secure through `--unsafely-treat-insecure-origin-as-secure`, which takes exact
origins only: wildcards such as `http://*.ts.net:4310` are ignored (checked in Edge, 2026-10-31). The flag is
fixed when the webview starts, so the launcher passes its list to `trust_origins` when it opens a server.
If a server is new, the client saves it to `trusted-origins.txt` in its config folder
(`%APPDATA%\net.studiolo.desktop`) and restarts once.

macOS has no such flag, so WKWebView offers no `getUserMedia` there. Since 0.2.1 the client records
itself (`src-tauri/src/recorder.rs`, cpal): `public/dictation.js` calls `start_recording` and
`stop_recording`, gets a 16 kHz mono WAV back and posts it to `/api/transcribe` like a browser
recording. macOS asks for microphone access the first time (`NSMicrophoneUsageDescription` in `Info.plist`).

## Updates

Since 0.2.1 the client updates itself: Settings → 版本 shows 「更新客户端」 when the server ships a newer
client (`clientVersion`, read from `tauri.conf.json`) or a newer build of the same version (`build` in
`package.json`). A version stays open while it gains features (CHANGELOG.md), so **raise `build` on every
client rebuild that ships**, and keep the version until the version is fixed. The button calls `update_client`,
which asks that server for `/api/client/update/{target}/{arch}/{current}?build={n}` (`src/client-update.mjs`,
no sign-in), downloads the bundle, checks its signature against the public key in `tauri.conf.json`
(`plugins.updater.pubkey`), installs it and restarts. The 0.2.0 client has no updater and is installed by hand once.

The repository ships a placeholder public key. Before building a client that updates itself, make your own key
pair and put the public key in `tauri.conf.json`:

```bash
npx tauri signer generate -w ~/.tauri/studiolo-updater.key
```

This writes the private key to `~/.tauri/studiolo-updater.key` and the public key next to it (`.pub`); paste the
`.pub` contents into `plugins.updater.pubkey`. A client built with the placeholder runs, but refuses every update.
Keep the private key on each machine that builds releases, never in a repo or a synced folder. Builds sign their
bundles with it:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/studiolo-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

Each server offers the bundles in its own `desktop/dist` (gitignored), so copy them to every server that should offer them:

- Windows: `bundle/nsis/Studiolo_<v>_x64-setup.exe` and its `.sig`.
- macOS: `bundle/macos/Studiolo.app.tar.gz` and its `.sig`, renamed to `Studiolo_<v>_aarch64.app.tar.gz(.sig)`.

## Links

The opener plugin's own click handler is off (`open_js_links_on_click(false)`): it opened links through a
command server pages may not call, so they did nothing. Every new window goes through `on_new_window`
(`src/lib.rs`, `new_window`) instead, and every link opens in the default browser. Settings → 版本 calls
`set_link_mode` to keep Studiolo pages in client windows: those of the window's own server and of the
servers the page named (`known_servers`, the hosts in `/api/bootstrap`). The choice is the file
`open-in-client` in the client's config folder.

Artifact windows open through `open_link` instead of `window.open`: the page first fetches a one-time
sign-in ticket (`public/api.js`, `openSignedIn`; `src/server.mjs`, sign-in handoff), and by then
`window.open` would have lost the click. Clients before 0.2.2 build 2 have no `open_link`; the page then
falls back to `window.open`.

## Debugging the Windows webview

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 ./src-tauri/target/release/studiolo-desktop.exe
```

Then `http://127.0.0.1:9333/json` lists the pages and their DevTools WebSocket URLs.
The variable replaces the client's own flags, so add the secure-origin flag to it when testing the microphone.
