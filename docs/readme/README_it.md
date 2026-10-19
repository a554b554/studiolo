<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · **Italiano** · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Un unico banco di lavoro per tutte le CLI di agenti di programmazione che paghi, su ogni tua macchina.

**Chatta con Claude Code e Codex dal browser, con account, macchine e cronologia dei progetti condivisi tra i tuoi computer.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Avvio rapido](#avvio-rapido) · [Account](#account-e-accesso) · [Chattare come nella CLI](#chattare-come-nella-cli) · [Più macchine](#più-macchine) · [Artifacts](#artifacts-e-commenti-nella-pagina) · [FAQ](#faq)

</div>

![Studiolo: una conversazione con un account Claude sulla workstation locale, l'utilizzo degli account a sinistra, i file del progetto e gli Artifacts a destra](../../docs/screenshot.png)

> Lo screenshot è una demo sintetica: account fittizi, risposte preimpostate.

---

## Installare con un agente di programmazione

Incolla questo in Claude Code, Codex o qualsiasi agente di programmazione in grado di eseguire comandi sulla macchina che vuoi usare:

```text
Installa Studiolo da https://github.com/a554b554/studiolo: clona il repository, verifica che Node.js 22.14+ sia disponibile e che le CLI `claude` e/o `codex` siano installate, esegui `node src/server.mjs` dalla radice del repository, conferma che http://127.0.0.1:4310 risponda, poi dimmi di aprire Settings → Hosts & accounts per accedere ai miei account. Non effettuare tu alcun accesso.
```

Oppure a mano:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo non ha dipendenze npm; `npm install` non è necessario. Test: `node --test test/*.test.mjs`.

---

## Che cos'è

Studiolo è un banco di lavoro web self-hosted che pilota le CLI **Claude Code** e **Codex** già installate sui tuoi computer. Non è l'ennesima interfaccia di chat sopra una chiave API:

- **I tuoi abbonamenti, le tue CLI.** Ogni richiesta passa per il vero processo `claude` o `codex` — stessi strumenti, skills, server MCP, modalità di permesso e comportamento dell'agente del terminale. Accesso con abbonamento o chiave API, a tua scelta per ogni account.
- **Account per macchina, gestiti da Studiolo.** Accedi a più account Claude e Codex su ogni computer dal browser. Ogni account ha la propria directory di configurazione della CLI isolata; nulla tocca i tuoi `~/.claude` o `~/.codex` personali. La quota di ogni account è mostrata in tempo reale.
- **Un'unica cronologia dei progetti su tutte le macchine.** I progetti risiedono in una cartella che sincronizzi come preferisci (per esempio con Syncthing). La cronologia delle conversazioni è un journal append-only che si unisce in modo deterministico; ogni macchina esegue lo stesso server e serve la stessa cronologia. Una conversazione viene eseguita sulla macchina che hai scelto per lei; puoi leggerla e continuarla da qualsiasi macchina.
- **L'esperienza del terminale, nel browser.** Interrompi un turno con Esc, guida un agente in esecuzione con un messaggio successivo, digita `/` per i comandi slash della CLI stessa — tutto mappato sui protocolli nativi, non reimplementato.
- **Artifacts e commenti nella pagina.** Le app web costruite dagli agenti girano come Artifacts con backend persistenti e storage sincronizzato; seleziona qualcosa nell'anteprima e invialo a un agente come attività.

---

## Avvio rapido

1. **Prerequisiti** — Node.js 22.14+ e la CLI `claude` e/o `codex` installata sulla macchina (`claude --version`, `codex --version`).
2. **Esegui** `node src/server.mjs` e apri <http://127.0.0.1:4310>.
3. **Aggiungi account** — Settings → *Hosts & accounts* → *Add account*. Scegli la macchina, il tipo (Claude Code / Codex) e il metodo di accesso, poi segui i passaggi mostrati (vedi sotto).
4. **Crea un progetto, avvia una conversazione** — il compositore sceglie **macchina → account → modello → sforzo → modalità di permesso**. Il primo messaggio fissa macchina, account e modello per quella conversazione; sforzo e permessi possono cambiare a ogni messaggio.

Variabili d'ambiente: `STUDIO_STATE_DIR` (stato privato della macchina, predefinito `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (byte, predefinito 100 MB). Un server per directory di stato.

---

## Account e accesso

Gli account appartengono a una macchina e vengono creati dal browser. Ogni account è una directory in `~/.studio-local/accounts/<id>/`, usata come `CLAUDE_CONFIG_DIR` o `CODEX_HOME`, così più account della stessa CLI coesistono e l'accesso del tuo terminale non viene mai toccato. Quando si crea un account, Studiolo popola quella directory a partire dalla tua directory CLI predefinita — copia `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) e crea collegamenti a `skills`, `plugins` e simili — così gli agenti mantengono le skills e i server MCP che già usi. Le credenziali non vengono mai copiate.

| Tipo | Metodo | Cosa succede |
| --- | --- | --- |
| Claude Code | **Abbonamento** | Studiolo esegue `claude auth login`; apri il link, accedi e incolli il codice di autorizzazione nella pagina. |
| Claude Code | **Chiave API Anthropic** | La chiave è salvata nella directory dell'account (modalità 0600) e passata come `ANTHROPIC_API_KEY`; verificata tramite l'handshake della CLI, scartata se rifiutata. Pagamento a consumo, senza finestre di quota. |
| Codex | **ChatGPT** | Codice dispositivo tramite l'app-server di Codex: la pagina mostra un link e un codice monouso; accedi da qualsiasi browser, la pagina si aggiorna al termine. |
| Codex | **Chiave API OpenAI** | Salvata da Codex stesso nel `CODEX_HOME` dell'account. |

Dopo l'accesso Studiolo legge l'identità dell'account (e-mail, piano) e l'elenco dei modelli direttamente dalla CLI — senza consumare alcuna richiesta al modello — e, per Claude, i comandi slash della CLI per il completamento automatico del compositore. Un account senza nome personalizzato viene rinominato con la sua e-mail, così il compositore, l'intestazione della conversazione, ogni risposta e il pannello di utilizzo indicano chi sta parlando. Gli account possono essere rinominati, aggiornati, disconnessi (`claude auth logout` / `codex logout`) o rimossi; una conversazione il cui account è stato rimosso può continuare con un altro account sulla stessa macchina.

Il pannello di utilizzo (in basso a sinistra) segue la macchina scelta nel compositore: gli abbonamenti Claude mostrano la finestra di 5 ore, Codex quella settimanale, gli account con chiave API sono fatturati a consumo. Legge gli endpoint di utilizzo delle CLI stesse (`get_usage`, `account/rateLimits/read`), mantiene una cache di 60 s, non fa mai polling e non avvia mai una CLI per un account disconnesso.

Tutto questo funziona anche per le macchine remote: scegli un altro host online in *Hosts & accounts* e le richieste vengono inoltrate a esso.

---

## Chattare come nella CLI

Ogni conversazione possiede un processo nativo residente — Claude Code tramite `stream-json` bidirezionale, Codex tramite `app-server` — così l'agente si comporta esattamente come nel terminale. I controlli web sono mappati sui protocolli nativi:

| Nel terminale | In Studiolo | Come |
| --- | --- | --- |
| Esc per fermare | **■ Stop** o Esc nel compositore | Richiesta di controllo `interrupt` di Claude / `turn/interrupt` di Codex. Il processo e la sessione nativa sopravvivono; la risposta parziale viene conservata; i messaggi successivi continuano la stessa sessione. |
| Scrivere mentre l'agente lavora | Inviare durante un turno = **Steer** | Claude lo legge al successivo confine tra strumenti; Codex `turn/steer`. Mostrato come *You · steer*; la risposta continua in un nuovo segmento. **Queue** invece invia dopo il turno. |
| `/compact`, `/context`, comandi personalizzati, skills | Digita `/` per l'elenco dei comandi | I comandi di Claude vengono passati alla lettera (l'elenco arriva dalla CLI stessa). Codex non ha comandi testuali; `/compact`, `/review`, `/skills`, `/mcp` sono mappati su richieste app-server. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Comandi della piattaforma gestiti nel browser o dalla coda. |

Le richieste di permesso che la CLI farebbe nel terminale compaiono nella pagina: approva una volta o nega, e la stessa esecuzione continua. La modalità automatica è quella della CLI stessa (Claude `auto`, Codex `auto_review`); Studiolo non aggiunge mai flag di bypass né regole di autorizzazione permanenti. Lo sforzo di ragionamento e il modello possono cambiare a ogni messaggio all'interno di una conversazione (Claude `set_model` / `apply_flag_settings`, parametri `turn/start` di Codex).

---

## Più macchine

Esegui lo stesso server su ogni computer; metti `projects/` in una cartella che sincronizzi (Syncthing o qualsiasi sincronizzazione di file). Il `.studio/events/` di ogni progetto è un journal immutabile con ordinamento causale; le macchine online si scambiano anche i journal direttamente, così le modifiche compaiono in pochi secondi. Qualsiasi macchina può mostrare ogni conversazione; l'esecuzione avviene sempre sulla macchina a cui la conversazione è legata, e le sessioni CLI native non migrano mai.

**Raggiungere le altre macchine.** La configurazione sicura più semplice è [Tailscale](https://tailscale.com): metti `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) e un `access-token.txt` casuale (≥ 32 caratteri) nella directory di stato, avvia normalmente e Studiolo pubblica la sua porta con `tailscale serve`; apri `http://<machine>:4310` e inserisci il token una volta. Con `"trustTailnet":true` il token non viene richiesto per il traffico della tailnet. Senza Tailscale, effettua il bind su un indirizzo privato con `STUDIO_BIND` e imposta `STUDIO_TOKEN`. I server si individuano a vicenda tramite `projects/.servers/` o con l'abbinamento manuale in Settings.

**Avvio automatico.** macOS: `node scripts/install-studio-macos.mjs` installa un LaunchAgent (`net.studio-local.server`). Windows: registra `scripts/start-studio-windows.ps1` come attività dell'Utilità di pianificazione (azione `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, esecuzione all'accesso, nessuna istanza duplicata, nuovo tentativo ogni minuto); `scripts/restart-studio-windows.ps1` la riavvia dopo un aggiornamento non appena non ci sono esecuzioni attive.

**Aggiornamento.** I file front-end in `public/` vengono letti a ogni richiesta e hanno effetto non appena vengono sincronizzati; le modifiche in `src/` richiedono un riavvio su ogni macchina.

---

## Artifacts e commenti nella pagina

Chiedi a un agente una pagina o un'app web e manterrà `studio.artifacts.json` nella radice del progetto:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Le pagine statiche omettono `command`, `port` e `dataPaths`. Ogni Artifact ottiene la propria porta di anteprima persistente e la propria origin; il `localStorage` dell'anteprima viene salvato nel progetto e sincronizzato, così una partita salvata su una macchina continua su un'altra. I backend girano come normali processi locali (non una sandbox) con `PORT` e `HOST`; **Snapshot** ferma il backend e copia i percorsi dei dati dichiarati, **Restore** li rimette al loro posto.

Nell'anteprima, *seleziona un elemento, del testo o una regione del canvas* e scrivi un commento: diventa un'attività per l'agente che scegli, con la selezione come prova (percorso DOM, testo citato o un PNG del canvas). I commenti su uno stesso Artifact vengono eseguiti in ordine; Artifacts e conversazioni diversi vengono eseguiti in parallelo. Vedi `examples/persistent-game/` (backend Node + SQLite + Canvas) e `examples/artifact-compatibility/`.

---

## File e configurazione

| Percorso | Contenuto |
| --- | --- |
| `projects/<id>/` | Directory di lavoro del progetto: codice, Artifacts, dati (sincronizzata) |
| `projects/<id>/.studio/events/` | Journal delle conversazioni autorevole e immutabile |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | Stato ricostruibile e cronologia leggibile per gli agenti |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Storage di anteprima sincronizzato, snapshot dei dati, prove dei commenti |
| `projects/<id>/uploads/` | File trascinati nella chat o nel pannello delle risorse |
| `projects/.servers/` | Indirizzi pubblici dei server per l'individuazione (nessun segreto) |
| `projects/.deleted/<id>.json` | Lapidi dei progetti eliminati (sincronizzate); una cartella ricreata da una sincronizzazione tardiva viene rimossa di nuovo |
| `~/.studio-local/` | Privato della macchina: identità, `accounts.json`, `accounts/<id>/`, abbinamenti, impostazioni Tailscale — non sincronizzare mai |
| `~/.studio-local/agent-profiles.json` | Facoltativo: percorso dell'eseguibile / env per famiglia di CLI (`claude`, `codex`) o per id di account |

L'eliminazione di un progetto è definitiva (l'archiviazione resta reversibile) e viene rifiutata finché ci sono lavori in coda, in esecuzione o in attesa. Il server che elimina scrive una lapide, poi rimuove l'intera cartella `projects/<id>/`; il tuo strumento di sincronizzazione porta entrambe le cose sulle altre macchine. Ogni server, vedendo una nuova lapide, rimuove la propria copia residua, i processi agente residenti del progetto e le porte di anteprima degli Artifacts, oltre alle trascrizioni di Claude (`projects/<encoded path>*` in ogni directory di configurazione) e ai rollout di Codex (riconosciuti dal `cwd` nella prima riga) la cui directory di lavoro si trovava all'interno del progetto. Gli ID gestiti vengono registrati in `~/.studio-local/purged-projects.json`. I progetti eliminati in modo soft dalle versioni precedenti (`deletedAt`) vengono rimossi una volta all'avvio.

---

## FAQ

**Usa la mia chiave API?** Solo se aggiungi un account con chiave API. Gli account in abbonamento passano per l'accesso proprio delle CLI; Studiolo non memorizza credenziali proprie.

**Il mio `claude` / `codex` del terminale ne risentirà?** No. Gli account di Studiolo risiedono in directory proprie; `~/.claude` e `~/.codex` vengono letti una sola volta per copiare le impostazioni e collegare le skills.

**È una sandbox?** No. Gli agenti e i backend degli Artifacts sono i tuoi processi locali con i tuoi permessi, esattamente come le CLI in un terminale.

**Posso usarlo dal telefono?** Sì, come client browser tramite Tailscale; le CLI girano sui tuoi computer.

**Perché zero dipendenze?** Il server è Node.js puro (ESM, solo moduli `node:`), quindi gira ovunque giri Node 22 e nulla nella supply chain si frappone tra te e le tue CLI.

---

## Licenza

MIT — vedi [LICENSE](../../LICENSE).
