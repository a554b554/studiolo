<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · **Deutsch** · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Eine Werkbank für jede Coding-Agent-CLI, für die du bezahlst, auf jedem Rechner, den du besitzt.

**Chatte mit Claude Code und Codex im Browser – Konten, Rechner und Projektverlauf werden zwischen deinen Computern geteilt.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Schnellstart](#schnellstart) · [Konten](#konten-und-anmeldung) · [Chatten wie in der CLI](#chatten-wie-in-der-cli) · [Mehrere Rechner](#mehrere-rechner) · [Artifacts](#artifacts-und-kommentare-in-der-seite) · [FAQ](#faq)

</div>

![Studiolo: ein Gespräch mit einem Claude-Konto auf der lokalen Workstation, Kontonutzung links, Projektdateien und Artifacts rechts](../../docs/screenshot.png)

> Der Screenshot ist eine synthetische Demo: fiktive Konten, vorgeschriebene Antworten.

---

## Installation mit einem Coding-Agent

Füge Folgendes in Claude Code, Codex oder einen beliebigen Coding-Agent ein, der auf dem gewünschten Rechner Befehle ausführen kann:

```text
Installiere Studiolo von https://github.com/a554b554/studiolo: Klone das Repository, stelle sicher, dass Node.js 22.14+ verfügbar ist und die CLIs `claude` und/oder `codex` installiert sind, führe `node src/server.mjs` im Wurzelverzeichnis des Repositorys aus, prüfe, dass http://127.0.0.1:4310 antwortet, und sag mir dann, dass ich Settings → Hosts & accounts öffnen soll, um meine Konten anzumelden. Melde selbst keine Konten an.
```

Oder von Hand:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo hat keine npm-Abhängigkeiten; `npm install` ist nicht nötig. Tests: `node --test test/*.test.mjs`.

---

## Was es ist

Studiolo ist eine selbst gehostete Web-Werkbank, die die bereits auf deinen Computern installierten CLIs **Claude Code** und **Codex** steuert. Es ist keine weitere Chat-Oberfläche über einem API-Schlüssel:

- **Deine Abos, deine CLIs.** Jede Anfrage läuft über den echten `claude`- bzw. `codex`-Prozess – dieselben Tools, Skills, MCP-Server, Berechtigungsmodi und dasselbe Agent-Verhalten wie im Terminal. Anmeldung per Abo oder API-Schlüssel, frei wählbar pro Konto.
- **Konten pro Rechner, verwaltet von Studiolo.** Melde mehrere Claude- und Codex-Konten auf jedem Computer direkt aus dem Browser an. Jedes Konto erhält sein eigenes, isoliertes CLI-Konfigurationsverzeichnis; dein persönliches `~/.claude` oder `~/.codex` bleibt unberührt. Das Kontingent jedes Kontos wird live angezeigt.
- **Ein Projektverlauf über alle Rechner.** Projekte liegen in einem Ordner, den du beliebig synchronisierst (zum Beispiel mit Syncthing). Der Gesprächsverlauf ist ein reines Anhänge-Journal, das deterministisch zusammengeführt wird; jeder Rechner führt denselben Server aus und liefert denselben Verlauf. Ein Gespräch wird auf dem Rechner ausgeführt, den du dafür gewählt hast; lesen und fortsetzen kannst du es von jedem aus.
- **Das Terminal-Erlebnis im Browser.** Stoppe einen Turn mit Esc, lenke einen laufenden Agent mit einer Folgenachricht, tippe `/` für die eigenen Slash-Befehle der CLI – alles auf die nativen Protokolle abgebildet, nicht nachgebaut.
- **Artifacts und Kommentare in der Seite.** Web-Apps, die die Agents bauen, laufen als Artifacts mit persistenten Backends und synchronisiertem Speicher; markiere etwas in der Vorschau und schicke es einem Agent als Aufgabe.

---

## Schnellstart

1. **Voraussetzungen** – Node.js 22.14+ sowie die CLI `claude` und/oder `codex` auf dem Rechner installiert (`claude --version`, `codex --version`).
2. **Starte** `node src/server.mjs` und öffne <http://127.0.0.1:4310>.
3. **Konten hinzufügen** – Settings → *Hosts & accounts* → *Add account*. Wähle den Rechner, den Typ (Claude Code / Codex) und die Anmeldemethode und folge dann den angezeigten Schritten (siehe unten).
4. **Projekt anlegen, Gespräch beginnen** – im Eingabefeld wählst du **Rechner → Konto → Modell → Effort → Berechtigungsmodus**. Die erste Nachricht legt Rechner, Konto und Modell für dieses Gespräch fest; Effort und Berechtigungen lassen sich pro Nachricht ändern.

Umgebungsvariablen: `STUDIO_STATE_DIR` (rechnerprivater Zustand, Standard `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (Bytes, Standard 100 MB). Ein Server pro Zustandsverzeichnis.

---

## Konten und Anmeldung

Konten gehören zu einem Rechner und werden im Browser angelegt. Jedes Konto ist ein Verzeichnis unter `~/.studio-local/accounts/<id>/`, das als `CLAUDE_CONFIG_DIR` oder `CODEX_HOME` verwendet wird. So können mehrere Konten derselben CLI nebeneinander bestehen, und die eigene Anmeldung deines Terminals wird nie angetastet. Beim Anlegen eines Kontos befüllt Studiolo dieses Verzeichnis aus deinem Standard-CLI-Verzeichnis – es kopiert `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) und verlinkt `skills`, `plugins` und Ähnliches –, sodass Agents die Skills und MCP-Server behalten, die du bereits nutzt. Zugangsdaten werden nie kopiert.

| Typ | Methode | Was passiert |
| --- | --- | --- |
| Claude Code | **Abo** | Studiolo führt `claude auth login` aus; du öffnest den Link, meldest dich an und fügst den Autorisierungscode wieder in die Seite ein. |
| Claude Code | **Anthropic-API-Schlüssel** | Der Schlüssel wird im Kontoverzeichnis gespeichert (mode 0600) und als `ANTHROPIC_API_KEY` übergeben; er wird über den CLI-Handshake geprüft und bei Ablehnung verworfen. Abrechnung nach Verbrauch, keine Kontingentfenster. |
| Codex | **ChatGPT** | Gerätecode über den Codex app-server: Die Seite zeigt einen Link und einen Einmalcode; melde dich in einem beliebigen Browser an, die Seite aktualisiert sich danach. |
| Codex | **OpenAI-API-Schlüssel** | Wird von Codex selbst im `CODEX_HOME` des Kontos gespeichert. |

Nach der Anmeldung liest Studiolo die Identität des Kontos (E-Mail, Tarif) und die Modellliste direkt aus der CLI – ohne eine einzige Modellanfrage zu verbrauchen – und bei Claude zusätzlich die Slash-Befehle der CLI für die Autovervollständigung im Eingabefeld. Ein Konto ohne eigenen Namen wird nach seiner E-Mail benannt, sodass Eingabefeld, Gesprächskopf, jede Antwort und das Nutzungspanel zeigen, wer spricht. Konten lassen sich umbenennen, aktualisieren, abmelden (`claude auth logout` / `codex logout`) oder entfernen; ein Gespräch, dessen Konto entfernt wurde, kann mit einem anderen Konto auf demselben Rechner fortgesetzt werden.

Das Nutzungspanel (unten links) folgt dem im Eingabefeld gewählten Rechner: Claude-Abos zeigen das 5-Stunden-Fenster, Codex das wöchentliche, API-Schlüssel-Konten werden nach Verbrauch abgerechnet. Es liest die eigenen Nutzungs-Endpunkte der CLIs (`get_usage`, `account/rateLimits/read`), cacht 60 s lang, pollt nie und startet nie eine CLI für ein abgemeldetes Konto.

All das funktioniert auch für entfernte Rechner: Wähle in *Hosts & accounts* einen anderen Online-Host, und die Anfragen werden an ihn weitergeleitet.

---

## Chatten wie in der CLI

Jedes Gespräch besitzt einen residenten nativen Prozess – Claude Code über bidirektionales `stream-json`, Codex über `app-server` –, sodass sich der Agent genau wie im Terminal verhält. Die Web-Bedienelemente bilden die nativen Protokolle ab:

| Im Terminal | In Studiolo | Wie |
| --- | --- | --- |
| Esc zum Stoppen | **■ Stop** oder Esc im Eingabefeld | Claude-Steueranfrage `interrupt` / Codex `turn/interrupt`. Prozess und native Sitzung bleiben bestehen; die Teilantwort bleibt erhalten; spätere Nachrichten setzen dieselbe Sitzung fort. |
| Tippen, während der Agent arbeitet | Senden während eines laufenden Turns = **Steer** | Claude liest die Nachricht an der nächsten Tool-Grenze; Codex `turn/steer`. Angezeigt als *You · steer*; die Antwort geht in einem neuen Segment weiter. **Queue** sendet stattdessen nach dem Turn. |
| `/compact`, `/context`, eigene Befehle, Skills | `/` tippen für die Befehlsliste | Claude-Befehle werden unverändert durchgereicht (die Liste stammt von der CLI selbst). Codex hat keine Textbefehle; `/compact`, `/review`, `/skills`, `/mcp` werden auf app-server-Anfragen abgebildet. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Plattformbefehle, die im Browser oder von der Warteschlange behandelt werden. |

Berechtigungsanfragen, die die CLI im Terminal stellen würde, erscheinen in der Seite: einmal erlauben oder ablehnen, und dieselbe Ausführung läuft weiter. Der Auto-Modus ist der eigene der CLI (Claude `auto`, Codex `auto_review`); Studiolo fügt nie Bypass-Flags oder dauerhafte Erlaubnisregeln hinzu. Reasoning-Effort und Modell lassen sich innerhalb eines Gesprächs pro Nachricht ändern (Claude `set_model` / `apply_flag_settings`, Codex-Parameter von `turn/start`).

---

## Mehrere Rechner

Führe auf jedem Computer denselben Server aus; lege `projects/` in einen synchronisierten Ordner (Syncthing oder eine beliebige Dateisynchronisation). Das `.studio/events/` jedes Projekts ist ein unveränderliches, kausal geordnetes Journal; Rechner, die online sind, tauschen Journale zusätzlich direkt aus, sodass Änderungen innerhalb von Sekunden erscheinen. Jeder Rechner kann jedes Gespräch anzeigen; ausgeführt wird immer auf dem Rechner, an den das Gespräch gebunden ist, und native CLI-Sitzungen wandern nie.

**Andere Rechner erreichen.** Die einfachste sichere Einrichtung ist [Tailscale](https://tailscale.com): Lege `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) und eine zufällige `access-token.txt` (≥ 32 Zeichen) ins Zustandsverzeichnis, starte wie gewohnt, und Studiolo veröffentlicht seinen Port mit `tailscale serve`; öffne `http://<machine>:4310` und gib das Token einmal ein. Mit `"trustTailnet":true` entfällt das Token für Tailnet-Verkehr. Ohne Tailscale bindest du mit `STUDIO_BIND` an eine private Adresse und setzt `STUDIO_TOKEN`. Server finden einander über `projects/.servers/` oder durch manuelles Pairing in Settings.

**Autostart.** macOS: `node scripts/install-studio-macos.mjs` installiert einen LaunchAgent (`net.studio-local.server`). Windows: Registriere `scripts/start-studio-windows.ps1` als Task-Scheduler-Aufgabe (Aktion `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, Ausführung bei Anmeldung, keine doppelten Instanzen, Wiederholung jede Minute); `scripts/restart-studio-windows.ps1` startet sie nach einem Upgrade neu, sobald keine Läufe mehr aktiv sind.

**Upgrades.** Frontend-Dateien unter `public/` werden pro Anfrage gelesen und wirken, sobald sie synchronisiert sind; Änderungen unter `src/` erfordern einen Neustart auf jedem Rechner.

---

## Artifacts und Kommentare in der Seite

Bitte einen Agent um eine Webseite oder App, und er pflegt `studio.artifacts.json` im Projektstamm:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Statische Seiten lassen `command`, `port` und `dataPaths` weg. Jedes Artifact erhält einen eigenen, dauerhaften Vorschau-Port und Origin; der `localStorage` der Vorschau wird im Projekt persistiert und synchronisiert, sodass ein auf einem Rechner gespeichertes Spiel auf einem anderen weitergeht. Backends laufen als gewöhnliche lokale Prozesse (keine Sandbox) mit `PORT` und `HOST`; **Snapshot** stoppt das Backend und kopiert die deklarierten Datenpfade, **Restore** legt sie zurück.

Markiere in der Vorschau *ein Element, Text oder einen Canvas-Bereich* und schreibe einen Kommentar: Er wird zur Aufgabe für den Agent deiner Wahl, mit der Auswahl als Beleg (DOM-Pfad, zitierter Text oder ein PNG des Canvas). Kommentare zu einem Artifact laufen der Reihe nach; verschiedene Artifacts und Gespräche laufen parallel. Siehe `examples/persistent-game/` (Node-Backend + SQLite + Canvas) und `examples/artifact-compatibility/`.

---

## Dateien und Konfiguration

| Ort | Inhalt |
| --- | --- |
| `projects/<id>/` | Arbeitsverzeichnis des Projekts: Code, Artifacts, Daten (synchronisiert) |
| `projects/<id>/.studio/events/` | Maßgebliches, unveränderliches Gesprächsjournal |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | Wiederherstellbarer Zustand und lesbarer Verlauf für Agents |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Synchronisierter Vorschauspeicher, Daten-Snapshots, Kommentarbelege |
| `projects/<id>/uploads/` | In den Chat oder den Ressourcenbereich gezogene Dateien |
| `projects/.servers/` | Öffentliche Serveradressen zur Erkennung (keine Geheimnisse) |
| `projects/.deleted/<id>.json` | Grabsteine gelöschter Projekte (synchronisiert); ein durch verspätete Synchronisation neu angelegter Ordner wird erneut entfernt |
| `~/.studio-local/` | Rechnerprivat: Identität, `accounts.json`, `accounts/<id>/`, Pairing, Tailscale-Einstellungen – nie synchronisieren |
| `~/.studio-local/agent-profiles.json` | Optional: Pfad zur ausführbaren Datei / env pro CLI-Familie (`claude`, `codex`) oder pro Konto-ID |

Das Löschen eines Projekts ist endgültig (Archivieren bleibt umkehrbar) und wird verweigert, solange Arbeit in der Warteschlange steht, läuft oder wartet. Der löschende Server schreibt einen Grabstein und entfernt dann den gesamten Ordner `projects/<id>/`; dein Sync-Tool überträgt beides auf die anderen Rechner. Jeder Server entfernt beim Sehen eines neuen Grabsteins seine verbliebene Kopie, die residenten Agent-Prozesse und Artifact-Vorschau-Ports des Projekts sowie die Claude-Transkripte (`projects/<encoded path>*` in jedem Konfigurationsverzeichnis) und Codex-Rollouts (zugeordnet über das `cwd` in ihrer ersten Zeile), deren Arbeitsverzeichnis innerhalb des Projekts lag. Bearbeitete IDs werden in `~/.studio-local/purged-projects.json` festgehalten. Projekte, die von älteren Versionen weich gelöscht wurden (`deletedAt`), werden einmalig beim Start entfernt.

---

## FAQ

**Verwendet es meinen API-Schlüssel?** Nur wenn du ein API-Schlüssel-Konto hinzufügst. Abo-Konten laufen über die eigene Anmeldung der CLIs; Studiolo speichert keine eigenen Zugangsdaten.

**Wird mein `claude` / `codex` im Terminal beeinflusst?** Nein. Studiolo-Konten liegen in eigenen Verzeichnissen; `~/.claude` und `~/.codex` werden nur einmal gelesen, um Einstellungen zu kopieren und Skills zu verlinken.

**Ist das eine Sandbox?** Nein. Agents und Artifact-Backends sind deine eigenen lokalen Prozesse mit deinen Berechtigungen, genau wie die CLIs im Terminal.

**Kann ich es vom Handy aus nutzen?** Ja, als Browser-Client über Tailscale; die CLIs laufen auf deinen Computern.

**Warum null Abhängigkeiten?** Der Server ist reines Node.js (ESM, nur `node:`-Module), läuft also überall, wo Node 22 läuft, und nichts aus der Lieferkette steht zwischen dir und deinen CLIs.

---

## Lizenz

MIT – siehe [LICENSE](../../LICENSE).
