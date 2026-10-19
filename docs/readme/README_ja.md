<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · **日本語** · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### 契約しているすべてのコーディングエージェント CLI を、手元のすべてのマシンで、ひとつのワークベンチに。

**ブラウザから Claude Code や Codex とチャット。アカウント、マシン、プロジェクト履歴はすべてのコンピューター間で共有されます。**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![npm 依存パッケージなし](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![テスト](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![ライセンス: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[クイックスタート](#クイックスタート) · [アカウント](#アカウントとサインイン) · [CLI と同じ感覚でチャット](#cli-と同じ感覚でチャット) · [複数マシン](#複数マシン) · [Artifact](#artifact-とページ内コメント) · [FAQ](#faq)

</div>

![Studiolo: ローカルのワークステーション上で Claude アカウントと会話している画面。左にアカウントの使用量、右にプロジェクトのファイルと Artifact](../../docs/screenshot.png)

> スクリーンショットは合成デモです。アカウントは架空のもので、返信はスクリプトによるものです。

---

## コーディングエージェントでインストール

使いたいマシン上でコマンドを実行できる Claude Code、Codex、またはその他のコーディングエージェントに、次の文章を貼り付けてください。

```text
https://github.com/a554b554/studiolo から Studiolo をインストールしてください。リポジトリをクローンし、Node.js 22.14 以上が使えること、`claude` と `codex` の CLI のどちらか（または両方）がインストールされていることを確認したうえで、リポジトリのルートで `node src/server.mjs` を実行し、http://127.0.0.1:4310 が応答することを確認してください。そのあと、Settings → Hosts & accounts を開いて自分のアカウントにサインインするよう私に伝えてください。あなた自身ではどのアカウントにもサインインしないでください。
```

手動でインストールする場合:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo には npm の依存パッケージがないため、`npm install` は不要です。テスト: `node --test test/*.test.mjs`。

---

## Studiolo とは

Studiolo は、コンピューターにすでにインストールされている **Claude Code** と **Codex** の CLI を動かす、セルフホスト型の Web ワークベンチです。API キーの上に載せただけのチャット UI とは違います。

- **自分のサブスクリプション、自分の CLI。** すべてのリクエストは本物の `claude` または `codex` プロセスを通じて実行されます。ツール、skills、MCP サーバー、権限モード、エージェントの挙動はターミナルとまったく同じです。サブスクリプションでのサインインか API キーかは、アカウントごとに選べます。
- **アカウントはマシンごとに Studiolo が管理。** 各コンピューターで複数の Claude / Codex アカウントにブラウザからサインインできます。アカウントごとに独立した CLI 設定ディレクトリが割り当てられ、個人の `~/.claude` や `~/.codex` には一切触れません。すべてのアカウントのクォータがリアルタイムで表示されます。
- **マシンをまたいだひとつのプロジェクト履歴。** プロジェクトは好きな方法（たとえば Syncthing）で同期するフォルダーに置きます。会話履歴は追記専用のジャーナルで、決定的にマージされます。すべてのマシンで同じサーバーが動き、同じ履歴を提供します。会話は指定したマシン上で実行され、どのマシンからでも閲覧・継続できます。
- **ターミナルの操作感をブラウザで。** Esc でターンを停止、実行中のエージェントにフォローアップメッセージで軌道修正、`/` で CLI 本来のスラッシュコマンド。すべてネイティブのプロトコルに対応付けられており、再実装ではありません。
- **Artifact とページ内コメント。** エージェントが作った Web アプリは、永続的なバックエンドと同期されるストレージを備えた Artifact として動作します。プレビュー内で何かを選択し、そのままタスクとしてエージェントに送れます。

---

## クイックスタート

1. **前提条件** — Node.js 22.14 以上と、マシンにインストールされた `claude` と `codex` のいずれか（または両方）の CLI（`claude --version`、`codex --version`）。
2. `node src/server.mjs` を**実行**し、<http://127.0.0.1:4310> を開きます。
3. **アカウントを追加** — Settings → *Hosts & accounts* → *Add account*。マシン、種類（Claude Code / Codex）、サインイン方法を選び、表示される手順に従います（後述）。
4. **プロジェクトを作成して会話を開始** — 入力欄で **マシン → アカウント → モデル → effort → 権限モード** を選びます。最初のメッセージでその会話のマシン、アカウント、モデルが固定されます。effort と権限はメッセージごとに変更できます。

環境変数: `STUDIO_STATE_DIR`（マシン固有の状態、既定値 `~/.studio-local`）、`STUDIO_BIND`、`STUDIO_PORT`（4310）、`STUDIO_PREVIEW_PORT`（4311）、`STUDIO_TOKEN`、`STUDIO_UPLOAD_LIMIT`（バイト単位、既定値 100 MB）。ひとつの状態ディレクトリにつきサーバーはひとつです。

---

## アカウントとサインイン

アカウントはマシンに属し、ブラウザから作成します。各アカウントは `~/.studio-local/accounts/<id>/` 配下のディレクトリで、`CLAUDE_CONFIG_DIR` または `CODEX_HOME` として使われます。そのため同じ CLI の複数アカウントを共存させられ、ターミナル側のサインインには一切影響しません。アカウント作成時、Studiolo は既定の CLI ディレクトリからそのディレクトリを初期化します。`settings.json` / `CLAUDE.md`（Codex では `config.toml` / `AGENTS.md`）をコピーし、`skills` や `plugins` などをリンクするので、エージェントはすでに使っている skills や MCP サーバーをそのまま利用できます。認証情報がコピーされることはありません。

| 種類 | 方法 | 流れ |
| --- | --- | --- |
| Claude Code | **サブスクリプション** | Studiolo が `claude auth login` を実行します。リンクを開いてサインインし、認可コードをページに貼り付けます。 |
| Claude Code | **Anthropic API キー** | キーはアカウントディレクトリに保存され（モード 0600）、`ANTHROPIC_API_KEY` として渡されます。CLI のハンドシェイクで検証され、拒否された場合は破棄されます。従量課金で、クォータの時間枠はありません。 |
| Codex | **ChatGPT** | Codex app-server 経由のデバイスコード方式です。ページにリンクとワンタイムコードが表示されるので、任意のブラウザでサインインすると、完了時にページが更新されます。 |
| Codex | **OpenAI API キー** | Codex 自身がアカウントの `CODEX_HOME` に保存します。 |

サインイン後、Studiolo はアカウントの ID 情報（メールアドレス、プラン）とモデル一覧を CLI から直接読み取ります。モデルへのリクエストは一切消費しません。Claude の場合は、入力欄の補完用に CLI のスラッシュコマンドも読み取ります。独自の名前が付いていないアカウントはメールアドレスに名前が変更されるため、入力欄、会話ヘッダー、各返信、使用量パネルのどこでも誰が話しているかがわかります。アカウントは名前の変更、更新、サインアウト（`claude auth logout` / `codex logout`）、削除ができます。アカウントが削除された会話は、同じマシン上の別のアカウントで続けられます。

使用量パネル（左下）は入力欄で選ばれたマシンに連動します。Claude のサブスクリプションは 5 時間枠、Codex は週単位の枠を表示し、API キーのアカウントは使用量に応じて課金されます。パネルは CLI 自身の使用量エンドポイント（`get_usage`、`account/rateLimits/read`）を読み取り、60 秒間キャッシュします。ポーリングは行わず、サインアウトしたアカウントのために CLI を起動することもありません。

これらはすべてリモートマシンでも動作します。*Hosts & accounts* で別のオンラインホストを選ぶと、リクエストがそのホストに中継されます。

---

## CLI と同じ感覚でチャット

各会話は常駐するネイティブプロセスを持ちます。Claude Code は双方向の `stream-json`、Codex は `app-server` を介して動作するため、エージェントはターミナルとまったく同じように振る舞います。Web の操作はネイティブのプロトコルに対応付けられています。

| ターミナルでは | Studiolo では | 仕組み |
| --- | --- | --- |
| Esc で停止 | **■ Stop** または入力欄で Esc | Claude の `interrupt` コントロールリクエスト / Codex の `turn/interrupt`。プロセスとネイティブセッションは維持され、途中までの返信も残ります。以降のメッセージは同じセッションを続けます。 |
| エージェントの作業中に入力 | ターン実行中に送信 = **Steer** | Claude は次のツール呼び出しの区切りで読み取ります。Codex は `turn/steer`。*You · steer* と表示され、返信は新しいセグメントで続きます。**Queue** を使うとターン終了後に送信されます。 |
| `/compact`、`/context`、カスタムコマンド、skills | `/` を入力するとコマンド一覧 | Claude のコマンドはそのまま渡されます（一覧は CLI 自身から取得）。Codex にはテキストコマンドがないため、`/compact`、`/review`、`/skills`、`/mcp` は app-server リクエストに対応付けられます。 |
| — | `/model`、`/effort`、`/mode`、`/rename`、`/new`、`/status`、`/clear`、`/stop`、`/help` | ブラウザまたはキューが処理するプラットフォームコマンドです。 |

CLI がターミナルで尋ねるはずの権限リクエストはページ上に表示されます。今回のみ許可するか拒否すると、同じ実行がそのまま続きます。Auto モードは CLI 自身のもの（Claude の `auto`、Codex の `auto_review`）です。Studiolo がバイパス用のフラグや恒久的な許可ルールを追加することはありません。推論の effort とモデルは、会話の途中でもメッセージごとに変更できます（Claude の `set_model` / `apply_flag_settings`、Codex の `turn/start` パラメーター）。

---

## 複数マシン

すべてのコンピューターで同じサーバーを動かし、`projects/` を同期するフォルダー（Syncthing や任意のファイル同期ツール）に置きます。各プロジェクトの `.studio/events/` は不変で因果順序付きのジャーナルです。オンラインのマシン同士はジャーナルを直接やり取りもするので、変更は数秒以内に反映されます。どのマシンでもすべての会話を表示できますが、実行は常に会話が紐付けられたマシンで行われ、ネイティブの CLI セッションが移動することはありません。

**他のマシンへの接続。** 最も簡単で安全なのは [Tailscale](https://tailscale.com) を使う方法です。状態ディレクトリに `tailnet.json`（`{"enabled":true,"command":"tailscale"}`）とランダムな `access-token.txt`（32 文字以上）を置いて通常どおり起動すると、Studiolo が `tailscale serve` でポートを公開します。`http://<machine>:4310` を開き、トークンを一度入力すれば完了です。`"trustTailnet":true` を指定すると、tailnet 内からのアクセスではトークンが省略されます。Tailscale を使わない場合は、`STUDIO_BIND` でプライベートアドレスにバインドし、`STUDIO_TOKEN` を設定してください。サーバー同士は `projects/.servers/` を通じて、または Settings での手動ペアリングによって互いを検出します。

**自動起動。** macOS: `node scripts/install-studio-macos.mjs` で LaunchAgent（`net.studio-local.server`）がインストールされます。Windows: `scripts/start-studio-windows.ps1` をタスク スケジューラのタスクとして登録します（操作は `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`、ログオン時に実行、重複インスタンスなし、1 分ごとに再試行）。アップグレード後は、実行中の処理がなくなった時点で `scripts/restart-studio-windows.ps1` が再起動します。

**アップグレード。** `public/` 配下のフロントエンドファイルはリクエストごとに読み込まれるため、同期された時点で反映されます。`src/` 配下の変更は、すべてのマシンで再起動が必要です。

---

## Artifact とページ内コメント

エージェントに Web ページやアプリを頼むと、プロジェクトのルートにある `studio.artifacts.json` をエージェントが管理します。

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

静的ページでは `command`、`port`、`dataPaths` を省略します。各 Artifact には専用の永続的なプレビューポートとオリジンが割り当てられます。プレビューの `localStorage` はプロジェクト内に永続化されて同期されるため、あるマシンでセーブしたゲームを別のマシンで続けられます。バックエンドは `PORT` と `HOST` を受け取る通常のローカルプロセスとして動作します（サンドボックスではありません）。**Snapshot** はバックエンドを停止して宣言されたデータパスをコピーし、**Restore** はそれを元に戻します。

プレビューで*要素、テキスト、またはキャンバスの領域を選択*してコメントを書くと、選択したエージェントへのタスクになり、選択内容が根拠として添付されます（DOM パス、引用テキスト、またはキャンバスの PNG）。ひとつの Artifact へのコメントは順番に実行され、異なる Artifact や会話は並行して実行されます。`examples/persistent-game/`（Node バックエンド + SQLite + Canvas）と `examples/artifact-compatibility/` を参照してください。

---

## ファイルと設定

| 場所 | 内容 |
| --- | --- |
| `projects/<id>/` | プロジェクトの作業ディレクトリ: コード、Artifact、データ（同期対象） |
| `projects/<id>/.studio/events/` | 正となる不変の会話ジャーナル |
| `projects/<id>/.studio/state.json`、`history-index.md`、`sessions/`、`artifacts/` | 再構築可能な状態と、エージェント向けの読みやすい履歴 |
| `projects/<id>/.studio/artifact-storage/`、`snapshots/`、`attachments/` | 同期されるプレビューストレージ、データのスナップショット、コメントの根拠 |
| `projects/<id>/uploads/` | チャットやリソースペインにドロップされたファイル |
| `projects/.servers/` | 検出用のサーバーの公開アドレス（秘密情報は含まない） |
| `projects/.deleted/<id>.json` | 削除されたプロジェクトのトゥームストーン（同期対象）。遅れて届いた同期で再作成されたフォルダーは再び削除される |
| `~/.studio-local/` | マシン固有: ID、`accounts.json`、`accounts/<id>/`、ペアリング、Tailscale の設定 — 絶対に同期しないこと |
| `~/.studio-local/agent-profiles.json` | 任意: CLI ファミリー（`claude`、`codex`）またはアカウント id ごとの実行ファイルパス / 環境変数 |

プロジェクトの削除は永続的で（アーカイブは元に戻せます）、キュー待ち・実行中・待機中の作業がある間は拒否されます。削除を行うサーバーはまずトゥームストーンを書き込み、続いて `projects/<id>/` フォルダー全体を削除します。両方とも同期ツールによって他のマシンへ運ばれます。各サーバーは新しいトゥームストーンを検出すると、残っているコピー、そのプロジェクトの常駐エージェントプロセスと Artifact のプレビューポート、そして作業ディレクトリがプロジェクト内にあった Claude のトランスクリプト（各設定ディレクトリの `projects/<encoded path>*`）と Codex の rollout（1 行目の `cwd` で照合）を削除します。処理済みの ID は `~/.studio-local/purged-projects.json` に記録されます。旧バージョンでソフト削除されたプロジェクト（`deletedAt`）は、起動時に一度だけ削除されます。

---

## FAQ

**API キーは使われますか？** API キーのアカウントを追加した場合のみです。サブスクリプションのアカウントは CLI 自身のサインインで動作し、Studiolo が独自に認証情報を保存することはありません。

**ターミナルの `claude` / `codex` に影響はありますか？** ありません。Studiolo のアカウントは専用のディレクトリにあり、`~/.claude` と `~/.codex` は設定のコピーと skills のリンクのために一度読み取られるだけです。

**これはサンドボックスですか？** いいえ。エージェントも Artifact のバックエンドも、ターミナルの CLI とまったく同じく、あなたの権限で動くローカルプロセスです。

**スマートフォンから使えますか？** はい。Tailscale 経由のブラウザクライアントとして使えます。CLI はあなたのコンピューター上で動作します。

**なぜ依存パッケージがゼロなのですか？** サーバーは素の Node.js（ESM、`node:` モジュールのみ）なので、Node 22 が動く場所ならどこでも動き、サプライチェーン上のものがあなたと CLI の間に入り込むこともありません。

---

## ライセンス

MIT — [LICENSE](../../LICENSE) を参照してください。
