# Inicia o agente (usado pela tarefa de inicialização / atalho).
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$logDir = Join-Path $HOME ".smartv"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
& node "$PSScriptRoot\dist\index.js" >> (Join-Path $logDir "agent.log") 2>&1
