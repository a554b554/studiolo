# Studiolo

### One workbench for every coding-agent CLI you pay for, on every machine you own.

**Chat with Claude Code and Codex from a browser, with the accounts, machines and project history shared across your computers.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)](package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-6f42c1)](test)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**English** · [中文](#中文) · [Quick start](#quick-start) · [Accounts](#accounts-and-sign-in) · [Chat like the CLI](#chat-like-the-cli) · [Multi-machine](#multi-machine) · [Artifacts](#artifacts-and-in-page-comments) · [FAQ](#faq)

![Studiolo: a conversation with a Claude account on the local workstation, account usage on the left, project files and Artifacts on the right](docs/screenshot.png)

> The screenshot is a synthetic demo: fictional accounts, scripted replies.

---

## Install with a coding agent

Paste this into Claude Code, Codex or any coding agent that can run commands on the machine you want to use:

```text
Install Studiolo from <REPO_URL>: clone the repository, make sure Node.js 22.14+ is available and that the `claude` and/or `codex` CLIs are installed, run `node src/server.mjs` from the repository root, confirm http://127.0.0.1:4310 answers, then tell me to open Settings → Hosts & accounts to sign in my accounts. Do not sign anything in yourself.
```

Or by hand:

```sh
git clone <REPO_URL> studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo has no npm dependencies; `npm install` is not needed. Tests: `node --test test/*.test.mjs`.

---

## What it is

Studiolo is a self-hosted web workbench that drives the **Claude Code** and **Codex** CLIs already installed on your computers. It is not another chat UI over an API key:

- **Your subscriptions, your CLIs.** Every request runs through the real `claude` or `codex` process — same tools, skills, MCP servers, permission modes and agent behaviour as the terminal. Subscription sign-in or API key, your choice per account.
- **Accounts per machine, managed by Studiolo.** Sign in several Claude and Codex accounts on each computer from the browser. Each account gets its own isolated CLI configuration directory; nothing touches your personal `~/.claude` or `~/.codex`. Quota for every account is shown live.
- **One project history across machines.** Projects live in a folder you synchronize however you like (Syncthing, for example). Conversation history is an append-only journal that merges deterministically; every machine runs the same server and serves the same history. A conversation executes on the machine you chose for it; you can read and continue it from any of them.
- **The terminal experience, in the browser.** Stop a turn with Esc, steer a running agent with a follow-up message, type `/` for the CLI's own slash commands — all mapped to the native protocols, not re-implemented.
- **Artifacts and in-page comments.** Web apps the agents build run as Artifacts with persistent backends and synchronized storage; select something in the preview and send it to an agent as a task.

---

## Quick start

1. **Prerequisites** — Node.js 22.14+, and the `claude` and/or `codex` CLI installed on the machine (`claude --version`, `codex --version`).
2. **Run** `node src/server.mjs` and open <http://127.0.0.1:4310>.
3. **Add accounts** — Settings → *Hosts & accounts* → *Add account*. Pick the machine, the type (Claude Code / Codex) and the sign-in method, then follow the steps shown (see below).
4. **Create a project, start a conversation** — the composer picks **machine → account → model → effort → permission mode**. The first message fixes machine, account and model for that conversation; effort and permissions can change per message.

Environment variables: `STUDIO_STATE_DIR` (machine-private state, default `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (bytes, default 100 MB). One server per state directory.

---

## Accounts and sign-in

Accounts belong to a machine and are created from the browser. Each account is a directory under `~/.studio-local/accounts/<id>/`, used as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so several accounts of one CLI coexist and your terminal's own sign-in is never touched. When an account is created, Studiolo seeds that directory from your default CLI directory — it copies `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) and links `skills`, `plugins` and friends — so agents keep the skills and MCP servers you already use. Credentials are never copied.

| Type | Method | What happens |
| --- | --- | --- |
| Claude Code | **Subscription** | Studiolo runs `claude auth login`; you open the link, sign in, paste the authorization code back into the page. |
| Claude Code | **Anthropic API key** | The key is stored in the account directory (mode 0600) and passed as `ANTHROPIC_API_KEY`; verified through the CLI handshake, dropped if rejected. Pay-as-you-go, no quota windows. |
| Codex | **ChatGPT** | Device code via the Codex app-server: the page shows a link and a one-time code; sign in from any browser, the page updates when done. |
| Codex | **OpenAI API key** | Stored by Codex itself in the account's `CODEX_HOME`. |

After sign-in Studiolo reads the account's identity (e-mail, plan) and model list straight from the CLI — no model request is spent — and, for Claude, the CLI's slash commands for the composer's autocomplete. An account without a custom name is renamed to its e-mail, so the composer, the conversation header, every reply and the usage panel say who is talking. Accounts can be renamed, refreshed, signed out (`claude auth logout` / `codex logout`) or removed; a conversation whose account was removed may continue with another account on the same machine.

The usage panel (bottom left) follows the machine chosen in the composer: Claude subscriptions show the 5-hour window, Codex the weekly one, API-key accounts are billed by usage. It reads the CLIs' own usage endpoints (`get_usage`, `account/rateLimits/read`), caches for 60 s, never polls and never starts a CLI for a signed-out account.

All of this works for remote machines too: pick another online host in *Hosts & accounts* and the requests are relayed to it.

---

## Chat like the CLI

Each conversation owns a resident native process — Claude Code over bidirectional `stream-json`, Codex over `app-server` — so the agent behaves exactly as in the terminal. The web controls map onto the native protocols:

| In the terminal | In Studiolo | How |
| --- | --- | --- |
| Esc to stop | **■ Stop** or Esc in the composer | Claude `interrupt` control request / Codex `turn/interrupt`. The process and native session survive; the partial reply is kept; later messages continue the same session. |
| Type while the agent works | Send while a turn runs = **Steer** | Claude reads it at the next tool boundary; Codex `turn/steer`. Shown as *You · steer*; the reply continues in a new segment. **Queue** sends after the turn instead. |
| `/compact`, `/context`, custom commands, skills | Type `/` for the command list | Claude commands pass through verbatim (the list comes from the CLI itself). Codex has no text commands; `/compact`, `/review`, `/skills`, `/mcp` are mapped to app-server requests. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Platform commands handled in the browser or by the queue. |

Permission requests that the CLI would ask in the terminal appear in the page: approve this once or deny, and the same execution continues. Auto mode is the CLI's own (Claude `auto`, Codex `auto_review`); Studiolo never adds bypass flags or permanent allow rules. Reasoning effort and model can change per message within a conversation (Claude `set_model` / `apply_flag_settings`, Codex `turn/start` parameters).

---

## Multi-machine

Run the same server on every computer; put `projects/` in a folder you synchronize (Syncthing or any file sync). Each project's `.studio/events/` is an immutable, causally-ordered journal; machines that are online also exchange journals directly so changes appear within seconds. Any machine can show every conversation; execution always happens on the machine the conversation is bound to, and native CLI sessions never migrate.

**Reaching other machines.** The simplest secure setup is [Tailscale](https://tailscale.com): put `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) and a random `access-token.txt` (≥ 32 chars) in the state directory, start normally, and Studiolo publishes its port with `tailscale serve`; open `http://<machine>:4310` and enter the token once. With `"trustTailnet":true` the token is skipped for tailnet traffic. Without Tailscale, bind to a private address with `STUDIO_BIND` and set `STUDIO_TOKEN`. Servers discover each other through `projects/.servers/` or by manual pairing in Settings.

**Autostart.** macOS: `node scripts/install-studio-macos.mjs` installs a LaunchAgent (`net.studio-local.server`). Windows: register `scripts/start-studio-windows.ps1` as a Task Scheduler task (action `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, run at logon, no duplicate instances, retry every minute); `scripts/restart-studio-windows.ps1` restarts it after an upgrade once no runs are active.

**Upgrading.** Front-end files under `public/` are read per request and take effect as soon as they sync; changes under `src/` need a restart on every machine.

---

## Artifacts and in-page comments

Ask an agent for a web page or app and it maintains `studio.artifacts.json` at the project root:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Static pages omit `command`, `port` and `dataPaths`. Each Artifact gets its own persistent preview port and origin; the preview's `localStorage` is persisted into the project and synchronized, so a game saved on one machine continues on another. Backends run as plain local processes (not a sandbox) with `PORT` and `HOST`; **Snapshot** stops the backend and copies the declared data paths, **Restore** puts them back.

In the preview, *select an element, text or a canvas region* and write a comment: it becomes a task for the agent you pick, with the selection as evidence (DOM path, quoted text or a PNG of the canvas). Comments on one Artifact run in order; different Artifacts and conversations run in parallel. See `examples/persistent-game/` (Node backend + SQLite + Canvas) and `examples/artifact-compatibility/`.

---

## Files and configuration

| Location | Contents |
| --- | --- |
| `projects/<id>/` | Project working directory: code, Artifacts, data (synchronized) |
| `projects/<id>/.studio/events/` | Authoritative, immutable conversation journal |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | Rebuildable state and readable history for agents |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Synced preview storage, data snapshots, comment evidence |
| `projects/<id>/uploads/` | Files dropped into the chat or the resource pane |
| `projects/.servers/` | Public addresses of servers for discovery (no secrets) |
| `~/.studio-local/` | Machine-private: identity, `accounts.json`, `accounts/<id>/`, pairing, Tailscale settings — never synchronize |
| `~/.studio-local/agent-profiles.json` | Optional: executable path / env per CLI family (`claude`, `codex`) or per account id |

---

## FAQ

**Does it use my API key?** Only if you add an API-key account. Subscription accounts run through the CLIs' own sign-in; Studiolo stores no credentials of its own.

**Will my terminal `claude` / `codex` be affected?** No. Studiolo accounts live in their own directories; `~/.claude` and `~/.codex` are only read once to copy settings and link skills.

**Is this a sandbox?** No. Agents and Artifact backends are your own local processes with your permissions, exactly like the CLIs in a terminal.

**Can I use it from my phone?** Yes, as a browser client over Tailscale; CLIs run on your computers.

**Why zero dependencies?** The server is plain Node.js (ESM, `node:` modules only) so it runs anywhere Node 22 runs and nothing in the supply chain sits between you and your CLIs.

---

## License

MIT — see [LICENSE](LICENSE).

---

# 中文

### 把你付费的每一个 coding agent CLI、每一台电脑，放进同一个工作台。

**在浏览器里和 Claude Code、Codex 对话，账号、机器和项目历史在你的所有电脑之间共享。**

[English](#studiolo) · [快速开始](#快速开始) · [账号与登录](#账号与登录) · [像 CLI 一样对话](#像-cli-一样对话) · [多机器](#多机器) · [Artifact 与批注](#artifact-与批注) · [常见问题](#常见问题)

> 上方截图为合成演示：虚构的账号、脚本化的回复。

## 用 coding agent 安装

把这段话发给能在目标机器上执行命令的 Claude Code、Codex 或其他 coding agent：

```text
从 <REPO_URL> 安装 Studiolo：克隆仓库，确认有 Node.js 22.14+ 和 claude / codex CLI，在仓库根目录运行 `node src/server.mjs`，确认 http://127.0.0.1:4310 能打开，然后提醒我到「设置 → 主机与账号」登录账号。不要替我登录任何账号。
```

手动安装：

```sh
git clone <REPO_URL> studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

没有 npm 依赖，不需要 `npm install`。测试：`node --test test/*.test.mjs`。

## 它是什么

Studiolo 是一个自托管的网页工作台，驱动的是你电脑上已经装好的 **Claude Code** 和 **Codex** CLI，不是又一个套 API key 的聊天界面：

- **用你的订阅、你的 CLI。** 每个请求都经过真实的 `claude` 或 `codex` 进程——工具、skills、MCP、权限模式和 agent 行为与终端完全一致。每个账号可选订阅登录或 API key。
- **账号按机器管理，由 Studiolo 自己登录。** 在浏览器里为每台电脑登录多个 Claude、Codex 账号；每个账号有独立的 CLI 配置目录，绝不碰你个人的 `~/.claude`、`~/.codex`。所有账号的额度实时显示。
- **一份项目历史，跨机器共享。** 项目放在你自己同步的文件夹里（例如 Syncthing）。对话记录是只追加、可确定性合并的事务日志；每台电脑运行同一个服务、看到同一份历史。对话在你为它选定的机器上执行，在任何一台电脑上都能阅读和继续。
- **终端体验，在浏览器里。** Esc 停止、执行中插话、输入 `/` 使用 CLI 自己的斜杠命令——全部映射到原生协议，不是重新实现。
- **Artifact 与页面内批注。** agent 做出的网页应用作为 Artifact 运行，支持持久后端和跨机同步的存档；在预览里选中内容，直接作为任务交给 agent。

## 快速开始

1. **准备**：Node.js 22.14+，以及机器上已安装的 `claude` 和／或 `codex` CLI（`claude --version`、`codex --version`）。
2. **运行** `node src/server.mjs`，打开 <http://127.0.0.1:4310>。
3. **添加账号**：设置 → 「主机与账号」→ 「添加账号」。选择机器、类型（Claude Code／Codex）和登录方式，按页面提示完成（见下文）。
4. **新建项目、开始对话**：输入框依次选择 **机器 → 账号 → 模型 → effort → 权限模式**。首条消息固定该对话的机器、账号和模型；effort 和权限可逐条调整。

环境变量：`STUDIO_STATE_DIR`（机器私有状态目录，默认 `~/.studio-local`）、`STUDIO_BIND`、`STUDIO_PORT`（4310）、`STUDIO_PREVIEW_PORT`（4311）、`STUDIO_TOKEN`、`STUDIO_UPLOAD_LIMIT`（字节，默认 100 MB）。每个状态目录只运行一个服务。

## 账号与登录

账号属于某一台机器，在浏览器里创建。每个账号是 `~/.studio-local/accounts/<id>/` 下的一个目录，作为 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME` 使用，因此同一个 CLI 可以登录多个账号，而你终端自己的登录完全不受影响。创建账号时，Studiolo 会从默认 CLI 目录继承配置：复制 `settings.json`／`CLAUDE.md`（Codex 为 `config.toml`／`AGENTS.md`），链接 `skills`、`plugins` 等目录，让 agent 保留你已有的 skills 和 MCP 服务器；凭据永远不复制。

| 类型 | 方式 | 流程 |
| --- | --- | --- |
| Claude Code | **订阅登录** | Studiolo 运行 `claude auth login`：打开链接登录，把页面显示的授权码粘贴回网页。 |
| Claude Code | **Anthropic API key** | key 保存在账号目录（0600），运行时以 `ANTHROPIC_API_KEY` 注入；通过 CLI 握手验证，无效即丢弃。按用量计费，没有额度窗口。 |
| Codex | **ChatGPT 登录** | Codex app-server 设备码：网页显示链接和一次性代码，在任意浏览器完成登录，页面自动更新。 |
| Codex | **OpenAI API key** | 由 Codex 自己保存在该账号的 `CODEX_HOME`。 |

登录成功后，Studiolo 直接从 CLI 读取账号身份（邮箱、套餐）和模型列表——不消耗任何模型请求——Claude 账号还会读取 CLI 的斜杠命令列表用于输入框补全。没有自定义名称的账号会自动改名为邮箱，于是输入框、对话标题、每条回复的署名和额度面板都能看出是谁在说话。账号可以重命名、刷新、退出登录（`claude auth logout`／`codex logout`）或移除；绑定到已移除账号的对话可以改用同一台机器上的其他账号继续。

左下角额度面板跟随输入框选中的机器：Claude 订阅显示五小时窗口，Codex 显示周窗口，API key 账号按用量计费。它读取 CLI 自己的用量接口（`get_usage`、`account/rateLimits/read`），缓存 60 秒，不轮询，也不会为未登录账号启动 CLI。

以上对远程机器同样适用：在「主机与账号」里选择另一台在线主机，请求会被转发过去。

## 像 CLI 一样对话

每个对话拥有一个常驻的原生进程——Claude Code 走双向 `stream-json`，Codex 走 `app-server`——所以 agent 的行为和终端里一模一样。网页控件映射到原生协议：

| 终端里 | Studiolo 里 | 实现 |
| --- | --- | --- |
| Esc 停止 | **■ 停止** 或在输入框按 Esc | Claude `interrupt` 控制请求／Codex `turn/interrupt`。进程和原生会话保留，已输出部分保存，后续消息继续同一会话。 |
| agent 工作时继续输入 | 执行中发送 = **插话** | Claude 在下一次工具调用边界读到它；Codex `turn/steer`。显示为「你 · 插话」，回复另起一段。「排队」则等本轮结束再发。 |
| `/compact`、`/context`、自定义命令、skills | 输入 `/` 弹出命令列表 | Claude 命令原样透传（列表来自 CLI 本身）。Codex 没有文本命令，`/compact`、`/review`、`/skills`、`/mcp` 映射为 app-server 请求。 |
| — | `/model`、`/effort`、`/mode`、`/rename`、`/new`、`/status`、`/clear`、`/stop`、`/help` | 平台命令，由浏览器或队列处理。 |

CLI 在终端里会询问的权限请求会出现在页面上：批准本次或拒绝，同一次执行继续。Auto 模式就是 CLI 自己的（Claude `auto`、Codex `auto_review`）；Studiolo 不添加绕过参数，也不写入永久允许规则。同一对话内模型和 effort 可以逐条切换（Claude `set_model`／`apply_flag_settings`，Codex `turn/start` 参数）。

## 多机器

在每台电脑上运行同一个服务，把 `projects/` 放进你同步的文件夹（Syncthing 或任何文件同步工具）。每个项目的 `.studio/events/` 是不可变、带因果顺序的日志；在线的机器之间还会直接交换日志，改动几秒内可见。任何机器都能显示所有对话；执行始终发生在对话绑定的机器上，原生 CLI 会话从不迁移。

**访问其他机器。** 最简单安全的方式是 [Tailscale](https://tailscale.com)：在状态目录放 `tailnet.json`（`{"enabled":true,"command":"tailscale"}`）和一个随机的 `access-token.txt`（≥ 32 字符），正常启动，Studiolo 会用 `tailscale serve` 发布端口；打开 `http://<机器名>:4310` 输入一次令牌即可。设置 `"trustTailnet":true` 后 tailnet 内的访问不再需要令牌。不用 Tailscale 时，用 `STUDIO_BIND` 绑定内网地址并设置 `STUDIO_TOKEN`。服务器通过 `projects/.servers/` 自动互相发现，也可在设置中手动配对。

**开机自启。** macOS：`node scripts/install-studio-macos.mjs` 安装 LaunchAgent（`net.studio-local.server`）。Windows：把 `scripts/start-studio-windows.ps1` 注册为任务计划程序任务（操作为 `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <脚本路径>`，登录时触发、禁止重复实例、失败每分钟重试）；升级后用 `scripts/restart-studio-windows.ps1` 在没有活动任务时重启。

**升级。** `public/` 下的前端文件按请求读取，同步到位即生效；`src/` 的改动需要在每台机器上重启。

## Artifact 与批注

让 agent 做网页或应用时，它会维护项目根目录的 `studio.artifacts.json`：

```json
{
  "artifacts": [
    { "key": "game", "name": "点击目标", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

静态页面省略 `command`、`port`、`dataPaths`。每个 Artifact 有独立、持久的预览端口和 origin；预览里的 `localStorage` 会落盘到项目并随之同步，一台机器上存的游戏进度在另一台继续。后端是普通的本地进程（不是沙箱），通过 `PORT` 和 `HOST` 启动；「数据快照」停止后端并复制声明的数据路径，「恢复」把它们放回去。

在预览里*选取元素、文字或 Canvas 区域*写下批注，它会成为你选定 agent 的任务，选区作为证据（DOM 路径、引用文字或 Canvas 的 PNG）。同一个 Artifact 的批注顺序执行，不同 Artifact 和对话并行。示例见 `examples/persistent-game/`（Node 后端 + SQLite + Canvas）和 `examples/artifact-compatibility/`。

## 文件与配置

| 位置 | 内容 |
| --- | --- |
| `projects/<id>/` | 项目工作目录：代码、Artifact、数据（随同步） |
| `projects/<id>/.studio/events/` | 权威、不可变的对话日志 |
| `projects/<id>/.studio/state.json`、`history-index.md`、`sessions/`、`artifacts/` | 可重建的状态与供 agent 阅读的历史 |
| `projects/<id>/.studio/artifact-storage/`、`snapshots/`、`attachments/` | 同步的预览存档、数据快照、批注证据 |
| `projects/<id>/uploads/` | 聊天和资源栏上传的文件 |
| `projects/.servers/` | 各服务器的公共地址，用于自动发现（不含秘密） |
| `~/.studio-local/` | 机器私有：身份、`accounts.json`、`accounts/<id>/`、配对、Tailscale 设置——不要同步 |
| `~/.studio-local/agent-profiles.json` | 可选：按 CLI 家族（`claude`、`codex`）或账号 id 覆盖可执行文件路径／环境变量 |

## 常见问题

**它会用我的 API key 吗？** 只有你添加 API key 账号时才会。订阅账号走 CLI 自己的登录，Studiolo 不保存任何自己的凭据。

**会影响我终端里的 `claude`／`codex` 吗？** 不会。Studiolo 的账号在自己的目录里；`~/.claude`、`~/.codex` 只在创建账号时读一次，用来复制设置和链接 skills。

**这是沙箱吗？** 不是。agent 和 Artifact 后端都是以你的权限运行的本地进程，和终端里的 CLI 一样。

**手机能用吗？** 能，通过 Tailscale 作为浏览器客户端；CLI 运行在你的电脑上。

**为什么零依赖？** 服务端是纯 Node.js（ESM，只用 `node:` 模块），Node 22 能跑的地方都能跑，供应链里没有任何东西隔在你和你的 CLI 之间。

## 许可证

MIT，见 [LICENSE](LICENSE)。
