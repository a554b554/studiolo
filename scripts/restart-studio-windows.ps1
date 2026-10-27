$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
$studioBase = 'http://127.0.0.1:4310'
$studioInfo = Invoke-RestMethod "$studioBase/api/bootstrap" -TimeoutSec 20
foreach ($project in $studioInfo.projects) {
    if ($project.unavailable) { throw "Project history unavailable: $($project.name). Resolve synchronization before restart." }
    $state = Invoke-RestMethod "$studioBase/api/projects/$($project.id)" -TimeoutSec 30
    $active = @($state.runs | Where-Object { $_.hostId -eq $studioInfo.hostId -and $_.status -in @('running','waiting','queued') })
    if ($active.Count) { throw "Finish or cancel active work in $($project.name) before restarting." }
}
$listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4310 -State Listen)
foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if ($process.CommandLine -notlike '*src*server.mjs*') { throw 'Port 4310 does not belong to the expected Studio process.' }
}
Stop-ScheduledTask -TaskName 'Studio Local - Login'
# Stopping the task ends only its headless conhost. End the supervising launcher
# (and its server child) first, or it would start a replacement under the old launcher.
foreach ($launcher in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*\start-studio-windows.ps1*' })) {
    & taskkill.exe /PID $launcher.ProcessId /T /F | Out-Null
}
foreach ($listener in $listeners) {
    if (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue) {
        & taskkill.exe /PID $listener.OwningProcess /T /F | Out-Null
    }
}
# Let the old launcher exit and release its lock before starting a new one.
for ($attempt=0; $attempt -lt 20; $attempt++) {
    if (-not @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*\start-studio-windows.ps1*' }).Count) { break }
    Start-Sleep -Milliseconds 500
}
Start-ScheduledTask -TaskName 'Studio Local - Login'
for ($attempt=0; $attempt -lt 45; $attempt++) {
    Start-Sleep -Seconds 2
    try {
        $identity = Invoke-RestMethod "$studioBase/api/identity" -TimeoutSec 5
        if ($identity.protocol -eq 2) { Write-Host 'Studio multi-server protocol 2 is running.'; exit 0 }
    } catch { }
}
throw 'Studiolo has not become ready. Inspect ~/.studio-local/server-*.stderr.log.'
