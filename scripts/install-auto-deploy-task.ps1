# One-time: register Windows Task Scheduler job for automatic Pages deploy
# after Claude writes data/latest.json (every 10 minutes, deploys only if file changed).

$TaskName = 'RytsenseGrowthBoardAutoDeploy'
$Script = 'E:\growth-board\scripts\watch-and-deploy.ps1'
$Tr = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""

schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
schtasks /Create /TN $TaskName /SC MINUTE /MO 10 /TR $Tr /RL LIMITED /F
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "OK: Task '$TaskName' runs every 10 minutes."
Write-Host "It deploys only when data\latest.json is newer than .cf-last-deploy-stamp."
Write-Host "Log: E:\growth-board\data\auto-deploy.log"
schtasks /Query /TN $TaskName /V /FO LIST | Select-String -Pattern 'TaskName|Status|Next Run|Task To Run'
