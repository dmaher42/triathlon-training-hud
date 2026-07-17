$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "The HUD dependencies could not be installed." }
}

$candidatePorts = 5173..5199
$portRecord = Join-Path $projectRoot ".hud-port"

if (Test-Path -LiteralPath $portRecord) {
    $recordedPort = [int](Get-Content -LiteralPath $portRecord -Raw)
    try {
        $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$recordedPort" -TimeoutSec 1
        if ($response.Content -match "<title>Triathlon Training HUD</title>") {
            Start-Process "http://127.0.0.1:$recordedPort"
            exit 0
        }
    } catch {
        Remove-Item -LiteralPath $portRecord -Force -ErrorAction SilentlyContinue
    }
}

$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)

foreach ($port in $candidatePorts) {
    if ($listeners.LocalPort -notcontains $port) { continue }
    try {
        $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port" -TimeoutSec 1
        if ($response.Content -match "<title>Triathlon Training HUD</title>") {
            Set-Content -LiteralPath $portRecord -Value $port
            Start-Process "http://127.0.0.1:$port"
            exit 0
        }
    } catch {
        # A different local service owns this port; leave it untouched.
    }
}

$port = $candidatePorts | Where-Object { $listeners.LocalPort -notcontains $_ } | Select-Object -First 1
if (-not $port) { throw "No free local port was found between 5173 and 5199." }

$node = (Get-Command node -ErrorAction Stop).Source
$vite = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
$serverProcess = Start-Process `
    -FilePath $node `
    -ArgumentList $vite, "--host", "127.0.0.1", "--port", $port, "--strictPort" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru

$url = "http://127.0.0.1:$port"
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 250
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) {
        throw "The Triathlon HUD server stopped during startup (exit code $($serverProcess.ExitCode))."
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 1
        if ($response.Content -match "<title>Triathlon Training HUD</title>") {
            Set-Content -LiteralPath $portRecord -Value $port
            Set-Content -LiteralPath (Join-Path $projectRoot ".vite-server.pid") -Value $serverProcess.Id
            Start-Process $url
            exit 0
        }
    } catch {
        # The local server is still starting.
    }
}

if (-not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
}
throw "The Triathlon HUD server did not become ready at $url."
