# Atalho "Modo Smart TV": garante a janela única da TV e navega ao launcher.
# Reusa a lógica do agente (TvBrowser via CDP). Uso: powershell -File start-tv.ps1
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath "dist/open-launcher.js")) {
  Write-Error "dist/open-launcher.js não encontrado. Rode 'npm run build' em apps/agent primeiro."
}
& node "dist/open-launcher.js"
if ($LASTEXITCODE -ne 0) { Write-Error "Falha ao abrir o launcher (veja a mensagem acima)." }
