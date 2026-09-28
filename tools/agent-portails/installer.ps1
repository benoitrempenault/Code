# Installe l'agent des portails (SeLoger, Bien'ici, Leboncoin) :
# Node.js portable si besoin, le pilote de navigateur, puis une tache planifiee
# (a l'ouverture de session et chaque soir a 20h ; un releve par jour au plus).
# Lancer : INSTALLER.cmd
$ErrorActionPreference = "Stop"
$ici = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-ChildItem -Path $ici -File | Unblock-File -ErrorAction SilentlyContinue
$config = Join-Path $ici "config.json"
$exemple = Join-Path $ici "config.exemple.json"
if (-not (Test-Path $config) -and (Test-Path $exemple) -and ((Get-Content $exemple -Raw) -match '"studio_cle"\s*:\s*"ak_')) {
  Copy-Item $exemple $config
  Write-Host "config.json cree a partir de config.exemple.json (rempli)." -ForegroundColor Cyan
}
if (-not (Test-Path $config)) {
  Write-Host "Creez d'abord config.json : ouvrez config.exemple.json, collez la cle de l'agent (Studio Bilans, bouton Portails, Nouvelle cle), enregistrez." -ForegroundColor Red
  Read-Host "Appuyez sur Entree pour fermer"
  exit 1
}

# 1) Node.js : celui du PC s'il existe, sinon une copie portable dans ce dossier.
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node) {
  $node = Join-Path $ici "node\node.exe"
  if (-not (Test-Path $node)) {
    Write-Host "Telechargement de Node.js (portable, reste dans ce dossier)..." -ForegroundColor Cyan
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
    $v = ($index | Where-Object { $_.version -like "v22.*" -and $_.files -contains "win-x64-zip" } | Select-Object -First 1).version
    $zip = Join-Path $env:TEMP "node-$v-win-x64.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $ici -Force
    Rename-Item (Join-Path $ici "node-$v-win-x64") "node"
    Remove-Item $zip -ErrorAction SilentlyContinue
  }
}
$npm = Join-Path (Split-Path $node) "npm.cmd"
Write-Host "Installation du pilote de navigateur (playwright-core, sans telecharger de navigateur : Edge est deja la)..." -ForegroundColor Cyan
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
& $npm install --prefix $ici --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Write-Host "npm install a echoue." -ForegroundColor Red; Read-Host "Entree pour fermer"; exit 1 }
Set-Content -Path (Join-Path $ici "node-chemin.txt") -Value $node -Encoding ASCII

# 2) La tache planifiee : dans la session de l'utilisateur (Edge a besoin d'un bureau).
$script = Join-Path $ici "agent-portails.mjs"
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $ici
$ouverture = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$ouverture.Delay = "PT3M"
$soir = New-ScheduledTaskTrigger -Daily -At 20:00
$reglages = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RunOnlyIfNetworkAvailable
Register-ScheduledTask -TaskName "Studio Kadima - Agent portails" -Action $action -Trigger @($ouverture, $soir) -Settings $reglages -Force | Out-Null
Write-Host "Tache planifiee installee : Studio Kadima - Agent portails (ouverture de session + 20h)." -ForegroundColor Green
Write-Host ""
Write-Host "Etape suivante : double-cliquez CONNECTER.cmd et connectez-vous aux 3 portails (une fois)." -ForegroundColor Yellow
Write-Host "Puis APPRENDRE.cmd : montrez-lui les pages de statistiques de vos annonces." -ForegroundColor Yellow
Read-Host "Termine - appuyez sur Entree pour fermer"
