<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · **Español** · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md)

# Studiolo

### Un solo banco de trabajo para cada CLI de agente de programación que pagas, en cada máquina que tienes.

**Chatea con Claude Code y Codex desde un navegador, con las cuentas, las máquinas y el historial de proyectos compartidos entre tus ordenadores.**

[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero npm dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)](../../package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-6f42c1)](../../test)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](../../LICENSE)

[Inicio rápido](#inicio-rápido) · [Cuentas](#cuentas-e-inicio-de-sesión) · [Chatear como en la CLI](#chatear-como-en-la-cli) · [Varias máquinas](#varias-máquinas) · [Artifacts](#artifacts-y-comentarios-en-la-página) · [Preguntas frecuentes](#preguntas-frecuentes)

</div>

![Studiolo: una conversación con una cuenta de Claude en la estación de trabajo local, el uso de las cuentas a la izquierda, los archivos del proyecto y los Artifacts a la derecha](../../docs/screenshot.png)

> La captura de pantalla es una demo sintética: cuentas ficticias, respuestas guionizadas.

---

## Instalar con un agente de programación

Pega esto en Claude Code, Codex o cualquier agente de programación que pueda ejecutar comandos en la máquina que quieres usar:

```text
Instala Studiolo desde https://github.com/a554b554/studiolo: clona el repositorio, asegúrate de que Node.js 22.14+ esté disponible y de que las CLI `claude` y/o `codex` estén instaladas, ejecuta `node src/server.mjs` desde la raíz del repositorio, confirma que http://127.0.0.1:4310 responde y luego dime que abra Settings → Hosts & accounts para iniciar sesión en mis cuentas. No inicies sesión en ninguna cuenta por tu cuenta.
```

O a mano:

```sh
git clone https://github.com/a554b554/studiolo studiolo && cd studiolo
node src/server.mjs        # http://127.0.0.1:4310
```

Studiolo no tiene dependencias de npm; no hace falta `npm install`. Tests: `node --test test/*.test.mjs`.

---

## Qué es

Studiolo es un banco de trabajo web autoalojado que controla las CLI de **Claude Code** y **Codex** ya instaladas en tus ordenadores. No es otra interfaz de chat más sobre una clave de API:

- **Tus suscripciones, tus CLI.** Cada petición pasa por el proceso real de `claude` o `codex`: las mismas herramientas, skills, servidores MCP, modos de permisos y comportamiento del agente que en la terminal. Inicio de sesión por suscripción o clave de API, a elegir en cada cuenta.
- **Cuentas por máquina, gestionadas por Studiolo.** Inicia sesión en varias cuentas de Claude y Codex en cada ordenador desde el navegador. Cada cuenta tiene su propio directorio de configuración de la CLI, aislado; nada toca tu `~/.claude` ni tu `~/.codex` personales. La cuota de cada cuenta se muestra en tiempo real.
- **Un único historial de proyectos entre máquinas.** Los proyectos viven en una carpeta que sincronizas como prefieras (con Syncthing, por ejemplo). El historial de conversaciones es un diario de solo anexado que se fusiona de forma determinista; cada máquina ejecuta el mismo servidor y sirve el mismo historial. Una conversación se ejecuta en la máquina que elegiste para ella; puedes leerla y continuarla desde cualquiera.
- **La experiencia de la terminal, en el navegador.** Detén un turno con Esc, reorienta un agente en marcha con un mensaje de seguimiento, escribe `/` para los propios comandos de barra de la CLI: todo se asigna a los protocolos nativos, no se reimplementa.
- **Artifacts y comentarios en la página.** Las aplicaciones web que construyen los agentes se ejecutan como Artifacts con backends persistentes y almacenamiento sincronizado; selecciona algo en la vista previa y envíaselo a un agente como tarea.

---

## Inicio rápido

1. **Requisitos previos**: Node.js 22.14+ y la CLI `claude` y/o `codex` instalada en la máquina (`claude --version`, `codex --version`).
2. **Ejecuta** `node src/server.mjs` y abre <http://127.0.0.1:4310>.
3. **Añade cuentas**: Settings → *Hosts & accounts* → *Add account*. Elige la máquina, el tipo (Claude Code / Codex) y el método de inicio de sesión, y sigue los pasos que se muestran (ver más abajo).
4. **Crea un proyecto, empieza una conversación**: el compositor elige **máquina → cuenta → modelo → effort → modo de permisos**. El primer mensaje fija la máquina y la cuenta de esa conversación; el modelo, el effort y los permisos pueden cambiar en cada mensaje. Otro modelo continúa la misma sesión nativa, y su primer turno vuelve a leer el contexto sin la caché del prompt.

Variables de entorno: `STUDIO_STATE_DIR` (estado privado de la máquina, por defecto `~/.studio-local`), `STUDIO_BIND`, `STUDIO_PORT` (4310), `STUDIO_PREVIEW_PORT` (4311), `STUDIO_TOKEN`, `STUDIO_UPLOAD_LIMIT` (bytes, por defecto 100 MB). Un servidor por directorio de estado.

---

## Cuentas e inicio de sesión

Las cuentas pertenecen a una máquina y se crean desde el navegador. Cada cuenta es un directorio bajo `~/.studio-local/accounts/<id>/`, usado como `CLAUDE_CONFIG_DIR` o `CODEX_HOME`, de modo que varias cuentas de una misma CLI conviven y el inicio de sesión propio de tu terminal nunca se toca. Al crear una cuenta, Studiolo inicializa ese directorio a partir de tu directorio de CLI por defecto: copia `settings.json` / `CLAUDE.md` (Codex: `config.toml` / `AGENTS.md`) y enlaza `skills`, `plugins` y similares, para que los agentes conserven las skills y los servidores MCP que ya usas. Las credenciales nunca se copian.

| Tipo | Método | Qué ocurre |
| --- | --- | --- |
| Claude Code | **Suscripción** | Studiolo ejecuta `claude auth login`; abres el enlace, inicias sesión y pegas el código de autorización de vuelta en la página. |
| Claude Code | **Clave de API de Anthropic** | La clave se guarda en el directorio de la cuenta (mode 0600) y se pasa como `ANTHROPIC_API_KEY`; se verifica mediante el handshake de la CLI y se descarta si es rechazada. Pago por uso, sin ventanas de cuota. |
| Codex | **ChatGPT** | Código de dispositivo mediante el app-server de Codex: la página muestra un enlace y un código de un solo uso; inicia sesión desde cualquier navegador y la página se actualiza al terminar. |
| Codex | **Clave de API de OpenAI** | La guarda el propio Codex en el `CODEX_HOME` de la cuenta. |

Tras iniciar sesión, Studiolo lee la identidad de la cuenta (correo, plan) y la lista de modelos directamente de la CLI, sin gastar ninguna petición al modelo, y en el caso de Claude, también los comandos de barra de la CLI para el autocompletado del compositor. Una cuenta sin nombre personalizado pasa a llamarse como su correo, de modo que el compositor, la cabecera de la conversación, cada respuesta y el panel de uso indican quién está hablando. Las cuentas se pueden renombrar, actualizar, cerrar sesión (`claude auth logout` / `codex logout`) o eliminar; una conversación cuya cuenta se eliminó puede continuar con otra cuenta de la misma máquina.

El panel de uso (abajo a la izquierda) sigue a la máquina elegida en el compositor: las suscripciones de Claude muestran la ventana de 5 horas, Codex la semanal, y las cuentas con clave de API se facturan por uso. Lee los propios endpoints de uso de las CLI (`get_usage`, `account/rateLimits/read`), guarda en caché durante 60 s, nunca hace sondeos y nunca inicia una CLI para una cuenta con la sesión cerrada.

Todo esto funciona también con máquinas remotas: elige otro host en línea en *Hosts & accounts* y las peticiones se le retransmiten.

---

## Chatear como en la CLI

Cada conversación posee un proceso nativo residente (Claude Code mediante `stream-json` bidireccional, Codex mediante `app-server`), así que el agente se comporta exactamente igual que en la terminal. Los controles web se asignan a los protocolos nativos:

| En la terminal | En Studiolo | Cómo |
| --- | --- | --- |
| Esc para detener | **■ Stop** o Esc en el compositor | Petición de control `interrupt` de Claude / `turn/interrupt` de Codex. El proceso y la sesión nativa sobreviven; la respuesta parcial se conserva; los mensajes posteriores continúan la misma sesión. |
| Escribir mientras el agente trabaja | Enviar mientras se ejecuta un turno = **Steer** | Claude lo lee en el siguiente límite de herramienta; Codex usa `turn/steer`. Se muestra como *You · steer*; la respuesta continúa en un nuevo segmento. **Queue**, en cambio, lo envía después del turno. |
| `/compact`, `/context`, comandos personalizados, skills | Escribe `/` para ver la lista de comandos | Los comandos de Claude se pasan tal cual (la lista viene de la propia CLI). Codex no tiene comandos de texto; `/compact`, `/review`, `/skills`, `/mcp` se asignan a peticiones de app-server. |
| — | `/model`, `/effort`, `/mode`, `/rename`, `/new`, `/status`, `/clear`, `/stop`, `/help` | Comandos de la plataforma, gestionados en el navegador o por la cola. |

Las solicitudes de permiso que la CLI haría en la terminal aparecen en la página: aprueba esta vez o deniega, y la misma ejecución continúa. El modo automático es el propio de la CLI (Claude `auto`, Codex `auto_review`); Studiolo nunca añade flags de omisión ni reglas de permiso permanentes. El effort de razonamiento y el modelo pueden cambiar en cada mensaje dentro de una conversación (Claude `set_model` / `apply_flag_settings`, parámetros de `turn/start` en Codex).

Mientras un turno se ejecuta, la conversación muestra el trabajo como lo hacen las CLI: lo que el agente dice entre pasos se mantiene completo, las llamadas a herramientas consecutivas se agrupan en una línea desplegable y el paso en curso y el tiempo transcurrido siguen a la vista; cuando llega la respuesta, toda la ejecución se pliega en su raw log. Un mensaje enviado aparece al instante y se entrega en segundo plano (si falla, se puede reintentar). En la barra lateral, un indicador giratorio marca las conversaciones y proyectos que están trabajando, y un punto marca los resultados que aún no has visto.

---

## Varias máquinas

Ejecuta el mismo servidor en cada ordenador; pon `projects/` en una carpeta que sincronices (Syncthing o cualquier sincronización de archivos). El `.studio/events/` de cada proyecto es un diario inmutable con orden causal; las máquinas que están en línea también intercambian diarios directamente, de modo que los cambios aparecen en cuestión de segundos. Cualquier máquina puede mostrar todas las conversaciones; la ejecución siempre ocurre en la máquina a la que está vinculada la conversación, y las sesiones nativas de la CLI nunca migran.

**Acceder a otras máquinas.** La configuración segura más sencilla es [Tailscale](https://tailscale.com): coloca `tailnet.json` (`{"enabled":true,"command":"tailscale"}`) y un `access-token.txt` aleatorio (≥ 32 caracteres) en el directorio de estado, arranca normalmente y Studiolo publica su puerto con `tailscale serve`; abre `http://<machine>:4310` e introduce el token una vez. Con `"trustTailnet":true` se omite el token para el tráfico del tailnet. Sin Tailscale, enlaza a una dirección privada con `STUDIO_BIND` y define `STUDIO_TOKEN`. Los servidores se descubren entre sí a través de `projects/.servers/` o mediante emparejamiento manual en Settings.

**Arranque automático.** macOS: `node scripts/install-studio-macos.mjs` instala un LaunchAgent (`net.studio-local.server`). Windows: registra `scripts/start-studio-windows.ps1` como tarea del Task Scheduler (acción `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>`, ejecutar al iniciar sesión, sin instancias duplicadas, reintentar cada minuto); `scripts/restart-studio-windows.ps1` la reinicia tras una actualización en cuanto no haya ejecuciones activas.

**Actualizaciones.** Los archivos de front-end en `public/` se leen en cada petición y surten efecto en cuanto se sincronizan; los cambios en `src/` requieren un reinicio en cada máquina.

---

## Artifacts y comentarios en la página

Pide a un agente una página web o una aplicación y mantendrá `studio.artifacts.json` en la raíz del proyecto:

```json
{
  "artifacts": [
    { "key": "game", "name": "Click the target", "root": "game", "entry": "index.html",
      "command": ["node", "server.mjs"], "port": 4320, "dataPaths": ["game/data"] }
  ]
}
```

Las páginas estáticas omiten `command`, `port` y `dataPaths`. Cada Artifact obtiene su propio puerto de vista previa y origin persistentes; el `localStorage` de la vista previa se persiste en el proyecto y se sincroniza, así que una partida guardada en una máquina continúa en otra. Los backends se ejecutan como procesos locales normales (no en un sandbox) con `PORT` y `HOST`; **Snapshot** detiene el backend y copia las rutas de datos declaradas, **Restore** las devuelve a su sitio.

En la vista previa, *selecciona un elemento, un texto o una región del canvas* y escribe un comentario: se convierte en una tarea para el agente que elijas, con la selección como evidencia (ruta DOM, texto citado o un PNG del canvas). Los comentarios sobre un mismo Artifact se ejecutan en orden; Artifacts y conversaciones distintos se ejecutan en paralelo. Consulta `examples/persistent-game/` (backend en Node + SQLite + Canvas) y `examples/artifact-compatibility/`.

---

## Archivos y configuración

| Ubicación | Contenido |
| --- | --- |
| `projects/<id>/` | Directorio de trabajo del proyecto: código, Artifacts, datos (sincronizado) |
| `projects/<id>/.studio/events/` | Diario de conversaciones autoritativo e inmutable |
| `projects/<id>/.studio/state.json`, `history-index.md`, `sessions/`, `artifacts/` | Estado reconstruible e historial legible para los agentes |
| `projects/<id>/.studio/artifact-storage/`, `snapshots/`, `attachments/` | Almacenamiento de vista previa sincronizado, instantáneas de datos, evidencias de comentarios |
| `projects/<id>/uploads/` | Archivos soltados en el chat o en el panel de recursos |
| `projects/.servers/` | Direcciones públicas de los servidores para el descubrimiento (sin secretos) |
| `projects/.deleted/<id>.json` | Lápidas de proyectos eliminados (sincronizadas); una carpeta recreada por una sincronización tardía se vuelve a eliminar |
| `~/.studio-local/` | Privado de la máquina: identidad, `accounts.json`, `accounts/<id>/`, emparejamiento, ajustes de Tailscale; nunca lo sincronices |
| `~/.studio-local/agent-profiles.json` | Opcional: ruta del ejecutable / env por familia de CLI (`claude`, `codex`) o por id de cuenta |

Eliminar un proyecto es permanente (archivar sigue siendo reversible) y se rechaza mientras haya trabajo en cola, en ejecución o en espera. El servidor que elimina escribe una lápida y después borra toda la carpeta `projects/<id>/`; tu herramienta de sincronización lleva ambas cosas a las demás máquinas. Cada servidor, al ver una lápida nueva, elimina su copia restante, los procesos de agente residentes y los puertos de vista previa de Artifacts del proyecto, y las transcripciones de Claude (`projects/<encoded path>*` en cada directorio de configuración) y los rollouts de Codex (identificados por el `cwd` de su primera línea) cuyo directorio de trabajo estaba dentro del proyecto. Los ID procesados se registran en `~/.studio-local/purged-projects.json`. Los proyectos eliminados de forma lógica por versiones anteriores (`deletedAt`) se eliminan una vez al arrancar.

---

## Preguntas frecuentes

**¿Usa mi clave de API?** Solo si añades una cuenta con clave de API. Las cuentas de suscripción funcionan mediante el inicio de sesión propio de las CLI; Studiolo no guarda credenciales propias.

**¿Se verán afectados mis `claude` / `codex` de la terminal?** No. Las cuentas de Studiolo viven en sus propios directorios; `~/.claude` y `~/.codex` solo se leen una vez para copiar los ajustes y enlazar las skills.

**¿Es un sandbox?** No. Los agentes y los backends de los Artifacts son tus propios procesos locales con tus permisos, exactamente como las CLI en una terminal.

**¿Puedo usarlo desde el móvil?** Sí, como cliente de navegador a través de Tailscale; las CLI se ejecutan en tus ordenadores.

**¿Por qué cero dependencias?** El servidor es Node.js puro (ESM, solo módulos `node:`), así que funciona en cualquier sitio donde funcione Node 22 y nada de la cadena de suministro se interpone entre tú y tus CLI.

---

## Licencia

MIT: consulta [LICENSE](../../LICENSE).
