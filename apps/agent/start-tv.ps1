# Atalho "Modo Smart TV": abre o launcher no Edge dedicado em tela cheia.
# Uso: powershell -File start-tv.ps1 (o instalador pode criar um atalho .lnk para este script)
$ErrorActionPreference = "Stop"
$envFile = Join-Path $PSScriptRoot ".env"
$launcher = "https://seu-app.vercel.app/tv"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$profile = ""
$x = "0"; $y = "0"
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*LAUNCHER_URL\s*=\s*(.+)\s*$') { $launcher = $Matches[1].Trim() }
    if ($line -match '^\s*BROWSER_PATH\s*=\s*(.+)\s*$') { $edge = $Matches[1].Trim() }
    if ($line -match '^\s*BROWSER_PROFILE_DIR\s*=\s*(.+)\s*$') { $profile = $Matches[1].Trim() }
    if ($line -match '^\s*TV_WINDOW_X\s*=\s*(.+)\s*$') { $x = $Matches[1].Trim() }
    if ($line -match '^\s*TV_WINDOW_Y\s*=\s*(.+)\s*$') { $y = $Matches[1].Trim() }
  }
}
$args = @("--window-position=$x,$y", "--disable-session-crashed-bubble", $launcher)
if ($profile -ne "") { $args = @("--user-data-dir=$profile") + $args }
Start-Process -FilePath $edge -ArgumentList $args
