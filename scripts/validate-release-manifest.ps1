param(
    [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$ReleaseDir = Join-Path $ProjectRoot "src-tauri\target\release"
$ReleaseExe = Join-Path $ReleaseDir "kimi-code-desktop.exe"
$ReleaseManifest = Join-Path $ReleaseDir "kimi-code-desktop.release.json"
$DistIndex = Join-Path $ProjectRoot "dist\index.html"

function Get-PackageVersion {
    return (Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json).version
}

function Assert-HashMatches {
    param(
        [string]$Path,
        [string]$ExpectedHash,
        [string]$Label
    )

    if (!(Test-Path $Path)) {
        throw "$Label is missing: $Path"
    }

    $actualHash = (Get-FileHash -Algorithm SHA256 $Path).Hash
    if ($actualHash -ne $ExpectedHash) {
        throw "$Label hash does not match the release manifest. Run npm run desktop:release."
    }
}

if (!(Test-Path $ReleaseManifest)) {
    throw "Release manifest is missing: $ReleaseManifest. Run npm run desktop:release."
}

$manifest = Get-Content $ReleaseManifest -Raw | ConvertFrom-Json
$currentVersion = Get-PackageVersion
if ($manifest.version -ne $currentVersion) {
    throw "Release manifest version $($manifest.version) does not match package.json version $currentVersion. Run npm run desktop:release."
}

Assert-HashMatches $ReleaseExe $manifest.files.releaseExe.sha256 "Release executable"
Assert-HashMatches $DistIndex $manifest.files.distIndex.sha256 "Frontend dist index"

Write-Host "Release manifest validated: $ReleaseManifest"
