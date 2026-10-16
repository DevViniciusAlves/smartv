# Instala o agente para iniciar com o Windows (Task Scheduler, roda no logon).
param(
  [string]$NodePath = "node",
  [string]$AgentDir = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)
$ErrorActionPreference = "Stop"
$taskName = "SmartTV Agent"
$start = "$AgentDir\start-agent.ps1"
if (-not (Test-Path -LiteralPath $start)) {
  Write-Error "start-agent.ps1 não encontrado em $AgentDir"
}
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -File `"$start`""
$trigger = New-ScheduledTaskLogonTrigger
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Smart TV agent (inicia com o Windows)" -Force | Out-Null
Write-Host "Tarefa '$taskName' instalada."
