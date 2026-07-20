$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $ProjectRoot "src-tauri\target\release"
$ReleaseExe = Join-Path $ReleaseDir "kimi-code-desktop.exe"
$ReleaseManifest = Join-Path $ReleaseDir "kimi-code-desktop.release.json"
$DistIndex = Join-Path $ProjectRoot "dist\index.html"

function Invoke-Native {
    param(
        [string]$Command,
        [string[]]$Arguments = @()
    )

    & $Command @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $commandText = (@($Command) + $Arguments) -join " "
        throw "Command failed with exit code $exitCode`: $commandText"
    }
}

function Stop-KimiDesktopProcesses {
    $processes = @(Get-Process -Name "kimi-code-desktop" -ErrorAction SilentlyContinue)
    if (-not $processes) {
        return
    }

    foreach ($process in $processes) {
        Write-Host "Stopping $($process.ProcessName) (PID $($process.Id))"
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
    }

    Start-Sleep -Milliseconds 500
    $remaining = @(Get-Process -Name "kimi-code-desktop" -ErrorAction SilentlyContinue)
    if ($remaining) {
        $ids = ($remaining | ForEach-Object { $_.Id }) -join ", "
        throw "Could not stop kimi-code-desktop process(es): $ids"
    }
}

function Get-PackageVersion {
    return (Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json).version
}

function Get-FileEntry {
    param([string]$Path)

    $item = Get-Item $Path
    $hash = Get-FileHash -Algorithm SHA256 $item.FullName
    return [ordered]@{
        path = $item.FullName
        bytes = $item.Length
        lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")
        sha256 = $hash.Hash
    }
}

function Write-ReleaseManifest {
    if (!(Test-Path $ReleaseExe)) {
        throw "Release executable was not created: $ReleaseExe"
    }
    if (!(Test-Path $DistIndex)) {
        throw "Frontend index was not created: $DistIndex"
    }

    $manifest = [ordered]@{
        schema = 1
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        buildCommand = "npm run desktop:release"
        version = Get-PackageVersion
        files = [ordered]@{
            releaseExe = Get-FileEntry $ReleaseExe
            distIndex = Get-FileEntry $DistIndex
        }
    }

    if (!(Test-Path $ReleaseDir)) {
        New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
    }

    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $ReleaseManifest -Encoding UTF8
    Write-Host "Release manifest written: $ReleaseManifest"
}

Push-Location $ProjectRoot
try {
    Stop-KimiDesktopProcesses
    if (Test-Path $ReleaseManifest) {
        Remove-Item $ReleaseManifest -Force
    }
    Invoke-Native "node" @("scripts/sync-version.js")
    Invoke-Native "npm" @("run", "tauri", "--", "build", "--no-bundle")
    Write-ReleaseManifest
}
finally {
    Pop-Location
}
