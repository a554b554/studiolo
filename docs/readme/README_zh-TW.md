<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · **繁體中文** · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### 把你付費使用的每一個 coding agent CLI、每一台電腦，整合進同一個工作台。

**在瀏覽器裡與 Claude Code、Codex 對話，帳號、機器與專案歷史在你所有的電腦之間共享。**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![零 npm 相依套件](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![測試](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![授權條款：MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[快速開始](#快速開始) · [帳號](#帳號與登入) · [像 CLI 一樣對話](#像-cli-一樣對話) · [多台機器](#多台機器) · [Artifact](#artifact-與頁面內註解) · [常見問題](#常見問題)

</div>

![Studiolo：在本機工作站上與一個 Claude 帳號對話，左側為帳號用量，右側為專案檔案與 Artifact](../../docs/screenshot.png)

> 截圖為合成示範：虛構的帳號、預先寫好的回覆。

---

## 用 coding agent 安裝

把以下內容貼給能在目標機器上執行指令的 Claude Code、Codex 或其他 coding agent：

```text
從 https://github.com/a554b554/studiolo 安裝 Studiolo：複製（clone）儲存庫，確認已有 Node.js 22.14+，並且已安裝 `claude` 和/或 `codex` CLI，在儲存庫根目錄執行 `node src/server.mjs`，確認 http://127.0.0.1:4310 有回應，然後提醒我開啟「Settings → Hosts & accounts」登入我的帳號。不要自行替我登入任何帳號。
```

或手動安裝：

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo 沒有任何 npm 相依套件，不需要執行 `npm install`。測試：`node --test test/*.test.mjs`。

---

## 這是什麼

Studiolo 是一個自行架設的網頁工作台，驅動的是你電腦上已經安裝好的 **Claude Code** 與 **Codex** CLI，而不是又一個包裝 API 金鑰的聊天介面：

- **你的訂閱、你的 CLI。** 每個請求都經由真正的 `claude` 或 `codex` 行程執行——工具、skills、MCP 伺服器、權限模式與 agent 行為都和終端機完全相同。每個帳號可自行選擇訂閱登入或 API 金鑰。
- **帳號依機器管理，由 Studiolo 負責。** 從瀏覽器在每台電腦上登入多個 Claude 與 Codex 帳號。每個帳號都有獨立的 CLI 設定目錄，絕不會動到你個人的 `~/.claude` 或 `~/.codex`。每個帳號的用量額度即時顯示。
- **一份專案歷史，跨機器共享。** 專案放在你用任何方式同步的資料夾中（例如 Syncthing）。對話紀錄是只能附加、可確定性合併的日誌；每台機器執行同一個伺服器、提供同一份歷史。對話在你為它選定的機器上執行，你可以在任何一台機器上閱讀並接續。
- **終端機體驗，搬進瀏覽器。** 按 Esc 停止一輪、在 agent 執行中傳送後續訊息加以引導、輸入 `/` 使用 CLI 本身的斜線指令——全部對應到原生協定，而非重新實作。
- **Artifact 與頁面內註解。** agent 建立的網頁應用程式以 Artifact 形式執行，具備持久化後端與同步儲存空間；在預覽中選取內容，即可作為任務交給 agent。

---

## 快速開始

1. **事前準備**——Node.js 22.14+，以及機器上已安裝的 `claude` 和/或 `codex` CLI（`claude --version`、`codex --version`）。
2. **執行** `node src/server.mjs`，然後開啟 <http://127.0.0.1:4310>。
3. **新增帳號**——Settings → *Hosts & accounts* → *Add account*。選擇機器、類型（Claude Code／Codex）與登入方式，再依照畫面上的步驟操作（見下文）。
4. **建立專案、開始對話**——輸入框依序選擇 **機器 → 帳號 → 模型 → effort → 權限模式**。第一則訊息會固定該對話的機器、帳號與模型；effort 與權限可以逐則訊息調整。

環境變數：`STUDIO_STATE_DIR`（機器私有狀態，預設為 `~/.studio-local`）、`STUDIO_BIND`、`STUDIO_PORT`（4310）、`STUDIO_PREVIEW_PORT`（4311）、`STUDIO_TOKEN`、`STUDIO_UPLOAD_LIMIT`（位元組，預設 100 MB）。每個狀態目錄只能執行一個伺服器。

---

## 帳號與登入

帳號隸屬於某一台機器，並從瀏覽器建立。每個帳號是 `~/.studio-local/accounts/<id>/` 底下的一個目錄，作為 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME` 使用，因此同一個 CLI 的多個帳號可以並存，而你終端機本身的登入狀態完全不受影響。建立帳號時，Studiolo 會以你預設的 CLI 目錄初始化該目錄——複製 `settings.json`／`CLAUDE.md`（Codex 為 `config.toml`／`AGENTS.md`），並連結 `skills`、`plugins` 等目錄——讓 agent 保留你已在使用的 skills 與 MCP 伺服器。憑證永遠不會被複製。

| 類型 | 方式 | 流程 |
| --- | --- | --- |
| Claude Code | **訂閱** | Studiolo 執行 `claude auth login`；你開啟連結、登入，再把授權碼貼回網頁。 |
| Claude Code | **Anthropic API 金鑰** | 金鑰儲存在帳號目錄中（權限 0600），以 `ANTHROPIC_API_KEY` 傳入；透過 CLI 交握驗證，遭拒絕即捨棄。依用量計費，沒有額度時段。 |
| Codex | **ChatGPT** | 透過 Codex app-server 的裝置代碼登入：網頁顯示連結與一次性代碼；在任何瀏覽器登入，完成後網頁會自動更新。 |
| Codex | **OpenAI API 金鑰** | 由 Codex 自行儲存在該帳號的 `CODEX_HOME` 中。 |

登入後，Studiolo 直接從 CLI 讀取帳號身分（電子郵件、方案）與模型清單——不會消耗任何模型請求——Claude 帳號還會讀取 CLI 的斜線指令，供輸入框自動完成使用。沒有自訂名稱的帳號會自動以電子郵件命名，因此輸入框、對話標題、每則回覆與用量面板都能看出是誰在說話。帳號可以重新命名、重新整理、登出（`claude auth logout`／`codex logout`）或移除；若對話所用的帳號已被移除，可改用同一台機器上的其他帳號繼續。

用量面板（左下角）會跟隨輸入框中選擇的機器：Claude 訂閱顯示 5 小時時段，Codex 顯示每週時段，API 金鑰帳號則依用量計費。它讀取 CLI 本身的用量端點（`get_usage`、`account/rateLimits/read`），快取 60 秒，從不輪詢，也絕不會為已登出的帳號啟動 CLI。

以上功能同樣適用於遠端機器：在 *Hosts & accounts* 中選擇另一台在線的主機，請求就會轉送過去。

---

## 像 CLI 一樣對話

每個對話都擁有一個常駐的原生行程——Claude Code 透過雙向 `stream-json`，Codex 透過 `app-server`——因此 agent 的行為與在終端機中完全相同。網頁上的控制項對應到原生協定：

| 在終端機中 | 在 Studiolo 中 | 實作方式 |
| --- | --- | --- |
| 按 Esc 停止 | **■ Stop** 或在輸入框按 Esc | Claude `interrupt` 控制請求／Codex `turn/interrupt`。行程與原生工作階段都會保留；已產生的部分回覆會留存；之後的訊息會延續同一個工作階段。 |
| agent 工作時繼續輸入 | 在一輪執行中傳送 = **Steer** | Claude 會在下一個工具呼叫的邊界讀取；Codex 使用 `turn/steer`。顯示為 *You · steer*；回覆會在新的段落中接續。**Queue** 則改為在這一輪結束後才傳送。 |
| `/compact`、`/context`、自訂指令、skills | 輸入 `/` 顯示指令清單 | Claude 指令原封不動傳遞（清單來自 CLI 本身）。Codex 沒有文字指令；`/compact`、`/review`、`/skills`、`/mcp` 會對應為 app-server 請求。 |
| — | `/model`、`/effort`、`/mode`、`/rename`、`/new`、`/status`、`/clear`、`/stop`、`/help` | 平台指令，由瀏覽器或佇列處理。 |

CLI 原本會在終端機中詢問的權限請求會顯示在網頁上：核准這一次或拒絕，同一次執行便會繼續。Auto 模式就是 CLI 本身的模式（Claude `auto`、Codex `auto_review`）；Studiolo 從不加入略過權限的旗標，也不會寫入永久允許規則。在同一個對話中，推理 effort 與模型都可以逐則訊息變更（Claude `set_model`／`apply_flag_settings`，Codex `turn/start` 參數）。

---

## 多台機器

在每台電腦上執行同一個伺服器；把 `projects/` 放進你同步的資料夾（Syncthing 或任何檔案同步工具）。每個專案的 `.studio/events/` 是不可變、依因果順序排列的日誌；在線的機器之間也會直接交換日誌，因此變更會在數秒內出現。任何一台機器都能顯示所有對話；執行永遠發生在對話所綁定的機器上，原生 CLI 工作階段從不搬移。

**連線到其他機器。** 最簡單又安全的設定方式是 [Tailscale](https://tailscale.com)：在狀態目錄中放入 `tailnet.json`（`{"enabled":true,"command":"tailscale"}`）以及一個隨機的 `access-token.txt`（≥ 32 個字元），照常啟動，Studiolo 就會透過 `tailscale serve` 公開它的連接埠；開啟 `http://<machine>:4310` 並輸入一次權杖即可。設定 `"trustTailnet":true` 後，來自 tailnet 的連線可略過權杖。不使用 Tailscale 時，請用 `STUDIO_BIND` 綁定私有位址並設定 `STUDIO_TOKEN`。伺服器會透過 `projects/.servers/` 互相探索，也可以在 Settings 中手動配對。

**開機自動啟動。** macOS：`node scripts/install-studio-macos.mjs` 會安裝一個 LaunchAgent（`net.studio-local.server`）。Windows：將 `scripts/start-studio-windows.ps1` 註冊為工作排程器的工作（動作為 `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`，登入時執行、不允許重複執行個體、每分鐘重試）；升級後，`scripts/restart-studio-windows.ps1` 會在沒有進行中的執行時重新啟動它。

**升級。** `public/` 底下的前端檔案在每次請求時讀取，同步完成即生效；`src/` 底下的變更則需要在每台機器上重新啟動。

---

## Artifact 與頁面內註解

請 agent 製作網頁或應用程式時，它會在專案根目錄維護 `studio.artifacts.json`：

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

靜態網頁可省略 `command`、`port` 與 `dataPaths`。每個 Artifact 都有自己的持久預覽連接埠與 origin；預覽中的 `localStorage` 會持久保存到專案中並同步，因此在一台機器上儲存的遊戲可以在另一台機器上繼續。後端以一般的本機行程執行（不是沙箱），並帶有 `PORT` 與 `HOST`；**Snapshot** 會停止後端並複製宣告的資料路徑，**Restore** 則將它們放回原處。

在預覽中*選取元素、文字或 Canvas 區域*並撰寫註解：它會成為你所選 agent 的任務，並附上選取內容作為佐證（DOM 路徑、引用文字或 Canvas 的 PNG）。同一個 Artifact 的註解依序執行；不同的 Artifact 與對話則平行執行。請參考 `examples/persistent-game/`（Node 後端 + SQLite + Canvas）與 `examples/artifact-compatibility/`。

---

## 檔案與設定

| 位置 | 內容 |
| --- | --- |
| `projects/<id>/` | 專案工作目錄：程式碼、Artifact、資料（會同步） |
| `projects/<id>/.studio/events/` | 權威、不可變的對話日誌 |
| `projects/<id>/.studio/state.json`、`history-index.md`、`sessions/`、`artifacts/` | 可重建的狀態，以及供 agent 閱讀的歷史 |
| `projects/<id>/.studio/artifact-storage/`、`snapshots/`、`attachments/` | 同步的預覽儲存空間、資料快照、註解佐證 |
| `projects/<id>/uploads/` | 拖放到聊天或資源窗格中的檔案 |
| `projects/.servers/` | 各伺服器用於探索的公開位址（不含機密） |
| `projects/.deleted/<id>.json` | 已刪除專案的墓碑標記（會同步）；因延遲同步而被重新建立的資料夾會再次移除 |
| `~/.studio-local/` | 機器私有：身分、`accounts.json`、`accounts/<id>/`、配對、Tailscale 設定——切勿同步 |
| `~/.studio-local/agent-profiles.json` | 選用：依 CLI 系列（`claude`、`codex`）或帳號 id 指定執行檔路徑／環境變數 |

刪除專案是永久性的（封存仍可復原），且在有工作排隊、執行中或等待中時會被拒絕。執行刪除的伺服器會先寫入墓碑標記，再移除整個 `projects/<id>/` 資料夾；你的同步工具會把兩者帶到其他機器。每台伺服器在看到新的墓碑標記時，會移除本機殘留的副本、該專案的常駐 agent 行程與 Artifact 預覽連接埠，以及工作目錄位於該專案內的 Claude 對話紀錄（各設定目錄中的 `projects/<encoded path>*`）與 Codex rollout（依第一行的 `cwd` 比對）。已處理的 ID 會記錄在 `~/.studio-local/purged-projects.json`。舊版本以軟刪除方式處理的專案（`deletedAt`）會在啟動時一次性移除。

---

## 常見問題

**它會使用我的 API 金鑰嗎？** 只有在你新增 API 金鑰帳號時才會。訂閱帳號透過 CLI 本身的登入機制運作；Studiolo 不會儲存任何自己的憑證。

**會影響我終端機裡的 `claude`／`codex` 嗎？** 不會。Studiolo 的帳號存放在各自的目錄中；`~/.claude` 與 `~/.codex` 只會被讀取一次，用來複製設定與連結 skills。

**這是沙箱嗎？** 不是。agent 與 Artifact 後端都是以你的權限執行的本機行程，就和終端機中的 CLI 一樣。

**可以用手機操作嗎？** 可以，透過 Tailscale 作為瀏覽器用戶端使用；CLI 則在你的電腦上執行。

**為什麼零相依套件？** 伺服器是純 Node.js（ESM，只使用 `node:` 模組），因此任何能執行 Node 22 的地方都能執行，供應鏈中也沒有任何東西夾在你與你的 CLI 之間。

---

## 授權條款

MIT——請參閱 [LICENSE](../../LICENSE)。
