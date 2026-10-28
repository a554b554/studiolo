<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · **Türkçe** · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Ücret ödediğiniz her kodlama ajanı CLI'ı için, sahip olduğunuz her makinede tek bir çalışma tezgâhı.

**Claude Code ve Codex ile tarayıcıdan sohbet edin; hesaplar, makineler ve proje geçmişi tüm bilgisayarlarınız arasında paylaşılır.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Sıfır npm bağımlılığı](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Testler](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![Lisans: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Hızlı başlangıç](#hızlı-başlangıç) · [Hesaplar](#hesaplar-ve-oturum-açma) · [CLI gibi sohbet](#cli-gibi-sohbet) · [Çoklu makine](#çoklu-makine) · [Artifact](#artifact-ve-sayfa-içi-yorumlar) · [SSS](#sss)

</div>

![Studiolo: yerel iş istasyonunda bir Claude hesabıyla yapılan sohbet; solda hesap kullanımı, sağda proje dosyaları ve Artifact'ler](../../docs/screenshot.png)

> Ekran görüntüsü sentetik bir demodur: hesaplar kurgusal, yanıtlar önceden yazılmıştır.

---

## Bir kodlama ajanıyla kurulum

Bunu, kullanmak istediğiniz makinede komut çalıştırabilen Claude Code'a, Codex'e veya herhangi bir kodlama ajanına yapıştırın:

```text
Studiolo'yu https://github.com/a554b554/studiolo adresinden kur: depoyu klonla, Node.js 22.14+ sürümünün mevcut olduğundan ve `claude` ve/veya `codex` CLI'larının kurulu olduğundan emin ol, depo kök dizininde `node src/server.mjs` komutunu çalıştır, http://127.0.0.1:4310 adresinin yanıt verdiğini doğrula, ardından hesaplarımda oturum açmam için Settings → Hosts & accounts bölümünü açmamı söyle. Hiçbir hesapta kendin oturum açma.
```

Ya da elle:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo'nun hiçbir npm bağımlılığı yoktur; `npm install` gerekmez. Testler: `node --test test/*.test.mjs`.

---

## Nedir

Studiolo, bilgisayarlarınızda zaten kurulu olan **Claude Code** ve **Codex** CLI'larını yöneten, kendi sunucunuzda barındırdığınız bir web çalışma tezgâhıdır. Bir API anahtarı üzerine kurulmuş başka bir sohbet arayüzü değildir:

- **Sizin abonelikleriniz, sizin CLI'larınız.** Her istek gerçek `claude` veya `codex` süreci üzerinden çalışır — terminaldekiyle aynı araçlar, skills, MCP sunucuları, izin modları ve ajan davranışı. Abonelikle oturum açma ya da API anahtarı; seçim her hesap için sizin.
- **Makine başına hesaplar, Studiolo tarafından yönetilir.** Her bilgisayarda birden fazla Claude ve Codex hesabında tarayıcıdan oturum açın. Her hesap kendi yalıtılmış CLI yapılandırma dizinini alır; kişisel `~/.claude` veya `~/.codex` dizinlerinize hiç dokunulmaz. Her hesabın kotası canlı olarak gösterilir.
- **Makineler arasında tek proje geçmişi.** Projeler, istediğiniz şekilde (örneğin Syncthing ile) senkronize ettiğiniz bir klasörde bulunur. Sohbet geçmişi, deterministik olarak birleşen, yalnızca ekleme yapılan bir günlüktür; her makine aynı sunucuyu çalıştırır ve aynı geçmişi sunar. Bir sohbet, onun için seçtiğiniz makinede yürütülür; herhangi bir makineden okuyabilir ve sürdürebilirsiniz.
- **Terminal deneyimi, tarayıcıda.** Esc ile bir turu durdurun, çalışan bir ajanı takip mesajıyla yönlendirin, CLI'ın kendi eğik çizgi komutları için `/` yazın — hepsi yeniden yazılmadan yerel protokollere eşlenmiştir.
- **Artifact'ler ve sayfa içi yorumlar.** Ajanların oluşturduğu web uygulamaları, kalıcı arka uçlara ve senkronize depolamaya sahip Artifact'ler olarak çalışır; önizlemede bir şey seçin ve bunu bir görev olarak ajana gönderin.

---

## Hızlı başlangıç

1. **Ön koşullar** — Node.js 22.14+ ve makinede kurulu `claude` ve/veya `codex` CLI'ı (`claude --version`, `codex --version`).
2. `node src/server.mjs` komutunu **çalıştırın** ve <http://127.0.0.1:4310> adresini açın.
3. **Hesap ekleyin** — Settings → *Hosts & accounts* → *Add account*. Makineyi, türü (Claude Code / Codex) ve oturum açma yöntemini seçin, ardından gösterilen adımları izleyin (aşağıya bakın).
4. **Bir proje oluşturun, sohbet başlatın** — mesaj kutusunda sırasıyla **makine → hesap → model → effort → izin modu** seçilir. İlk mesaj, o sohbetin makinesini ve hesabını sabitler; model, effort ve izinler mesaj başına değiştirilebilir. Başka bir model aynı yerel oturumu sürdürür; onun ilk turu bağlamı istem önbelleği olmadan yeniden okur.

Ortam değişkenleri: `STUDIO_STATE_DIR` (makineye özel durum, varsayılan `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (bayt, varsayılan 100 MB). Her durum dizini için bir sunucu.

---

## Hesaplar ve oturum açma

Hesaplar bir makineye aittir ve tarayıcıdan oluşturulur. Her hesap, `~/.studio-local/accounts/<id>/` altında `CLAUDE_CONFIG_DIR` veya `CODEX_HOME` olarak kullanılan bir dizindir; böylece aynı CLI'ın birden fazla hesabı bir arada bulunabilir ve terminalinizin kendi oturumuna asla dokunulmaz. Bir hesap oluşturulduğunda Studiolo bu dizini varsayılan CLI dizininizden hazırlar — `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) dosyalarını kopyalar ve `skills`, `plugins` gibi dizinleri bağlar — böylece ajanlar halihazırda kullandığınız skills ve MCP sunucularını korur. Kimlik bilgileri asla kopyalanmaz.

| Tür | Yöntem | Ne olur |
| --- | --- | --- |
| Claude Code | **Abonelik** | Studiolo `claude auth login` komutunu çalıştırır; bağlantıyı açar, oturum açar ve yetkilendirme kodunu sayfaya geri yapıştırırsınız. |
| Claude Code | **Anthropic API anahtarı** | Anahtar hesap dizininde saklanır (mod 0600) ve `ANTHROPIC_API_KEY` olarak iletilir; CLI el sıkışmasıyla doğrulanır, reddedilirse silinir. Kullandıkça öde; kota pencereleri yoktur. |
| Codex | **ChatGPT** | Codex app-server üzerinden cihaz kodu: sayfa bir bağlantı ve tek kullanımlık bir kod gösterir; herhangi bir tarayıcıdan oturum açın, işlem bitince sayfa güncellenir. |
| Codex | **OpenAI API anahtarı** | Codex tarafından hesabın `CODEX_HOME` dizininde saklanır. |

Oturum açıldıktan sonra Studiolo hesabın kimliğini (e-posta, plan) ve model listesini doğrudan CLI'dan okur — hiçbir model isteği harcanmaz — ve Claude için mesaj kutusunun otomatik tamamlaması amacıyla CLI'ın eğik çizgi komutlarını da okur. Özel adı olmayan bir hesap e-posta adresiyle yeniden adlandırılır; böylece mesaj kutusu, sohbet başlığı, her yanıt ve kullanım paneli kimin konuştuğunu gösterir. Hesaplar yeniden adlandırılabilir, yenilenebilir, oturumu kapatılabilir (`claude auth logout` / `codex logout`) veya kaldırılabilir; hesabı kaldırılan bir sohbet aynı makinedeki başka bir hesapla devam edebilir.

Kullanım paneli (sol alt), mesaj kutusunda seçilen makineyi izler: Claude abonelikleri 5 saatlik pencereyi, Codex haftalık pencereyi gösterir; API anahtarlı hesaplar kullanıma göre faturalandırılır. Panel CLI'ların kendi kullanım uç noktalarını (`get_usage`, `account/rateLimits/read`) okur, 60 sn önbelleğe alır, asla yoklama yapmaz ve oturumu kapalı bir hesap için asla CLI başlatmaz.

Bunların hepsi uzak makineler için de çalışır: *Hosts & accounts* bölümünde çevrimiçi başka bir ana makine seçin, istekler ona aktarılır.

---

## CLI gibi sohbet

Her sohbetin kalıcı bir yerel süreci vardır — Claude Code çift yönlü `stream-json` üzerinden, Codex `app-server` üzerinden — böylece ajan tam olarak terminaldeki gibi davranır. Web kontrolleri yerel protokollere eşlenir:

| Terminalde | Studiolo'da | Nasıl |
| --- | --- | --- |
| Durdurmak için Esc | **■ Stop** veya mesaj kutusunda Esc | Claude `interrupt` kontrol isteği / Codex `turn/interrupt`. Süreç ve yerel oturum korunur; yarım kalan yanıt saklanır; sonraki mesajlar aynı oturumu sürdürür. |
| Ajan çalışırken yazmak | Tur sürerken göndermek = **Steer** | Claude bunu bir sonraki araç sınırında okur; Codex `turn/steer`. *You · steer* olarak gösterilir; yanıt yeni bir bölümde devam eder. **Queue** ise mesajı tur bittikten sonra gönderir. |
| `/compact`, `/context`, özel komutlar, skills | Komut listesi için `/` yazın | Claude komutları olduğu gibi iletilir (liste CLI'ın kendisinden gelir). Codex'in metin komutları yoktur; `/compact`, `/review`, `/skills`, `/mcp` app-server isteklerine eşlenir. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Tarayıcıda veya kuyruk tarafından işlenen platform komutları. |

CLI'ın terminalde soracağı izin istekleri sayfada görünür: bu seferlik onaylayın ya da reddedin, aynı yürütme devam eder. Auto modu CLI'ın kendi modudur (Claude `auto`, Codex `auto_review`); Studiolo asla atlama bayrakları veya kalıcı izin kuralları eklemez. Akıl yürütme effort'u ve model, bir sohbet içinde mesaj başına değiştirilebilir (Claude `set_model` / `apply_flag_settings`, Codex `turn/start` parametreleri).

Bir tur çalışırken konuşma, işi CLI'lar gibi gösterir: agent'ın adımlar arasında söyledikleri olduğu gibi kalır, art arda gelen araç çağrıları açılabilen tek bir satırda toplanır, süren adım ve geçen süre görünür kalır; yanıt geldiğinde tüm çalışma kendi raw log'una katlanır. Gönderdiğiniz mesaj hemen görünür ve arka planda iletilir (başarısız olursa yeniden denenebilir). Kenar çubuğunda dönen bir gösterge çalışmakta olan konuşmaları ve projeleri, bir nokta ise henüz görmediğiniz sonuçları işaretler.

---

## Çoklu makine

Aynı sunucuyu her bilgisayarda çalıştırın; `projects/` dizinini senkronize ettiğiniz bir klasöre koyun (Syncthing veya herhangi bir dosya senkronizasyon aracı). Her projenin `.studio/events/` dizini değiştirilemez, nedensel sıralı bir günlüktür; çevrimiçi olan makineler günlükleri doğrudan da değiş tokuş eder, böylece değişiklikler saniyeler içinde görünür. Her makine tüm sohbetleri gösterebilir; yürütme her zaman sohbetin bağlı olduğu makinede gerçekleşir ve yerel CLI oturumları asla taşınmaz.

**Diğer makinelere erişim.** En basit güvenli kurulum [Tailscale](https://tailscale.com)'dir: durum dizinine `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) ve rastgele bir `access-token.txt` (≥ 32 karakter) koyun, normal şekilde başlatın; Studiolo portunu `tailscale serve` ile yayınlar. `http://<machine>:4310` adresini açın ve belirteci bir kez girin. `"trustTailnet":true` ile tailnet trafiği için belirteç atlanır. Tailscale olmadan, `STUDIO_BIND` ile özel bir adrese bağlayın ve `STUDIO_TOKEN` ayarlayın. Sunucular birbirlerini `projects/.servers/` üzerinden veya Settings içinde elle eşleştirme yoluyla bulur.

**Otomatik başlatma.** macOS: `node scripts/install-studio-macos.mjs` bir LaunchAgent (`net.studio-local.server`) kurar. Windows: `scripts/start-studio-windows.ps1` dosyasını bir Görev Zamanlayıcı görevi olarak kaydedin (eylem `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, oturum açıldığında çalıştır, yinelenen örnek yok, her dakika yeniden dene); yükseltmeden sonra `scripts/restart-studio-windows.ps1`, etkin çalıştırma kalmadığında onu yeniden başlatır.

**Yükseltme.** `public/` altındaki ön yüz dosyaları her istekte okunur ve senkronize edilir edilmez etkili olur; `src/` altındaki değişiklikler her makinede yeniden başlatma gerektirir.

---

## Artifact ve sayfa içi yorumlar

Bir ajandan web sayfası veya uygulama isteyin; ajan proje kök dizininde `studio.artifacts.json` dosyasını yönetir:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Statik sayfalar `command`, `port` ve `dataPaths` alanlarını içermez. Her Artifact kendi kalıcı önizleme portunu ve kaynağını (origin) alır; önizlemenin `localStorage` verisi projeye kalıcı olarak yazılır ve senkronize edilir, böylece bir makinede kaydedilen oyun başka bir makinede devam eder. Arka uçlar `PORT` ve `HOST` ile sıradan yerel süreçler olarak çalışır (sanal alan değildir); **Snapshot** arka ucu durdurur ve bildirilen veri yollarını kopyalar, **Restore** onları geri koyar.

Önizlemede *bir öğe, metin veya tuval bölgesi seçin* ve bir yorum yazın: yorum, seçtiğiniz ajan için bir göreve dönüşür ve seçim kanıt olarak eklenir (DOM yolu, alıntılanan metin veya tuvalin PNG'si). Tek bir Artifact üzerindeki yorumlar sırayla çalışır; farklı Artifact'ler ve sohbetler paralel çalışır. `examples/persistent-game/` (Node arka ucu + SQLite + Canvas) ve `examples/artifact-compatibility/` örneklerine bakın.

---

## Dosyalar ve yapılandırma

| Konum | İçerik |
| --- | --- |
| `projects/<id>/` | Proje çalışma dizini: kod, Artifact'ler, veriler (senkronize edilir) |
| `projects/<id>/.studio/events/` | Yetkili, değiştirilemez sohbet günlüğü |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | Yeniden oluşturulabilir durum ve ajanlar için okunabilir geçmiş |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Senkronize önizleme depolaması, veri anlık görüntüleri, yorum kanıtları |
| `projects/<id>/uploads/` | Sohbete veya kaynak paneline bırakılan dosyalar |
| `projects/.servers/` | Keşif için sunucuların genel adresleri (gizli bilgi içermez) |
| `projects/.deleted/<id>.json` | Silinen projelerin mezar taşları (senkronize edilir); geç gelen bir senkronizasyonla yeniden oluşturulan klasör tekrar kaldırılır |
| `~/.studio-local/` | Makineye özel: kimlik, `accounts.json`, `accounts/<id>/`, eşleştirme, Tailscale ayarları — asla senkronize etmeyin |
| `~/.studio-local/agent-profiles.json` | İsteğe bağlı: CLI ailesi (`claude`, `codex`) veya hesap kimliği başına çalıştırılabilir dosya yolu / ortam değişkenleri |

Bir projeyi silmek kalıcıdır (arşivleme geri alınabilir) ve kuyruğa alınmış, çalışan veya bekleyen iş varken reddedilir. Silme işlemini yapan sunucu önce bir mezar taşı yazar, ardından `projects/<id>/` klasörünün tamamını kaldırır; senkronizasyon aracınız ikisini de diğer makinelere taşır. Her sunucu yeni bir mezar taşı gördüğünde, kalan kopyasını, projenin kalıcı ajan süreçlerini ve Artifact önizleme portlarını, ayrıca çalışma dizini proje içinde olan Claude dökümlerini (her yapılandırma dizinindeki `projects/<encoded path>*`) ve Codex rollout'larını (ilk satırlarındaki `cwd` ile eşleştirilir) kaldırır. İşlenen kimlikler `~/.studio-local/purged-projects.json` dosyasına kaydedilir. Eski sürümlerin geçici olarak sildiği projeler (`deletedAt`) başlangıçta bir kez kaldırılır.

---

## SSS

**API anahtarımı kullanır mı?** Yalnızca bir API anahtarı hesabı eklerseniz. Abonelik hesapları CLI'ların kendi oturum açma mekanizmasıyla çalışır; Studiolo kendine ait hiçbir kimlik bilgisi saklamaz.

**Terminalimdeki `claude` / `codex` etkilenir mi?** Hayır. Studiolo hesapları kendi dizinlerinde bulunur; `~/.claude` ve `~/.codex` yalnızca ayarları kopyalamak ve skills'i bağlamak için bir kez okunur.

**Bu bir sanal alan (sandbox) mı?** Hayır. Ajanlar ve Artifact arka uçları, tıpkı terminaldeki CLI'lar gibi, sizin izinlerinizle çalışan kendi yerel süreçlerinizdir.

**Telefonumdan kullanabilir miyim?** Evet, Tailscale üzerinden bir tarayıcı istemcisi olarak; CLI'lar bilgisayarlarınızda çalışır.

**Neden sıfır bağımlılık?** Sunucu düz Node.js'tir (ESM, yalnızca `node:` modülleri); bu yüzden Node 22'nin çalıştığı her yerde çalışır ve tedarik zincirindeki hiçbir şey sizinle CLI'larınız arasına girmez.

---

## Lisans

MIT — bkz. [LICENSE](../../LICENSE).
