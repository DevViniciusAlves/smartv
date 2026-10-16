# Smart TV + Controle pelo Celular

Sistema que transforma qualquer tela ligada por HDMI a um PC Windows em uma smart TV,
controlada pelo celular. Sem pareamento, sem contas: quem abre o `/controle` com o token vira o controle.

## Arquitetura

```
Celular (https://<vercel>/controle)
   |  wss
   v
Backend no Render (retransmissor, sala fixa, valida token)
   |  wss
   v
Agente local no PC Windows (Node.js) -> teclas reais, mouse, volume, abre apps
   |
   v
Edge (perfil dedicado) -> launcher /tv, YouTube, Netflix, HBO, Disney+ -> HDMI -> TV
   + Extensão própria (navegação por foco com setas)
```

| Peça | Onde roda | Pasta |
|---|---|---|
| `web` | Vercel (estático) | `apps/web` — páginas `/tv` e `/controle` |
| `server` | Render (Web Service) | `apps/server` |
| `agent` | PC Windows | `apps/agent` |
| `extension` | Edge do PC | `apps/extension` |
| `desktop` | app Windows próprio (Electron) | `apps/desktop` — ver `apps/desktop/README.md` |
| `shared` | protocolo/tipos | `packages/shared` |

O Vercel só serve as páginas (não suporta WebSocket persistente). O Render só retransmite.
Quem executa teclas/mouse/volume é o agente local. A página `/tv` não usa WebSocket
(escuta `keydown`); a extensão escuta as teclas reais geradas pelo agente.

## Pré-requisitos

- Node.js 20 LTS ou superior em todas as máquinas.
- Gere dois tokens longos e diferentes (ex.: `openssl rand -hex 32` duas vezes):
  `ROOM_TOKEN` (celular) e `AGENT_TOKEN` (PC).

## 1. Deploy do backend (Render)

1. Suba este repositório no GitHub e crie um **Web Service** a partir dele.
   Você pode criar como **Blueprint** (o `render.yaml` já configura build/start e `/health`)
   ou manualmente. **Atenção:** se o serviço foi criado manualmente, o **Build Command e o
   Start Command do painel valem no lugar do `render.yaml`** — mantenha os dois iguais:
   - Build: `npm ci --omit=dev --omit=optional && npm run build -w packages/shared && npm run build -w apps/server`
     (instalação mínima: todas as ferramentas de build do servidor — `tsc`,
     `@types/*` — estão em `dependencies`; com `NODE_ENV=production` o npm
     pularia as `devDependencies` de qualquer jeito)
   - Start: `npm run start -w apps/server`
   - Health Check Path: `/health`
2. No painel do Render, defina as variáveis:
   - `ROOM_TOKEN` = token do celular
   - `AGENT_TOKEN` = token do PC (diferente do anterior)
   - `ALLOWED_ORIGINS` = URL do Vercel, ex. `https://seu-app.vercel.app`
   - `NODE_ENV` = `production` (`PORT` o Render define sozinho)
   - `LOG_LEVEL` = `info` (opcional; use `debug` para ver o tipo de cada comando)
3. Anote a URL pública, ex. `wss://seu-servico.onrender.com/ws` (o caminho do WebSocket é `/ws`).

**Plano gratuito:** o serviço dorme após inatividade. O agente envia ping a cada ~30 s para manter
acordado e o controle mostra "Acordando servidor… / Conectando ao PC… / Conectado / PC offline",
com reconexão automática (backoff exponencial). As regras do plano gratuito podem mudar;
a alternativa é o plano pago mais barato do Render.

## 2. Deploy do frontend (Vercel)

1. Importe o repositório na Vercel com **Root Directory = raiz do repositório (`./`)**,
   **Framework Preset = Other**. Build, output e rewrites vêm do `vercel.json` da raiz
   (que compila `packages/shared` antes do web e mapeia `/tv` → `tv.html`,
   `/controle` → `controle.html`). Só existe um `vercel.json` (na raiz).
2. Variável de ambiente (`Production`): `VITE_BACKEND_URL` = `wss://seu-servico.onrender.com/ws`.
   Se adicioná-la depois do primeiro deploy, faça **Redeploy** (o Vite embute a variável no build).
3. Faça o deploy e anote a URL, ex. `https://seu-app.vercel.app`.

## 3. Instalação do agente (PC Windows)

1. Instale o Node.js 20+ no PC.
2. Copie a pasta `apps/agent` (ou o repo) para o PC, ex. `C:\smartv\agent`.
3. `npm ci && npm run build`, depois crie o `.env` a partir do `.env.example`:
   - `BACKEND_URL` = `wss://seu-servico.onrender.com/ws`
   - `AGENT_TOKEN` = o mesmo do Render
   - `BROWSER_PATH` = caminho do Edge
   - `BROWSER_PROFILE_DIR` = ex. `C:\Users\Voce\smartv-edge-profile` (perfil dedicado)
   - `LAUNCHER_URL` = `https://seu-app.vercel.app/tv`
   - `TV_WINDOW_X` / `TV_WINDOW_Y` = posição do monitor da TV (ex. `1920,0` se a TV é o segundo monitor; use `0,0` se for o principal)
   - `BACK_BEHAVIOR` = `alt-left` (voltar do navegador) ou `esc`
   - `TV_MODE` = `kiosk` (padrão: Edge em quiosque, sem barra nem abas) ou `app` (janela de app em tela cheia)
   - `CDP_PORT` = porta do Chrome DevTools Protocol, padrão `9222` (**somente `127.0.0.1`**, nunca expor)
   - `TV_TARGET` = `edge` (padrão, janela do Edge) ou `electron` (app desktop aberto com `--smartv-cdp=PORTA`; ver `apps/desktop/README.md`)
4. Teste: `npm start`. Deve logar `connected as agent` e abrir o launcher na janela única da TV.
5. Iniciar com o Windows (admin): `powershell -ExecutionPolicy Bypass -File install-startup.ps1`.
   Para remover: `uninstall-startup.ps1`.
6. Atalho "Modo Smart TV": crie um atalho na área de trabalho para `powershell -File C:\smartv\agent\start-tv.ps1`.
7. Logs em `%USERPROFILE%\.smartv\agent.log` (sem dados sensíveis).

**Janela única (quiosque):** o agente mantém **uma única janela** do Edge (perfil dedicado,
em quiosque no modo padrão). Home e os 4 atalhos **navegam essa mesma janela via CDP**
(`Page.navigate` pela porta `CDP_PORT` em `127.0.0.1`); a URL precisa estar na whitelist
(apps da config + `LAUNCHER_URL`), senão é recusada e registrada no log. Abas extras
(ex.: link com `target=_blank`) são fechadas automaticamente. Se o CDP estiver indisponível,
o fallback em cadeia tenta: (1) `Ctrl+L` + colar URL + `Enter`; (2) reabrir o Edge com o
mesmo `--user-data-dir` (o Edge repassa à instância em execução). O caminho usado aparece no log.

**Como escolher o monitor:** abra `Configurações > Sistema > Tela`, identifique os monitores e veja
a posição (principal em 0,0; o segundo geralmente em 1920,0). Ajuste `TV_WINDOW_X/Y` e teste com `start-tv.ps1`.
No modo `app`, o agente posiciona a janela via CDP (`Browser.setWindowBounds`) antes da tela cheia;
no modo `kiosk`, vale o `--window-position`.

**Teclado/mouse:** usa `@nut-tree-fork/nut-js`; se o provider nativo falhar no Windows, o agente
cai automaticamente para o fallback PowerShell (`SendKeys`, `user32.dll` para mouse/volume/tela).
O backend usado aparece no log (`automation backend: nut-js | powershell`).

**Volume:** controla o volume do Windows (teclas de mídia), que sai pelo HDMI. Deixe a TV em volume
médio fixo e use o do PC. O volume interno da TV (infravermelho) não é alterável por software.

**`back`:** padrão `Alt+Left` (voltar do navegador). Se preferir fechar menus/diálogos, use `BACK_BEHAVIOR=esc`.

## 4. Perfil dedicado do Edge + logins + extensão

1. Rode **uma vez** `powershell -ExecutionPolicy Bypass -File setup-profile.ps1` em `apps/agent`.
   Ele abre o Edge **normal** (sem quiosque) com o perfil dedicado.
2. Nesse perfil, acesse YouTube, Netflix, HBO e Disney+ e faça login **uma vez** em cada.
   O sistema não guarda nenhuma senha.
3. Instale a extensão: edite `LAUNCHER_URL` em `apps/extension/src/config.ts` para a sua URL
   do `/tv`, rode `npm run build -w apps/extension` e no Edge abra `edge://extensions`,
   ative o **Modo do desenvolvedor**, clique **Carregar sem compactação** e selecione
   `apps/extension/dist`. (Não use `--load-extension`: foi removido das versões recentes
   dos navegadores.) Confirme que ela está ativa no perfil dedicado.
   A extensão adiciona: navegação por setas, relógio + botão Início em overlay (some em ~4 s;
   em vídeo em tela cheia o overlay não aparece — limitação do navegador) e contenção de
   links `target=_blank` na mesma aba.
4. Feche o Edge normal. A partir daí, o agente/`start-tv.ps1` abre a janela única em quiosque.
   Fixe a TV em volume médio.

## 5. Controle no celular

1. Primeira abertura: `https://seu-app.vercel.app/controle?k=SEU_ROOM_TOKEN`.
   O token é salvo no `localStorage` e removido da URL. Depois basta abrir `/controle`.
2. Sem token: a tela pede para colar o token. Token recusado: a conexão fecha e o status indica;
   confira o `ROOM_TOKEN` no Render.
3. **Instalar como PWA:** no Android (Chrome) menu ⋮ → "Adicionar à tela inicial"/"Instalar";
   no iPhone (Safari) Compartilhar → "Adicionar à Tela de Início". Abre sem barra do navegador.
   (Os ícones `icon-192/512.png` são placeholders de 1 px — substitua por PNGs 192×192 e 512×512 com a sua marca.)
4. Toque longo no ⏻ com confirmação apaga a tela (o PC continua ligado; qualquer mouse acorda).

## 6. Adicionar um serviço de streaming

Edite `packages/shared/src/apps.ts` e inclua uma linha:

```ts
{ id: "novo", name: "Novo+", url: "https://...", color: "#123456" },
```

O botão aparece no launcher e no controle automaticamente; o agente abre a URL. Rebuild + redeploy
do web e do agent. Para a navegação por setas funcionar bem no site novo, adicione os seletores
em `apps/extension/src/adapters.ts` e as URLs em `manifest.json`.

**HBO:** o serviço migrou entre `hbomax.com` e `max.com`; o padrão aqui é `https://www.hbomax.com`.
Se a sua conta usa `max.com`, troque a URL na config.

**YouTube:** o padrão agora é `https://www.youtube.com` em `packages/shared/src/apps.ts`.
Comprovado por screenshot no Chromium desktop: o `youtube.com/tv` foi descontinuado
para navegadores desktop e mostra só um interstitial "Vamos direcionar você para
o youtube.com". Não há troca automática de user-agent.

## Solução de problemas

| Sintoma | Causa provável / ação |
|---|---|
| "Acordando servidor…" por >1 min | Render gratuito dormindo; aguarde até 60 s ou faça upgrade. Confira `VITE_BACKEND_URL`. |
| "PC offline" | Agente parado: rode `npm start` no PC, confira `BACKEND_URL`/`AGENT_TOKEN`, veja `%USERPROFILE%\.smartv\agent.log`. |
| Setas não movem na Netflix/HBO | Extensão desativada ou perfil errado: ative em `edge://extensions` no perfil dedicado. No player em reprodução as setas são nativas de propósito. |
| Teclas não respondem no launcher | Foco fora do Edge: use Home no controle para reabrir o launcher. |
| Acentos não digitam | O agente digita via clipboard (`Ctrl+V`); confira se o campo de texto está focado. |
| Qualidade baixa na Netflix/HBO | Normal em navegador sem Widevine L1/app nativo; use o plano/config de qualidade do site. Limitação conhecida. |
| Janela abre no monitor errado | Ajuste `TV_WINDOW_X/Y` (seção 3). No modo `app`, o agente reposiciona via CDP; no `kiosk`, confira se o `--window-position` levou a janela. |
| Segunda janela/aba do Edge abre | O agente navega a janela única via CDP; confira no log qual caminho foi usado (`cdp` x `fallback`). Se o CDP não subiu (porta recusada no perfil), o fallback por `Ctrl+L`/respawn é usado e registrado. |
| Token recusado | `ROOM_TOKEN` diferente entre celular e Render, ou `ALLOWED_ORIGINS` sem a URL do Vercel. |

## Solução de problemas de conexão

O controle mostra exatamente o motivo. Tabela sintoma → causa → o que fazer
(entre parênteses, a linha que deve aparecer nos logs do Render):

| Sintoma no celular | Causa | O que fazer |
|---|---|---|
| `Carregando…` para sempre (>1 min) | Servidor fora do ar ou URL errada (sem `/health` respondendo) | Abra `/diag` no celular: o passo 3 diz se o servidor responde. Confira `VITE_BACKEND_URL` na Vercel + redeploy |
| `Erro: token inválido` | `ROOM_TOKEN` do celular ≠ Render | O painel do token abre sozinho: digite de novo e salve (log: `hello_fail reason=bad_token`) |
| `Erro: origem não permitida` | URL da Vercel fora de `ALLOWED_ORIGINS` | Copie a origem mostrada na tela para `ALLOWED_ORIGINS` no Render, exatamente igual (log: `origin_not_allowed`) |
| `Erro: servidor não configurado` | Falta `VITE_BACKEND_URL` | Configure na Vercel (Production) e faça redeploy |
| `Conectado ao servidor, PC offline` | Agente do PC desconectado | Ligue o PC, confira `.env` (`AGENT_TOKEN`, `BACKEND_URL`) e o log `%USERPROFILE%\.smartv\agent.log` (no Render: sem linha `agent_online`) |
| `/health` não abre no navegador | Serviço dormindo ou URL errada | Aguarde ~1 min (cold start) e recarregue; confira a URL do serviço |

**Passo a passo no celular:** abra `https://seu-app.vercel.app/diag` e siga os 5 passos
(config → token → `/health` → handshake → PC). Cada ❌ diz o que fazer. O botão
**Copiar relatório** gera um texto sem o token para colar no suporte.

**iPhone:** o app instalado na tela inicial (PWA) **não compartilha** o `localStorage`
com o Safari. O token precisa ser digitado **dentro do próprio app** (engrenagem ⚙ ou
`?k=TOKEN` aberto no app). Se instalou o PWA antes de salvar o token, abra o `?k=`
no app instalado, não no Safari.

Para depurar pelo Render: **Dashboard → serviço → Logs**. Você deve ver o `boot`
(porta, `ALLOWED_ORIGINS`, tokens marcados só como "definido"), cada `upgrade`
(caminho, origem), `hello_ok`/`hello_fail` com o motivo, e `agent_online`/`agent_offline`.
Nenhum log contém tokens. Nível de detalhe via `LOG_LEVEL` (`debug` mostra só o tipo
dos comandos, nunca o conteúdo).

## Limitações conhecidas (honestas)

- Render gratuito dorme; a primeira conexão do dia pode levar ~1 min.
- Netflix/HBO/Disney+ em navegador podem limitar resolução (sem app nativo/DRM total).
- YouTube abre o site normal (o `/tv` foi descontinuado no desktop; comprovado).
- Overlay da extensão (relógio + Início) não aparece com vídeo em tela cheia; sem indicador
  de volume no overlay (a extensão não tem canal com o agente; o Windows já mostra o próprio).
- Volume controla o Windows/HDMI, não o infravermelho da TV.
- Apenas um agente ativo (o mais recente substitui o anterior); vários celulares podem controlar ao mesmo tempo.

## Checklist manual de teste no Windows

Itens que dependem de Windows/Edge reais e precisam ser conferidos no PC da TV:

- [ ] `npm start` abre **uma única** janela do Edge em quiosque, no monitor da TV, com o launcher.
- [ ] Home e os 4 atalhos **navegam a mesma janela** (nenhuma aba/janela nova; log mostra `browser navigate: cdp`).
- [ ] `http://127.0.0.1:9222/json/version` responde no PC (CDP só local, com o perfil dedicado).
- [ ] Se a porta CDP for recusada, o fallback (`Ctrl+L` + colar, ou respawn) assume sozinho e o log registra.
- [ ] No modo `app`, a janela vai para o monitor certo e entra em tela cheia.
- [ ] YouTube abre o site normal e responde às setas via extensão de foco.
- [ ] Link com `target=_blank` nos streamings abre na mesma aba.
- [ ] Overlay (relógio + Início) aparece ao mexer o mouse/setas e some em ~4 s; botão Início volta ao launcher.
- [ ] Play/Pause, ±10 s, Enter, Voltar e Próximo funcionam com o backend nut-js **e** com o PowerShell
      (force cada um: renomeie temporariamente o provider do nut-js ou bloqueie seu carregamento
      e confira `automation backend: powershell` no log).

## Desenvolvimento

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test
```

## Checklist de aceitação

- [x] `/controle` com token salvo conecta sozinho, sem pareamento.
- [x] Setas/OK/Voltar/Home no launcher e YouTube (keydown + agente).
- [x] Setas navegam entre capas via extensão, sem atrapalhar o player (heurística `playerActive`).
- [x] Home e os 4 atalhos navegam a **mesma janela** via CDP (whitelist de URLs); nenhum F11 nesse fluxo.
- [x] Play/Pause, ±10 s, Enter, Voltar e Próximo mapeados na API semântica (`tap`/`combo`) e cobertos por teste nos dois backends (lógica provada por teste; confirmação física no checklist Windows acima).
- [x] Volume +/−/mudo via teclas de mídia; segurar repete (cliente repete a cada 120 ms).
- [x] Teclado digita em tempo real com acentos (clipboard + Ctrl+V).
- [x] Touchpad move/clica/clique-direito/rola (eventos agrupados ~60 Hz).
- [x] Power (toque longo) apaga a tela sem derrubar o agente (`SendMessage SC_MONITORPOWER`).
- [x] Agente reconecta com backoff, inicia com o Windows (Task Scheduler).
- [x] Controle mostra: conectando / acordando servidor / conectado / PC offline.
- [x] Token inválido e origem não permitida recusados; whitelist zod em server e agente.
- [x] Build do server passa só com `dependencies`; build do web é autossuficiente; um só `vercel.json`.
- [x] Nenhum segredo no repo; `.env.example` em cada app.
- [x] Lint, typecheck e testes (incluindo agente: 14 testes) passam.
