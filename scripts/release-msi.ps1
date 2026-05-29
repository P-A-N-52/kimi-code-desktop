param(
    [switch]$SkipPreflight,
    [switch]$Sign
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BundleDir = Join-Path $ProjectRoot "src-tauri\target\release\bundle\msi"
$ReleaseExe = Join-Path $ProjectRoot "src-tauri\target\release\kimi-code-desktop.exe"

function Get-CommandText {
    param([string]$Command)

    $result = & $Command --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $result) {
        return ($result -join " ").Trim()
    }
    return $null
}

function Get-GitValue {
    param([string[]]$GitArgs)

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        return $null
    }

    $oldErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $value = & git @GitArgs 2>$null
        $exitCode = $LASTEXITCODE
    } catch {
        return $null
    } finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }

    if ($exitCode -eq 0 -and $value) {
        return ($value -join "`n").Trim()
    }
    return $null
}

function Write-ReleaseMetadata {
    param(
        [System.IO.FileInfo]$Msi
    )

    $files = @($Msi)
    if (Test-Path $ReleaseExe) {
        $files += Get-Item $ReleaseExe
    }

    $hashLines = @()
    $fileEntries = @()
    foreach ($file in $files) {
        $hash = Get-FileHash -Algorithm SHA256 $file.FullName
        $hashLines += "$($hash.Hash)  $($file.Name)"
        $fileEntries += [ordered]@{
            name = $file.Name
            path = $file.FullName
            bytes = $file.Length
            sha256 = $hash.Hash
        }
    }

    $shaFile = Join-Path $BundleDir "SHA256SUMS.txt"
    $hashLines | Set-Content -Path $shaFile -Encoding UTF8

    $gitCommit = Get-GitValue -GitArgs @("rev-parse", "HEAD")
    $gitShortCommit = Get-GitValue -GitArgs @("rev-parse", "--short", "HEAD")
    $gitStatus = Get-GitValue -GitArgs @("status", "--short")

    $manifest = [ordered]@{
        product = "Kimi Code"
        version = (Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json).version
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        platform = "windows-x64"
        bundle = "msi"
        git = [ordered]@{
            commit = $gitCommit
            shortCommit = $gitShortCommit
            dirty = [bool]$gitStatus
        }
        toolchain = [ordered]@{
            node = Get-CommandText "node"
            npm = Get-CommandText "npm"
            rustc = Get-CommandText "rustc"
            cargo = Get-CommandText "cargo"
            python = Get-CommandText "python"
            uv = Get-CommandText "uv"
        }
        files = $fileEntries
    }

    $manifestPath = Join-Path $BundleDir "release-manifest.json"
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8

    Write-Host ""
    Write-Host "Release artifact:"
    Write-Host "  $($Msi.FullName)"
    Write-Host "Checksums:"
    Write-Host "  $shaFile"
    Write-Host "Manifest:"
    Write-Host "  $manifestPath"
}

Push-Location $ProjectRoot
try {
    if (-not $SkipPreflight) {
        & (Join-Path $PSScriptRoot "release-preflight.ps1")
    }

    Write-Host ""
    Write-Host "==> Building MSI bundle"
    npm run tauri:build

    if (!(Test-Path $BundleDir)) {
        throw "MSI bundle directory was not created: $BundleDir"
    }

    $msi = Get-ChildItem -Path $BundleDir -Filter "*.msi" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $msi) {
        throw "No MSI artifact found in $BundleDir"
    }

    if ($Sign) {
        & (Join-Path $PSScriptRoot "sign-windows.ps1") -Artifacts @($ReleaseExe, $msi.FullName)
    }

    Write-ReleaseMetadata -Msi $msi
}
finally {
    Pop-Location
}
