# Compatibilidade de streaming — diagnóstico honesto

**Estado em 2026-10-16: nenhum serviço foi testado com reprodução real.**
Não há credenciais de teste neste ambiente e a interface do app não foi aberta
aqui (abrir um app fullscreen na máquina em uso seria intrusivo; o smoke
executado foi `electron --version` + build + pacote). Tudo abaixo é análise
técnica + pendência de teste manual com suas contas (checklist no README).

## Por que DRM importa

Netflix, Max e Disney+ entregam vídeo criptografado (Widevine L1/L3 no
Windows) e recusam reprodução sem o módulo CDM licenciado + codecs
proprietários. "A página abriu" ≠ "o vídeo toca". A matriz distingue 7 níveis.

## Matriz (Electron padrão 44 / Chromium)

| # | Nível | YouTube | Netflix | Max | Disney+ |
|---|---|---|---|---|---|
| 1 | Página inicial carrega | esperado ✅ (a testar) | esperado ✅ | esperado ✅ | esperado ✅ |
| 2 | Login/sessão persistente | esperado ✅ | esperado ✅ | esperado ✅ | esperado ✅ |
| 3 | Navegação por teclado | esperado ✅ | melhorada ⚠️ (foco espacial, a testar) | melhorada ⚠️ | melhorada ⚠️ |
| 4 | Vídeo não-protegido toca | esperado ✅ | n/a | n/a | n/a |
| 5 | DRM (Widevine) | n/a | **bloqueado** ❌ | **bloqueado** ❌ | **bloqueado** ❌ |
| 6 | Tela cheia c/ áudio | esperado ✅ | bloqueado por 5 | bloqueado por 5 | bloqueado por 5 |
| 7 | Qualidade comprovada | pendente | pendente | pendente | pendente |

Motivo de 5: builds oficiais do Electron **não incluem o CDM Widevine**
(componente proprietário Google, licenciado por integrador). Youtube usa
stream progressivo/WebM sem DRM na maioria dos vídeos → deve funcionar.
Erros típicos esperados: Netflix `M7701`/`M7121`, equivalentes nos demais.

## Navegação por foco (controle remoto)

As páginas de streaming são sites feitos para mouse/teclado. Para o D-pad do
celular se comportar como um controle de TV, o `serviceView` recebe um preload
próprio (`apps/desktop/src/service-preload.ts`) que:

- intercepta as setas e move o foco entre os elementos focáveis da página
  usando geometria (o mais próximo naquela direção, priorizando alinhamento);
- mostra um anel de foco visível (`smartv-focused`);
- ativa o elemento focado com **Enter**;
- **não** interfere enquanto um `<video>` está reproduzindo, preservando o
  comportamento nativo das setas (seek) — mesma heurística da extensão Edge
  (`apps/extension/src/content.ts`).

Os seletores por serviço ficam em `SITE_SELECTORS` (mirror dos adaptadores da
extensão). É um preload **sem ponte**: nada de `window.smartv`/IPC para páginas
remotas. Ainda depende de validação manual por serviço (nível 3 acima).

O botão **Voltar** do controle usa o histórico da página (volta uma tela do
serviço) e, sem histórico, retorna à Home — mais próximo de um controle real
do que o antigo `Esc` fixo.


## Alternativas avaliadas

1. **Fork castlabs `electron-releases`** (Electron + Widevine + codecs):
   projeto público e conhecido, usado por apps que precisam de DRM; porém
   **não verificado aqui** (binário de terceiro, ~100 MB+, licenciamento
   próprio a conferir para distribuição, cadência de updates atrás do Electron
   oficial). Não adotado nesta etapa; nada foi baixado/instalado.
   Se adotar: trocar a dependência `electron` pela deles, rebuild, e testar os
   níveis 1–7 com conta real.
2. **Fallback Edge oficial (sistema atual, intacto)**: agente + Edge com
   Widevine nativo reproduz tudo; perde a janela integrada (abre o navegador).
   Continua funcionando em paralelo — nenhuma regressão.
3. **App híbrido**: Home Electron + delegar só a reprodução ao Edge/WebView2:
   complexidade alta, duas janelas — rejeitado por enquanto.

## Decisão

Etapa 1 entrega o app integrado com o Electron padrão (YouTube utilizável,
catálogos navegáveis, logins persistentes) e documenta o bloqueio de DRM sem
fingir sucesso. Se Netflix/Max/Disney+ com reprodução forem obrigatórios,
o próximo passo exato é: avaliar o fork castlabs (licença + teste de
reprodução real) **ou** manter a reprodução no Edge via agente e usar o app
Electron como Home/controle.
