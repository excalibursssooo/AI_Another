param(
    [string]$ComposeFile = "docker-compose.yml"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$pgUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "postgres" }
$pgDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "companion" }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker is not installed or not available in PATH"
}

Write-Host "infra init: applying postgres schema" -ForegroundColor Cyan
docker compose -f $ComposeFile exec -T postgres psql -U $pgUser -d $pgDb -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/001_schema.sql | Out-Host

Write-Host "infra init: schema applied" -ForegroundColor Green
