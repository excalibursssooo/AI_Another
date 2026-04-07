param(
    [string]$ComposeFile = "docker-compose.yml",
    [switch]$RemoveVolumes
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker 未安装或不可用。"
}

if ($RemoveVolumes) {
    Write-Host "[infra:down] Stopping and removing containers with volumes..." -ForegroundColor Yellow
    docker compose -f $ComposeFile down -v | Out-Host
} else {
    Write-Host "[infra:down] Stopping containers..." -ForegroundColor Yellow
    docker compose -f $ComposeFile down | Out-Host
}

Write-Host "[infra:down] Done." -ForegroundColor Green
