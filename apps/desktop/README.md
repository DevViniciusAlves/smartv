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
`electron`/`electron-builder` são `optionalDependencies`, e os comandos de
instalação na Vercel (`npm install --omit=optional`) e no Render
(`npm ci --include=dev --omit=optional`) pulam o download do Electron.

## Controle pelo iPhone (etapa seguinte, não implementada aqui)

De propósito, o app abre e funciona **local** primeiro. O caminho de
integração, sem reescrever a infra:

1. Hoje o agente já envia teclas/mouse/volume de sistema — com o app em foco,
   setas/Enter/espaço/mouse/volume/texto/power **já funcionam** (são globais).
2. Falta só o chaveamento Home/aplicativos (comandos `home`/`app` do protocolo,
   hoje amarrados ao Edge via CDP). Opção de menor risco: apontar o `TvBrowser`
   do agente para o Electron rodando com `--remote-debugging-port` local
   (mesma whitelist, mesmo protocolo, mesmos tokens). Nada muda no servidor.

`src/keys.ts` já define os strokes de injeção (`sendInputEvent`) para essa etapa.

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
