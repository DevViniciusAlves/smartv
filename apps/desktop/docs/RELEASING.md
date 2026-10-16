# Publicar uma versão do app Windows (RELEASING)

Fluxo suportado pelo CI (`.github/workflows/ci.yml`):

- Push na `main` (ou PR): roda só `validate` (lint, typecheck, testes, build).
- Push de tag `vX.Y.Z`: roda `validate` + `release` (Windows), que gera o
  instalador e publica o GitHub Release com `SmartTV-Setup-*.exe`,
  `latest.yml` e `.blockmap`. Apps instalados atualizam sozinhos ao reiniciar.

## Passo a passo

```powershell
# 1. versão nova em apps/desktop/package.json (ex: 1.0.2 -> 1.0.3)
git add -A
git commit -m "o que mudou"
git push
# 2. tag EXATAMENTE igual à versão (o CI falha se diferir)
git tag v1.0.3
git push origin v1.0.3
```

## Regras e armadilhas (aprendidas na prática)

- `dist:publish` usa `--win nsis` explícito: publicar com os targets
  `[nsis, dir]` dispara dois fluxos concorrentes e o segundo morre com
  `422 already_exists` na criação do Release.
- `electron-builder.yml` tem `releaseType: release`: tags publicam direto,
  sem rascunho. Rascunho é invisível para o atualizador.
- Se uma run falhar **depois** de criar rascunho parcial: apague o draft em
  Releases, mova a tag (`git tag -f vX.Y.Z; git push origin -f vX.Y.Z`).
- Instalador sem espaços no nome (`artifactName`): o `latest.yml` referencia
  o nome exato; com espaços o download 404.
- `electron`/`electron-builder` são `devDependencies` (nunca `optional`: o CI
  perde os tipos; nunca fixar pacote nativo do Rollup como dep direta:
  quebra o install no Windows).
- App empacotado exige `import` default de `electron-updater`
  (`import { autoUpdater }` quebra dentro do asar).
- O app instalado só verifica Releases **publicados** (~15 s após abrir e a
  cada 6 h) e instala **ao fechar/reabrir**. Dev (`npm start`) nunca verifica.
