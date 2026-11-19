# Flyttar orderportal-projektet till C:\dev\orderportal för att undvika
# Windows MAX_PATH-problemet som Electron triggar på djupa sökvägar.
#
# Användning: högerklicka på filen → "Run with PowerShell"
#             eller i PowerShell: .\move-to-dev.ps1

$ErrorActionPreference = 'Stop'
$dest = 'C:\dev\orderportal'
$source = $PSScriptRoot

Write-Host ""
Write-Host "OrderPortal - flytt till kort sokvag" -ForegroundColor Cyan
Write-Host "  Fran: $source"
Write-Host "  Till: $dest"
Write-Host ""

if (-not (Test-Path 'C:\dev')) {
  Write-Host "Skapar C:\dev..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Path 'C:\dev' -Force | Out-Null
}

if (Test-Path $dest) {
  $answer = Read-Host "Destinationen finns redan. Skriv 'ja' for att skriva over"
  if ($answer -ne 'ja') {
    Write-Host "Avbrutet." -ForegroundColor Red
    exit 1
  }
  Remove-Item -Recurse -Force $dest
}

Write-Host "Kopierar kallkod (hoppar over node_modules + dist)..." -ForegroundColor Yellow
# robocopy returnerar exit code 0-7 som success, 8+ som fel
robocopy $source $dest /E /XD node_modules dist .git /XF *.zip /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) {
  Write-Host "robocopy misslyckades med exit code $LASTEXITCODE" -ForegroundColor Red
  exit 1
}

Set-Location $dest
Write-Host ""
Write-Host "Klart! Nu installeras dependencies i nya platsen..." -ForegroundColor Green
Write-Host ""

npm install

if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "npm install misslyckades. Kolla felmeddelandet ovan." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor Green
Write-Host " Allt klart!" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Appen finns nu i: $dest"
Write-Host ""
Write-Host "For att starta appen:"
Write-Host "  cd $dest"
Write-Host "  npm start"
Write-Host ""
Write-Host "Vill du starta direkt nu? (j/n)"
$start = Read-Host
if ($start -eq 'j' -or $start -eq 'J') {
  npm start
}
