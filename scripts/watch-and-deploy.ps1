# Auto-deploy Growth Board when data/latest.json changes.
# Windows Task Scheduler runs this every 10 minutes (no Claude shell needed).

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Latest = Join-Path $Root 'data\latest.json'
$Stamp = Join-Path $Root '.cf-last-deploy-stamp'
$Log = Join-Path $Root 'data\auto-deploy.log'

function Log([string]$msg) {
  Add-Content -Path $Log -Value (('{0:u} {1}' -f (Get-Date).ToUniversalTime(), $msg)) -Encoding utf8
}

if (-not (Test-Path $Latest)) { Log 'SKIP no latest.json'; exit 0 }

$latestTime = (Get-Item $Latest).LastWriteTimeUtc
if (Test-Path $Stamp) {
  try {
    $stampTime = [datetime]::Parse(
      (Get-Content $Stamp -Raw).Trim(),
      $null,
      [System.Globalization.DateTimeStyles]::RoundtripKind
    )
    if ($latestTime -le $stampTime) { exit 0 }
  } catch { }
}

Log ("DEPLOY start latest={0:u}" -f $latestTime)
Set-Location $Root
try {
  & npm run deploy:cf
  if ($LASTEXITCODE -ne 0) { throw "deploy:cf exit $LASTEXITCODE" }
  Set-Content -Path $Stamp -Value ($latestTime.ToString('o')) -Encoding ascii -NoNewline
  Log 'DEPLOY ok'
  exit 0
} catch {
  Log ("DEPLOY fail: {0}" -f $_.Exception.Message)
  exit 1
}
