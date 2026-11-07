# Studiolo releases

The server reports its release (`/api/identity`, `/api/bootstrap`); the topbar and Settings → 版本 show it, together with the release of every other registered server and of the desktop client. The desktop client has its own release and is rebuilt only when the client itself changes, since its UI comes from the server.

## 0.2.5 (open)

Server, web front end and desktop client 0.2.5 (Windows, macOS). The desktop client changed only its version; its UI comes from the server.

- The sidebar orders projects by their newest message, and conversations inside a project the same way: a message anywhere in a chat, its forks or a category lifts that branch to the top, and a project jumps up when a reply arrives in it. Only the first 15 projects are drawn; scrolling to the end (or 「显示更早的项目」) draws the next 15. A search box above the list finds projects and conversations by name.
- Project files are no longer synchronized between computers. Every computer keeps its own copy of a project's folder; the version manifests, automatic commit after a run, background pulls, the run barrier and the 「有冲突」 state are gone, and two computers may run the same project at once. The project settings keep one setting, 可运行的电脑: the owner always, plus the computers ticked there; a ticked computer gets an empty folder at its first run. The agent's first turn in a project that several computers may run lists each computer's project folder and SSH address, so it can fetch what the user asks for (an experiment's results, a file) with ssh, scp or rsync. Conversations and run records are still exchanged between servers every few seconds. Projects that were synced before keep their copies, and the computers that held one stay allowed.
- A server that stops answering is noticed and left. On Windows the server keeps a 1 GB working set that the memory manager may not page out, and runs at above-normal CPU priority, so a game that takes all the memory no longer freezes it (`STUDIO_RESIDENT_MB` sets the size, `0` turns it off). The event stream now pings every 5 s; a page that hears nothing for 15 s counts the server as gone, and after a 5 s countdown moves to another server it knows, with the same conversation and its unsent text. The page there says why, and offers the way back once the old server answers. A message still being sent holds the switch.
- Every computer keeps its own copy of a project's files and Artifacts, and the right sidebar shows one of them. When several computers hold a copy, a picker under 项目目录 chooses whose; it follows the open conversation's computer, and a choice holds until another conversation opens. The file tree, uploads, opened files and the Artifact list all use the chosen copy, and a file open from two computers is two tabs. An Artifact belongs to the computer whose studio.artifacts.json declares it, which is where the conversation that made it ran, and 启动 and 常驻运行 run it there whichever server the page or app uses; the same key in two copies is two Artifacts. Artifacts from before 0.2.5 belong to the project's owner. To move an Artifact to another computer, ask the agent to copy it.

## 0.2.4 (2026-11-04)

Server, web front end and desktop client 0.2.4 (Windows, macOS).

- Right-click a file or folder in Files → 在文件资源管理器中显示 (在访达中显示 on a Mac) opens it in the system file manager with the file selected. It works only for a page on the same computer as the server that holds the files (`127.0.0.1` / `localhost`); anywhere else the item is greyed out and says why.
- An Artifact added to a project whose files are on another computer now shows up. The server answering the project view asks the computer with the files to look for new Artifacts, and pulls its journal when something changed. Before, refreshing kept showing the old list.
- The sidebar's main button creates a project, and every chat lives in a project (the project's ＋, ⋯ → 新建对话, `/new`). The small ＋ beside 「项目」 is gone.
- Artifact comments in different threads run in parallel, each in its own agent session; replies in one thread still queue behind it. Each thread's agent is told that other threads may be editing the same files at the same time. Resolving an idle thread closes its agent process. A thread from before 0.2.4 starts a new session at its next reply.
- Switching conversations is quick again; on large projects it could take more than 10 s in the Windows client.
  - The page loads only the open conversation (`?session=`, `?artifact=`). Tool records of ended runs arrive as 500-character previews, and the full record loads when a Raw log is opened (`GET …/runs/<id>/records`). For the largest project, 32.6 MB per load became 0.70 MB.
  - The readable history files (`history-index.md`, `sessions/*.md`, `artifacts/*.md`, `state.json`) are written shortly after a change, and only for the conversations and Artifacts that changed. They are always written before an agent run starts.
  - After a change the server applies only the new journal events instead of reading the whole journal again.
  - The ten most recently opened conversations show at once from a cache while a fresh copy loads; sending waits for that copy.
  - Long conversations show their last 60 items. 「显示更早的内容」 or scrolling to the top shows 60 more, and the reading position stays put.
- A reply no longer disappears into the Raw log a few minutes after its turn. When Claude reported background work after a turn had ended (a background command or a subagent finishing), the finished reply was turned into narration. Replies hidden this way are restored when each server starts.

## 0.2.3 (2026-11-04)

Server, web front end and desktop client 0.2.3 (Windows, macOS).

- Voice input shows what it hears as you speak. Tap the microphone and a voice bar replaces the composer's controls: a live waveform, ✕ to cancel (Esc) and ✓ to finish (Enter). The words appear in the message box at the cursor while you talk, like an input method, through OpenAI's realtime transcription (`gpt-live-transcribe`). The server only mints a two-minute client secret (`/api/transcribe/realtime`, forwarded to the computer that holds the OpenAI key); the page streams audio to OpenAI itself and commits a turn at each pause. If the connection drops, what was already transcribed stays and the rest is transcribed in one piece on ✓. Hold-to-talk is gone. The desktop client streams its native microphone (`start_streaming`); older clients fall back to recording and uploading.
- Conversations can be dragged in the Windows client again. Tauri's own file drop handler swallowed every drag in the page, so a drag showed a forbidden sign.
- A reply no longer vanishes when its turn ends in a long conversation. A snapshot of the turn still running could arrive after the final one and fold the reply back into the closed timeline until the next refresh; the page now applies snapshots in order and never brings an ended turn back, and the server reads again when a turn ends while it assembles the view.
- Streaming no longer pulls you away from what you are reading. Only your own scrolling decides whether the view follows: at the bottom it follows the reply, scrolled up it stays where it is and new output is added at the end.
- A sent message no longer shows twice (once recorded, once 「发送中」 under a 「启动中」 placeholder). The small live refresh dropped a turn the page had not loaded yet but kept its messages; it now adds the turn. Requests that get no answer time out (reads after 60 s, sends after 30 s, after which the page checks whether the server recorded the send), so one hung request no longer stops every later refresh or send.
- One stuck check of which computers are online no longer freezes the whole server. Every page request shared it, so project views, sends and the host list all hung while the server still looked connected; callers now get the last known answer after 8 s.
- The attachment button is a line-drawn paperclip instead of the 📎 emoji.

## 0.2.2 (2026-11-01)

Server, web front end and desktop client 0.2.2 (Windows, macOS).

- Artifacts of a project that runs on another computer open on that computer. Their ↗ links (and so 复制链接) go to that server's address, the side-pane tab offers its windows instead of a blank frame, and old links to this server's Artifact pages forward there. A page here could not frame them: the preview's sign-in cookie never reaches another site, so the frame stayed white.
- Links in the desktop client open again, in the default browser (client 0.2.2 build 2). Settings → 版本 can keep Artifact windows and other servers' pages in client windows instead.
- Artifact windows open signed in, with no token or device approval in the browser that shows them, on this computer or another: the page asks its server for a one-time sign-in link (60 s, one use), forwarded to the Artifact's server when it runs elsewhere. Copied links carry no ticket, so whoever opens one still signs in.

## 0.2.1 (2026-11-01)

Server, web front end and desktop client 0.2.1 (Windows, macOS).

- The composer's pickers (computer, account, model, effort, permissions) are as wide as the value they show, not their longest option. The row keeps even gaps, and Send stays on the same line unless the composer is too narrow. Chromium only (web and the Windows client); Safari and the Mac client keep the old widths.
- The composer row stays on one line while a turn runs, too: Stop, 排队 and 插话 stay together on the right, and the long pickers (account, model, permissions) shorten with "…" to make room. Only a composer too narrow even for that wraps the pickers, and the actions then keep a line of their own.
- Narrow windows and phones show the conversation again. Below 900 px it fell into a 0-wide column and the page looked empty (since 0.2.0).
- The account usage panel's height is adjustable: drag its top edge (double-click resets). Accounts that don't fit scroll inside the panel, under its title and above its footer. By default it takes up to 45% of the sidebar, and the project list always keeps room for a few rows.
- Voice input works in the Mac client on a tailnet server. WKWebView has no microphone for a plain-http page, so the client records natively and the page uploads the recording.
- One-click client updates: Settings → 版本 shows 「更新客户端」 when the server has a newer desktop client, including a newer build of the same version. The client downloads the signed bundle from that server, installs it and restarts. The 0.2.0 client is the last one installed by hand.

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
