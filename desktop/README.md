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
(`%APPDATA%\net.studiolo.desktop`) and restarts once. macOS has no such flag, so on a Mac use 127.0.0.1 or HTTPS.

## Debugging the Windows webview

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 ./src-tauri/target/release/studiolo-desktop.exe
```

Then `http://127.0.0.1:9333/json` lists the pages and their DevTools WebSocket URLs.
The variable replaces the client's own flags, so add the secure-origin flag to it when testing the microphone.
