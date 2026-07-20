param(
    [switch]$SkipPreflight,
    [switch]$Sign
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BundleDir = Join-Path $ProjectRoot "src-tauri\target\release\bundle\msi"
$WixDir = Join-Path $ProjectRoot "src-tauri\target\release\wix"
$ReleaseExe = Join-Path $ProjectRoot "src-tauri\target\release\kimi-code-desktop.exe"
$ReleaseManifest = Join-Path $ProjectRoot "src-tauri\target\release\kimi-code-desktop.release.json"
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

function Invoke-LocalScript {
    param(
        [string]$ScriptPath,
        [string[]]$Arguments = @()
    )

    & $ScriptPath @Arguments
    if (-not $?) {
        $commandText = (@($ScriptPath) + $Arguments) -join " "
        throw "Script failed: $commandText"
    }
}

function Get-PackageVersion {
    return (Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json).version
}

function Get-FileEntry {
    param([string]$Path)

    if (!(Test-Path $Path)) {
        throw "Required artifact is missing: $Path"
    }

    $item = Get-Item $Path
    $hash = Get-FileHash -Algorithm SHA256 $item.FullName
    return [ordered]@{
        path = $item.FullName
        bytes = $item.Length
        lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")
        sha256 = $hash.Hash
    }
}

function Write-LocalReleaseManifest {
    $manifest = [ordered]@{
        schema = 1
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        buildCommand = "npm run release:msi"
        version = Get-PackageVersion
        files = [ordered]@{
            releaseExe = Get-FileEntry $ReleaseExe
            distIndex = Get-FileEntry $DistIndex
        }
    }

    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $ReleaseManifest -Encoding UTF8
}

function Assert-FreshReleaseExe {
    if (!(Test-Path $ReleaseExe)) {
        throw "Release executable was not created: $ReleaseExe"
    }

    $hash = (Get-FileHash -Algorithm SHA256 $ReleaseExe).Hash
    Write-Host "Release executable present (sha256: $hash)"
}

function Get-TauriConfig {
    return Get-Content (Join-Path $ProjectRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
}

function Get-LatestWixMainFile {
    if (!(Test-Path $WixDir)) {
        throw "WiX output directory was not created: $WixDir"
    }

    $wixMain = Get-ChildItem -Path $WixDir -Filter "main.wxs" -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $wixMain) {
        throw "Generated WiX main.wxs was not found under $WixDir"
    }

    return $wixMain
}

function Assert-TextPattern {
    param(
        [string]$Content,
        [string]$Pattern,
        [string]$Description
    )

    if ($Content -notmatch $Pattern) {
        throw "MSI uninstall validation failed: missing $Description."
    }
}

function Assert-MsiUninstallSupport {
    $wixMain = Get-LatestWixMainFile
    $content = Get-Content -LiteralPath $wixMain.FullName -Raw

    $config = Get-TauriConfig
    $upgradeCode = $config.bundle.windows.wix.upgradeCode
    if ([string]::IsNullOrWhiteSpace([string]$upgradeCode)) {
        throw "MSI uninstall validation failed: bundle.windows.wix.upgradeCode must be pinned in tauri.conf.json."
    }

    Assert-TextPattern $content ([regex]::Escape("UpgradeCode=`"$upgradeCode`"")) "pinned WiX UpgradeCode $upgradeCode"
    Assert-TextPattern $content '<MajorUpgrade\b' "MajorUpgrade rule for upgrade/uninstall continuity"
    Assert-TextPattern $content '<Shortcut\b[^>]*Id="UninstallShortcut"' "Start Menu uninstall shortcut"
    Assert-TextPattern $content 'Name="Uninstall Kimi Code"' "visible Uninstall Kimi Code shortcut name"
    Assert-TextPattern $content 'Target="\[System64Folder\]msiexec\.exe"' "msiexec uninstall shortcut target"
    Assert-TextPattern $content 'Arguments="/x \[ProductCode\]"' "msiexec /x ProductCode uninstall command"
    Assert-TextPattern $content '<RemoveFolder\b[^>]*Id="ApplicationProgramsFolder"[^>]*On="uninstall"' "Start Menu folder removal on uninstall"
    Assert-TextPattern $content '<RemoveFolder\b[^>]*Id="INSTALLDIR"[^>]*On="uninstall"' "install directory removal on uninstall"
    Assert-TextPattern $content '<Property\b[^>]*Id="ARPNOREPAIR"' "Windows Apps entry without repair action"
    Assert-TextPattern $content '<SetProperty\b[^>]*Id="ARPNOMODIFY"' "Windows Apps entry without modify action"
    Assert-TextPattern $content '<SetProperty\b[^>]*Id="ARPINSTALLLOCATION"' "Windows Apps install location metadata"

    Write-Host "MSI uninstall support validated:"
    Write-Host "  WiX: $($wixMain.FullName)"
    Write-Host "  UpgradeCode: $upgradeCode"
    Write-Host "  Entry points: Windows Apps and Start Menu Uninstall Kimi Code"
}

function Get-CommandText {
    param([string]$Command)

    $result = & $Command --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $result) {
        return ($result -join " ").Trim()
    }
    return $null
}

function Clear-PreviousBundleArtifacts {
    if (!(Test-Path $BundleDir)) {
        return
    }

    $patterns = @("*.msi", "SHA256SUMS.txt", "release-manifest.json")
    foreach ($pattern in $patterns) {
        Get-ChildItem -Path $BundleDir -Filter $pattern -File -ErrorAction SilentlyContinue |
            Remove-Item -Force
    }
}

function Get-NewMsiArtifact {
    param(
        [string]$Version
    )

    if (!(Test-Path $BundleDir)) {
        throw "MSI bundle directory was not created: $BundleDir"
    }

    $msiCandidates = Get-ChildItem -Path $BundleDir -Filter "*.msi" -File |
        Where-Object { $_.Name -like "*$Version*" } |
        Sort-Object LastWriteTime -Descending

    $msi = $msiCandidates | Select-Object -First 1
    if (-not $msi) {
        $existing = Get-ChildItem -Path $BundleDir -Filter "*.msi" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 5 -ExpandProperty Name
        if ($existing) {
            Write-Host "Existing MSI files did not match this build/version:"
            $existing | ForEach-Object { Write-Host "  $_" }
        }
        throw "No fresh MSI artifact for version $Version was found in $BundleDir"
    }

    return $msi
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
    $packageVersion = Get-PackageVersion
    Invoke-Native "node" @("scripts/sync-version.js")

    if (-not $SkipPreflight) {
        Invoke-LocalScript (Join-Path $PSScriptRoot "release-preflight.ps1") @("-SkipTauriBuild")
    }

    Write-Host ""
    Write-Host "==> Building MSI bundle"
    Clear-PreviousBundleArtifacts
    Invoke-Native "npm" @("run", "tauri:build:raw-msi")

    $msi = Get-NewMsiArtifact -Version $packageVersion
    Assert-FreshReleaseExe
    Assert-MsiUninstallSupport

    if ($Sign) {
        Invoke-LocalScript (Join-Path $PSScriptRoot "sign-windows.ps1") @("-Artifacts", $ReleaseExe, $msi.FullName)
    }

    Write-LocalReleaseManifest
    Invoke-LocalScript (Join-Path $PSScriptRoot "validate-release-manifest.ps1") @("-ProjectRoot", $ProjectRoot)
    Write-ReleaseMetadata -Msi $msi
}
finally {
    Pop-Location
}
