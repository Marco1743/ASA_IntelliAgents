# validate.ps1 — end-to-end validation driver for the Deliveroo project.
#
# Launches BOTH agents against the game server configured in .env and feeds the
# LLM agent a paced sequence of Challenge-2 missions (L1 atomic / L2 strategy /
# L3 coordination), so you can watch the behaviour in the logs and the 3D UI.
#
# What it does:
#   - starts BDI_agent.js  (Agent A) in a SEPARATE window   → its own logs
#   - starts LLM_agent.js  (Agent B) inline in THIS console → logs + driving
#   - sends one mission at a time, pausing so you can observe each
#   - optionally enables the PDDL high-level task planner on the BDI
#
# Prerequisites:
#   - .env present with HOST, TOKEN (BDI) and LLM_TOKEN (LLM) — distinct tokens
#   - the game server at HOST reachable (unitn VPN / cloud / local localhost:8080)
#   - LLM reachable: LLM_LOCAL=true needs Ollama installed (first run may pull a
#     model → raise -InitialWait); LLM_LOCAL=false needs the unitn VPN
#
# Usage (from the repo root):
#   ./validate.ps1                     # default sequence, greedy BDI
#   ./validate.ps1 -PddlTasks          # also enable PDDL pickup-order planner
#   ./validate.ps1 -Pause 15 -InitialWait 25
#
[CmdletBinding()]
param(
    [int]$Pause       = 12,   # seconds between missions (time to observe each)
    [int]$InitialWait = 15,   # seconds to wait for Ollama bootstrap + game state
    [switch]$PddlTasks        # set BDI_USE_PDDL_TASKS=true for the BDI process
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

if (-not (Test-Path "$root/.env")) {
    Write-Error ".env not found in $root — need HOST, TOKEN and LLM_TOKEN."
}

# The Challenge-2 mission sequence. Edit freely. Grouped by level.
$missions = @(
    # --- L1: atomic / standing tile rules ------------------------------------
    'Move to coordinate (5,5) and you get +10pts',
    'Move to x=4*2 y=(1+3)*3 to get -10pts',
    # --- L2: persistent game-strategy constraints ----------------------------
    'Deliver stacks of exactly 3 parcels at a time to double the reward',
    'If you deliver parcels with a score higher than 10 you get no reward',
    'Deliver stacks of exactly 5 parcels and you get 0 pts',
    # --- L3: coordination with the BDI teammate ------------------------------
    'rendezvous at (5,5) within a maximum distance of 1',
    'wait for my signal',
    'go'
)

# 1) BDI agent in its own window (so its logs stay separate from the LLM's).
if ($PddlTasks) { $env:BDI_USE_PDDL_TASKS = 'true' } else { Remove-Item Env:BDI_USE_PDDL_TASKS -ErrorAction SilentlyContinue }
Write-Host "[validate] starting BDI agent (PDDL tasks: $($PddlTasks.IsPresent))..." -ForegroundColor Cyan
$bdi = Start-Process -FilePath 'node' -ArgumentList 'BDI_agent.js' -WorkingDirectory $root -PassThru
Start-Sleep -Seconds 4   # let it connect and receive the map

# 2) LLM agent inline: redirect ONLY stdin (so we can feed missions); let its
#    stdout/stderr inherit this console so you see its logs live.
Write-Host "[validate] starting LLM agent (this console shows its logs)..." -ForegroundColor Cyan
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName               = 'node'
$psi.Arguments              = 'LLM_agent.js'
$psi.WorkingDirectory       = $root
$psi.UseShellExecute        = $false
$psi.RedirectStandardInput  = $true
$llm = [System.Diagnostics.Process]::Start($psi)

Write-Host "[validate] waiting ${InitialWait}s for LLM bootstrap + game state..." -ForegroundColor Cyan
Start-Sleep -Seconds $InitialWait

# 3) drive the sequence.
try {
    foreach ($m in $missions) {
        if ($llm.HasExited) { Write-Warning "LLM agent exited early — aborting sequence."; break }
        Write-Host "`n>>> MISSION: $m" -ForegroundColor Green
        $llm.StandardInput.WriteLine($m)
        $llm.StandardInput.Flush()
        Start-Sleep -Seconds $Pause
    }
    Write-Host "`n[validate] sequence finished. Agents still running." -ForegroundColor Cyan
    Write-Host "[validate] type extra missions and press Enter, or just Enter to stop both." -ForegroundColor Cyan
    while (-not $llm.HasExited) {
        $line = [System.Console]::ReadLine()
        if ([string]::IsNullOrWhiteSpace($line)) { break }
        Write-Host ">>> MISSION: $line" -ForegroundColor Green
        $llm.StandardInput.WriteLine($line); $llm.StandardInput.Flush()
    }
}
finally {
    Write-Host "[validate] stopping agents..." -ForegroundColor Cyan
    try { if (-not $llm.HasExited) { $llm.StandardInput.WriteLine('quit'); $llm.StandardInput.Flush() } } catch {}
    Start-Sleep -Seconds 1
    foreach ($p in @($llm, $bdi)) {
        try { if ($p -and -not $p.HasExited) { $p.Kill() } } catch {}
    }
    Remove-Item Env:BDI_USE_PDDL_TASKS -ErrorAction SilentlyContinue
    Write-Host "[validate] done." -ForegroundColor Cyan
}
