<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · **Français** · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Un seul atelier pour toutes les CLI d'agents de codage que vous payez, sur toutes vos machines.

**Discutez avec Claude Code et Codex depuis un navigateur, avec les comptes, les machines et l'historique des projets partagés entre vos ordinateurs.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Démarrage rapide](#démarrage-rapide) · [Comptes](#comptes-et-connexion) · [Comme dans la CLI](#discuter-comme-dans-la-cli) · [Multi-machine](#multi-machine) · [Artifacts](#artifacts-et-commentaires-dans-la-page) · [FAQ](#faq)

</div>

![Studiolo : une conversation avec un compte Claude sur le poste local, l'utilisation des comptes à gauche, les fichiers du projet et les Artifacts à droite](../../docs/screenshot.png)

> La capture d'écran est une démo synthétique : comptes fictifs, réponses scriptées.

---

## Installer avec un agent de codage

Collez ceci dans Claude Code, Codex ou tout agent de codage capable d'exécuter des commandes sur la machine que vous voulez utiliser :

```text
Installe Studiolo depuis https://github.com/a554b554/studiolo : clone le dépôt, vérifie que Node.js 22.14+ est disponible et que les CLI `claude` et/ou `codex` sont installées, lance `node src/server.mjs` depuis la racine du dépôt, confirme que http://127.0.0.1:4310 répond, puis dis-moi d'ouvrir Settings → Hosts & accounts pour connecter mes comptes. Ne connecte aucun compte toi-même.
```

Ou à la main :

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo n'a aucune dépendance npm ; `npm install` n'est pas nécessaire. Tests : `node --test test/*.test.mjs`.

---

## Présentation

Studiolo est un atelier web auto-hébergé qui pilote les CLI **Claude Code** et **Codex** déjà installées sur vos ordinateurs. Ce n'est pas une énième interface de chat au-dessus d'une clé API :

- **Vos abonnements, vos CLI.** Chaque requête passe par le vrai processus `claude` ou `codex` — mêmes outils, skills, serveurs MCP, modes de permission et comportement d'agent que dans le terminal. Connexion par abonnement ou clé API, au choix pour chaque compte.
- **Des comptes par machine, gérés par Studiolo.** Connectez plusieurs comptes Claude et Codex sur chaque ordinateur depuis le navigateur. Chaque compte dispose de son propre répertoire de configuration CLI isolé ; rien ne touche à vos `~/.claude` ou `~/.codex` personnels. Le quota de chaque compte est affiché en direct.
- **Un seul historique de projet sur toutes les machines.** Les projets vivent dans un dossier que vous synchronisez comme vous le souhaitez (Syncthing, par exemple). L'historique des conversations est un journal en ajout seul qui fusionne de manière déterministe ; chaque machine exécute le même serveur et sert le même historique. Une conversation s'exécute sur la machine que vous avez choisie pour elle ; vous pouvez la lire et la poursuivre depuis n'importe laquelle.
- **L'expérience du terminal, dans le navigateur.** Arrêtez un tour avec Échap, orientez un agent en cours d'exécution avec un message de suivi, tapez `/` pour les commandes slash propres à la CLI — le tout mappé sur les protocoles natifs, pas réimplémenté.
- **Artifacts et commentaires dans la page.** Les applications web construites par les agents tournent comme des Artifacts avec des backends persistants et un stockage synchronisé ; sélectionnez un élément dans l'aperçu et envoyez-le à un agent comme tâche.

---

## Démarrage rapide

1. **Prérequis** — Node.js 22.14+, et la CLI `claude` et/ou `codex` installée sur la machine (`claude --version`, `codex --version`).
2. **Lancez** `node src/server.mjs` et ouvrez <http://127.0.0.1:4310>.
3. **Ajoutez des comptes** — Settings → *Hosts & accounts* → *Add account*. Choisissez la machine, le type (Claude Code / Codex) et la méthode de connexion, puis suivez les étapes affichées (voir ci-dessous).
4. **Créez un projet, démarrez une conversation** — le compositeur sélectionne **machine → compte → modèle → effort → mode de permission**. Le premier message fixe la machine, le compte et le modèle de cette conversation ; l'effort et les permissions peuvent changer à chaque message.

Variables d'environnement : `STUDIO_STATE_DIR` (état privé de la machine, par défaut `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (octets, 100 Mo par défaut). Un serveur par répertoire d'état.

---

## Comptes et connexion

Les comptes appartiennent à une machine et sont créés depuis le navigateur. Chaque compte est un répertoire sous `~/.studio-local/accounts/<id>/`, utilisé comme `CLAUDE_CONFIG_DIR` ou `CODEX_HOME`, de sorte que plusieurs comptes d'une même CLI coexistent et que la connexion propre à votre terminal n'est jamais touchée. À la création d'un compte, Studiolo initialise ce répertoire à partir de votre répertoire CLI par défaut — il copie `settings.json` / `CLAUDE.md` (Codex : `config.toml` / `AGENTS.md`) et crée des liens vers `skills`, `plugins` et consorts — afin que les agents conservent les skills et serveurs MCP que vous utilisez déjà. Les identifiants ne sont jamais copiés.

| Type | Méthode | Ce qui se passe |
| --- | --- | --- |
| Claude Code | **Abonnement** | Studiolo exécute `claude auth login` ; vous ouvrez le lien, vous vous connectez, puis collez le code d'autorisation dans la page. |
| Claude Code | **Clé API Anthropic** | La clé est stockée dans le répertoire du compte (mode 0600) et transmise comme `ANTHROPIC_API_KEY` ; vérifiée via le handshake de la CLI, supprimée si elle est rejetée. Paiement à l'usage, sans fenêtres de quota. |
| Codex | **ChatGPT** | Code d'appareil via l'app-server de Codex : la page affiche un lien et un code à usage unique ; connectez-vous depuis n'importe quel navigateur, la page se met à jour une fois terminé. |
| Codex | **Clé API OpenAI** | Stockée par Codex lui-même dans le `CODEX_HOME` du compte. |

Après la connexion, Studiolo lit l'identité du compte (e-mail, offre) et la liste des modèles directement depuis la CLI — sans consommer de requête de modèle — et, pour Claude, les commandes slash de la CLI pour l'autocomplétion du compositeur. Un compte sans nom personnalisé est renommé d'après son e-mail, pour que le compositeur, l'en-tête de conversation, chaque réponse et le panneau d'utilisation indiquent qui parle. Les comptes peuvent être renommés, actualisés, déconnectés (`claude auth logout` / `codex logout`) ou supprimés ; une conversation dont le compte a été supprimé peut continuer avec un autre compte sur la même machine.

Le panneau d'utilisation (en bas à gauche) suit la machine choisie dans le compositeur : les abonnements Claude affichent la fenêtre de 5 heures, Codex la fenêtre hebdomadaire, les comptes par clé API sont facturés à l'usage. Il lit les endpoints d'utilisation propres aux CLI (`get_usage`, `account/rateLimits/read`), met en cache pendant 60 s, n'interroge jamais en boucle et ne lance jamais de CLI pour un compte déconnecté.

Tout cela fonctionne aussi pour les machines distantes : choisissez un autre hôte en ligne dans *Hosts & accounts* et les requêtes lui sont relayées.

---

## Discuter comme dans la CLI

Chaque conversation possède un processus natif résident — Claude Code via `stream-json` bidirectionnel, Codex via `app-server` — de sorte que l'agent se comporte exactement comme dans le terminal. Les contrôles web sont mappés sur les protocoles natifs :

| Dans le terminal | Dans Studiolo | Comment |
| --- | --- | --- |
| Échap pour arrêter | **■ Stop** ou Échap dans le compositeur | Requête de contrôle `interrupt` de Claude / `turn/interrupt` de Codex. Le processus et la session native survivent ; la réponse partielle est conservée ; les messages suivants poursuivent la même session. |
| Taper pendant que l'agent travaille | Envoyer pendant un tour = **Steer** | Claude le lit à la prochaine frontière d'outil ; Codex `turn/steer`. Affiché comme *You · steer* ; la réponse continue dans un nouveau segment. **Queue** envoie plutôt après le tour. |
| `/compact`, `/context`, commandes personnalisées, skills | Tapez `/` pour la liste des commandes | Les commandes Claude sont transmises telles quelles (la liste vient de la CLI elle-même). Codex n'a pas de commandes texte ; `/compact`, `/review`, `/skills`, `/mcp` sont mappées sur des requêtes app-server. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Commandes de la plateforme gérées dans le navigateur ou par la file d'attente. |

Les demandes de permission que la CLI poserait dans le terminal apparaissent dans la page : approuvez une fois ou refusez, et la même exécution continue. Le mode automatique est celui de la CLI (Claude `auto`, Codex `auto_review`) ; Studiolo n'ajoute jamais d'options de contournement ni de règles d'autorisation permanentes. L'effort de raisonnement et le modèle peuvent changer à chaque message au sein d'une conversation (Claude `set_model` / `apply_flag_settings`, paramètres `turn/start` de Codex).

---

## Multi-machine

Exécutez le même serveur sur chaque ordinateur ; placez `projects/` dans un dossier que vous synchronisez (Syncthing ou n'importe quel outil de synchronisation de fichiers). Le `.studio/events/` de chaque projet est un journal immuable, ordonné causalement ; les machines en ligne échangent aussi directement leurs journaux, si bien que les changements apparaissent en quelques secondes. N'importe quelle machine peut afficher toutes les conversations ; l'exécution a toujours lieu sur la machine à laquelle la conversation est liée, et les sessions CLI natives ne migrent jamais.

**Atteindre les autres machines.** La configuration sécurisée la plus simple est [Tailscale](https://tailscale.com) : placez `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) et un `access-token.txt` aléatoire (≥ 32 caractères) dans le répertoire d'état, démarrez normalement, et Studiolo publie son port avec `tailscale serve` ; ouvrez `http://<machine>:4310` et saisissez le jeton une fois. Avec `"trustTailnet":true`, le jeton n'est pas demandé pour le trafic du tailnet. Sans Tailscale, liez le serveur à une adresse privée avec `STUDIO_BIND` et définissez `STUDIO_TOKEN`. Les serveurs se découvrent mutuellement via `projects/.servers/` ou par appairage manuel dans Settings.

**Démarrage automatique.** macOS : `node scripts/install-studio-macos.mjs` installe un LaunchAgent (`net.studio-local.server`). Windows : enregistrez `scripts/start-studio-windows.ps1` comme tâche du Planificateur de tâches (action `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, exécution à l'ouverture de session, pas d'instances en double, nouvelle tentative chaque minute) ; `scripts/restart-studio-windows.ps1` la redémarre après une mise à niveau dès qu'aucune exécution n'est active.

**Mise à niveau.** Les fichiers front-end sous `public/` sont lus à chaque requête et prennent effet dès qu'ils sont synchronisés ; les modifications sous `src/` nécessitent un redémarrage sur chaque machine.

---

## Artifacts et commentaires dans la page

Demandez une page ou une application web à un agent et il maintient `studio.artifacts.json` à la racine du projet :

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Les pages statiques omettent `command`, `port` et `dataPaths`. Chaque Artifact obtient son propre port d'aperçu persistant et sa propre origine ; le `localStorage` de l'aperçu est persisté dans le projet et synchronisé, de sorte qu'une partie sauvegardée sur une machine se poursuit sur une autre. Les backends tournent comme de simples processus locaux (pas un bac à sable) avec `PORT` et `HOST` ; **Snapshot** arrête le backend et copie les chemins de données déclarés, **Restore** les remet en place.

Dans l'aperçu, *sélectionnez un élément, du texte ou une zone du canvas* et écrivez un commentaire : il devient une tâche pour l'agent de votre choix, avec la sélection comme preuve (chemin DOM, texte cité ou PNG du canvas). Les commentaires sur un même Artifact s'exécutent dans l'ordre ; des Artifacts et des conversations différents s'exécutent en parallèle. Voir `examples/persistent-game/` (backend Node + SQLite + Canvas) et `examples/artifact-compatibility/`.

---

## Fichiers et configuration

| Emplacement | Contenu |
| --- | --- |
| `projects/<id>/` | Répertoire de travail du projet : code, Artifacts, données (synchronisé) |
| `projects/<id>/.studio/events/` | Journal de conversation faisant autorité, immuable |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | État reconstructible et historique lisible pour les agents |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Stockage d'aperçu synchronisé, instantanés de données, preuves des commentaires |
| `projects/<id>/uploads/` | Fichiers déposés dans le chat ou le panneau des ressources |
| `projects/.servers/` | Adresses publiques des serveurs pour la découverte (aucun secret) |
| `projects/.deleted/<id>.json` | Pierres tombales des projets supprimés (synchronisées) ; un dossier recréé par une synchronisation tardive est de nouveau supprimé |
| `~/.studio-local/` | Privé à la machine : identité, `accounts.json`, `accounts/<id>/`, appairage, paramètres Tailscale — ne jamais synchroniser |
| `~/.studio-local/agent-profiles.json` | Facultatif : chemin d'exécutable / env par famille de CLI (`claude`, `codex`) ou par id de compte |

La suppression d'un projet est définitive (l'archivage reste réversible) et est refusée tant que du travail est en file d'attente, en cours ou en attente. Le serveur qui supprime écrit une pierre tombale, puis supprime tout le dossier `projects/<id>/` ; votre outil de synchronisation propage les deux vers les autres machines. Chaque serveur, en voyant une nouvelle pierre tombale, supprime sa copie restante, les processus d'agent résidents du projet et les ports d'aperçu des Artifacts, ainsi que les transcriptions Claude (`projects/<encoded path>*` dans chaque répertoire de configuration) et les rollouts Codex (identifiés par le `cwd` de leur première ligne) dont le répertoire de travail se trouvait dans le projet. Les ID traités sont enregistrés dans `~/.studio-local/purged-projects.json`. Les projets supprimés en douceur par les anciennes versions (`deletedAt`) sont supprimés une fois au démarrage.

---

## FAQ

**Utilise-t-il ma clé API ?** Uniquement si vous ajoutez un compte par clé API. Les comptes par abonnement passent par la connexion propre aux CLI ; Studiolo ne stocke aucun identifiant de son côté.

**Mon `claude` / `codex` du terminal sera-t-il affecté ?** Non. Les comptes Studiolo vivent dans leurs propres répertoires ; `~/.claude` et `~/.codex` ne sont lus qu'une fois pour copier les paramètres et lier les skills.

**Est-ce un bac à sable ?** Non. Les agents et les backends des Artifacts sont vos propres processus locaux avec vos permissions, exactement comme les CLI dans un terminal.

**Puis-je l'utiliser depuis mon téléphone ?** Oui, comme client navigateur via Tailscale ; les CLI tournent sur vos ordinateurs.

**Pourquoi zéro dépendance ?** Le serveur est du Node.js pur (ESM, uniquement des modules `node:`), il tourne donc partout où Node 22 tourne et rien dans la chaîne d'approvisionnement ne s'interpose entre vous et vos CLI.

---

## Licence

MIT — voir [LICENSE](../../LICENSE).
