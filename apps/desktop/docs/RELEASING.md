# Publicar uma versão do app Windows (RELEASING)

Fluxo suportado pelo CI (`.github/workflows/ci.yml`):

- Push na `main` (ou PR): roda só `validate` (lint, typecheck, testes, build).
- Push de tag `vX.Y.Z`: roda `validate` + `release` (Windows), que gera o
  instalador e publica o GitHub Release com `SmartTV-Setup-*.exe`,
  `latest.yml` e `.blockmap`. Apps instalados atualizam sozinhos ao reiniciar.

## Configuração embutida (PC sem configurar nada)

O app instalado precisa saber o servidor (Render) e o próprio token
(`AGENT_TOKEN`) para conectar sozinho. Em vez de exigir que o usuário digite
isso, o build **copia esses valores para dentro do instalador**
(`src/defaults.ts`, gerado por `scripts/gen-defaults.mjs`). Resultado: o PC
abre já conectado e o celular só precisa do **código de pareamento**.

Configure **uma vez** no GitHub, em *Settings → Secrets and variables → Actions*:

| Nome | Tipo | Valor |
|---|---|---|
| `SMARTV_BACKEND_URL` | **Variable** (não é segredo) | `wss://seu-servico.onrender.com/ws` |
| `SMARTV_AGENT_TOKEN` | **Secret** | o mesmo `AGENT_TOKEN` do Render |

- O `src/defaults.ts` versionado fica **vazio** de propósito (nada de segredo no
  repo): o CI sobrescreve só no momento do build. Build local sem essas variáveis
  continua vazio (nada muda).
- ⚠️ O token compilado é extraível de um `.exe` público. É o preço do
  zero-config; se preferir esconder o token, não defina `SMARTV_AGENT_TOKEN` e
  preencha **Conexão → Configuração avançada** no PC uma vez (fica em
  `%AppData%/SmartTV`).
- A URL do servidor não é segredo (o app do celular já a usa via Vercel).

## Passo a passo (jeito certo, sempre igual)

```powershell
# 1. versão nova em apps/desktop/package.json (ex: 1.0.3 -> 1.0.4)
git add -A
git commit -m "o que mudou"
git push
# 2. tag EXATAMENTE igual à versão (o CI falha se diferir)
git tag v1.0.4
git push origin v1.0.4
# 3. aguarde o job `release` ficar verde no Actions
```

## Conferência obrigatória (todo release)

Abra a página **Releases** e confirme, para a versão nova:

1. Existe **UM ÚNICO** release daquela versão (sem duplicatas, sem rascunho).
2. Ele está **publicado** (sem selo `Draft`).
3. Em **Assets** há exatamente 3 arquivos:
   `SmartTV-Setup-X.Y.Z.exe` (~100 MB) + `latest.yml` + `.blockmap`.

Só então teste no app instalado: abrir → barra mostra o download →
**fechar e reabrir** → nova versão ativa.

## Se algo sair errado (não crie outro release por cima)

- **Dois releases para a mesma tag** (ou um incompleto, só com `blockmap`):
  o GitHub pode resolver a tag para o objeto quebrado e o app recebe 404 no
  `latest.yml` ("Falha ao verificar atualização"). Apague os duplicados/
  incompletos (lixeira na página Releases) até sobrar **um por versão**.
- **Run falhou depois de criar rascunho parcial**: apague o draft, mova a tag
  (`git tag -f vX.Y.Z; git push origin -f vX.Y.Z`) para rodar de novo do zero.
- **Nunca** clique em "Draft a new release" manual para a mesma tag: gera o
  duplicado que quebra a resolução.
- Para checar sem a interface, sem login: abrir no navegador
  `https://github.com/<owner>/<repo>/releases/download/<tag>/latest.yml`
  tem que baixar o YAML (404 = release quebrado/ausente).

## Regras e armadilhas (aprendidas na prática)

- `dist:publish` usa `--win nsis` explícito: publicar com os targets
  `[nsis, dir]` dispara dois fluxos concorrentes e o segundo morre com
  `422 already_exists` na criação do Release (e ainda deixa duplicata).
  **O `win.target` do `electron-builder.yml` precisa listar SÓ `nsis`** — no
  electron-builder 26 o `--win nsis` da CLI NÃO substitui a lista do arquivo,
  então ter `dir` ali recria o release duplicado mesmo com a flag. (O `pack`,
  que usa `--dir` na CLI, continua gerando a pasta descompactada quando
  necessário.)
- `electron-builder.yml` tem `releaseType: release`: tags publicam direto,
  sem rascunho. Rascunho é invisível para o atualizador.
- Instalador sem espaços no nome (`artifactName`): o `latest.yml` referencia
  o nome exato; com espaços o download 404.
- `electron`/`electron-builder` são `devDependencies` (nunca `optional`: o CI
  perde os tipos; nunca fixar pacote nativo do Rollup como dep direta:
  quebra o install no Windows).
- App empacotado exige `import` default de `electron-updater`
  (`import { autoUpdater }` quebra dentro do asar).
- O app instalado só verifica Releases **publicados** (~15 s após abrir e a
  cada 6 h) e instala **ao fechar/reabrir**. Dev (`npm start`) nunca verifica.
- O repo precisa ser **público**: o atualizador consulta o GitHub sem login e
  repo privado responde 404. Nenhum token vai no app (qualquer um extrai do
  `.exe`); segredos reais ficam no Render/Vercel e nunca foram commitados.
- A barra do app mostra o motivo: "baixando…", "pronta — reinicie o app",
  "release não encontrado (repositório privado?)", "sem internet".
