# Remove a tarefa de inicialização do agente.
Unregister-ScheduledTask -TaskName "SmartTV Agent" -Confirm:$false
Write-Host "Tarefa removida."
