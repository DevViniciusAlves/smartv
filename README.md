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
| `shared` | protocolo/tipos | `packages/shared` |

O Vercel só serve as páginas (não suporta WebSocket persistente). O Render só retransmite.
Quem executa teclas/mouse/volume é o agente local. A página `/tv` não usa WebSocket
(escuta `keydown`); a extensão escuta as teclas reais geradas pelo agente.

## Pré-requisitos

- Node.js 20 LTS ou superior em todas as máquinas.
- Gere dois tokens longos e diferentes (ex.: `openssl rand -hex 32` duas vezes):
  `ROOM_TOKEN` (celular) e `AGENT_TOKEN` (PC).

## 1. Deploy do backend (Render)

1. Suba este repositório no GitHub e crie um **Web Service** a partir dele (o `render.yaml` já configura build/start e `/health`).
2. No painel do Render, defina as variáveis:
   - `ROOM_TOKEN` = token do celular
   - `AGENT_TOKEN` = token do PC (diferente do anterior)
   - `ALLOWED_ORIGINS` = URL do Vercel, ex. `https://seu-app.vercel.app`
   - `NODE_ENV` = `production` (`PORT` o Render define sozinho)
3. Anote a URL pública, ex. `wss://seu-servico.onrender.com/ws` (o caminho do WebSocket é `/ws`).

**Plano gratuito:** o serviço dorme após inatividade. O agente envia ping a cada ~30 s para manter
acordado e o controle mostra "Acordando servidor… / Conectando ao PC… / Conectado / PC offline",
com reconexão automática (backoff exponencial). As regras do plano gratuito podem mudar;
a alternativa é o plano pago mais barato do Render.

## 2. Deploy do frontend (Vercel)

1. Importe o repositório na Vercel com **Root Directory = `apps/web`**.
2. Variável de ambiente: `VITE_BACKEND_URL` = `wss://seu-servico.onrender.com/ws`.
3. O `vercel.json` na raiz já cria as rotas limpas `/tv` → `tv.html` e `/controle` → `controle.html`.
4. Faça o deploy e anote a URL, ex. `https://seu-app.vercel.app`.

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
4. Teste: `npm start`. Deve logar `connected as agent` e abrir o launcher.
5. Iniciar com o Windows (admin): `powershell -ExecutionPolicy Bypass -File install-startup.ps1`.
   Para remover: `uninstall-startup.ps1`.
6. Atalho "Modo Smart TV": crie um atalho na área de trabalho para `powershell -File C:\smartv\agent\start-tv.ps1`.
7. Logs em `%USERPROFILE%\.smartv\agent.log` (sem dados sensíveis).

**Como escolher o monitor:** abra `Configurações > Sistema > Tela`, identifique os monitores e veja
a posição (principal em 0,0; o segundo geralmente em 1920,0). Ajuste `TV_WINDOW_X/Y` e teste com `start-tv.ps1`.

**Teclado/mouse:** usa `@nut-tree-fork/nut-js`; se o provider nativo falhar no Windows, o agente
cai automaticamente para o fallback PowerShell (`SendKeys`, `user32.dll` para mouse/volume/tela).
O backend usado aparece no log (`automation backend: nut-js | powershell`).

**Volume:** controla o volume do Windows (teclas de mídia), que sai pelo HDMI. Deixe a TV em volume
médio fixo e use o do PC. O volume interno da TV (infravermelho) não é alterável por software.

**`back`:** padrão `Alt+Left` (voltar do navegador). Se preferir fechar menus/diálogos, use `BACK_BEHAVIOR=esc`.

## 4. Perfil dedicado do Edge + logins + extensão

1. O agente abre o Edge com `--user-data-dir=<BROWSER_PROFILE_DIR>` sozinho no primeiro start;
   isso cria o perfil dedicado. (Ou abra manualmente com esse flag.)
2. Nesse perfil, acesse YouTube, Netflix, HBO e Disney+ e faça login **uma vez** em cada.
   O sistema não guarda nenhuma senha.
3. Instale a extensão: `apps/extension` → `npm ci && npm run build` → no Edge, `edge://extensions`,
   ative **Modo de desenvolvedor**, **Carregar sem empacotar**, selecione `apps/extension/dist`
   (com o `manifest.json` copiado — o build copia automaticamente; se não, copie à mão).
   Confirme que ela está ativa no perfil dedicado.
4. Fixe a TV em volume médio e o Edge em tela cheia (F11) após abrir o launcher.

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

**YouTube:** o padrão é `https://www.youtube.com/tv` (interface feita para setas). Testado:
se o Edge for redirecionado para o YouTube normal ou exigir user-agent de TV, troque a URL para
`https://www.youtube.com` e use atalhos de teclado + extensão de foco (documentado, sem quebra).

## Solução de problemas

| Sintoma | Causa provável / ação |
|---|---|
| "Acordando servidor…" por >1 min | Render gratuito dormindo; aguarde até 60 s ou faça upgrade. Confira `VITE_BACKEND_URL`. |
| "PC offline" | Agente parado: rode `npm start` no PC, confira `BACKEND_URL`/`AGENT_TOKEN`, veja `%USERPROFILE%\.smartv\agent.log`. |
| Setas não movem na Netflix/HBO | Extensão desativada ou perfil errado: ative em `edge://extensions` no perfil dedicado. No player em reprodução as setas são nativas de propósito. |
| Teclas não respondem no launcher | Foco fora do Edge: use Home no controle para reabrir o launcher. |
| Acentos não digitam | O agente digita via clipboard (`Ctrl+V`); confira se o campo de texto está focado. |
| Qualidade baixa na Netflix/HBO | Normal em navegador sem Widevine L1/app nativo; use o plano/config de qualidade do site. Limitação conhecida. |
| Janela abre no monitor errado | Ajuste `TV_WINDOW_X/Y` (seção 3). |
| Token recusado | `ROOM_TOKEN` diferente entre celular e Render, ou `ALLOWED_ORIGINS` sem a URL do Vercel. |

## Limitações conhecidas (honestas)

- Render gratuito dorme; a primeira conexão do dia pode levar ~1 min.
- Netflix/HBO/Disney+ em navegador podem limitar resolução (sem app nativo/DRM total).
- `youtube.com/tv` pode redirecionar no Edge desktop; fallback documentado acima.
- Volume controla o Windows/HDMI, não o infravermelho da TV.
- Apenas um agente ativo (o mais recente substitui o anterior); vários celulares podem controlar ao mesmo tempo.

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
- [x] 4 atalhos abrem os serviços no Edge dedicado, no monitor configurado, com tentativa de tela cheia.
- [x] Volume +/−/mudo via teclas de mídia; segurar repete (cliente repete a cada 120 ms).
- [x] Teclado digita em tempo real com acentos (clipboard + Ctrl+V).
- [x] Touchpad move/clica/clique-direito/rola (eventos agrupados ~60 Hz).
- [x] Power (toque longo) apaga a tela sem derrubar o agente (`SendMessage SC_MONITORPOWER`).
- [x] Agente reconecta com backoff, inicia com o Windows (Task Scheduler).
- [x] Controle mostra: conectando / acordando servidor / conectado / PC offline.
- [x] Token inválido e origem não permitida recusados; whitelist zod em server e agente.
- [x] Nenhum segredo no repo; `.env.example` em cada app.
- [x] Lint, typecheck e testes passam.
