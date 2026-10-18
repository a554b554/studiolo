param(
    [string]$StudioRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$StateDirectory = (Join-Path $env:USERPROFILE '.studio-local')
)
$ErrorActionPreference = 'Stop'
$studioLock = $null
$studioExit = 1
try {
    New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
    $studioLog = Join-Path $StateDirectory 'autostart.log'
    function Write-StudioLog([string]$Message) {
        Add-Content -LiteralPath $studioLog -Value ((Get-Date -Format o) + ' ' + $Message)
    }
    # File locking also protects against launches in another login session.
    try {
        $studioLock = [System.IO.File]::Open((Join-Path $StateDirectory 'autostart.lock'),[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
        Write-StudioLog 'Another Studio launcher owns the lock; no process started.'
        exit 0
    }
    $studioListeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue)
    if ($studioListeners.Count) {
        # Never kill a listener or start a second service over an occupied port.
        $studioInfo = Invoke-RestMethod -Uri 'http://127.0.0.1:4310/api/bootstrap' -TimeoutSec 15
        $studioMachine = Get-Content -LiteralPath (Join-Path $StateDirectory 'machine.json') -Raw | ConvertFrom-Json
        if (-not $studioInfo.hostId -or $studioInfo.hostId -ne $studioMachine.hostId) { throw 'Port 4310 belongs to a different service.' }
        Write-StudioLog ('Studio already running; no process started. PID=' + ($studioListeners.OwningProcess -join ','))
        exit 0
    }
    $studioEntry = Join-Path $StudioRoot 'src\server.mjs'
    if (-not (Test-Path -LiteralPath $studioEntry -PathType Leaf)) { throw 'Studio folder is not available yet.' }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js executable not found.' }
    $env:STUDIO_STATE_DIR = $StateDirectory
    $env:STUDIO_BIND = '127.0.0.1'
    $env:STUDIO_PORT = '4310'
    $env:STUDIO_PREVIEW_PORT = '4311'
    # Refresh PATH from the user's installed environment (including CLI updates).
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $studioStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $studioOut = Join-Path $StateDirectory "server-$studioStamp.stdout.log"
    $studioErr = Join-Path $StateDirectory "server-$studioStamp.stderr.log"
    $studioChild = Start-Process -FilePath $NodePath -ArgumentList ('"' + $studioEntry + '"') -WorkingDirectory $StudioRoot -WindowStyle Hidden -RedirectStandardOutput $studioOut -RedirectStandardError $studioErr -PassThru
    Write-StudioLog ('Started Studio PID=' + $studioChild.Id + '; stderr=' + $studioErr)
    # Keep the scheduled task running for the lifetime of the service. A failed
    # child returns failure to Task Scheduler, which retries after one minute.
    $studioChild.WaitForExit()
    $studioChild.Refresh()
    $studioExit = if ($null -eq $studioChild.ExitCode) { 1 } else { $studioChild.ExitCode }
    Write-StudioLog ('Studio exited with code ' + $studioExit)
} catch {
    if ($studioLog) { Write-StudioLog ('Startup failed: ' + $_.Exception.Message) }
    $studioExit = 1
} finally {
    if ($studioLock) { $studioLock.Dispose() }
}
exit $studioExit
