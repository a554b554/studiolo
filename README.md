# Studiolo

Self-hosted, multi-machine workbench for CLI coding agents. It drives the `claude` and `codex` CLIs that are already logged in on your computers (no API keys), keeps every project's conversation history as a synchronized journal that each machine serves as a peer (no central server), runs the web apps your agents build as "Artifacts" with persistent backends, and lets you comment on page content directly in the preview so an agent picks the comment up as a task. Interface in Chinese and English. Node.js 22.14+, zero npm dependencies.

个人自托管 AI 工作台。通过本机已登录的 `claude`、`claude1`、`claude2`、`codex` CLI 工作（不需要 API key）；每个项目的对话记录以事务日志保存在项目目录里，随 Syncthing 等文件同步工具到达每台电脑，每台电脑各自运行一个对等服务；可运行带后端和持久数据的网页 Artifact，并在预览里对网页内容发送批注，交给 agent 执行。

## 它和"又一个 CLI 网页界面"的区别

- **无中心的多机架构**：每台电脑运行同一个服务，项目目录（含 `.studio/` 对话记录）通过 Syncthing 同步。历史是不可变事务日志，离线修改可确定性合并；在线服务器之间还会直接交换日志加速同步。任何一台电脑都能查看全部对话，执行始终在对话绑定的那台电脑上进行。
- **用自己的 CLI 订阅**：所有请求走本机 CLI 进程，凭据由各 CLI 自己管理；支持多个 Claude 账号（独立配置目录）和 Codex 并行，并按账号显示额度。
- **Artifact 工作流**：agent 生成的静态网页或带 Node 后端的应用直接登记、在隔离端口预览、localStorage 自动落盘并随项目同步，支持数据快照与恢复。
- **页面内批注**：在预览里选取元素、文字或 Canvas 区域，带证据发出评论，进入该 Artifact 的 agent 队列顺序执行；批注历史跨机共享。
- **网页端批准**：原生 CLI 需要人工批准时，在网页里批准或拒绝并继续同一次执行。

## 启动

需要 Node.js **22.14 或更高版本**，以及已在当前电脑登录的 CLI。没有必须安装的 npm 依赖。

```sh
node src/server.mjs
```

打开 <http://127.0.0.1:4310>。4311 保留为预览入口；每个 Artifact 分配独立、持久的预览端口。按 Ctrl+C 停止平台及其子进程；活动任务标记中断，不自动重放。测试：`node --test test/*.test.mjs`。

支持的环境变量：`STUDIO_STATE_DIR`（机器私有状态目录，默认 `~/.studio-local`）、`STUDIO_BIND`、`STUDIO_PORT`、`STUDIO_PREVIEW_PORT`、`STUDIO_TOKEN`、`STUDIO_UPLOAD_LIMIT`（单文件上传上限，字节，默认 100 MB）。每个 stateDir 仅运行一个服务。

## CLI 账号与模型

服务固定提供四个入口：`claude`、`claude1`、`claude2`、`codex`。`claude` 和 `codex` 直接使用 PATH 上的同名可执行文件；`claude1`、`claude2` 是同一个 `claude` 可执行文件配合独立的配置目录（默认 `~/.claude1`、`~/.claude2`，通过 `CLAUDE_CONFIG_DIR` 传入），用于登录第二、第三个 Claude 账号。找不到可执行文件的入口会在界面里标为不可用，不影响其他入口。

在 `STUDIO_STATE_DIR/agent-profiles.json` 中可以按入口覆盖设置，这个文件只属于本机，不要放进同步目录：

```json
{
  "claude": { "command": "/opt/homebrew/bin/claude", "label": "Claude 主账号" },
  "claude1": { "configDir": "/Users/me/.claude-work" },
  "claude2": { "models": [] },
  "codex": {
    "command": "codex",
    "args": [],
    "env": { "CODEX_HOME": "/Users/me/.codex" },
    "models": [{ "id": "gpt-6.1-sol", "label": "GPT-6.1-Sol", "efforts": ["low", "medium", "high"], "defaultEffort": "medium" }]
  }
}
```

字段：`command`（可执行文件名或绝对路径）、`args`（附加参数数组）、`env`（附加环境变量）、`configDir`（仅 `claude1`、`claude2`）、`models`（允许的模型列表，`[]` 表示禁用该入口）、`label`（界面显示名）。Codex 未覆盖 `models` 时读取 `~/.codex/models_cache.json` 中的可见模型；`claude1`、`claude2` 只能使用内置 Claude 模型列表。文件修改后立即生效，不需要重启。

## 使用

点击顶部「＋ 新建项目」，填写名称；点击项目旁的 `+` 直接创建会话。新对话首条消息选择执行电脑、CLI 账号和模型，提交后这三项固定；同一项目的不同对话可以在不同电脑同时执行。reasoning effort 和权限可逐条调整。默认"自动审核"显式启用 Claude auto 或 Codex auto_review；不会永久修改原生 CLI 配置。原生 CLI 需要人工批准时，聊天和 Artifact 页面显示具体操作，可"批准本次／拒绝"并继续同一次执行。

左下角「账号额度」显示当前服务电脑上的四个 CLI 账号：Claude1／Claude2 显示五小时剩余额度，Claude／Codex 显示周剩余额度。点击 ↻ 重新读取；点击「详细 Usage」查看所有账号的额度窗口、重置时间、套餐、额外额度和可用重置次数（以账号实际返回为准）。页面首次打开读取一次，普通读取缓存 60 秒，手动刷新最短间隔 5 秒；不轮询、不发送模型消息。通过 Claude 原生 `get_usage` 和 Codex `account/rateLimits/read` 查询，凭据仍由各 CLI 管理。查询失败保留带时间戳的旧数据或显示不可用。旧版 CLI 若不支持该查询，需要升级对应 CLI。

项目固定保存在平台目录的 `projects/<项目ID>/` 下，创建时自动建文件夹，不接受自定义路径。代码、Artifact、持久数据与 `.studio/` 对话记录一起通过你的文件同步目录同步。服务启动和运行期间会自动发现这些项目；每台电脑根据自己的平台目录计算路径，不需要手动关联。机器身份、主机配对令牌和 CLI 登录仍只保存在本机，不随项目同步。

聊天窗口和「项目资源」栏都支持上传文件：点击输入框旁的 📎 或资源栏的「＋ 上传文件」选择文件，或直接从系统文件管理器拖放到聊天区域或资源栏。所有上传统一保存到项目的 `uploads/` 文件夹，同名文件自动加 ` (2)`、` (3)` 后缀而不覆盖已有文件，文件名只保留最后一段并去掉 Windows 与 Syncthing 不能存储的字符；不支持上传文件夹。拖放或通过 📎 添加到聊天的文件先上传，再以附件标签显示在输入框上方，随本条消息一起发送；agent 在本次请求的提示词中收到这些文件的项目相对路径，消息记录和 `.studio/sessions/*.md` 也保留附件列表。附件保存在当前浏览器所连接的服务器上；若对话绑定在另一台电脑执行，agent 需要等待文件同步送达（提示词中已说明）。

新会话首轮回复成功后，会用该轮选定的 CLI 账号和模型单独生成一句简短标题，消耗少量额度；生成在后台进行，不占用会话队列，不添加隐藏会话消息。生成失败或超时则使用首条消息的简短摘录。对话旁的 `⋯` →「重命名」可保存 1–120 字符的自定义标题，手动名称不会被自动标题覆盖；名称同步显示在侧栏、聊天顶部和历史导出中。

## Tailscale 与其他电脑

本机可启用持久的 Tailscale Serve 转发：在机器私有的 `STUDIO_STATE_DIR` 保存 `tailnet.json`，内容为 `{"enabled":true,"command":"tailscale"}`，并在同目录 `access-token.txt` 保存至少 32 字符的随机访问令牌。Windows 可将 command 设为 Tailscale 可执行文件的绝对路径。这两个文件不要放进同步目录。

启用后正常运行 `node src/server.mjs` 即可：服务仍只监听回环地址，启动时自动检查并建立主页面端口的 `tailscale serve --bg --tcp` 转发；每个 Artifact 启动时也自动转发其独立预览端口。已有端口转发必须指向本服务，否则报错，不覆盖其他服务，也不启用 Funnel。用 `http://<本机 Tailscale 名称或 IP>:4310` 访问，首次在网页登录上述访问令牌。聊天、SSE 实时输出、权限批准、文件、额度和 Artifact 使用相同接口；浏览器不需安装 CLI。Tailscale 必须已登录并在线，访问设备也需获 tailnet 策略允许。Serve 的后台配置可跨 Tailscale 重启保留；这不等于自动启动 Studio 本身。

如果整个 tailnet 都可信，可在 `tailnet.json` 中设置 `"trustTailnet":true`。此模式不需要访问令牌，允许本机及发往本机 Tailscale IP／名称的内网转发连接；监听必须保持 `127.0.0.1`，未知 Host 仍被拒绝，跨站操作仍检查 Origin，不开启公网 Funnel。启动时从本机 Tailscale 状态读取允许的地址，需要 Tailscale 已连接。

不使用 Serve 时也可以直接监听 Tailscale 地址。每台执行电脑分别安装 Node 和需要使用的 CLI，完成该机登录，保留独立的 `STUDIO_STATE_DIR`，以该机的 Tailscale IPv4 地址绑定服务，并设一个自己生成的长随机访问令牌：

```sh
export STUDIO_BIND='你的 Tailscale IPv4 地址'
export STUDIO_TOKEN='你生成的长随机令牌'
node src/server.mjs
```

Windows PowerShell 用 `$env:STUDIO_BIND` 和 `$env:STUDIO_TOKEN`。从电脑或手机打开 `http://该机Tailscale地址:4310`，输入令牌。预览需要浏览器能访问执行机上每个 Artifact 的独立端口；端口保存在机器私有的 `preview-ports.json`，状态 API 的 `previewPort` 也会返回它。防火墙规则应限定在自己的 Tailscale 网络，包含管理端口和所需预览端口。无需公开互联网入口。当前使用直接 HTTP over Tailscale，未验收反向代理的 HTTPS 配置。跨主机 HTTP iframe 若被浏览器的第三方 Cookie 规则拦截，可用"在执行电脑打开"进入该机工作台登录后预览。

可信 Tailscale 服务器会通过 `projects/.servers/` 中的公共地址自动发现彼此；不在该目录保存令牌。也可在「设置」中手动配对地址；采用令牌认证时填写令牌，可信 Tailscale 模式可留空。同一个 `projects/` 同步到各电脑后会自动登记，项目稳定 ID 会复用；Windows 与 Mac 的平台绝对路径可以不同。项目没有独占执行机。每台服务器读取同一份项目历史，并通过在线服务器之间的事务交换加速同步。下拉框只列出在线且协议兼容的服务器；已有对话的执行机离线时历史仍可阅读，但不能改绑或执行。新建对话可以选择另一台在线电脑。

原生 CLI 会话始终在绑定机器上继续；不会自动迁移进程或私有 CLI 文件。旧对话根据最后一次执行记录保留原来的机器、账号和模型。手机仅作为浏览器访问在线电脑。

## 开机自启与升级

**macOS**：运行 `node scripts/install-studio-macos.mjs` 安装当前用户登录启动服务，并立即启动。需要已连接的 Tailscale 和已登录的 CLI。机器配置保存在 `~/.studio-local`；LaunchAgent 为 `~/Library/LaunchAgents/net.studio-local.server.plist`。日志在 `~/.studio-local/server.stdout.log` 和 `server.stderr.log`。Tailscale 暂未就绪时，launchd 间隔重试。重启：`launchctl kickstart -k gui/$(id -u)/net.studio-local.server`。

**Windows**：`scripts/start-studio-windows.ps1` 是适合注册为任务计划程序的启动脚本：以当前用户、非管理员身份隐藏运行，使用文件锁并检查已有 4310 服务，不会重复拉起；日志在 `~/.studio-local/autostart.log` 和 `server-*.stdout.log` / `server-*.stderr.log`。建议的任务设置：用户登录后延迟约 30 秒触发、禁止重复实例、失败每分钟重试、不设运行时长限制。平台目录移动后需更新任务路径。`scripts/restart-studio-windows.ps1` 会先确认没有活动任务，再通过该计划任务重启服务。

**多服务器升级**：等待代码同步到各电脑，确认没有活动任务后重启对应服务。`/api/identity` 应返回 `protocol: 2`；服务器选择器不会列出仍运行旧协议的进程。`public/` 下的前端文件按请求从磁盘读取，同步完成即生效；`src/` 的改动需要重启。

## 多服务器行为

每个服务器地址展示共同的项目、对话和 Artifact 列表，手动登记和清单登记的 Artifact 都使用同步的项目记录。清单先到、页面目录后到时仍展示 Artifact；启动前显示等待同步，同步完成后直接启动，无需重新登记。Artifact 的启动、停止、预览和数据快照在当前浏览器地址所指向的服务器执行。批注历史共享，批注执行队列按 Artifact 和服务电脑分别排队。批注和回复固定由当前 Artifact 网页服务器上的 CLI 执行。

历史同步不等于通用文件数据库合并：代码和 Artifact 数据仍由文件同步工具同步。两个 agent 同时修改同一个普通文件，或两个 Artifact 后端同时写同一数据库，仍需应用自身的并发/复制机制；平台不会合并数据库内部事务。新服务器首次使用项目须先完成项目文件的同步。已有但尚未发送的草稿对话由创建服务器协调首次绑定；该服务器离线时可在在线服务器新建对话。

## Artifact 与批注

请求 agent 生成网页时，它会收到 `studio.artifacts.json` 清单格式说明。项目根目录清单示例：

```json
{
  "artifacts": [
    {
      "key": "game",
      "name": "点击目标",
      "root": "game",
      "entry": "index.html",
      "command": ["node", "server.mjs"],
      "port": 4320,
      "dataPaths": ["game/data"]
    }
  ]
}
```

静态 HTML 省略 command、port、dataPaths。静态页面以及后端 HTML 在 Studio 预览里使用的 localStorage 自动保存到项目 `.studio/artifact-storage/<ArtifactID>/`；不需要为该存档添加 dataPaths。首次打开会导入这个浏览器之前的 localStorage，已有共享值和已删除键不会被旧值覆盖。独立存档记录随项目同步，双方修改不同键可以合并，同键冲突采用确定性顺序；不是对存档字符串内部的业务合并。页面显示"存档已保存到项目"表示当前服务器已落盘，不表示已同步到另一台。短暂断网时待保存操作留在浏览器并重试，刷新、停止和创建快照会先等待当前预览保存。每个 Artifact 当前存档上限 5 MiB；sessionStorage、IndexedDB、Cookie 和第三方服务数据不自动同步。后端持久数据必须使用项目内相同的相对路径，避免主机名、用户目录或临时目录；普通数据库仍需停写后等待同步再换机运行。root 相对于项目目录；command 是直接执行的 argv 数组，工作目录为 root，不经过 shell。后端使用环境变量 PORT 和 HOST（127.0.0.1）。dataPaths 相对于**项目目录**，应覆盖完整数据库文件及相关日志目录。示例在 `examples/persistent-game/`：真实 Node 后端、SQLite 存档、Canvas 游戏。

清单保存后，项目刷新会自动登记或更新链接；稳定 key 保持 Artifact ID 和批注。删除清单条目不会删除已有 Artifact 或讨论。也可从右侧手动登记。点击链接后，在 Artifact 页启动应用。

"选取内容／文字／框选区域"产生批注证据，按 Escape 退出选取。支持 HTML 元素、SVG、开放 Shadow DOM、文字引用与 Canvas 区域；正常浏览模式保留页面自身交互。Canvas 可导出时附 PNG，保存到项目 `.studio/attachments/`，agent 获得实际图片路径。评论选择 agent 后单条入队；同一 Artifact 的评论顺序执行，不同会话和 Artifact 可以并行。完成不自动解决批注；点击"解决"才结束。定位失败的内容保留在"位置失效"筛选中。

预览保留页面的 DOCTYPE、原有 base、相对链接和根路径资源；支持 ES modules、多页面及静态 SPA 路由刷新。选取控件使用独立 Shadow DOM，与页面样式分离。多标签页共用实时更新连接；不支持 SharedWorker 的浏览器定时同步。兼容样例在 `examples/artifact-compatibility/`。

"数据快照"会停止后端并复制声明的数据路径，同时保存平台托管的 localStorage；纯静态 Artifact 也可创建和恢复存档快照。恢复保留替换前的 `.before-restore-*` 副本，应用保持停止，需重新启动。迁移前先创建快照并等同步完成；异常离线时优先恢复最后一个完整快照，不把仍在写入的数据库副本当作一致备份。当前进程停止以进程树终止为边界，复制完整数据目录；SQLite 恢复已验证，其他数据库需采用该数据库支持的备份／恢复方式。

## 文件与配置

| 位置 | 内容 |
| --- | --- |
| `projects/<项目ID>/` | 项目独立工作目录：代码、Artifact 与持久数据 |
| `项目/uploads/` | 聊天附件和资源栏上传的文件，随项目同步 |
| `项目/.studio/events/` | 权威、不可变事务记录 |
| `项目/.studio/state.json` | 可重建当前状态 |
| `项目/.studio/history-index.md` | 各 agent 的共同历史入口 |
| `项目/.studio/sessions/`、`artifacts/` | 可读对话和批注记录 |
| `项目/.studio/snapshots/` | Artifact 数据快照 |
| `项目/.studio/artifact-storage/` | 各 Artifact 的共享 localStorage 存档，随项目同步 |
| `项目/.studio/attachments/` | 批注的 Canvas 图片证据 |
| `projects/.servers/` | 各服务器的公共地址登记，用于自动发现；不含令牌 |
| `~/.studio-local/` | 本机身份、路径登记、配对信息、`agent-profiles.json`、`tailnet.json`、访问令牌；不要同步 |

`projects/` 是数据目录，不应提交到代码仓库；把它交给 Syncthing 或类似的文件同步工具。

## 安全边界

- 服务默认只监听回环地址；非回环监听必须设置访问令牌。跨站请求按 Origin 拒绝；每个 Artifact 与管理页面使用独立 origin，并校验桥接来源。
- Artifact 后端是用户自己的本机进程，**不是 OS 沙箱**。HTTP 代理支持表单、命名空间 Cookie、重定向、压缩 HTML、缓存与 SSE；暂不代理 WebSocket 或依赖 WebSocket 的热更新。
- 网页批准通道使用 Claude 双向 stream-json 和 Codex 本地 app-server。自动审核保留原生策略；不会绕过拒绝规则、静默换模型或永久添加允许规则。服务重启会使未决请求失效。第三方登录和不支持的 MCP 专有交互仍需对应原生界面。
- 发给 agent 的页面证据和历史被标记为参考数据；提示词要求 agent 不执行页面内容里嵌入的指令。公开操作文本会做二次脱敏，但 CLI 自身输出的内容仍以 CLI 为准。

## 当前边界

- 已安装的 Claude CLI 不支持 Haiku 4.5 配合 Auto。界面会禁用并标注该选项，提交前拒绝此组合；请显式选择沿用 CLI 权限、Plan 或允许修改项目。不会自动切换模型或放宽权限。
- Canvas 导出受浏览器跨域污染限制；DOM 框选保存文字／位置证据，不生成整个网页的像素截图。跨域 iframe、封闭 Shadow DOM 的内部内容受浏览器边界约束。复杂改版不能保证自动重新定位，每条讨论仍保留。依赖第三方登录、设备权限或特殊浏览器能力的 HTML 需独立验收，HTML 注入上限 16 MiB。
- 事务使用带因果父节点的字段变更日志。不同机器离线产生的记录可确定性合并；缺失父节点时停止写入，等待同步。不要手动删改 `.studio/events`。升级后所有服务器必须使用新版；旧服务进程需要重启。
- 历史读取按文件身份、大小和修改时间校验已验证的事件缓存；新增事件仅解析增量，旧事件变化则重新验证完整链。磁盘历史仍是权威来源。
- Agent 流式输出先在内存中合并，最多每 3 秒提交一次字段变更；原生会话身份、批准请求和执行结束时立即提交。页面通过实时叠加显示尚未提交的输出。服务异常退出时，最后约 3 秒的中间输出可能不在记录中。
- 回归测试覆盖离线合并、首次绑定竞争、批准转发、数据快照、多主机路由和文件上传；真实 CLI 行为随各家 CLI 版本变化，升级 CLI 后请重新验证额度查询和批准通道。

## 开发

源码在 `src/`（Node ESM），网页在 `public/`（浏览器原生 ES modules，无构建步骤），测试在 `test/`（`node:test`，启动临时实例，不占用 4310/4311）。`node --check src/server.mjs` 做语法检查，`node --test test/*.test.mjs` 运行全部测试。
