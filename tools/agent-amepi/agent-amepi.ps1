# =============================================================================
# agent-amepi.ps1 - relevé du fichier des mandats AMEPI (Amanda) DEPUIS L'AGENCE
# et dépôt sur Studio Kadima.
#
# Pourquoi ici et pas sur le serveur : Amanda refuse les connexions par mot de
# passe venant d'ailleurs que du réseau de l'agence. Ce script tourne donc sur
# un poste de l'agence (tâche planifiée à l'ouverture de session), se connecte
# comme le ferait le navigateur, lit le fichier page par page et le dépose sur
# Studio avec la clé d'agent. Les identifiants restent dans config.json, ici.
#
# Lancer à la main :  powershell -ExecutionPolicy Bypass -File agent-amepi.ps1
# Journal :           agent-amepi.log (à côté du script)
# =============================================================================
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ici = Split-Path -Parent $MyInvocation.MyCommand.Path
$journal = Join-Path $ici "agent-amepi.log"
function Log($m) { $ligne = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m; Add-Content -Path $journal -Value $ligne -Encoding UTF8; Write-Host $ligne }

try {
  $cfg = Get-Content (Join-Path $ici "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $amepi = ($cfg.amepi_base, "https://agglomeration-bordelaise.amepi.info")[[string]::IsNullOrWhiteSpace($cfg.amepi_base)].TrimEnd("/")
  $studio = $cfg.studio_api.TrimEnd("/")
  $sources = @("1", "2", "3"); if ($cfg.sources) { $sources = @($cfg.sources | ForEach-Object { "$_" }) }
  $cps = @(); if ($cfg.communes) { $cps = @(($cfg.communes -split "[\s,;]+") | Where-Object { $_ -match "^\d{5}$" }) }
  $parPage = 100

  # 1) Connexion à Amanda, comme le navigateur : page de connexion (jeton +
  #    cookies), puis formulaire (agence 0, comme la page le fait).
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 AgentStudioKadima/1.0"
  $page = Invoke-WebRequest -Uri "$amepi/Account/Login" -WebSession $session -UserAgent $ua -UseBasicParsing
  $jeton = [regex]::Match($page.Content, 'name="__RequestVerificationToken"[^>]*value="([^"]+)"').Groups[1].Value
  if (-not $jeton) { throw "Page de connexion Amanda inattendue (pas de jeton)." }
  $corps = @{ Email = $cfg.amepi_email; Password = $cfg.amepi_password; RememberMe = "false"; SelectedAgency = "0"; __RequestVerificationToken = $jeton }
  $rep = Invoke-WebRequest -Uri "$amepi/Account/Login" -Method Post -Body $corps -WebSession $session -UserAgent $ua -UseBasicParsing `
    -Headers @{ Referer = "$amepi/Account/Login"; Origin = $amepi }
  if ($rep.Content -match "Email ou mot de passe invalide") { throw "Amanda refuse la connexion : e-mail ou mot de passe invalide (config.json), ou connexion hors du réseau de l'agence." }
  # Vérification : la page de recherche s'ouvre sans renvoyer au formulaire.
  $verif = Invoke-WebRequest -Uri "$amepi/mandate/search" -WebSession $session -UserAgent $ua -UseBasicParsing
  if ($verif.Content -match 'id="frmLogin"') { throw "Amanda a réaffiché le formulaire de connexion : identifiants ou réseau à vérifier." }
  Log "Connecté à Amanda ($($cfg.amepi_email))."

  # 2) Le fichier, page par page, déposé sur Studio au fur et à mesure.
  $numero = 1; $total = 0; $lus = 0; $premier = $true
  do {
    $form = @{
      searchTypeId = 1; assetTypes = @(); rooms = @(); bedrooms = @(); transactionStates = @(); sourceTypes = $sources
      sector = $null; sectorBBAL = $false; sectorBBAV = $false; filterResults = $false; userLogin = $cfg.amepi_email; agenciesList = @()
      mandateResultFilter = @{ displayType = 1; isPrivate = $false; filterType = 1; selectAll = $false; numberOfSelected = 0; page = $numero; itemsPerPage = $parPage }
    }
    if ($cps.Count -gt 0) { $form.location = $cps }
    $json = $form | ConvertTo-Json -Depth 6 -Compress
    $r = Invoke-WebRequest -Uri "$amepi/search" -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType "application/json;charset=utf-8" `
      -WebSession $session -UserAgent $ua -UseBasicParsing -Headers @{ Accept = "application/json"; Referer = "$amepi/mandate/search"; "X-Requested-With" = "XMLHttpRequest" }
    $res = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json
    if ($null -eq $res.value) { throw "Réponse inattendue d'Amanda sur /search (page $numero)." }
    $total = [int]$res.total
    $lot = @($res.value); $lus += $lot.Count
    $fini = ($lot.Count -lt $parPage) -or ($numero * $parPage -ge $total)
    $depot = @{ mandats = $lot; debut = $premier; fini = $fini; total = $total; base = $amepi } | ConvertTo-Json -Depth 12 -Compress
    $d = Invoke-WebRequest -Uri "$studio/crm/amepi/import" -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($depot)) -ContentType "application/json" `
      -Headers @{ "X-Agent-Key" = $cfg.studio_cle } -UseBasicParsing
    $stats = ([Text.Encoding]::UTF8.GetString($d.RawContentStream.ToArray()) | ConvertFrom-Json).stats
    Log ("Page {0} : {1} bien(s) déposé(s) - nouveaux {2}, baisses {3}{4}" -f $numero, $lot.Count, $stats.nouveaux, $stats.baisses, $(if ($fini) { ", retirés " + $stats.retirees + " - relevé terminé" } else { "" }))
    $premier = $false; $numero++
    if ($numero -gt 60) { throw "Plus de 60 pages : arrêt de sécurité." }
  } until ($fini)
  Log "Terminé : $lus bien(s) lus sur $total annoncés."
  exit 0
} catch {
  Log ("ERREUR : " + $_.Exception.Message)
  # On signale l'erreur à Studio (visible dans l'Administration) si la clé est là.
  try {
    if ($cfg -and $cfg.studio_cle) {
      $corpsErr = @{ mandats = @(); erreur = $_.Exception.Message } | ConvertTo-Json -Compress
      Invoke-WebRequest -Uri "$($cfg.studio_api.TrimEnd('/'))/crm/amepi/import" -Method Post -Body $corpsErr -ContentType "application/json" -Headers @{ "X-Agent-Key" = $cfg.studio_cle } -UseBasicParsing | Out-Null
    }
  } catch { }
  exit 1
}
