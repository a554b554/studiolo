# Studiolo releases

The server reports its release (`/api/identity`, `/api/bootstrap`); the topbar and Settings → 版本 show it, together with the release of every other registered server and of the desktop client. The desktop client has its own release and is rebuilt only when the client itself changes, since its UI comes from the server.

## 0.2.0 (2026-10-31)

Server and web/desktop front end, desktop client 0.2.0.

- New interface: light/dark follows the system, and both side panels collapse and resize (Ctrl+B, Ctrl+Alt+B).
- Files and Artifacts open as tabs in a side pane next to the chat (Ctrl+\). Each project has its own tabs.
- Files can be edited in place. Saving is automatic, and Ctrl+S saves at once. An edit made elsewhere in the meantime is caught as a conflict instead of being overwritten.
- Chat categories within a project: drag a chat onto another chat to group them. Forks nest under their chat, and a fork can be detached into its own chat.
- Artifacts start and stop from the list, and open in a new window in edit mode or browse mode (the Artifact alone, like any web application). The Artifact page's comments sidebar collapses and resizes.
- Persistent Artifacts (∞): an Artifact can run as its own server that keeps running when Studiolo closes or restarts, until someone stops it, and is started again after a reboot. Its `persistent` manifest entry sets how other computers reach it: the listen address, Tailscale forwarding, or its own URLs.
- Voice input: Settings → 语音转写 keeps one OpenAI API key on one machine, and every server forwards its recordings there. The Windows desktop client allows the microphone over plain HTTP on the tailnet.
- Device allowlist (`"deviceAllowlist":true` in `tailnet.json`): each browser and client registers itself, and Settings → 设备 or `scripts/devices.mjs` approves it.
- Per-project settings dialog: where the files are, sync, and the copy on each computer.
- Claude API-key accounts list every model the key can use, with versions ("Opus 5.5"), not just four bare aliases.
- Projects live apart from the platform, in `studiolo-projects` next to the checkout. The first start moves the old `projects/` folder there and renames Claude's saved conversations to match.
- Release numbers: open pages offer a reload after an update, and Settings → 版本 flags servers and clients on a different release.
- One app icon for the web page, the home screen and the desktop client.

## 0.1.0 (2026-10-30)

Multi-host without file sync: servers exchange a host index and project journals over HTTP, a project's files live on its owner, and *Sync* copies them to chosen machines. Desktop client for Windows and macOS.
