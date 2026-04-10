param(
    [string]$ComposeFile = "docker-compose.yml"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "python is not installed or not available in PATH"
}

Write-Host "infra init: applying alembic migrations" -ForegroundColor Cyan
python -m alembic -c infra/db/alembic.ini upgrade head | Out-Host

Write-Host "infra init: migrations applied" -ForegroundColor Green
