#Requires -Version 5.1
<#
  Install the SEO agent team into ~/.claude so it is available in every project.
  Usage: ./install.ps1  |  ./install.ps1 -Check  |  ./install.ps1 -Uninstall
#>
param([switch]$Check, [switch]$Uninstall)

$Src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $HOME '.claude' }

$agents   = Get-ChildItem (Join-Path $Src '.claude/agents/*.md')
$commands = Get-ChildItem (Join-Path $Src '.claude/commands/*.md')

if ($Check) {
  Write-Host "Would install into $Dest"
  Write-Host "  $($agents.Count) agents  -> $Dest\agents\"
  Write-Host "  $($commands.Count) commands -> $Dest\commands\"
  $conflicts = 0
  foreach ($f in @($agents) + @($commands)) {
    $sub = Split-Path -Leaf (Split-Path -Parent $f.FullName)
    $t = Join-Path $Dest "$sub\$($f.Name)"
    if ((Test-Path $t) -and ((Get-FileHash $t).Hash -ne (Get-FileHash $f.FullName).Hash)) {
      Write-Host "  CONFLICT (would overwrite): $sub\$($f.Name)"; $conflicts++
    }
  }
  if ($conflicts -eq 0) { Write-Host 'No conflicts.' } else { Write-Host "$conflicts existing file(s) differ and would be replaced." }
  exit 0
}

if ($Uninstall) {
  $n = 0
  foreach ($f in @($agents) + @($commands)) {
    $sub = Split-Path -Leaf (Split-Path -Parent $f.FullName)
    $t = Join-Path $Dest "$sub\$($f.Name)"
    if (Test-Path $t) { Remove-Item $t -Force; $n++ }
  }
  Write-Host "Removed $n file(s) from $Dest"
  exit 0
}

New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'agents')   | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'commands') | Out-Null
Copy-Item $agents   -Destination (Join-Path $Dest 'agents')   -Force
Copy-Item $commands -Destination (Join-Path $Dest 'commands') -Force

Write-Host "Installed into $Dest"
Write-Host "  $($agents.Count) agents"
Write-Host "  $($commands.Count) commands"
Write-Host ''
Write-Host 'Agents are now available in every project. The tools they call'
Write-Host '(tools/serp.mjs, tools/memory.mjs, tools/guard.mjs) live in this repo and'
Write-Host 'are referenced by relative path, so run engagements from:'
Write-Host "  $Src"
