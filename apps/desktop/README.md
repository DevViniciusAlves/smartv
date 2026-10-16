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
(workaround do bug electron-builder#3984 com workspaces npm).

## Variáveis de ambiente

Nenhuma. O app não usa tokens nem senhas; logins são feitos nas páginas
oficiais e guardados na sessão persistente do próprio Chromium.

## Render/Vercel preservados

Intocados nesta etapa. O deploy do backend/frontend não muda, exceto:
`electron`/`electron-builder` são `optionalDependencies`, e o comando de
instalação no Render (`npm ci --include=dev --omit=optional`) pula o download
do Electron (o build do servidor usa só `tsc`, sem binários nativos).
Na Vercel a instalação é completa (`npm install`): o `--omit=optional` quebrava
o Vite no Linux (faltava `@rollup/rollup-linux-x64-gnu`, dependência opcional
de plataforma), e o npm não permite omitir só o Electron nem fixar o pacote
nativo como dependência direta (quebra o `npm install` no Windows); o binário
do Electron baixa só em builds frios, depois vale o cache da Vercel.

## Controle pelo iPhone (via agente, sem mudar servidor/controle)

O app não fala com a rede: quem recebe o WebSocket do Render continua sendo o
**agente** (`apps/agent`), agora com alvo `electron`. Um único agente por vez
(o servidor substitui o anterior); nada de segunda infra ou API local aberta.

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
