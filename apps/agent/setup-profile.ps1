# Primeira configuração: abre o Edge NORMAL (sem quiosque) com o perfil dedicado,
# para logar uma vez nas contas (YouTube, Netflix, HBO, Disney+) e instalar a
# extensão descompactada via edge://extensions (Modo do desenvolvedor).
# Uso (uma única vez): powershell -ExecutionPolicy Bypass -File setup-profile.ps1
$ErrorActionPreference = "Stop"
$envFile = Join-Path $PSScriptRoot ".env"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$profile = ""
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*BROWSER_PATH\s*=\s*(.+)\s*$') { $edge = $Matches[1].Trim() }
    if ($line -match '^\s*BROWSER_PROFILE_DIR\s*=\s*(.+)\s*$') { $profile = $Matches[1].Trim() }
  }
}
if ($profile -eq "") { Write-Error "BROWSER_PROFILE_DIR não definido no .env" }
$profile = [Environment]::ExpandEnvironmentVariables($profile)
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Write-Host "Abrindo Edge normal com o perfil dedicado..."
Write-Host "1) Faça login nos 4 serviços de streaming."
Write-Host "2) Abra edge://extensions, ative o Modo do desenvolvedor e 'Carregar sem compactação' apontando para apps/extension/dist."
Start-Process -FilePath $edge -ArgumentList @("--user-data-dir=$profile")
