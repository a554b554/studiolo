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
    # The server refuses to start trusted tailnet access until Tailscale is connected,
    # and the Tailscale tray app starts minutes after login.
    function Test-StudioTailnet {
        $tailnetPath = Join-Path $StateDirectory 'tailnet.json'
        if (-not (Test-Path -LiteralPath $tailnetPath -PathType Leaf)) { return $true }
        $tailnet = Get-Content -LiteralPath $tailnetPath -Raw | ConvertFrom-Json
        if (-not $tailnet.enabled -or $tailnet.trustTailnet -ne $true) { return $true }
        $tailnetCommand = if ($tailnet.command) { $tailnet.command } else { 'tailscale' }
        try { $tailnetStatus = (& $tailnetCommand status --json | Out-String) | ConvertFrom-Json } catch { return $false }
        return ($tailnetStatus.BackendState -eq 'Running' -and [bool]$tailnetStatus.Self.DNSName)
    }
    # File locking also protects against launches in another login session.
    try {
        $studioLock = [System.IO.File]::Open((Join-Path $StateDirectory 'autostart.lock'),[System.IO.FileMode]::OpenOrCreate,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
    } catch [System.IO.IOException] {
        Write-StudioLog 'Another Studio launcher owns the lock; no process started.'
        exit 0
    }
    $studioEntry = Join-Path $StudioRoot 'src\server.mjs'
    $env:STUDIO_STATE_DIR = $StateDirectory
    $env:STUDIO_BIND = '127.0.0.1'
    $env:STUDIO_PORT = '4310'
    $env:STUDIO_PREVIEW_PORT = '4311'
    $env:TAILSCALE_BE_CLI = '1'
    # Refresh PATH from the user's installed environment (including CLI updates).
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    # Supervise the service for the whole login session. Task Scheduler never
    # retries it: the headless conhost wrapper always reports success.
    $studioDelay = 5
    while ($true) {
        $studioListeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue)
        if ($studioListeners.Count) {
            # Never kill a listener or start a second service over an occupied port.
            $studioInfo = Invoke-RestMethod -Uri 'http://127.0.0.1:4310/api/bootstrap' -TimeoutSec 15
            $studioMachine = Get-Content -LiteralPath (Join-Path $StateDirectory 'machine.json') -Raw | ConvertFrom-Json
            if (-not $studioInfo.hostId -or $studioInfo.hostId -ne $studioMachine.hostId) { throw 'Port 4310 belongs to a different service.' }
            $studioPids = @($studioListeners.OwningProcess | Select-Object -Unique)
            Write-StudioLog ('Studio already running; supervising PID=' + ($studioPids -join ','))
            Wait-Process -Id $studioPids -ErrorAction SilentlyContinue
            continue
        }
        if (-not (Test-Path -LiteralPath $studioEntry -PathType Leaf)) { throw 'Studio folder is not available yet.' }
        if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js executable not found.' }
        if (-not (Test-StudioTailnet)) {
            Write-StudioLog 'Waiting for Tailscale to connect.'
            while (-not (Test-StudioTailnet)) { Start-Sleep -Seconds 5 }
            Write-StudioLog 'Tailscale connected.'
        }
        $studioStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $studioOut = Join-Path $StateDirectory "server-$studioStamp.stdout.log"
        $studioErr = Join-Path $StateDirectory "server-$studioStamp.stderr.log"
        $studioChild = Start-Process -FilePath $NodePath -ArgumentList ('"' + $studioEntry + '"') -WorkingDirectory $StudioRoot -WindowStyle Hidden -RedirectStandardOutput $studioOut -RedirectStandardError $studioErr -PassThru
        $studioStarted = Get-Date
        Write-StudioLog ('Started Studio PID=' + $studioChild.Id + '; stderr=' + $studioErr)
        $studioChild.WaitForExit()
        $studioChild.Refresh()
        $studioExit = if ($null -eq $studioChild.ExitCode) { 1 } else { $studioChild.ExitCode }
        # A run of ten minutes resets the backoff; a crash loop slows to one start per minute.
        if (((Get-Date) - $studioStarted).TotalMinutes -ge 10) { $studioDelay = 5 }
        Write-StudioLog ('Studio exited with code ' + $studioExit + '; restarting in ' + $studioDelay + ' s')
        Start-Sleep -Seconds $studioDelay
        $studioDelay = [Math]::Min($studioDelay * 2, 60)
    }
} catch {
    if ($studioLog) { Write-StudioLog ('Startup failed: ' + $_.Exception.Message) }
    $studioExit = 1
} finally {
    if ($studioLock) { $studioLock.Dispose() }
}
exit $studioExit
