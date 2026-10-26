<div align="center">

[English](../../README.md) · **简体中文** · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### 把你付费的每一个 coding agent CLI、每一台电脑，放进同一个工作台。

**在浏览器里和 Claude Code、Codex 对话，账号、机器和项目历史在你的所有电脑之间共享。**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![零 npm 依赖](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![测试](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![许可证：MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[快速开始](#快速开始) · [账号](#账号与登录) · [像 CLI 一样对话](#像-cli-一样对话) · [子代理](#子代理与账号路由) · [多机器](#多机器) · [Artifact](#artifact-与批注) · [常见问题](#常见问题)

</div>

![Studiolo：在本地工作站上与一个 Claude 账号对话，左侧为账号额度，右侧为项目文件和 Artifact](../../docs/screenshot.png)

> 截图为合成演示：虚构的账号、脚本化的回复。

---

## 用 coding agent 安装

把这段话发给能在目标机器上执行命令的 Claude Code、Codex 或其他 coding agent：

```text
从 https://github.com/a554b554/studiolo 安装 Studiolo：克隆仓库，确认有 Node.js 22.14+，并且已安装 `claude` 和/或 `codex` CLI，在仓库根目录运行 `node src/server.mjs`，确认 http://127.0.0.1:4310 能正常响应，然后提醒我打开「设置 → 主机与账号」登录我的账号。不要自己替我登录任何账号。
```

或者手动安装：

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo 没有 npm 依赖，不需要 `npm install`。测试：`node --test test/*.test.mjs`。

---

## 它是什么

Studiolo 是一个自托管的网页工作台，驱动的是你电脑上已经装好的 **Claude Code** 和 **Codex** CLI，不是又一个套 API key 的聊天界面：

- **用你的订阅、你的 CLI。** 每个请求都经过真实的 `claude` 或 `codex` 进程——工具、skills、MCP 服务器、权限模式和 agent 行为与终端完全一致。每个账号可选订阅登录或 API key。
- **账号按机器管理，由 Studiolo 负责。** 在浏览器里为每台电脑登录多个 Claude、Codex 账号。每个账号有独立的 CLI 配置目录，绝不碰你个人的 `~/.claude`、`~/.codex`。所有账号的额度实时显示。
- **一份项目历史，跨机器共享。** 项目放在你自己同步的文件夹里（例如 Syncthing）。对话记录是只追加、可确定性合并的日志；每台电脑运行同一个服务、提供同一份历史。对话在你为它选定的机器上执行，在任何一台电脑上都能阅读和继续。
- **终端体验，在浏览器里。** Esc 停止一轮、在 agent 运行中发消息插话、输入 `/` 使用 CLI 自己的斜杠命令——全部映射到原生协议，不是重新实现。
- **跨账号的子代理。** agent 可以把任务交给本机已登录的任何其他账号——Codex 调用 Claude、Claude 调用 Codex——作为一次性子代理运行，由你在设置里编辑的规则和实时额度决定路由。
- **Artifact 与页面内批注。** agent 做出的网页应用作为 Artifact 运行，支持持久后端和同步存储；在预览里选中内容，直接作为任务交给 agent。

---

## 快速开始

1. **准备**：Node.js 22.14+，以及机器上已安装的 `claude` 和／或 `codex` CLI（`claude --version`、`codex --version`）。
2. **运行** `node src/server.mjs`，打开 <http://127.0.0.1:4310>。
3. **添加账号**：设置 → *主机与账号* → *添加账号*。选择机器、类型（Claude Code／Codex）和登录方式，按页面提示完成（见下文）。
4. **新建项目、开始对话**：输入框依次选择 **机器 → 账号 → 模型 → effort → 权限模式**。首条消息固定该对话的机器和账号；模型、effort 和权限可逐条调整。换成其他模型时继续同一个原生会话，切换后的第一轮没有 prompt 缓存，会重新读取全部上下文。

环境变量：`STUDIO_STATE_DIR`（机器私有状态目录，默认 `~/.studio-local`）、`STUDIO_BIND`、`STUDIO_PORT`（4310）、`STUDIO_PREVIEW_PORT`（4311）、`STUDIO_TOKEN`、`STUDIO_UPLOAD_LIMIT`（字节，默认 100 MB）。每个状态目录只运行一个服务。

---

## 账号与登录

账号属于某一台机器，在浏览器里创建。每个账号是 `~/.studio-local/accounts/<id>/` 下的一个目录，作为 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME` 使用，因此同一个 CLI 的多个账号可以共存，而你终端自己的登录完全不受影响。创建账号时，Studiolo 会从默认 CLI 目录初始化该目录：复制 `settings.json`／`CLAUDE.md`（Codex 为 `config.toml`／`AGENTS.md`），链接 `skills`、`plugins` 等目录，让 agent 保留你已有的 skills 和 MCP 服务器。凭据永远不复制。

| 类型 | 方式 | 流程 |
| --- | --- | --- |
| Claude Code | **订阅登录** | Studiolo 运行 `claude auth login`：打开链接登录，把授权码粘贴回网页。 |
| Claude Code | **Anthropic API key** | key 保存在账号目录（权限 0600），以 `ANTHROPIC_API_KEY` 传入；通过 CLI 握手验证，被拒绝即丢弃。按用量计费，没有额度窗口。 |
| Codex | **ChatGPT 登录** | 通过 Codex app-server 的设备码登录：网页显示链接和一次性代码，在任意浏览器完成登录，完成后页面自动更新。 |
| Codex | **OpenAI API key** | 由 Codex 自己保存在该账号的 `CODEX_HOME`。 |

登录成功后，Studiolo 直接从 CLI 读取账号身份（邮箱、套餐）和模型列表——不消耗任何模型请求——Claude 账号还会读取 CLI 的斜杠命令列表用于输入框补全。没有自定义名称的账号会自动改名为邮箱，于是输入框、对话标题、每条回复和额度面板都能看出是谁在说话。账号可以重命名、刷新、退出登录（`claude auth logout`／`codex logout`）或移除；绑定到已移除账号的对话可以改用同一台机器上的其他账号继续。

左下角额度面板跟随输入框选中的机器：Claude 订阅显示五小时窗口，Codex 显示周窗口，API key 账号按用量计费。它读取 CLI 自己的用量接口（`get_usage`、`account/rateLimits/read`），缓存 60 秒，从不轮询，也不会为未登录账号启动 CLI。

以上对远程机器同样适用：在 *主机与账号* 里选择另一台在线主机，请求会被转发过去。

---

## 像 CLI 一样对话

每个对话拥有一个常驻的原生进程——Claude Code 走双向 `stream-json`，Codex 走 `app-server`——所以 agent 的行为和终端里一模一样。网页控件映射到原生协议：

| 终端里 | Studiolo 里 | 实现 |
| --- | --- | --- |
| Esc 停止 | **■ 停止** 或在输入框按 Esc | Claude `interrupt` 控制请求／Codex `turn/interrupt`。进程和原生会话保留，已输出的部分回复保存，后续消息继续同一会话。 |
| agent 工作时继续输入 | 执行中发送 = **插话** | Claude 在下一次工具调用边界读到它；Codex `turn/steer`。显示为 *你 · 插话*，回复另起一段继续。**排队** 则等本轮结束再发送。 |
| `/compact`、`/context`、自定义命令、skills | 输入 `/` 弹出命令列表 | Claude 命令原样透传（列表来自 CLI 本身）。Codex 没有文本命令，`/compact`、`/review`、`/skills`、`/mcp` 映射为 app-server 请求。 |
| — | `/model`、`/effort`、`/mode`、`/rename`、`/new`、`/status`、`/clear`、`/stop`、`/help` | 平台命令，由浏览器或队列处理。 |

CLI 在终端里会询问的权限请求会出现在页面上：批准本次或拒绝，同一次执行继续。Auto 模式就是 CLI 自己的（Claude `auto`、Codex `auto_review`）；Studiolo 从不添加绕过参数，也不写入永久允许规则。同一对话内模型和推理 effort 可以逐条切换（Claude `set_model`／`apply_flag_settings`，Codex `turn/start` 参数）。

---

## 子代理与账号路由

agent 在对话里可以把任务交给本机已登录的任何其他账号——Claude Code 或 Codex——作为一次性子代理运行：Codex 会话可以调用 Claude 子代理，反之亦然，也可以把工作分散到多个账号的额度上。这与 CLI 自带的子代理工具（始终用对话所用的账号）并存。

- **启动器** `scripts/subagent.mjs`：`node scripts/subagent.mjs --account "<名称或 id>" --model <模型 id> [--effort …] [--permissions auto|project-write|read-only] [--cwd <目录>] [--timeout <秒>] [--verbose] "<任务>"`（任务也可从 stdin 传入）。它读取本机 `~/.studio-local/accounts.json`，用该账号的配置目录和与网页聊天相同的 CLI 参数一次性运行 `claude -p`／`codex exec`，把最终回答打印到 stdout，一行摘要（账号、模型、tokens）打印到 stderr；退出码 0 完成、3 停在无人回答的权限请求、其余失败。`--list` 列出本机账号及当前额度和路由规则。模型可用别名片段（如 `haiku`、`sonnet-5-5`）；权限默认 auto，不支持 auto 的模型退到 project-write。
- **共享知识注入**（`src/subagents.mjs`、`src/context.mjs`）：每个新对话首轮的平台提示附带一段「Subagents」说明——启动器用法、本机可用账号（名称、id、CLI、套餐、额度、模型列表）和路由规则，并要求 agent 在用户点名账号或模型时照办，否则按规则和额度选择并告知用了哪个账号。额度取额度面板的缓存（不等待 CLI），过期时在后台刷新。规则或账号列表变化时，进行中的对话在下一条消息再次收到这段说明；仅额度变化不触发重发。斜杠命令和标题生成不附带。
- **设置 → 子代理**：开关、路由规则文本框、「恢复默认」「保存规则」，以及本机将注入的提示词预览。默认规则：较小的模型优先用团队或备用账号；高端模型留在主账号；首选账号任一额度窗口剩余不足 30% 时改用主账号；消息里点名账号或模型时以消息为准。规则保存在 `projects/.studio-settings.json`，随项目目录同步到每台电脑；账号列表和额度由各电脑运行时附加。接口 `GET`／`PUT /api/settings/subagents`。

子代理不继承对话上下文，也无人回答它的提问，agent 需在任务里写清文件和期望输出；它消耗所运行账号的额度，与聊天选择的账号无关。

---

## 多机器

在每台电脑上运行同一个服务，把 `projects/` 放进你同步的文件夹（Syncthing 或任何文件同步工具）。每个项目的 `.studio/events/` 是不可变、按因果顺序排列的日志；在线的机器之间还会直接交换日志，改动几秒内可见。任何机器都能显示所有对话；执行始终发生在对话绑定的机器上，原生 CLI 会话从不迁移。

**访问其他机器。** 最简单安全的方式是 [Tailscale](https://tailscale.com)：在状态目录放 `tailnet.json`（`{"enabled":true,"command":"tailscale"}`）和一个随机的 `access-token.txt`（≥ 32 字符），正常启动，Studiolo 会用 `tailscale serve` 发布端口；打开 `http://<machine>:4310` 输入一次令牌即可。设置 `"trustTailnet":true` 后，tailnet 内的访问不再需要令牌。不用 Tailscale 时，用 `STUDIO_BIND` 绑定内网地址并设置 `STUDIO_TOKEN`。服务器通过 `projects/.servers/` 互相发现，也可在设置中手动配对。

**开机自启。** macOS：`node scripts/install-studio-macos.mjs` 安装 LaunchAgent（`net.studio-local.server`）。Windows：把 `scripts/start-studio-windows.ps1` 注册为任务计划程序任务（操作为 `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`，登录时运行、禁止重复实例、每分钟重试）；升级后，`scripts/restart-studio-windows.ps1` 会在没有活动任务时重启它。

**升级。** `public/` 下的前端文件按请求读取，同步到位即生效；`src/` 下的改动需要在每台机器上重启。

---

## Artifact 与批注

让 agent 做网页或应用时，它会维护项目根目录的 `studio.artifacts.json`：

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

静态页面省略 `command`、`port` 和 `dataPaths`。每个 Artifact 有独立、持久的预览端口和 origin；预览里的 `localStorage` 会持久化到项目并随之同步，一台机器上保存的游戏可以在另一台继续。后端是普通的本地进程（不是沙箱），通过 `PORT` 和 `HOST` 运行；**快照** 停止后端并复制声明的数据路径，**恢复** 把它们放回去。

在预览里*选取元素、文字或 Canvas 区域*写下批注：它会成为你选定 agent 的任务，选区作为证据（DOM 路径、引用文字或 Canvas 的 PNG）。同一个 Artifact 的批注顺序执行，不同 Artifact 和对话并行执行。示例见 `examples/persistent-game/`（Node 后端 + SQLite + Canvas）和 `examples/artifact-compatibility/`。

---

## 文件与配置

| 位置 | 内容 |
| --- | --- |
| `projects/<id>/` | 项目工作目录：代码、Artifact、数据（随同步） |
| `projects/<id>/.studio/events/` | 权威、不可变的对话日志 |
| `projects/<id>/.studio/state.json`、`history-index.md`、`sessions/`、`artifacts/` | 可重建的状态与供 agent 阅读的历史 |
| `projects/<id>/.studio/artifact-storage/`、`snapshots/`、`attachments/` | 同步的预览存储、数据快照、批注证据 |
| `projects/<id>/uploads/` | 拖入聊天或资源栏的文件 |
| `projects/.servers/` | 各服务器的公共地址，用于发现（不含秘密） |
| `projects/.deleted/<id>.json` | 已删除项目的墓碑（随同步）；被迟到的同步重建的目录会再次删除 |
| `projects/.studio-settings.json` | 共享设置：子代理路由规则（随同步） |
| `~/.studio-local/` | 机器私有：身份、`accounts.json`、`accounts/<id>/`、配对、Tailscale 设置——不要同步 |
| `~/.studio-local/agent-profiles.json` | 可选：按 CLI 家族（`claude`、`codex`）或账号 id 指定可执行文件路径／环境变量 |

删除项目是永久删除（归档仍可恢复），有排队、执行或等待中的任务时会被拒绝。执行删除的服务器先写墓碑，再删除整个 `projects/<id>/` 文件夹；你的同步工具把两者带到其他机器。每台服务器看到新墓碑后，删除本机的残留副本、该项目的常驻 agent 进程和 Artifact 预览端口，以及工作目录在该项目内的 Claude 记录（各配置目录下的 `projects/<encoded path>*`）和 Codex rollout（按首行的 `cwd` 匹配）。处理过的 ID 记录在 `~/.studio-local/purged-projects.json`。旧版本软删除的项目（`deletedAt`）在启动时一次性删除。

---

## 常见问题

**它会用我的 API key 吗？** 只有你添加 API key 账号时才会。订阅账号走 CLI 自己的登录，Studiolo 不保存任何自己的凭据。

**会影响我终端里的 `claude`／`codex` 吗？** 不会。Studiolo 的账号在自己的目录里；`~/.claude`、`~/.codex` 只读一次，用来复制设置和链接 skills。

**这是沙箱吗？** 不是。agent 和 Artifact 后端都是以你的权限运行的本地进程，和终端里的 CLI 完全一样。

**手机能用吗？** 能，通过 Tailscale 作为浏览器客户端使用；CLI 运行在你的电脑上。

**为什么零依赖？** 服务端是纯 Node.js（ESM，只用 `node:` 模块），Node 22 能跑的地方都能跑，供应链里没有任何东西隔在你和你的 CLI 之间。

---

## 许可证

MIT，见 [LICENSE](../../LICENSE)。
