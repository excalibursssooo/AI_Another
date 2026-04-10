param(
    [string]$ComposeFile = "docker-compose.yml"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$pgUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "postgres" }
$pgDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "companion" }
$qdrantPort = if ($env:QDRANT_PORT) { $env:QDRANT_PORT } else { "6333" }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker is not installed or not available in PATH"
}

Write-Host "infra up: starting postgres and qdrant" -ForegroundColor Cyan
docker compose -f $ComposeFile up -d postgres qdrant | Out-Host

Write-Host "infra up: waiting for postgres" -ForegroundColor Yellow
$pgReady = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        docker compose -f $ComposeFile exec -T postgres pg_isready -U $pgUser -d $pgDb | Out-Null
        $pgReady = $true
        break
    }
    catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $pgReady) {
    throw "postgres startup timeout"
}

Write-Host "infra up: waiting for qdrant" -ForegroundColor Yellow
$qdrantReady = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $qdrantUrl = "http://127.0.0.1:" + $qdrantPort + "/healthz"
        $resp = Invoke-WebRequest -UseBasicParsing $qdrantUrl -TimeoutSec 2
        if ($resp.StatusCode -eq 200) {
            $qdrantReady = $true
            break
        }
    }
    catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $qdrantReady) {
    throw "qdrant startup timeout"
}

Write-Host "infra up: applying migrations" -ForegroundColor Cyan
& "$PSScriptRoot/local_infra_init.ps1" -ComposeFile $ComposeFile

Write-Host "infra up: done" -ForegroundColor Green
Write-Host "Postgres: postgresql://postgres:postgres@localhost:5432/companion"
Write-Host "Qdrant : http://localhost:6333"
