<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · **한국어** · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### 비용을 내고 쓰는 모든 코딩 에이전트 CLI를, 가진 모든 컴퓨터에서, 하나의 워크벤치로.

**브라우저에서 Claude Code, Codex와 채팅하세요. 계정, 머신, 프로젝트 기록이 모든 컴퓨터 사이에서 공유됩니다.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![npm 의존성 0개](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![테스트](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![라이선스: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[빠른 시작](#빠른-시작) · [계정](#계정과-로그인) · [CLI처럼 채팅](#cli처럼-채팅) · [멀티 머신](#멀티-머신) · [Artifact](#artifact와-페이지-내-댓글) · [FAQ](#faq)

</div>

![Studiolo: 로컬 워크스테이션에서 Claude 계정과 대화하는 화면. 왼쪽은 계정 사용량, 오른쪽은 프로젝트 파일과 Artifact](../../docs/screenshot.png)

> 스크린샷은 합성 데모입니다. 계정은 가상이며, 답변은 미리 작성된 것입니다.

---

## 코딩 에이전트로 설치

사용하려는 머신에서 명령을 실행할 수 있는 Claude Code, Codex 또는 다른 코딩 에이전트에 다음 내용을 붙여 넣으세요.

```text
https://github.com/a554b554/studiolo 에서 Studiolo를 설치해 줘. 저장소를 클론하고, Node.js 22.14 이상을 사용할 수 있는지, `claude` 및/또는 `codex` CLI가 설치되어 있는지 확인한 뒤, 저장소 루트에서 `node src/server.mjs`를 실행하고, http://127.0.0.1:4310 이 응답하는지 확인해. 그다음 Settings → Hosts & accounts를 열어 내 계정에 로그인하라고 알려 줘. 어떤 계정에도 직접 로그인하지 마.
```

직접 설치하려면:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo에는 npm 의존성이 없으므로 `npm install`이 필요하지 않습니다. 테스트: `node --test test/*.test.mjs`.

---

## Studiolo 소개

Studiolo는 컴퓨터에 이미 설치된 **Claude Code**와 **Codex** CLI를 구동하는 셀프 호스팅 웹 워크벤치입니다. API 키 위에 얹은 또 하나의 채팅 UI가 아닙니다.

- **내 구독, 내 CLI.** 모든 요청은 실제 `claude` 또는 `codex` 프로세스를 통해 실행됩니다. 도구, skills, MCP 서버, 권한 모드, 에이전트 동작이 터미널과 똑같습니다. 구독 로그인과 API 키 중 무엇을 쓸지는 계정마다 선택할 수 있습니다.
- **머신별 계정을 Studiolo가 관리.** 브라우저에서 각 컴퓨터에 여러 Claude, Codex 계정으로 로그인할 수 있습니다. 계정마다 격리된 CLI 설정 디렉터리가 주어지며, 개인 `~/.claude`나 `~/.codex`는 전혀 건드리지 않습니다. 모든 계정의 할당량이 실시간으로 표시됩니다.
- **머신 간에 하나의 프로젝트 기록.** 프로젝트는 원하는 방식(예: Syncthing)으로 동기화하는 폴더에 둡니다. 대화 기록은 추가 전용 저널이며 결정적으로 병합됩니다. 모든 머신이 같은 서버를 실행하고 같은 기록을 제공합니다. 대화는 지정한 머신에서 실행되며, 어느 머신에서든 읽고 이어갈 수 있습니다.
- **터미널 경험을 브라우저에서.** Esc로 턴을 중지하고, 실행 중인 에이전트에 후속 메시지로 방향을 바꾸고, `/`를 입력해 CLI 자체의 슬래시 명령을 사용합니다. 모두 다시 구현한 것이 아니라 네이티브 프로토콜에 매핑됩니다.
- **Artifact와 페이지 내 댓글.** 에이전트가 만든 웹 앱은 영구 백엔드와 동기화된 저장소를 갖춘 Artifact로 실행됩니다. 미리보기에서 무언가를 선택해 작업으로 에이전트에게 보낼 수 있습니다.

---

## 빠른 시작

1. **사전 요구 사항** — Node.js 22.14 이상, 그리고 머신에 설치된 `claude` 및/또는 `codex` CLI(`claude --version`, `codex --version`).
2. `node src/server.mjs`를 **실행**하고 <http://127.0.0.1:4310>을 엽니다.
3. **계정 추가** — Settings → *Hosts & accounts* → *Add account*. 머신, 종류(Claude Code / Codex), 로그인 방식을 고른 뒤 화면에 표시되는 단계를 따릅니다(아래 참고).
4. **프로젝트를 만들고 대화 시작** — 입력창에서 **머신 → 계정 → 모델 → effort → 권한 모드**를 선택합니다. 첫 메시지가 해당 대화의 머신과 계정을 고정하며, 모델, effort, 권한은 메시지마다 바꿀 수 있습니다. 다른 모델로 바꿔도 같은 네이티브 세션이 이어지고, 바꾼 뒤 첫 턴은 프롬프트 캐시 없이 컨텍스트를 다시 읽습니다.

환경 변수: `STUDIO_STATE_DIR`(머신 전용 상태, 기본값 `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT`(4310), `STUDIO_PREVIEW_PORT`(4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT`(바이트, 기본값 100 MB). 상태 디렉터리 하나당 서버 하나만 실행합니다.

---

## 계정과 로그인

계정은 머신에 속하며 브라우저에서 생성합니다. 각 계정은 `~/.studio-local/accounts/<id>/` 아래의 디렉터리로, `CLAUDE_CONFIG_DIR` 또는 `CODEX_HOME`으로 사용됩니다. 따라서 한 CLI의 여러 계정이 공존할 수 있고, 터미널 자체의 로그인은 전혀 영향을 받지 않습니다. 계정을 만들 때 Studiolo는 기본 CLI 디렉터리를 바탕으로 그 디렉터리를 초기화합니다. `settings.json` / `CLAUDE.md`(Codex는 `config.toml` / `AGENTS.md`)를 복사하고 `skills`, `plugins` 등을 링크하므로, 에이전트는 이미 쓰고 있는 skills와 MCP 서버를 그대로 사용합니다. 자격 증명은 절대 복사되지 않습니다.

| 종류 | 방식 | 진행 과정 |
| --- | --- | --- |
| Claude Code | **구독** | Studiolo가 `claude auth login`을 실행합니다. 링크를 열어 로그인한 뒤 인증 코드를 페이지에 다시 붙여 넣습니다. |
| Claude Code | **Anthropic API 키** | 키는 계정 디렉터리에 저장되고(모드 0600) `ANTHROPIC_API_KEY`로 전달됩니다. CLI 핸드셰이크로 검증되며, 거부되면 폐기됩니다. 사용한 만큼 과금되며 할당량 기간이 없습니다. |
| Codex | **ChatGPT** | Codex app-server를 통한 디바이스 코드 방식입니다. 페이지에 링크와 일회용 코드가 표시되고, 아무 브라우저에서나 로그인하면 완료 시 페이지가 갱신됩니다. |
| Codex | **OpenAI API 키** | Codex가 직접 계정의 `CODEX_HOME`에 저장합니다. |

로그인 후 Studiolo는 계정 정보(이메일, 요금제)와 모델 목록을 CLI에서 바로 읽어 옵니다. 모델 요청은 전혀 소모되지 않습니다. Claude의 경우 입력창 자동 완성을 위해 CLI의 슬래시 명령도 읽어 옵니다. 사용자 지정 이름이 없는 계정은 이메일로 이름이 바뀌므로, 입력창, 대화 헤더, 모든 답변, 사용량 패널에서 누가 말하고 있는지 알 수 있습니다. 계정은 이름 변경, 새로 고침, 로그아웃(`claude auth logout` / `codex logout`), 삭제가 가능합니다. 계정이 삭제된 대화는 같은 머신의 다른 계정으로 이어갈 수 있습니다.

사용량 패널(왼쪽 아래)은 입력창에서 선택한 머신을 따라갑니다. Claude 구독은 5시간 기간을, Codex는 주간 기간을 보여 주며, API 키 계정은 사용량에 따라 과금됩니다. 패널은 CLI 자체의 사용량 엔드포인트(`get_usage`, `account/rateLimits/read`)를 읽고 60초 동안 캐시하며, 폴링하지 않고 로그아웃된 계정을 위해 CLI를 시작하지도 않습니다.

이 모든 기능은 원격 머신에서도 동작합니다. *Hosts & accounts*에서 다른 온라인 호스트를 선택하면 요청이 그 호스트로 중계됩니다.

---

## CLI처럼 채팅

각 대화는 상주하는 네이티브 프로세스를 가집니다. Claude Code는 양방향 `stream-json`, Codex는 `app-server`를 사용하므로 에이전트는 터미널에서와 정확히 똑같이 동작합니다. 웹 컨트롤은 네이티브 프로토콜에 매핑됩니다.

| 터미널에서 | Studiolo에서 | 방식 |
| --- | --- | --- |
| Esc로 중지 | **■ Stop** 또는 입력창에서 Esc | Claude `interrupt` 제어 요청 / Codex `turn/interrupt`. 프로세스와 네이티브 세션은 유지되고, 부분 답변도 보존되며, 이후 메시지는 같은 세션을 이어갑니다. |
| 에이전트가 작업하는 동안 입력 | 턴 실행 중에 전송 = **Steer** | Claude는 다음 도구 호출 경계에서 이를 읽고, Codex는 `turn/steer`를 사용합니다. *You · steer*로 표시되며 답변은 새 세그먼트에서 이어집니다. **Queue**는 대신 턴이 끝난 뒤에 전송합니다. |
| `/compact`, `/context`, 사용자 지정 명령, skills | `/`를 입력하면 명령 목록 | Claude 명령은 그대로 전달됩니다(목록은 CLI 자체에서 가져옴). Codex에는 텍스트 명령이 없어 `/compact`, `/review`, `/skills`, `/mcp`가 app-server 요청에 매핑됩니다. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | 브라우저 또는 큐가 처리하는 플랫폼 명령입니다. |

CLI가 터미널에서 물어볼 권한 요청은 페이지에 표시됩니다. 이번 한 번 승인하거나 거부하면 같은 실행이 계속됩니다. Auto 모드는 CLI 자체의 모드(Claude `auto`, Codex `auto_review`)이며, Studiolo는 우회 플래그나 영구 허용 규칙을 절대 추가하지 않습니다. 추론 effort와 모델은 한 대화 안에서도 메시지마다 바꿀 수 있습니다(Claude `set_model` / `apply_flag_settings`, Codex `turn/start` 매개변수).

턴이 실행되는 동안 대화는 CLI처럼 작업 과정을 보여 줍니다. 단계 사이에 agent가 한 말은 그대로 남고, 연속된 도구 호출은 펼쳐 볼 수 있는 한 줄로 접히며, 진행 중인 단계와 경과 시간이 계속 표시됩니다. 최종 답변이 도착하면 실행 전체가 Raw log로 접힙니다. 보낸 메시지는 즉시 표시되고 백그라운드에서 전달됩니다(실패하면 다시 시도할 수 있음). 사이드바에서는 작업 중인 대화와 프로젝트에 회전 표시가, 아직 보지 않은 결과에 점이 표시됩니다.

---

## 멀티 머신

모든 컴퓨터에서 같은 서버를 실행하고, `projects/`를 동기화하는 폴더(Syncthing 또는 아무 파일 동기화 도구)에 둡니다. 각 프로젝트의 `.studio/events/`는 변경 불가능하고 인과 순서가 보장되는 저널입니다. 온라인 상태인 머신들은 저널을 직접 주고받기도 하므로 변경 사항이 몇 초 안에 나타납니다. 어느 머신에서든 모든 대화를 볼 수 있지만, 실행은 항상 대화가 연결된 머신에서 이루어지며 네이티브 CLI 세션은 다른 머신으로 옮겨지지 않습니다.

**다른 머신에 접속하기.** 가장 간단하고 안전한 구성은 [Tailscale](https://tailscale.com)입니다. 상태 디렉터리에 `tailnet.json`(`{"enabled":true,"command":"tailscale"}`)과 임의의 `access-token.txt`(32자 이상)를 두고 평소처럼 시작하면, Studiolo가 `tailscale serve`로 포트를 공개합니다. `http://<machine>:4310`을 열고 토큰을 한 번 입력하면 됩니다. `"trustTailnet":true`를 설정하면 tailnet 트래픽에서는 토큰을 건너뜁니다. Tailscale 없이 쓰려면 `STUDIO_BIND`로 사설 주소에 바인딩하고 `STUDIO_TOKEN`을 설정하세요. 서버들은 `projects/.servers/`를 통해, 또는 Settings에서 수동으로 페어링하여 서로를 찾습니다.

**자동 시작.** macOS: `node scripts/install-studio-macos.mjs`가 LaunchAgent(`net.studio-local.server`)를 설치합니다. Windows: `scripts/start-studio-windows.ps1`을 작업 스케줄러 작업으로 등록합니다(동작은 `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, 로그온 시 실행, 중복 인스턴스 없음, 1분마다 재시도). 업그레이드 후에는 `scripts/restart-studio-windows.ps1`이 진행 중인 실행이 없을 때 서버를 재시작합니다.

**업그레이드.** `public/` 아래의 프런트엔드 파일은 요청마다 읽히므로 동기화되는 즉시 적용됩니다. `src/` 아래의 변경은 모든 머신에서 재시작해야 합니다.

---

## Artifact와 페이지 내 댓글

에이전트에게 웹 페이지나 앱을 요청하면, 에이전트가 프로젝트 루트의 `studio.artifacts.json`을 관리합니다.

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

정적 페이지는 `command`, `port`, `dataPaths`를 생략합니다. 각 Artifact는 고유한 영구 미리보기 포트와 origin을 갖습니다. 미리보기의 `localStorage`는 프로젝트에 영구 저장되고 동기화되므로, 한 머신에서 저장한 게임을 다른 머신에서 이어서 할 수 있습니다. 백엔드는 `PORT`와 `HOST`를 받는 일반 로컬 프로세스로 실행됩니다(샌드박스가 아닙니다). **Snapshot**은 백엔드를 중지하고 선언된 데이터 경로를 복사하며, **Restore**는 이를 원래대로 되돌립니다.

미리보기에서 *요소, 텍스트 또는 캔버스 영역을 선택*하고 댓글을 작성하면, 선택한 에이전트의 작업이 되며 선택 내용이 근거로 첨부됩니다(DOM 경로, 인용한 텍스트 또는 캔버스의 PNG). 한 Artifact에 달린 댓글은 순서대로 실행되고, 서로 다른 Artifact와 대화는 병렬로 실행됩니다. `examples/persistent-game/`(Node 백엔드 + SQLite + Canvas)과 `examples/artifact-compatibility/`를 참고하세요.

---

## 파일과 설정

| 위치 | 내용 |
| --- | --- |
| `projects/<id>/` | 프로젝트 작업 디렉터리: 코드, Artifact, 데이터(동기화됨) |
| `projects/<id>/.studio/events/` | 기준이 되는 변경 불가능한 대화 저널 |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | 재구성 가능한 상태와 에이전트가 읽을 수 있는 기록 |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | 동기화되는 미리보기 저장소, 데이터 스냅샷, 댓글 근거 |
| `projects/<id>/uploads/` | 채팅이나 리소스 창에 끌어다 놓은 파일 |
| `projects/.servers/` | 탐색용 서버 공개 주소(비밀 정보 없음) |
| `projects/.deleted/<id>.json` | 삭제된 프로젝트의 툼스톤(동기화됨). 늦게 도착한 동기화로 다시 생성된 폴더는 다시 삭제됨 |
| `~/.studio-local/` | 머신 전용: 식별 정보, `accounts.json`, `accounts/<id>/`, 페어링, Tailscale 설정 — 절대 동기화하지 말 것 |
| `~/.studio-local/agent-profiles.json` | 선택 사항: CLI 계열(`claude`, `codex`) 또는 계정 id별 실행 파일 경로 / 환경 변수 |

프로젝트 삭제는 영구적이며(보관은 되돌릴 수 있음), 대기열에 있거나 실행 중이거나 대기 중인 작업이 있으면 거부됩니다. 삭제를 수행하는 서버는 먼저 툼스톤을 쓴 다음 `projects/<id>/` 폴더 전체를 삭제하며, 동기화 도구가 둘 다 다른 머신으로 전달합니다. 각 서버는 새 툼스톤을 발견하면 남아 있는 사본, 해당 프로젝트의 상주 에이전트 프로세스와 Artifact 미리보기 포트, 그리고 작업 디렉터리가 프로젝트 안에 있던 Claude 대화 기록(각 설정 디렉터리의 `projects/<encoded path>*`)과 Codex rollout(첫 줄의 `cwd`로 대조)을 삭제합니다. 처리된 ID는 `~/.studio-local/purged-projects.json`에 기록됩니다. 이전 버전에서 소프트 삭제된 프로젝트(`deletedAt`)는 시작 시 한 번 삭제됩니다.

---

## FAQ

**제 API 키를 사용하나요?** API 키 계정을 추가한 경우에만 사용합니다. 구독 계정은 CLI 자체의 로그인을 통해 실행되며, Studiolo는 자체적으로 자격 증명을 저장하지 않습니다.

**터미널의 `claude` / `codex`에 영향이 있나요?** 없습니다. Studiolo 계정은 별도의 디렉터리에 있으며, `~/.claude`와 `~/.codex`는 설정 복사와 skills 링크를 위해 한 번 읽힐 뿐입니다.

**샌드박스인가요?** 아닙니다. 에이전트와 Artifact 백엔드는 터미널의 CLI와 똑같이 사용자 권한으로 실행되는 로컬 프로세스입니다.

**휴대폰에서도 쓸 수 있나요?** 네, Tailscale을 통해 브라우저 클라이언트로 쓸 수 있습니다. CLI는 컴퓨터에서 실행됩니다.

**왜 의존성이 0개인가요?** 서버는 순수 Node.js(ESM, `node:` 모듈만 사용)라서 Node 22가 돌아가는 곳이면 어디서나 실행되고, 공급망의 어떤 것도 사용자와 CLI 사이에 끼어들지 않습니다.

---

## 라이선스

MIT — [LICENSE](../../LICENSE)를 참고하세요.
