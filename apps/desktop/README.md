# SmartTV Desktop (Windows, Electron)

Aplicativo Windows próprio: Home em tela cheia estilo smart TV + área de
conteúdo integrada para os serviços de streaming, sem abrir o Edge.

## Arquitetura (antes → depois)

Antes: `iPhone → /controle (Vercel) → Render → agente → Edge → TV`.
Depois (etapa 1, este app): o app Electron **substitui o Edge como tela**:
Home própria + `WebContentsView` sandboxed por serviço, sessão persistente,
navegação por allowlist. **Nada da infra remota foi alterado**: `/controle`,
Render, agente e extensão continuam intactos (ver "Controle pelo iPhone").

```
┌ Electron (fullscreen) ─────────────────────────┐
│ barra slim: ⌂ Início + status            (local│preload mínima)
│ ┌ Home (local, preload smartv API)  ─────────┐ │
│ │ YouTube Netflix HBO Disney+ (setas + Enter) │ │
│ └─────────────────────────────────────────────┘ │
│ ┌ Serviço (WebContentsView, SEM preload) ─────┐ │
│ │ youtube.com/tv, netflix.com… (sessão        │ │
│ │ persistente, allowlist, sem popups)         │ │
│ └─────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┘
```

Decisões (alternativas avaliadas em `docs/DECISION.md`, resumo):
- `WebContentsView` reutilizada (1 por Home/barra + 1 de serviço) em vez de
  `iframe` (**rejeitado**: X-Frame-Options/CSP dos serviços + DRM) ou uma
  `BrowserWindow` por serviço (processos e janelas duplicadas).
- Sessão persistente única `persist:smartv` (como um perfil de navegador;
  serviços isolados entre si por domínio, pela própria plataforma web).
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` em
  tudo; páginas remotas **não recebem preload** (zero acesso a Node).
- Sem porta de depuração remota no app final (só flag local `--smartv-dev`,
  que hoje só ativa um aviso de log).

## Arquivos

| Arquivo | Função |
|---|---|
| `src/main.ts` | ciclo de vida, janela fullscreen, views, IPC, guardas de navegação |
| `src/preload.ts` | ponte `window.smartv` (só Home/barra local) |
| `src/security.ts` | allowlist de apps/URLs (pura, testada) |
| `src/keys.ts` | camada de teclas dpad → `sendInputEvent` (pura, testada) |
| `src/renderer/` | Home (`home.html/ts/css`, reaproveita o visual do `/tv`) + barra (`bar.*`) |
| `vite.renderer.ts` | bundle só do renderer local (páginas remotas nunca são empacotadas) |
| `electron-builder.yml` | pacote Windows (`nsis` instalador + `dir` pasta) |

## Executar no Windows

Pré-requisito: Node.js 20+.

```powershell
npm install            # na raiz do monorepo (baixa o Electron, ~100 MB)
npm run build -w @smartv/shared
npm run build -w apps/desktop
npm start -w apps/desktop   # abre em tela cheia; Esc volta à Home
```

Desenvolvimento: `npm run dev -w apps/desktop` (build + abre).

## Testes

```powershell
npm run test -w apps/desktop       # allowlist, teclas, rejeição (5 testes)
npm run typecheck -w apps/desktop
npm run lint                       # na raiz
```

O que os testes **não** provam: reprodução real de vídeo/DRM (ver abaixo).

## Gerar o instalador

```powershell
npm run pack -w apps/desktop   # pasta release\win-unpacked (teste rápido)
npm run dist -w apps/desktop   # release\SmartTV Setup007...exe (instalador NSIS)
```

Não assinado: o Windows SmartScreen avisa na primeira execução (normal para
app pessoal; "Mais informações → Executar assim mesmo"). `electronVersion` no
`electron-builder.yml` precisa acompanhar o `electron` do `package.json`
(workaround do bug electron-builder#3984 com workspaces npm). O nome do
instalador não tem espaços (`artifactName`), porque o `latest.yml` referencia
esse nome exato para download.

## Atualizações automáticas (GitHub Releases + electron-updater)

O app instalado verifica novidades ao abrir (após ~15 s) e a cada 6 h, mostra
o estado na barra (`Verificando…`, `baixando…`, `pronta — reinicie o app`) e
instala **ao fechar/abrir** (`autoInstallOnAppQuit`; nunca reinicia sozinho).
Sem internet ou com o GitHub fora, segue na versão atual. Só o Releases deste
repo é consultado (`publish` no `electron-builder.yml`); dev (`npm start`)
nunca verifica. Lógica em `src/updater.ts` (testada com emissor falso).

**Publicar uma versão:**

1. Atualize `"version"` em `apps/desktop/package.json` (ex. `1.0.1`).
2. Commit + push na `main` (o CI valida tudo).
3. Crie a tag **igual à versão**: `git tag v1.0.1; git push origin v1.0.1`.
4. O job `release` (Windows) valida, gera o NSIS e publica o Release com
   `SmartTV-Setup-*.exe` + `latest.yml` + `.blockmap` (diferencial).
5. O CI usa o `GITHUB_TOKEN` automático (`contents: write`); **nenhum secret
   manual, nenhum token no código**.

**Testar uma atualização no Windows:** instale a versão antiga pelo exe do
Release, publique a nova tag, abra o app (barra mostra o progresso), feche e
reabra — a nova versão deve estar ativa. Produção real (instalado → release →
update) ainda **não** foi testada de ponta a ponta; pendente no PC da TV.

## Variáveis de ambiente / flags (só para o controle remoto)

Opcional — a configuração normal é pela UI (⚙ Controle na barra, salva em
`%AppData%/SmartTV/smartv-remote.json`). Alternativas sem UI:

- CLI: `--smartv-backend=wss://…/ws --smartv-agent-token=…`, `--smartv-remote-off`
- env: `SMARTV_BACKEND_URL`/`SMARTV_AGENT_TOKEN` (ou `BACKEND_URL`/`AGENT_TOKEN`)
- legado CDP local: `--smartv-cdp=PORTA` (só `127.0.0.1`, para o agente standalone)

Logins de streaming continuam nas páginas oficiais, guardados na sessão
persistente do próprio Chromium. Nenhum token vai para logs ou Git.

## Render/Vercel preservados

Intocados nesta etapa. O deploy do backend/frontend não muda, exceto:
`electron`/`electron-builder` são `devDependencies` (ferramentas de build do
desktop). O comando de instalação no Render
(`npm ci --omit=dev --omit=optional`) instala só o necessário para compilar o
servidor (todas as ferramentas de build dele estão em `dependencies`).
Na Vercel a instalação é completa (`npm install`): o build web precisa das
`devDependencies`, e o npm não permite omitir só o Electron (tentativas com
`--omit=optional` quebraram o Vite no Linux, e fixar o pacote nativo do
Rollup quebra o install no Windows); o binário do Electron baixa só em
builds frios, depois vale o cache da Vercel.

## Controle pelo celular (agente embutido, sem processo separado)

O app instalado **é ele mesmo o dispositivo controlável**: ao abrir, ele
conecta ao Render como `role: "agent"` (ver `src/remote-agent.ts`) e executa
os comandos nativamente (`src/command-runner.ts`):

```
Celular /controle → wss://…/ws (Render, valida ROOM_TOKEN)
  → app SmartTV no PC (valida AGENT_TOKEN, executa e responde estado)
```

| Comando | Execução no app |
|---|---|
| setas/Enter, play/pause, ±10 s, `f`, Próximo, texto, backspace/enter | `sendInputEvent` na view focada (Home ou serviço) |
| `back`, `home` | volta à Home local (sem depender de `Alt+Left`/foco) |
| `app` (4 atalhos) | navega a view de serviço (allowlist de sempre, sem CDP/flag) |
| volume, mouse, power | sistema via PowerShell (`user32.dll`), igual ao agente standalone |

**Configuração (uma vez, no PC da TV):** abra o app, clique em
**⚙ Controle** na barra superior e salve:
- Servidor: `wss://seu-servico.onrender.com/ws` (mesmo `VITE_BACKEND_URL` da Vercel)
- Token do PC: o mesmo `AGENT_TOKEN` do Render.

O status aparece na barra (`Controle: online / conectando… / token inválido /
não configurado`). Também aceita provisionamento sem UI:
`--smartv-backend=<url> --smartv-agent-token=<token>`, env
`SMARTV_BACKEND_URL`/`SMARTV_AGENT_TOKEN` (ou `BACKEND_URL`/`AGENT_TOKEN`),
ou o arquivo `%AppData%/SmartTV/smartv-remote.json`. Para desligar o
embutido (modo Edge legado): `--smartv-remote-off`.

**Importante — um agente por vez:** o servidor mantém 1 agente (o mais novo
substitui o anterior, código 4400). Com o app configurado, **não rode
`apps/agent` com o mesmo `AGENT_TOKEN`** (pare o Task Scheduler /
`uninstall-startup.ps1`), senão os dois ficam se derrubando. O status
`Controle: outro agente assumiu a sala` indica exatamente isso.

**Diagnóstico da cadeia:** `/controle` mostra `PC offline` distinto de erro
de servidor/token; comandos com PC offline são bloqueados no celular com
`PC offline — comando não enviado`; a página `/diag` (passo 5) confirma se o
PC está online; o Render loga `hello_ok/agent_online/agent_offline` sem
tokens. Agentes nativos (Node/Electron via `ws`) não enviam `Origin`: o
servidor aceita ausência de `Origin` (navegadores sempre enviam) e mantém a
autenticação por token — sem isso, o agente de produção era recusado com
4403 mesmo com o token certo.

Modo legado (Edge via CDP) continua documentado abaixo para quem usa
`apps/agent` sem este app.

### Alternativa legada: agente standalone via CDP (só se precisar do Edge)

Se você NÃO usa o agente embutido acima (ex.: ainda controla o Edge em vez
do app), o **agente** (`apps/agent`) continua recebendo o WebSocket com alvo
`electron`. Um único agente por vez (o servidor substitui o anterior); nada
de segunda infra ou API local aberta. Não use os dois ao mesmo tempo.

**Diagnóstico da cadeia (verificado no código):** `/controle` normaliza a URL
(`https://`→`wss://` + `/ws`) e mostra um status por código (`4401` token,
`4403` origem, `PC offline` distinto); o servidor autentica `controller` com
`ROOM_TOKEN` e `agent` com `AGENT_TOKEN`, mantém 1 agente + N controles e
retransmite comandos validados; o controle usa um único socket com geração e
não reconecta em loop nesses erros; o protocolo já cobre tudo que o desktop
precisa (`key/media/volume/app/text/textKey/mouse/scroll/power`). A falha
antiga ("preso em Acordando servidor…") era status único sem diagnóstico —
corrigida com statuses por motivo + página `/diag` + logs no Render.

**Configuração (PC da TV):**

1. No `.env` do agente: `TV_TARGET=electron` e `CDP_PORT=9222` (mesma porta).
2. Abra o app com a flag local (só `127.0.0.1`, desligada por padrão):
   `npx electron apps/desktop --smartv-cdp=9222` (ou `npm start -w apps/desktop -- --smartv-cdp=9222`).
3. Rode o agente normalmente (`npm start -w apps/agent`). O log deve mostrar
   `browser already running, reusing window` e `connected as agent`.

**Mapeamento no modo electron** (resto idêntico ao Edge):

| Comando | Execução |
|---|---|
| setas/Enter, play/pause, ±10 s, `f`, texto, mouse, volume, power | iguais (teclas/mouse de sistema com o app em foco) |
| `back`, `home` | `Esc` (Home global do app; sem chrome de navegador, `Alt+Left` não faria nada) |
| `app` (4 atalhos) | `Page.navigate` via CDP na mesma view (whitelist de sempre) |

Sem o app aberto com a flag, `navigate` falha fechado (`false` + log, sem
abrir o Edge). `start-tv.ps1`/`open-launcher` nesse modo só verificam o CDP —
a Home local é exibida pelo próprio app.

## Limitações conhecidas

- **DRM**: Electron padrão não traz o CDM Widevine → Netflix/Max/Disney+
  (conteúdo protegido) **não devem reproduzir**; YouTube deve funcionar.
  Detalhes e alternativas em `docs/STREAMING.md`. Nada foi burlado.
- Vídeo em tela cheia exclusiva (botão fullscreen do player) ocupa a área do
  serviço, abaixo da barra de 56 px (decisão consciente: não sacrificar a Home).
- A extensão do Edge **não** é usada aqui (Electron não executa extensões MV3
  como o Edge); navegação por foco nas Home é nativa, nos serviços é a nativa
  de cada site + setas do teclado.
- Sem auto-update nesta etapa (instalador manual).

## Testes manuais pendentes (no PC da TV, com suas contas)

1. Abrir, navegar na Home só com setas + Enter; Esc volta à Home de qualquer serviço.
2. Logar nos 4 serviços (sessão persiste após fechar/reabrir?).
3. `youtube.com/tv` navega e reproduz com som em tela cheia.
4. Netflix/Max/Disney+: até onde chega sem conta e com conta (registrar erro exato — esperado: erro de DRM, ex. Netflix M7701/M7121).
5. Repetir abrir o mesmo serviço 5x: nunca duplicar janela/processo.
6. Feche e reabra: uma única instância (segunda execução foca a primeira).
