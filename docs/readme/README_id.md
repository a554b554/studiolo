<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · **Bahasa Indonesia** · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Satu meja kerja untuk setiap CLI agen coding yang Anda bayar, di setiap mesin yang Anda miliki.

**Mengobrol dengan Claude Code dan Codex dari browser, dengan akun, mesin, dan riwayat proyek yang dibagikan di antara komputer Anda.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Tanpa dependensi npm](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Pengujian](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![Lisensi: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Mulai cepat](#mulai-cepat) · [Akun](#akun-dan-masuk) · [Chat seperti di CLI](#chat-seperti-di-cli) · [Multi-mesin](#multi-mesin) · [Artifact](#artifact-dan-komentar-di-halaman) · [Pertanyaan umum](#pertanyaan-umum)

</div>

![Studiolo: percakapan dengan akun Claude di workstation lokal, penggunaan akun di kiri, file proyek dan Artifact di kanan](../../docs/screenshot.png)

> Tangkapan layar ini adalah demo sintetis: akun fiktif, balasan yang sudah ditulis sebelumnya.

---

## Instalasi dengan agen coding

Tempelkan ini ke Claude Code, Codex, atau agen coding apa pun yang dapat menjalankan perintah di mesin yang ingin Anda gunakan:

```text
Instal Studiolo dari https://github.com/a554b554/studiolo: clone repositorinya, pastikan Node.js 22.14+ tersedia dan CLI `claude` dan/atau `codex` sudah terinstal, jalankan `node src/server.mjs` dari root repositori, pastikan http://127.0.0.1:4310 merespons, lalu beri tahu saya untuk membuka Settings → Hosts & accounts agar saya bisa masuk ke akun-akun saya. Jangan masuk ke akun apa pun sendiri.
```

Atau secara manual:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo tidak memiliki dependensi npm; `npm install` tidak diperlukan. Pengujian: `node --test test/*.test.mjs`.

---

## Apa itu Studiolo

Studiolo adalah meja kerja web yang di-host sendiri yang menjalankan CLI **Claude Code** dan **Codex** yang sudah terinstal di komputer Anda. Ini bukan sekadar UI chat lain di atas kunci API:

- **Langganan Anda, CLI Anda.** Setiap permintaan berjalan melalui proses `claude` atau `codex` yang sesungguhnya: alat, skill, server MCP, mode izin, dan perilaku agen yang sama seperti di terminal. Masuk dengan langganan atau kunci API, pilihan Anda per akun.
- **Akun per mesin, dikelola oleh Studiolo.** Masuk ke beberapa akun Claude dan Codex di setiap komputer dari browser. Setiap akun mendapatkan direktori konfigurasi CLI tersendiri yang terisolasi; `~/.claude` atau `~/.codex` pribadi Anda tidak disentuh. Kuota setiap akun ditampilkan secara langsung.
- **Satu riwayat proyek di semua mesin.** Proyek berada di folder yang Anda sinkronkan dengan cara apa pun (misalnya Syncthing). Riwayat percakapan adalah jurnal append-only yang digabungkan secara deterministik; setiap mesin menjalankan server yang sama dan menyajikan riwayat yang sama. Sebuah percakapan dieksekusi di mesin yang Anda pilih untuknya; Anda dapat membaca dan melanjutkannya dari mesin mana pun.
- **Pengalaman terminal, di browser.** Hentikan sebuah giliran dengan Esc, arahkan agen yang sedang berjalan dengan pesan susulan, ketik `/` untuk slash command milik CLI itu sendiri; semuanya dipetakan ke protokol native, bukan diimplementasikan ulang.
- **Artifact dan komentar di halaman.** Aplikasi web yang dibuat agen berjalan sebagai Artifact dengan backend persisten dan penyimpanan tersinkron; pilih sesuatu di pratinjau dan kirimkan ke agen sebagai tugas.

---

## Mulai cepat

1. **Prasyarat**: Node.js 22.14+, dan CLI `claude` dan/atau `codex` terinstal di mesin (`claude --version`, `codex --version`).
2. **Jalankan** `node src/server.mjs` lalu buka <http://127.0.0.1:4310>.
3. **Tambahkan akun**: Settings → *Hosts & accounts* → *Add account*. Pilih mesin, jenis (Claude Code / Codex), dan metode masuk, lalu ikuti langkah-langkah yang ditampilkan (lihat di bawah).
4. **Buat proyek, mulai percakapan**: kotak penulisan memilih **mesin → akun → model → effort → mode izin**. Pesan pertama menetapkan mesin, akun, dan model untuk percakapan tersebut; effort dan izin dapat diubah per pesan.

Variabel lingkungan: `STUDIO_STATE_DIR` (state privat mesin, default `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (byte, default 100 MB). Satu server per direktori state.

---

## Akun dan masuk

Akun dimiliki oleh sebuah mesin dan dibuat dari browser. Setiap akun adalah direktori di bawah `~/.studio-local/accounts/<id>/`, yang digunakan sebagai `CLAUDE_CONFIG_DIR` atau `CODEX_HOME`, sehingga beberapa akun dari satu CLI dapat berdampingan dan login terminal Anda sendiri tidak pernah tersentuh. Saat akun dibuat, Studiolo mengisi direktori tersebut dari direktori CLI default Anda: menyalin `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) dan menautkan `skills`, `plugins`, dan sejenisnya, sehingga agen tetap memiliki skill dan server MCP yang sudah Anda gunakan. Kredensial tidak pernah disalin.

| Jenis | Metode | Yang terjadi |
| --- | --- | --- |
| Claude Code | **Langganan** | Studiolo menjalankan `claude auth login`; Anda membuka tautan, masuk, lalu menempelkan kode otorisasi kembali ke halaman. |
| Claude Code | **Kunci Anthropic API** | Kunci disimpan di direktori akun (mode 0600) dan diteruskan sebagai `ANTHROPIC_API_KEY`; diverifikasi melalui handshake CLI, dibuang jika ditolak. Bayar sesuai pemakaian, tanpa jendela kuota. |
| Codex | **ChatGPT** | Kode perangkat melalui app-server Codex: halaman menampilkan tautan dan kode sekali pakai; masuk dari browser mana pun, halaman diperbarui setelah selesai. |
| Codex | **Kunci OpenAI API** | Disimpan oleh Codex sendiri di `CODEX_HOME` milik akun. |

Setelah masuk, Studiolo membaca identitas akun (e-mail, paket) dan daftar model langsung dari CLI, tanpa menghabiskan permintaan model apa pun, dan, untuk Claude, slash command milik CLI untuk pelengkapan otomatis di kotak penulisan. Akun tanpa nama khusus diganti namanya menjadi e-mailnya, sehingga kotak penulisan, header percakapan, setiap balasan, dan panel penggunaan menunjukkan siapa yang berbicara. Akun dapat diganti namanya, disegarkan, dikeluarkan (`claude auth logout` / `codex logout`), atau dihapus; percakapan yang akunnya dihapus dapat dilanjutkan dengan akun lain di mesin yang sama.

Panel penggunaan (kiri bawah) mengikuti mesin yang dipilih di kotak penulisan: langganan Claude menampilkan jendela 5 jam, Codex jendela mingguan, akun kunci API ditagih berdasarkan pemakaian. Panel ini membaca endpoint penggunaan milik CLI sendiri (`get_usage`, `account/rateLimits/read`), menyimpan cache selama 60 detik, tidak pernah melakukan polling, dan tidak pernah memulai CLI untuk akun yang sudah keluar.

Semua ini juga berfungsi untuk mesin jarak jauh: pilih host online lain di *Hosts & accounts* dan permintaan akan diteruskan ke sana.

---

## Chat seperti di CLI

Setiap percakapan memiliki proses native yang tetap berjalan, Claude Code melalui `stream-json` dua arah, Codex melalui `app-server`, sehingga agen berperilaku persis seperti di terminal. Kontrol web dipetakan ke protokol native:

| Di terminal | Di Studiolo | Caranya |
| --- | --- | --- |
| Esc untuk berhenti | **■ Stop** atau Esc di kotak penulisan | Permintaan kontrol `interrupt` di Claude / `turn/interrupt` di Codex. Proses dan sesi native tetap hidup; balasan parsial disimpan; pesan berikutnya melanjutkan sesi yang sama. |
| Mengetik saat agen bekerja | Mengirim saat giliran berjalan = **Steer** | Claude membacanya pada batas alat berikutnya; Codex `turn/steer`. Ditampilkan sebagai *You · steer*; balasan berlanjut di segmen baru. **Queue** justru mengirim setelah giliran selesai. |
| `/compact`, `/context`, perintah kustom, skill | Ketik `/` untuk daftar perintah | Perintah Claude diteruskan apa adanya (daftarnya berasal dari CLI itu sendiri). Codex tidak memiliki perintah teks; `/compact`, `/review`, `/skills`, `/mcp` dipetakan ke permintaan app-server. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Perintah platform yang ditangani di browser atau oleh antrean. |

Permintaan izin yang akan ditanyakan CLI di terminal muncul di halaman: setujui sekali atau tolak, dan eksekusi yang sama berlanjut. Mode otomatis adalah milik CLI sendiri (Claude `auto`, Codex `auto_review`); Studiolo tidak pernah menambahkan flag bypass atau aturan izin permanen. Tingkat effort penalaran dan model dapat diubah per pesan dalam satu percakapan (Claude `set_model` / `apply_flag_settings`, parameter `turn/start` di Codex).

---

## Multi-mesin

Jalankan server yang sama di setiap komputer; letakkan `projects/` di folder yang Anda sinkronkan (Syncthing atau alat sinkronisasi file apa pun). `.studio/events/` setiap proyek adalah jurnal yang tidak dapat diubah dan berurutan secara kausal; mesin yang online juga bertukar jurnal secara langsung sehingga perubahan muncul dalam hitungan detik. Mesin mana pun dapat menampilkan setiap percakapan; eksekusi selalu terjadi di mesin tempat percakapan terikat, dan sesi CLI native tidak pernah berpindah.

**Menjangkau mesin lain.** Pengaturan aman yang paling sederhana adalah [Tailscale](https://tailscale.com): letakkan `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) dan `access-token.txt` acak (≥ 32 karakter) di direktori state, jalankan seperti biasa, dan Studiolo memublikasikan port-nya dengan `tailscale serve`; buka `http://<machine>:4310` dan masukkan token sekali. Dengan `"trustTailnet":true` token dilewati untuk lalu lintas tailnet. Tanpa Tailscale, bind ke alamat privat dengan `STUDIO_BIND` dan atur `STUDIO_TOKEN`. Server saling menemukan melalui `projects/.servers/` atau dengan pemasangan manual di Settings.

**Mulai otomatis.** macOS: `node scripts/install-studio-macos.mjs` memasang LaunchAgent (`net.studio-local.server`). Windows: daftarkan `scripts/start-studio-windows.ps1` sebagai tugas Task Scheduler (aksi `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, dijalankan saat logon, tanpa instans ganda, coba ulang setiap menit); `scripts/restart-studio-windows.ps1` memulai ulang setelah upgrade begitu tidak ada run yang aktif.

**Upgrade.** File front-end di bawah `public/` dibaca per permintaan dan langsung berlaku begitu tersinkron; perubahan di bawah `src/` memerlukan restart di setiap mesin.

---

## Artifact dan komentar di halaman

Minta agen membuat halaman web atau aplikasi dan agen akan memelihara `studio.artifacts.json` di root proyek:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Halaman statis menghilangkan `command`, `port`, dan `dataPaths`. Setiap Artifact mendapatkan port pratinjau dan origin persisten tersendiri; `localStorage` pratinjau disimpan ke dalam proyek dan disinkronkan, sehingga game yang disimpan di satu mesin dapat dilanjutkan di mesin lain. Backend berjalan sebagai proses lokal biasa (bukan sandbox) dengan `PORT` dan `HOST`; **Snapshot** menghentikan backend dan menyalin jalur data yang dideklarasikan, **Restore** mengembalikannya.

Di pratinjau, *pilih elemen, teks, atau area canvas* dan tulis komentar: komentar itu menjadi tugas untuk agen yang Anda pilih, dengan pilihan tersebut sebagai bukti (jalur DOM, teks kutipan, atau PNG dari canvas). Komentar pada satu Artifact berjalan berurutan; Artifact dan percakapan yang berbeda berjalan secara paralel. Lihat `examples/persistent-game/` (backend Node + SQLite + Canvas) dan `examples/artifact-compatibility/`.

---

## File dan konfigurasi

| Lokasi | Isi |
| --- | --- |
| `projects/<id>/` | Direktori kerja proyek: kode, Artifact, data (tersinkron) |
| `projects/<id>/.studio/events/` | Jurnal percakapan otoritatif yang tidak dapat diubah |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | State yang dapat dibangun ulang dan riwayat yang dapat dibaca agen |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Penyimpanan pratinjau tersinkron, snapshot data, bukti komentar |
| `projects/<id>/uploads/` | File yang dijatuhkan ke chat atau panel sumber daya |
| `projects/.servers/` | Alamat publik server untuk penemuan (tanpa rahasia) |
| `projects/.deleted/<id>.json` | Tombstone proyek yang dihapus (tersinkron); folder yang dibuat ulang oleh sinkronisasi yang terlambat akan dihapus lagi |
| `~/.studio-local/` | Privat untuk mesin: identitas, `accounts.json`, `accounts/<id>/`, pemasangan, pengaturan Tailscale; jangan pernah disinkronkan |
| `~/.studio-local/agent-profiles.json` | Opsional: jalur executable / env per keluarga CLI (`claude`, `codex`) atau per id akun |

Menghapus proyek bersifat permanen (pengarsipan tetap dapat dibatalkan) dan ditolak selama ada pekerjaan yang mengantre, berjalan, atau menunggu. Server yang menghapus menulis tombstone, lalu menghapus seluruh folder `projects/<id>/`; alat sinkronisasi Anda membawa keduanya ke mesin lain. Setiap server, saat melihat tombstone baru, menghapus salinan sisanya, proses agen proyek yang tetap berjalan dan port pratinjau Artifact, serta transkrip Claude (`projects/<encoded path>*` di setiap direktori konfigurasi) dan rollout Codex (dicocokkan dengan `cwd` pada baris pertamanya) yang direktori kerjanya berada di dalam proyek. ID yang sudah ditangani dicatat di `~/.studio-local/purged-projects.json`. Proyek yang dihapus secara lunak oleh versi lama (`deletedAt`) dihapus sekali saat startup.

---

## Pertanyaan umum

**Apakah ini menggunakan kunci API saya?** Hanya jika Anda menambahkan akun kunci API. Akun langganan berjalan melalui login milik CLI sendiri; Studiolo tidak menyimpan kredensial apa pun miliknya sendiri.

**Apakah `claude` / `codex` di terminal saya akan terpengaruh?** Tidak. Akun Studiolo berada di direktorinya sendiri; `~/.claude` dan `~/.codex` hanya dibaca sekali untuk menyalin pengaturan dan menautkan skill.

**Apakah ini sandbox?** Bukan. Agen dan backend Artifact adalah proses lokal Anda sendiri dengan izin Anda, persis seperti CLI di terminal.

**Bisakah saya menggunakannya dari ponsel?** Ya, sebagai klien browser melalui Tailscale; CLI berjalan di komputer Anda.

**Mengapa tanpa dependensi?** Server ini murni Node.js (ESM, hanya modul `node:`) sehingga dapat berjalan di mana pun Node 22 berjalan dan tidak ada apa pun dari rantai pasok yang berada di antara Anda dan CLI Anda.

---

## Lisensi

MIT — lihat [LICENSE](../../LICENSE).
