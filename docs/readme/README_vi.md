<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · **Tiếng Việt** · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Một bàn làm việc cho mọi CLI coding agent bạn trả tiền, trên mọi máy bạn sở hữu.

**Trò chuyện với Claude Code và Codex từ trình duyệt, với tài khoản, máy và lịch sử dự án được chia sẻ giữa các máy tính của bạn.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Bắt đầu nhanh](#bắt-đầu-nhanh) · [Tài khoản](#tài-khoản-và-đăng-nhập) · [Trò chuyện như CLI](#trò-chuyện-như-cli) · [Nhiều máy](#nhiều-máy) · [Artifact](#artifact-và-bình-luận-trong-trang) · [Câu hỏi thường gặp](#câu-hỏi-thường-gặp)

</div>

![Studiolo: một cuộc trò chuyện với tài khoản Claude trên máy trạm cục bộ, mức sử dụng tài khoản ở bên trái, tệp dự án và Artifact ở bên phải](../../docs/screenshot.png)

> Ảnh chụp màn hình là bản demo tổng hợp: tài khoản hư cấu, câu trả lời được dựng sẵn.

---

## Cài đặt bằng coding agent

Dán nội dung này vào Claude Code, Codex hoặc bất kỳ coding agent nào có thể chạy lệnh trên máy bạn muốn dùng:

```text
Hãy cài đặt Studiolo từ https://github.com/a554b554/studiolo: clone repository, đảm bảo có sẵn Node.js 22.14+ và đã cài CLI `claude` và/hoặc `codex`, chạy `node src/server.mjs` từ thư mục gốc của repository, xác nhận http://127.0.0.1:4310 phản hồi, rồi bảo tôi mở Settings → Hosts & accounts để đăng nhập các tài khoản của tôi. Không tự đăng nhập bất kỳ tài khoản nào.
```

Hoặc làm thủ công:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo không có phụ thuộc npm; không cần `npm install`. Kiểm thử: `node --test test/*.test.mjs`.

---

## Studiolo là gì

Studiolo là một bàn làm việc web tự host, điều khiển các CLI **Claude Code** và **Codex** đã được cài trên máy tính của bạn. Đây không phải lại một giao diện chat nữa đặt trên API key:

- **Gói đăng ký của bạn, CLI của bạn.** Mọi yêu cầu đều chạy qua tiến trình `claude` hoặc `codex` thật — cùng công cụ, skill, máy chủ MCP, chế độ quyền và hành vi agent như trong terminal. Đăng nhập bằng gói đăng ký hay API key, bạn chọn cho từng tài khoản.
- **Tài khoản theo từng máy, do Studiolo quản lý.** Đăng nhập nhiều tài khoản Claude và Codex trên mỗi máy tính ngay từ trình duyệt. Mỗi tài khoản có thư mục cấu hình CLI riêng, tách biệt; không có gì động đến `~/.claude` hay `~/.codex` cá nhân của bạn. Hạn mức của mọi tài khoản được hiển thị trực tiếp.
- **Một lịch sử dự án trên mọi máy.** Dự án nằm trong một thư mục bạn đồng bộ theo cách bạn muốn (ví dụ Syncthing). Lịch sử trò chuyện là một nhật ký chỉ-ghi-thêm, được hợp nhất một cách tất định; mọi máy chạy cùng một server và phục vụ cùng một lịch sử. Một cuộc trò chuyện được thực thi trên máy bạn chọn cho nó; bạn có thể đọc và tiếp tục nó từ bất kỳ máy nào.
- **Trải nghiệm terminal, ngay trong trình duyệt.** Dừng một lượt bằng Esc, điều hướng agent đang chạy bằng một tin nhắn tiếp theo, gõ `/` để dùng slash command của chính CLI — tất cả được ánh xạ lên giao thức gốc, không phải viết lại.
- **Artifact và bình luận trong trang.** Ứng dụng web do agent xây dựng chạy dưới dạng Artifact với backend lâu dài và bộ lưu trữ được đồng bộ; chọn một thứ trong bản xem trước và gửi nó cho agent như một tác vụ.

---

## Bắt đầu nhanh

1. **Yêu cầu** — Node.js 22.14+, và CLI `claude` và/hoặc `codex` đã được cài trên máy (`claude --version`, `codex --version`).
2. **Chạy** `node src/server.mjs` và mở <http://127.0.0.1:4310>.
3. **Thêm tài khoản** — Settings → *Hosts & accounts* → *Add account*. Chọn máy, loại (Claude Code / Codex) và phương thức đăng nhập, rồi làm theo các bước hiển thị (xem bên dưới).
4. **Tạo dự án, bắt đầu trò chuyện** — khung soạn tin chọn **máy → tài khoản → mô hình → effort → chế độ quyền**. Tin nhắn đầu tiên cố định máy và tài khoản cho cuộc trò chuyện đó; mô hình, effort và quyền có thể thay đổi theo từng tin nhắn. Mô hình mới tiếp tục cùng phiên gốc, và lượt đầu tiên của nó đọc lại ngữ cảnh mà không có bộ nhớ đệm prompt.

Biến môi trường: `STUDIO_STATE_DIR` (trạng thái riêng của máy, mặc định `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (byte, mặc định 100 MB). Mỗi thư mục trạng thái một server.

---

## Tài khoản và đăng nhập

Tài khoản thuộc về một máy và được tạo từ trình duyệt. Mỗi tài khoản là một thư mục trong `~/.studio-local/accounts/<id>/`, được dùng làm `CLAUDE_CONFIG_DIR` hoặc `CODEX_HOME`, nên nhiều tài khoản của cùng một CLI cùng tồn tại và phiên đăng nhập riêng của terminal bạn không bao giờ bị động đến. Khi tạo tài khoản, Studiolo khởi tạo thư mục đó từ thư mục CLI mặc định của bạn — sao chép `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) và liên kết `skills`, `plugins` cùng các mục tương tự — để agent giữ lại các skill và máy chủ MCP bạn đang dùng. Thông tin xác thực không bao giờ được sao chép.

| Loại | Phương thức | Điều gì xảy ra |
| --- | --- | --- |
| Claude Code | **Gói đăng ký** | Studiolo chạy `claude auth login`; bạn mở liên kết, đăng nhập, rồi dán mã ủy quyền trở lại trang. |
| Claude Code | **Anthropic API key** | Key được lưu trong thư mục tài khoản (mode 0600) và truyền dưới dạng `ANTHROPIC_API_KEY`; được xác minh qua bước bắt tay của CLI, bị loại bỏ nếu bị từ chối. Trả theo mức dùng, không có cửa sổ hạn mức. |
| Codex | **ChatGPT** | Mã thiết bị qua Codex app-server: trang hiển thị một liên kết và một mã dùng một lần; đăng nhập từ bất kỳ trình duyệt nào, trang tự cập nhật khi xong. |
| Codex | **OpenAI API key** | Được chính Codex lưu trong `CODEX_HOME` của tài khoản. |

Sau khi đăng nhập, Studiolo đọc danh tính tài khoản (e-mail, gói) và danh sách mô hình trực tiếp từ CLI — không tốn yêu cầu mô hình nào — và với Claude, cả các slash command của CLI để tự động hoàn thành trong khung soạn tin. Tài khoản không có tên tùy chỉnh sẽ được đổi tên thành e-mail của nó, nên khung soạn tin, tiêu đề cuộc trò chuyện, mọi câu trả lời và bảng mức sử dụng đều cho biết ai đang nói. Tài khoản có thể được đổi tên, làm mới, đăng xuất (`claude auth logout` / `codex logout`) hoặc xóa; một cuộc trò chuyện có tài khoản đã bị xóa có thể tiếp tục bằng một tài khoản khác trên cùng máy.

Bảng mức sử dụng (góc dưới bên trái) đi theo máy được chọn trong khung soạn tin: gói đăng ký Claude hiển thị cửa sổ 5 giờ, Codex hiển thị cửa sổ hằng tuần, tài khoản API key được tính phí theo mức dùng. Nó đọc các endpoint mức sử dụng riêng của CLI (`get_usage`, `account/rateLimits/read`), lưu đệm 60 giây, không bao giờ thăm dò định kỳ và không bao giờ khởi động CLI cho tài khoản đã đăng xuất.

Tất cả những điều này cũng hoạt động với máy từ xa: chọn một host khác đang trực tuyến trong *Hosts & accounts* và các yêu cầu sẽ được chuyển tiếp tới đó.

---

## Trò chuyện như CLI

Mỗi cuộc trò chuyện sở hữu một tiến trình gốc thường trú — Claude Code qua `stream-json` hai chiều, Codex qua `app-server` — nên agent hoạt động y hệt như trong terminal. Các điều khiển web được ánh xạ lên giao thức gốc:

| Trong terminal | Trong Studiolo | Cách thức |
| --- | --- | --- |
| Esc để dừng | **■ Stop** hoặc Esc trong khung soạn tin | Yêu cầu điều khiển `interrupt` của Claude / `turn/interrupt` của Codex. Tiến trình và phiên gốc vẫn tồn tại; câu trả lời dở dang được giữ lại; các tin nhắn sau tiếp tục cùng phiên. |
| Gõ trong khi agent đang làm việc | Gửi khi một lượt đang chạy = **Steer** | Claude đọc nó ở ranh giới công cụ tiếp theo; Codex dùng `turn/steer`. Hiển thị là *You · steer*; câu trả lời tiếp tục trong một đoạn mới. **Queue** thì gửi sau khi lượt kết thúc. |
| `/compact`, `/context`, lệnh tùy chỉnh, skill | Gõ `/` để xem danh sách lệnh | Lệnh Claude được chuyển nguyên văn (danh sách lấy từ chính CLI). Codex không có lệnh dạng văn bản; `/compact`, `/review`, `/skills`, `/mcp` được ánh xạ thành các yêu cầu app-server. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Lệnh của nền tảng, được xử lý trong trình duyệt hoặc bởi hàng đợi. |

Các yêu cầu cấp quyền mà CLI sẽ hỏi trong terminal xuất hiện ngay trong trang: chấp thuận một lần hoặc từ chối, và cùng lần thực thi đó tiếp tục. Chế độ tự động là chế độ riêng của CLI (Claude `auto`, Codex `auto_review`); Studiolo không bao giờ thêm cờ bỏ qua hay quy tắc cho phép vĩnh viễn. Effort suy luận và mô hình có thể thay đổi theo từng tin nhắn trong một cuộc trò chuyện (Claude `set_model` / `apply_flag_settings`, tham số `turn/start` của Codex).

Trong khi một lượt đang chạy, cuộc trò chuyện hiển thị quá trình làm việc giống như CLI: những gì agent nói giữa các bước được giữ nguyên, các lệnh gọi công cụ liên tiếp được gộp thành một dòng có thể mở ra, bước đang chạy và thời gian đã trôi qua luôn hiển thị; khi câu trả lời đến, toàn bộ lượt chạy được thu gọn vào raw log. Tin nhắn bạn gửi xuất hiện ngay và được chuyển đi ở chế độ nền (nếu thất bại có thể thử lại). Ở thanh bên, biểu tượng xoay đánh dấu các cuộc trò chuyện và dự án đang làm việc, còn dấu chấm đánh dấu kết quả bạn chưa xem.

---

## Nhiều máy

Chạy cùng một server trên mọi máy tính; đặt `projects/` trong một thư mục bạn đồng bộ (Syncthing hoặc bất kỳ công cụ đồng bộ tệp nào). `.studio/events/` của mỗi dự án là một nhật ký bất biến, có thứ tự nhân quả; các máy đang trực tuyến còn trao đổi nhật ký trực tiếp với nhau nên thay đổi xuất hiện trong vài giây. Bất kỳ máy nào cũng có thể hiển thị mọi cuộc trò chuyện; việc thực thi luôn diễn ra trên máy mà cuộc trò chuyện được gắn với, và phiên CLI gốc không bao giờ di chuyển.

**Kết nối tới các máy khác.** Thiết lập an toàn đơn giản nhất là [Tailscale](https://tailscale.com): đặt `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) và một `access-token.txt` ngẫu nhiên (≥ 32 ký tự) vào thư mục trạng thái, khởi động như bình thường, và Studiolo công bố cổng của nó bằng `tailscale serve`; mở `http://<machine>:4310` và nhập token một lần. Với `"trustTailnet":true`, token được bỏ qua cho lưu lượng tailnet. Không có Tailscale, hãy bind vào một địa chỉ riêng bằng `STUDIO_BIND` và đặt `STUDIO_TOKEN`. Các server phát hiện nhau qua `projects/.servers/` hoặc ghép nối thủ công trong Settings.

**Tự khởi động.** macOS: `node scripts/install-studio-macos.mjs` cài một LaunchAgent (`net.studio-local.server`). Windows: đăng ký `scripts/start-studio-windows.ps1` làm tác vụ Task Scheduler (hành động `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, chạy khi đăng nhập, không chạy trùng phiên bản, thử lại mỗi phút); `scripts/restart-studio-windows.ps1` khởi động lại nó sau khi nâng cấp, khi không còn lần chạy nào đang hoạt động.

**Nâng cấp.** Các tệp front-end trong `public/` được đọc theo từng yêu cầu và có hiệu lực ngay khi được đồng bộ; thay đổi trong `src/` cần khởi động lại trên mọi máy.

---

## Artifact và bình luận trong trang

Yêu cầu agent làm một trang web hoặc ứng dụng và nó sẽ duy trì `studio.artifacts.json` ở thư mục gốc dự án:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Trang tĩnh bỏ qua `command`, `port` và `dataPaths`. Mỗi Artifact có cổng xem trước và origin lâu dài riêng; `localStorage` của bản xem trước được lưu vào dự án và đồng bộ, nên một trò chơi được lưu trên máy này sẽ tiếp tục trên máy khác. Backend chạy như các tiến trình cục bộ thông thường (không phải sandbox) với `PORT` và `HOST`; **Snapshot** dừng backend và sao chép các đường dẫn dữ liệu đã khai báo, **Restore** đặt chúng trở lại.

Trong bản xem trước, *chọn một phần tử, đoạn văn bản hoặc một vùng canvas* rồi viết bình luận: nó trở thành tác vụ cho agent bạn chọn, kèm vùng chọn làm bằng chứng (đường dẫn DOM, văn bản được trích dẫn hoặc ảnh PNG của canvas). Các bình luận trên cùng một Artifact chạy theo thứ tự; các Artifact và cuộc trò chuyện khác nhau chạy song song. Xem `examples/persistent-game/` (backend Node + SQLite + Canvas) và `examples/artifact-compatibility/`.

---

## Tệp và cấu hình

| Vị trí | Nội dung |
| --- | --- |
| `projects/<id>/` | Thư mục làm việc của dự án: mã, Artifact, dữ liệu (được đồng bộ) |
| `projects/<id>/.studio/events/` | Nhật ký trò chuyện chính thức, bất biến |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | Trạng thái có thể dựng lại và lịch sử dễ đọc cho agent |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Bộ lưu trữ xem trước được đồng bộ, ảnh chụp dữ liệu, bằng chứng bình luận |
| `projects/<id>/uploads/` | Tệp được thả vào chat hoặc khung tài nguyên |
| `projects/.servers/` | Địa chỉ công khai của các server để phát hiện (không chứa bí mật) |
| `projects/.deleted/<id>.json` | Bia mộ của các dự án đã xóa (được đồng bộ); thư mục bị tạo lại do đồng bộ muộn sẽ bị xóa lần nữa |
| `~/.studio-local/` | Riêng của máy: danh tính, `accounts.json`, `accounts/<id>/`, ghép nối, cài đặt Tailscale — không bao giờ đồng bộ |
| `~/.studio-local/agent-profiles.json` | Tùy chọn: đường dẫn thực thi / env cho từng họ CLI (`claude`, `codex`) hoặc theo id tài khoản |

Xóa dự án là vĩnh viễn (lưu trữ thì vẫn có thể hoàn tác) và bị từ chối khi có công việc đang xếp hàng, đang chạy hoặc đang chờ. Server thực hiện xóa ghi một bia mộ, rồi xóa toàn bộ thư mục `projects/<id>/`; công cụ đồng bộ của bạn mang cả hai sang các máy khác. Mỗi server, khi thấy một bia mộ mới, sẽ xóa bản sao còn sót lại của mình, các tiến trình agent thường trú và cổng xem trước Artifact của dự án, cùng các transcript Claude (`projects/<encoded path>*` trong mỗi thư mục cấu hình) và rollout Codex (khớp theo `cwd` ở dòng đầu tiên) có thư mục làm việc nằm trong dự án. Các ID đã xử lý được ghi vào `~/.studio-local/purged-projects.json`. Các dự án bị xóa mềm bởi phiên bản cũ (`deletedAt`) sẽ bị xóa một lần khi khởi động.

---

## Câu hỏi thường gặp

**Nó có dùng API key của tôi không?** Chỉ khi bạn thêm một tài khoản API key. Tài khoản gói đăng ký chạy qua cơ chế đăng nhập riêng của CLI; Studiolo không lưu bất kỳ thông tin xác thực nào của riêng nó.

**`claude` / `codex` trong terminal của tôi có bị ảnh hưởng không?** Không. Tài khoản Studiolo nằm trong thư mục riêng; `~/.claude` và `~/.codex` chỉ được đọc một lần để sao chép cài đặt và liên kết skill.

**Đây có phải sandbox không?** Không. Agent và backend Artifact là các tiến trình cục bộ của chính bạn với quyền của bạn, y như CLI trong terminal.

**Tôi có thể dùng nó từ điện thoại không?** Có, như một client trình duyệt qua Tailscale; CLI chạy trên máy tính của bạn.

**Vì sao không có phụ thuộc nào?** Server là Node.js thuần (ESM, chỉ dùng module `node:`) nên nó chạy ở bất cứ đâu Node 22 chạy được, và không có gì trong chuỗi cung ứng nằm giữa bạn và các CLI của bạn.

---

## Giấy phép

MIT — xem [LICENSE](../../LICENSE).
