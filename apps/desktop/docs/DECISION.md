# Decisão de arquitetura — app Windows

## Área de conteúdo: `WebContentsView` (escolhida)

| Opção | Veredito |
|---|---|
| `WebContentsView` única reutilizada (Home local + 1 view de serviço) | **Escolhida**: layout integrado, `webPreferences` distintas por view (serviço sem preload/Node), sem janelas duplicadas |
| `iframe` na Home | **Rejeitada**: Netflix/Max/Disney+ bloqueiam incorporação (`X-Frame-Options`/CSP) e DRM exige contexto top-level com CDM |
| `BrowserWindow` por serviço | **Rejeitada**: proliferação de janelas/processos, foco e kiosk difíceis de gerenciar |

## Sessão: partição persistente única (`persist:smartv`)

Como um perfil de navegador: logins sobrevivem a reinícios; serviços isolados
entre si por origem (garantia da plataforma web, não nossa). Alternativa de
uma partição por serviço foi rejeitada (4 perfis p/ gerenciar, sem ganho real).

## Segurança

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` em todas
as views; preload mínimo só no conteúdo local; páginas remotas sem preload;
navegação top-level e popups validados contra a allowlist
(`packages/shared`); sem CDP/remoto exposto; sem segredos no app.

## Empacotamento: `electron-builder`

Padrão da comunidade, NSIS + pasta, funciona com workspaces (com o workaround
`electronVersion` do bug #3984). Alternativas (`electron-forge`, `electron-packager`)
avaliadas: Forge exige mais andaime para o mesmo NSIS; packager não gera
instalador. Nenhum custo.

## Agente: intocado nesta etapa

`apps/agent` (nut-js nativo) não roda dentro do Electron (rebuild nativo
frágil, duas implementações concorrentes). Continua controlando o Edge. A
integração remota do app usa o protocolo atual numa etapa seguinte (detalhes
no README, seção "Controle pelo iPhone").
