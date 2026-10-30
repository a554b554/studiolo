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

Icons: `npm run icons` regenerates `icon-source.png` and `src-tauri/icons/`.

## Debugging the Windows webview

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 ./src-tauri/target/release/studiolo-desktop.exe
```

Then `http://127.0.0.1:9333/json` lists the pages and their DevTools WebSocket URLs.
