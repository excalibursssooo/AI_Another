param(
    [string]$ComposeFile = "docker-compose.yml"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$qdrantPort = if ($env:QDRANT_PORT) { $env:QDRANT_PORT } else { "6333" }
$postgresPort = if ($env:POSTGRES_PORT) { $env:POSTGRES_PORT } else { "5432" }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker is not installed or not available in PATH"
}

Write-Host "infra status: docker compose ps" -ForegroundColor Cyan
docker compose -f $ComposeFile ps | Out-Host

Write-Host "infra status: endpoint checks" -ForegroundColor Cyan
try {
    $qdrantUrl = "http://127.0.0.1:" + $qdrantPort + "/healthz"
    $qdrant = Invoke-WebRequest -UseBasicParsing $qdrantUrl -TimeoutSec 2
    Write-Host "Qdrant  : OK ($($qdrant.StatusCode)) at $qdrantUrl" -ForegroundColor Green
} catch {
    Write-Host "Qdrant  : NOT READY at http://127.0.0.1:$qdrantPort/healthz" -ForegroundColor Yellow
}

try {
    $pgConn = Test-NetConnection -ComputerName 127.0.0.1 -Port ([int]$postgresPort) -WarningAction SilentlyContinue
    if ($pgConn.TcpTestSucceeded) {
        Write-Host "Postgres: OK at 127.0.0.1:$postgresPort" -ForegroundColor Green
    } else {
        Write-Host "Postgres: NOT READY at 127.0.0.1:$postgresPort" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Postgres: CHECK FAILED at 127.0.0.1:$postgresPort" -ForegroundColor Yellow
}
