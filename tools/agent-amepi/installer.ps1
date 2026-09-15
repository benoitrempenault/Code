# Installe l'agent AMEPI : une tâche planifiée qui lance agent-amepi.ps1 à
# chaque ouverture de session Windows (et tout de suite, pour vérifier).
# Lancer :  powershell -ExecutionPolicy Bypass -File installer.ps1
$ici = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $ici "config.json"))) { Write-Host "Créez d'abord config.json (copiez config.exemple.json et remplissez-le)." -ForegroundColor Red; exit 1 }
$script = Join-Path $ici "agent-amepi.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$declencheur = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$declencheur.Delay = "PT2M"   # deux minutes après l'ouverture de session, le temps du réseau
$reglages = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RunOnlyIfNetworkAvailable
Register-ScheduledTask -TaskName "Studio Kadima - Agent AMEPI" -Action $action -Trigger $declencheur -Settings $reglages -Force | Out-Null
Write-Host "Tâche planifiée installée : « Studio Kadima - Agent AMEPI » (à chaque ouverture de session)." -ForegroundColor Green
Write-Host "Premier relevé maintenant..." -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
Write-Host "Journal : $(Join-Path $ici 'agent-amepi.log')"
