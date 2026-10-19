<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · **Polski** · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Jeden warsztat dla wszystkich CLI agentów kodujących, za które płacisz, na każdej Twojej maszynie.

**Rozmawiaj z Claude Code i Codex w przeglądarce, z kontami, maszynami i historią projektów współdzielonymi między Twoimi komputerami.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Szybki start](#szybki-start) · [Konta](#konta-i-logowanie) · [Czat jak w CLI](#czat-jak-w-cli) · [Wiele maszyn](#wiele-maszyn) · [Artifacts](#artifacts-i-komentarze-na-stronie) · [FAQ](#faq)

</div>

![Studiolo: rozmowa z kontem Claude na lokalnej stacji roboczej, zużycie kont po lewej, pliki projektu i Artifacts po prawej](../../docs/screenshot.png)

> Zrzut ekranu to syntetyczne demo: fikcyjne konta, przygotowane odpowiedzi.

---

## Instalacja z agentem kodującym

Wklej to do Claude Code, Codex lub dowolnego agenta kodującego, który może uruchamiać polecenia na maszynie, której chcesz używać:

```text
Zainstaluj Studiolo z https://github.com/a554b554/studiolo: sklonuj repozytorium, upewnij się, że dostępny jest Node.js 22.14+ i że zainstalowane są CLI `claude` i/lub `codex`, uruchom `node src/server.mjs` z katalogu głównego repozytorium, potwierdź, że http://127.0.0.1:4310 odpowiada, a potem powiedz mi, żebym otworzył Settings → Hosts & accounts i zalogował swoje konta. Nie loguj niczego samodzielnie.
```

Albo ręcznie:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo nie ma zależności npm; `npm install` nie jest potrzebne. Testy: `node --test test/*.test.mjs`.

---

## Czym to jest

Studiolo to samodzielnie hostowany warsztat webowy, który steruje CLI **Claude Code** i **Codex** już zainstalowanymi na Twoich komputerach. To nie jest kolejny interfejs czatu na kluczu API:

- **Twoje subskrypcje, Twoje CLI.** Każde żądanie przechodzi przez prawdziwy proces `claude` lub `codex` — te same narzędzia, skills, serwery MCP, tryby uprawnień i zachowanie agenta co w terminalu. Logowanie subskrypcją lub klucz API — do wyboru dla każdego konta.
- **Konta per maszyna, zarządzane przez Studiolo.** Loguj z przeglądarki kilka kont Claude i Codex na każdym komputerze. Każde konto dostaje własny, odizolowany katalog konfiguracji CLI; nic nie dotyka Twoich prywatnych `~/.claude` ani `~/.codex`. Limit każdego konta jest wyświetlany na żywo.
- **Jedna historia projektów na wszystkich maszynach.** Projekty znajdują się w folderze, który synchronizujesz w dowolny sposób (np. Syncthing). Historia rozmów to dziennik typu append-only, który scala się deterministycznie; każda maszyna uruchamia ten sam serwer i serwuje tę samą historię. Rozmowa wykonuje się na maszynie, którą dla niej wybrałeś; możesz ją czytać i kontynuować z dowolnej z nich.
- **Doświadczenie terminala w przeglądarce.** Zatrzymaj turę klawiszem Esc, pokieruj działającym agentem kolejną wiadomością, wpisz `/`, aby użyć własnych poleceń slash CLI — wszystko zmapowane na natywne protokoły, a nie zaimplementowane od nowa.
- **Artifacts i komentarze na stronie.** Aplikacje webowe budowane przez agentów działają jako Artifacts z trwałymi backendami i synchronizowanym magazynem; zaznacz coś w podglądzie i wyślij to agentowi jako zadanie.

---

## Szybki start

1. **Wymagania** — Node.js 22.14+ oraz CLI `claude` i/lub `codex` zainstalowane na maszynie (`claude --version`, `codex --version`).
2. **Uruchom** `node src/server.mjs` i otwórz <http://127.0.0.1:4310>.
3. **Dodaj konta** — Settings → *Hosts & accounts* → *Add account*. Wybierz maszynę, typ (Claude Code / Codex) i metodę logowania, a następnie wykonaj pokazane kroki (patrz niżej).
4. **Utwórz projekt, rozpocznij rozmowę** — w polu wiadomości wybierasz **maszynę → konto → model → wysiłek → tryb uprawnień**. Pierwsza wiadomość ustala maszynę, konto i model dla tej rozmowy; wysiłek i uprawnienia można zmieniać przy każdej wiadomości.

Zmienne środowiskowe: `STUDIO_STATE_DIR` (prywatny stan maszyny, domyślnie `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (bajty, domyślnie 100 MB). Jeden serwer na katalog stanu.

---

## Konta i logowanie

Konta należą do maszyny i są tworzone z przeglądarki. Każde konto to katalog w `~/.studio-local/accounts/<id>/`, używany jako `CLAUDE_CONFIG_DIR` lub `CODEX_HOME`, dzięki czemu kilka kont jednego CLI współistnieje, a własne logowanie Twojego terminala nigdy nie jest naruszane. Przy tworzeniu konta Studiolo wypełnia ten katalog na podstawie domyślnego katalogu CLI — kopiuje `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) i linkuje `skills`, `plugins` i pokrewne — aby agenci zachowali skills i serwery MCP, których już używasz. Dane uwierzytelniające nigdy nie są kopiowane.

| Typ | Metoda | Co się dzieje |
| --- | --- | --- |
| Claude Code | **Subskrypcja** | Studiolo uruchamia `claude auth login`; otwierasz link, logujesz się i wklejasz kod autoryzacji z powrotem na stronę. |
| Claude Code | **Klucz API Anthropic** | Klucz jest przechowywany w katalogu konta (tryb 0600) i przekazywany jako `ANTHROPIC_API_KEY`; weryfikowany przez handshake CLI, usuwany w razie odrzucenia. Płatność za użycie, bez okien limitu. |
| Codex | **ChatGPT** | Kod urządzenia przez app-server Codex: strona pokazuje link i jednorazowy kod; zaloguj się z dowolnej przeglądarki, strona zaktualizuje się po zakończeniu. |
| Codex | **Klucz API OpenAI** | Przechowywany przez sam Codex w `CODEX_HOME` konta. |

Po zalogowaniu Studiolo odczytuje tożsamość konta (e-mail, plan) i listę modeli bezpośrednio z CLI — bez zużywania żadnego żądania do modelu — a dla Claude także polecenia slash CLI do autouzupełniania w polu wiadomości. Konto bez własnej nazwy otrzymuje nazwę od swojego adresu e-mail, dzięki czemu pole wiadomości, nagłówek rozmowy, każda odpowiedź i panel zużycia pokazują, kto mówi. Konta można zmieniać nazwę, odświeżać, wylogowywać (`claude auth logout` / `codex logout`) lub usuwać; rozmowa, której konto usunięto, może być kontynuowana z innym kontem na tej samej maszynie.

Panel zużycia (na dole po lewej) podąża za maszyną wybraną w polu wiadomości: subskrypcje Claude pokazują okno 5-godzinne, Codex — tygodniowe, konta z kluczem API są rozliczane za użycie. Odczytuje on własne endpointy zużycia CLI (`get_usage`, `account/rateLimits/read`), buforuje wynik na 60 s, nigdy nie odpytuje cyklicznie i nigdy nie uruchamia CLI dla wylogowanego konta.

Wszystko to działa także dla zdalnych maszyn: wybierz inny host online w *Hosts & accounts*, a żądania zostaną do niego przekazane.

---

## Czat jak w CLI

Każda rozmowa ma własny rezydentny proces natywny — Claude Code przez dwukierunkowy `stream-json`, Codex przez `app-server` — więc agent zachowuje się dokładnie tak jak w terminalu. Kontrolki webowe są mapowane na natywne protokoły:

| W terminalu | W Studiolo | Jak |
| --- | --- | --- |
| Esc, aby zatrzymać | **■ Stop** lub Esc w polu wiadomości | Żądanie sterujące `interrupt` w Claude / `turn/interrupt` w Codex. Proces i natywna sesja przetrwają; częściowa odpowiedź zostaje zachowana; kolejne wiadomości kontynuują tę samą sesję. |
| Pisanie, gdy agent pracuje | Wysłanie podczas tury = **Steer** | Claude odczytuje to na następnej granicy narzędzia; Codex — `turn/steer`. Wyświetlane jako *You · steer*; odpowiedź kontynuowana jest w nowym segmencie. **Queue** wysyła zamiast tego po turze. |
| `/compact`, `/context`, własne polecenia, skills | Wpisz `/`, aby zobaczyć listę poleceń | Polecenia Claude są przekazywane dosłownie (lista pochodzi z samego CLI). Codex nie ma poleceń tekstowych; `/compact`, `/review`, `/skills`, `/mcp` są mapowane na żądania app-server. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Polecenia platformy obsługiwane w przeglądarce lub przez kolejkę. |

Prośby o uprawnienia, o które CLI zapytałoby w terminalu, pojawiają się na stronie: zatwierdź jednorazowo lub odmów, a to samo wykonanie będzie kontynuowane. Tryb automatyczny to tryb samego CLI (Claude `auto`, Codex `auto_review`); Studiolo nigdy nie dodaje flag omijających ani stałych reguł zezwoleń. Wysiłek rozumowania i model można zmieniać przy każdej wiadomości w obrębie rozmowy (Claude `set_model` / `apply_flag_settings`, parametry `turn/start` w Codex).

---

## Wiele maszyn

Uruchom ten sam serwer na każdym komputerze; umieść `projects/` w folderze, który synchronizujesz (Syncthing lub dowolna synchronizacja plików). `.studio/events/` każdego projektu to niezmienny dziennik uporządkowany przyczynowo; maszyny online wymieniają się też dziennikami bezpośrednio, więc zmiany pojawiają się w ciągu sekund. Każda maszyna może wyświetlić każdą rozmowę; wykonanie zawsze odbywa się na maszynie, do której rozmowa jest przypisana, a natywne sesje CLI nigdy nie migrują.

**Dostęp do innych maszyn.** Najprostsza bezpieczna konfiguracja to [Tailscale](https://tailscale.com): umieść `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) i losowy `access-token.txt` (≥ 32 znaki) w katalogu stanu, uruchom normalnie, a Studiolo opublikuje swój port za pomocą `tailscale serve`; otwórz `http://<machine>:4310` i wpisz token jeden raz. Z `"trustTailnet":true` token jest pomijany dla ruchu z tailnetu. Bez Tailscale zbinduj serwer do prywatnego adresu przez `STUDIO_BIND` i ustaw `STUDIO_TOKEN`. Serwery odnajdują się nawzajem przez `projects/.servers/` lub przez ręczne parowanie w Settings.

**Autostart.** macOS: `node scripts/install-studio-macos.mjs` instaluje LaunchAgent (`net.studio-local.server`). Windows: zarejestruj `scripts/start-studio-windows.ps1` jako zadanie Harmonogramu zadań (akcja `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, uruchamianie przy logowaniu, bez zduplikowanych instancji, ponawianie co minutę); `scripts/restart-studio-windows.ps1` restartuje je po aktualizacji, gdy nie ma aktywnych uruchomień.

**Aktualizacja.** Pliki front-endu w `public/` są odczytywane przy każdym żądaniu i zaczynają działać zaraz po synchronizacji; zmiany w `src/` wymagają restartu na każdej maszynie.

---

## Artifacts i komentarze na stronie

Poproś agenta o stronę lub aplikację webową, a będzie on utrzymywał `studio.artifacts.json` w katalogu głównym projektu:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Strony statyczne pomijają `command`, `port` i `dataPaths`. Każdy Artifact dostaje własny trwały port podglądu i origin; `localStorage` podglądu jest zapisywany w projekcie i synchronizowany, więc gra zapisana na jednej maszynie jest kontynuowana na innej. Backendy działają jako zwykłe procesy lokalne (nie sandbox) z `PORT` i `HOST`; **Snapshot** zatrzymuje backend i kopiuje zadeklarowane ścieżki danych, **Restore** przywraca je na miejsce.

W podglądzie *zaznacz element, tekst lub obszar canvas* i napisz komentarz: staje się on zadaniem dla wybranego agenta, z zaznaczeniem jako dowodem (ścieżka DOM, cytowany tekst lub PNG z canvas). Komentarze do jednego Artifact wykonują się po kolei; różne Artifacts i rozmowy wykonują się równolegle. Zobacz `examples/persistent-game/` (backend Node + SQLite + Canvas) oraz `examples/artifact-compatibility/`.

---

## Pliki i konfiguracja

| Lokalizacja | Zawartość |
| --- | --- |
| `projects/<id>/` | Katalog roboczy projektu: kod, Artifacts, dane (synchronizowany) |
| `projects/<id>/.studio/events/` | Autorytatywny, niezmienny dziennik rozmów |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | Stan możliwy do odtworzenia i czytelna historia dla agentów |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Synchronizowany magazyn podglądu, migawki danych, dowody z komentarzy |
| `projects/<id>/uploads/` | Pliki upuszczone na czat lub do panelu zasobów |
| `projects/.servers/` | Publiczne adresy serwerów do wykrywania (bez sekretów) |
| `projects/.deleted/<id>.json` | Nagrobki usuniętych projektów (synchronizowane); folder odtworzony przez spóźnioną synchronizację jest usuwany ponownie |
| `~/.studio-local/` | Prywatne dla maszyny: tożsamość, `accounts.json`, `accounts/<id>/`, parowanie, ustawienia Tailscale — nigdy nie synchronizuj |
| `~/.studio-local/agent-profiles.json` | Opcjonalnie: ścieżka pliku wykonywalnego / env dla rodziny CLI (`claude`, `codex`) lub dla id konta |

Usunięcie projektu jest trwałe (archiwizacja pozostaje odwracalna) i jest odrzucane, dopóki praca jest w kolejce, w toku lub oczekuje. Serwer usuwający zapisuje nagrobek, a następnie usuwa cały folder `projects/<id>/`; Twoje narzędzie synchronizacji przenosi oba na pozostałe maszyny. Każdy serwer, widząc nowy nagrobek, usuwa swoją pozostałą kopię, rezydentne procesy agentów projektu i porty podglądu Artifacts oraz transkrypty Claude (`projects/<encoded path>*` w każdym katalogu konfiguracji) i rollouty Codex (dopasowane po `cwd` w pierwszej linii), których katalog roboczy znajdował się w projekcie. Obsłużone ID są zapisywane w `~/.studio-local/purged-projects.json`. Projekty miękko usunięte przez starsze wersje (`deletedAt`) są usuwane jednorazowo przy starcie.

---

## FAQ

**Czy używa mojego klucza API?** Tylko jeśli dodasz konto z kluczem API. Konta subskrypcyjne działają przez własne logowanie CLI; Studiolo nie przechowuje żadnych własnych danych uwierzytelniających.

**Czy wpłynie to na mój `claude` / `codex` w terminalu?** Nie. Konta Studiolo znajdują się we własnych katalogach; `~/.claude` i `~/.codex` są odczytywane tylko raz, aby skopiować ustawienia i podlinkować skills.

**Czy to sandbox?** Nie. Agenci i backendy Artifacts to Twoje własne procesy lokalne z Twoimi uprawnieniami, dokładnie jak CLI w terminalu.

**Czy mogę używać go z telefonu?** Tak, jako klienta w przeglądarce przez Tailscale; CLI działają na Twoich komputerach.

**Dlaczego zero zależności?** Serwer to czysty Node.js (ESM, tylko moduły `node:`), więc działa wszędzie tam, gdzie działa Node 22, i nic w łańcuchu dostaw nie stoi między Tobą a Twoimi CLI.

---

## Licencja

MIT — zobacz [LICENSE](../../LICENSE).
