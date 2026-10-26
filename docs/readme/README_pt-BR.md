<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · **Português (Brasil)** · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Uma só bancada para todas as CLIs de agentes de programação que você paga, em todas as suas máquinas.

**Converse com o Claude Code e o Codex pelo navegador, com contas, máquinas e histórico de projetos compartilhados entre seus computadores.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Início rápido](#início-rápido) · [Contas](#contas-e-login) · [Converse como na CLI](#converse-como-na-cli) · [Várias máquinas](#várias-máquinas) · [Artifacts](#artifacts-e-comentários-na-página) · [Perguntas frequentes](#perguntas-frequentes)

</div>

![Studiolo: uma conversa com uma conta Claude na estação de trabalho local, uso das contas à esquerda, arquivos do projeto e Artifacts à direita](../../docs/screenshot.png)

> A captura de tela é uma demonstração sintética: contas fictícias, respostas roteirizadas.

---

## Instalar com um agente de programação

Cole isto no Claude Code, no Codex ou em qualquer agente de programação capaz de executar comandos na máquina que você quer usar:

```text
Instale o Studiolo a partir de https://github.com/a554b554/studiolo: clone o repositório, verifique se o Node.js 22.14+ está disponível e se as CLIs `claude` e/ou `codex` estão instaladas, execute `node src/server.mjs` na raiz do repositório, confirme que http://127.0.0.1:4310 responde e então me diga para abrir Settings → Hosts & accounts para fazer login nas minhas contas. Não faça login em nada você mesmo.
```

Ou manualmente:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

O Studiolo não tem dependências npm; `npm install` não é necessário. Testes: `node --test test/*.test.mjs`.

---

## O que é

O Studiolo é uma bancada web auto-hospedada que controla as CLIs **Claude Code** e **Codex** já instaladas nos seus computadores. Não é mais uma interface de chat sobre uma chave de API:

- **Suas assinaturas, suas CLIs.** Cada requisição passa pelo processo real `claude` ou `codex` — as mesmas ferramentas, skills, servidores MCP, modos de permissão e comportamento de agente do terminal. Login por assinatura ou chave de API, à sua escolha para cada conta.
- **Contas por máquina, gerenciadas pelo Studiolo.** Faça login em várias contas Claude e Codex em cada computador pelo navegador. Cada conta tem seu próprio diretório de configuração da CLI isolado; nada toca nos seus `~/.claude` ou `~/.codex` pessoais. A cota de cada conta é exibida em tempo real.
- **Um só histórico de projetos em todas as máquinas.** Os projetos ficam em uma pasta que você sincroniza como preferir (Syncthing, por exemplo). O histórico de conversas é um journal somente de anexação que se mescla de forma determinística; cada máquina roda o mesmo servidor e serve o mesmo histórico. Uma conversa é executada na máquina que você escolheu para ela; você pode lê-la e continuá-la a partir de qualquer uma delas.
- **A experiência do terminal, no navegador.** Interrompa um turno com Esc, direcione um agente em execução com uma mensagem de acompanhamento, digite `/` para os comandos de barra da própria CLI — tudo mapeado para os protocolos nativos, não reimplementado.
- **Artifacts e comentários na página.** Os aplicativos web que os agentes constroem rodam como Artifacts com backends persistentes e armazenamento sincronizado; selecione algo na pré-visualização e envie a um agente como tarefa.

---

## Início rápido

1. **Pré-requisitos** — Node.js 22.14+ e a CLI `claude` e/ou `codex` instalada na máquina (`claude --version`, `codex --version`).
2. **Execute** `node src/server.mjs` e abra <http://127.0.0.1:4310>.
3. **Adicione contas** — Settings → *Hosts & accounts* → *Add account*. Escolha a máquina, o tipo (Claude Code / Codex) e o método de login, depois siga os passos exibidos (veja abaixo).
4. **Crie um projeto, inicie uma conversa** — o compositor escolhe **máquina → conta → modelo → esforço → modo de permissão**. A primeira mensagem fixa a máquina e a conta daquela conversa; modelo, esforço e permissões podem mudar a cada mensagem. Outro modelo continua a mesma sessão nativa, e o primeiro turno nele relê o contexto sem o cache do prompt.

Variáveis de ambiente: `STUDIO_STATE_DIR` (estado privado da máquina, padrão `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (bytes, padrão 100 MB). Um servidor por diretório de estado.

---

## Contas e login

As contas pertencem a uma máquina e são criadas pelo navegador. Cada conta é um diretório em `~/.studio-local/accounts/<id>/`, usado como `CLAUDE_CONFIG_DIR` ou `CODEX_HOME`, de modo que várias contas de uma mesma CLI coexistem e o login próprio do seu terminal nunca é tocado. Quando uma conta é criada, o Studiolo preenche esse diretório a partir do seu diretório padrão da CLI — copia `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) e cria links para `skills`, `plugins` e afins — para que os agentes mantenham as skills e os servidores MCP que você já usa. Credenciais nunca são copiadas.

| Tipo | Método | O que acontece |
| --- | --- | --- |
| Claude Code | **Assinatura** | O Studiolo executa `claude auth login`; você abre o link, faz login e cola o código de autorização de volta na página. |
| Claude Code | **Chave de API da Anthropic** | A chave é armazenada no diretório da conta (modo 0600) e passada como `ANTHROPIC_API_KEY`; verificada pelo handshake da CLI, descartada se for rejeitada. Pagamento por uso, sem janelas de cota. |
| Codex | **ChatGPT** | Código de dispositivo via app-server do Codex: a página mostra um link e um código de uso único; faça login em qualquer navegador, a página se atualiza ao concluir. |
| Codex | **Chave de API da OpenAI** | Armazenada pelo próprio Codex no `CODEX_HOME` da conta. |

Após o login, o Studiolo lê a identidade da conta (e-mail, plano) e a lista de modelos diretamente da CLI — sem gastar nenhuma requisição de modelo — e, para o Claude, os comandos de barra da CLI para o preenchimento automático do compositor. Uma conta sem nome personalizado é renomeada para o seu e-mail, para que o compositor, o cabeçalho da conversa, cada resposta e o painel de uso mostrem quem está falando. As contas podem ser renomeadas, atualizadas, desconectadas (`claude auth logout` / `codex logout`) ou removidas; uma conversa cuja conta foi removida pode continuar com outra conta na mesma máquina.

O painel de uso (canto inferior esquerdo) acompanha a máquina escolhida no compositor: assinaturas Claude mostram a janela de 5 horas, Codex a semanal, contas com chave de API são cobradas por uso. Ele lê os próprios endpoints de uso das CLIs (`get_usage`, `account/rateLimits/read`), mantém cache por 60 s, nunca faz polling e nunca inicia uma CLI para uma conta desconectada.

Tudo isso também funciona para máquinas remotas: escolha outro host online em *Hosts & accounts* e as requisições são repassadas a ele.

---

## Converse como na CLI

Cada conversa tem um processo nativo residente — Claude Code via `stream-json` bidirecional, Codex via `app-server` — para que o agente se comporte exatamente como no terminal. Os controles web são mapeados para os protocolos nativos:

| No terminal | No Studiolo | Como |
| --- | --- | --- |
| Esc para parar | **■ Stop** ou Esc no compositor | Requisição de controle `interrupt` do Claude / `turn/interrupt` do Codex. O processo e a sessão nativa sobrevivem; a resposta parcial é mantida; mensagens seguintes continuam a mesma sessão. |
| Digitar enquanto o agente trabalha | Enviar durante um turno = **Steer** | O Claude lê na próxima fronteira de ferramenta; Codex `turn/steer`. Exibido como *You · steer*; a resposta continua em um novo segmento. **Queue** envia depois do turno. |
| `/compact`, `/context`, comandos personalizados, skills | Digite `/` para a lista de comandos | Os comandos do Claude são repassados literalmente (a lista vem da própria CLI). O Codex não tem comandos de texto; `/compact`, `/review`, `/skills`, `/mcp` são mapeados para requisições do app-server. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Comandos da plataforma tratados no navegador ou pela fila. |

Pedidos de permissão que a CLI faria no terminal aparecem na página: aprove uma vez ou negue, e a mesma execução continua. O modo automático é o da própria CLI (Claude `auto`, Codex `auto_review`); o Studiolo nunca adiciona flags de bypass nem regras de permissão permanentes. O esforço de raciocínio e o modelo podem mudar a cada mensagem dentro de uma conversa (Claude `set_model` / `apply_flag_settings`, parâmetros de `turn/start` do Codex).

---

## Várias máquinas

Execute o mesmo servidor em cada computador; coloque `projects/` em uma pasta que você sincroniza (Syncthing ou qualquer sincronização de arquivos). O `.studio/events/` de cada projeto é um journal imutável, ordenado causalmente; máquinas online também trocam journals diretamente, para que as mudanças apareçam em segundos. Qualquer máquina pode exibir todas as conversas; a execução sempre acontece na máquina à qual a conversa está vinculada, e sessões nativas da CLI nunca migram.

**Acessando outras máquinas.** A configuração segura mais simples é o [Tailscale](https://tailscale.com): coloque `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) e um `access-token.txt` aleatório (≥ 32 caracteres) no diretório de estado, inicie normalmente e o Studiolo publica sua porta com `tailscale serve`; abra `http://<machine>:4310` e informe o token uma vez. Com `"trustTailnet":true`, o token é dispensado para o tráfego do tailnet. Sem Tailscale, vincule a um endereço privado com `STUDIO_BIND` e defina `STUDIO_TOKEN`. Os servidores se descobrem via `projects/.servers/` ou por pareamento manual em Settings.

**Inicialização automática.** macOS: `node scripts/install-studio-macos.mjs` instala um LaunchAgent (`net.studio-local.server`). Windows: registre `scripts/start-studio-windows.ps1` como tarefa do Agendador de Tarefas (ação `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, executar no logon, sem instâncias duplicadas, nova tentativa a cada minuto); `scripts/restart-studio-windows.ps1` a reinicia após uma atualização assim que não houver execuções ativas.

**Atualizando.** Arquivos de front-end em `public/` são lidos a cada requisição e entram em vigor assim que sincronizam; mudanças em `src/` exigem reinicialização em cada máquina.

---

## Artifacts e comentários na página

Peça a um agente uma página ou aplicativo web e ele mantém `studio.artifacts.json` na raiz do projeto:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Páginas estáticas omitem `command`, `port` e `dataPaths`. Cada Artifact recebe sua própria porta de pré-visualização persistente e sua própria origem; o `localStorage` da pré-visualização é persistido no projeto e sincronizado, então um jogo salvo em uma máquina continua em outra. Os backends rodam como processos locais comuns (não um sandbox) com `PORT` e `HOST`; **Snapshot** para o backend e copia os caminhos de dados declarados, **Restore** os coloca de volta.

Na pré-visualização, *selecione um elemento, um texto ou uma região do canvas* e escreva um comentário: ele vira uma tarefa para o agente que você escolher, com a seleção como evidência (caminho DOM, texto citado ou um PNG do canvas). Comentários em um mesmo Artifact rodam em ordem; Artifacts e conversas diferentes rodam em paralelo. Veja `examples/persistent-game/` (backend Node + SQLite + Canvas) e `examples/artifact-compatibility/`.

---

## Arquivos e configuração

| Local | Conteúdo |
| --- | --- |
| `projects/<id>/` | Diretório de trabalho do projeto: código, Artifacts, dados (sincronizado) |
| `projects/<id>/.studio/events/` | Journal de conversas oficial e imutável |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | Estado reconstruível e histórico legível para agentes |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Armazenamento de pré-visualização sincronizado, snapshots de dados, evidências de comentários |
| `projects/<id>/uploads/` | Arquivos soltos no chat ou no painel de recursos |
| `projects/.servers/` | Endereços públicos dos servidores para descoberta (sem segredos) |
| `projects/.deleted/<id>.json` | Lápides de projetos excluídos (sincronizadas); uma pasta recriada por uma sincronização atrasada é removida de novo |
| `~/.studio-local/` | Privado da máquina: identidade, `accounts.json`, `accounts/<id>/`, pareamento, configurações do Tailscale — nunca sincronize |
| `~/.studio-local/agent-profiles.json` | Opcional: caminho do executável / env por família de CLI (`claude`, `codex`) ou por id de conta |

Excluir um projeto é permanente (arquivar continua reversível) e é recusado enquanto houver trabalho na fila, em execução ou aguardando. O servidor que exclui grava uma lápide e depois remove toda a pasta `projects/<id>/`; sua ferramenta de sincronização leva ambos para as outras máquinas. Cada servidor, ao ver uma nova lápide, remove sua cópia restante, os processos de agente residentes do projeto e as portas de pré-visualização dos Artifacts, além das transcrições do Claude (`projects/<encoded path>*` em cada diretório de configuração) e dos rollouts do Codex (identificados pelo `cwd` da primeira linha) cujo diretório de trabalho estava dentro do projeto. Os IDs tratados são registrados em `~/.studio-local/purged-projects.json`. Projetos excluídos de forma reversível por versões anteriores (`deletedAt`) são removidos uma vez na inicialização.

---

## Perguntas frequentes

**Ele usa minha chave de API?** Somente se você adicionar uma conta com chave de API. Contas por assinatura passam pelo login próprio das CLIs; o Studiolo não armazena credenciais próprias.

**Meu `claude` / `codex` do terminal será afetado?** Não. As contas do Studiolo ficam em seus próprios diretórios; `~/.claude` e `~/.codex` são lidos apenas uma vez para copiar configurações e criar links para as skills.

**Isto é um sandbox?** Não. Os agentes e os backends dos Artifacts são seus próprios processos locais com suas permissões, exatamente como as CLIs em um terminal.

**Posso usar pelo celular?** Sim, como cliente de navegador via Tailscale; as CLIs rodam nos seus computadores.

**Por que zero dependências?** O servidor é Node.js puro (ESM, apenas módulos `node:`), então roda em qualquer lugar onde o Node 22 roda e nada na cadeia de suprimentos fica entre você e suas CLIs.

---

## Licença

MIT — veja [LICENSE](../../LICENSE).
