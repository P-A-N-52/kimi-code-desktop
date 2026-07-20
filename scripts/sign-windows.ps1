param(
    [string[]]$Artifacts
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DefaultTimestampUrl = "http://timestamp.digicert.com"
$TimestampUrl = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { $DefaultTimestampUrl }

function Find-SignTool {
    if ($env:SIGNTOOL_EXE -and (Test-Path $env:SIGNTOOL_EXE)) {
        return $env:SIGNTOOL_EXE
    }

    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    if (Test-Path $kitsRoot) {
        $candidate = Get-ChildItem -Path $kitsRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($candidate) {
            return $candidate.FullName
        }
    }

    $fromPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }

    throw "signtool.exe was not found. Install the Windows SDK or set SIGNTOOL_EXE."
}

function Resolve-Artifacts {
    if ($Artifacts -and $Artifacts.Count -gt 0) {
        return $Artifacts
    }

    $bundleDir = Join-Path $ProjectRoot "src-tauri\target\release\bundle\msi"
    $releaseExe = Join-Path $ProjectRoot "src-tauri\target\release\kimi-code-desktop.exe"
    $defaults = @()
    if (Test-Path $releaseExe) {
        $defaults += $releaseExe
    }
    if (Test-Path $bundleDir) {
        $defaults += Get-ChildItem -Path $bundleDir -Filter "*.msi" | Select-Object -ExpandProperty FullName
    }
    return $defaults
}

$signTool = Find-SignTool
$targets = Resolve-Artifacts
if (-not $targets -or $targets.Count -eq 0) {
    throw "No artifacts were provided or found to sign."
}

$baseArgs = @("sign", "/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256")
if ($env:WINDOWS_CERT_PATH) {
    if (!(Test-Path $env:WINDOWS_CERT_PATH)) {
        throw "WINDOWS_CERT_PATH does not exist: $env:WINDOWS_CERT_PATH"
    }
    if ($env:WINDOWS_CERT_PASSWORD) {
        Write-Host "Importing signing certificate from PFX without exposing password on the command line."
        $securePassword = ConvertTo-SecureString $env:WINDOWS_CERT_PASSWORD -AsPlainText -Force
        $imported = Import-PfxCertificate -FilePath $env:WINDOWS_CERT_PATH -Password $securePassword -CertStoreLocation Cert:\CurrentUser\My -Exportable
        $baseArgs += @("/sha1", $imported.Thumbprint)
    }
    else {
        $baseArgs += @("/f", $env:WINDOWS_CERT_PATH)
    }
}
elseif ($env:WINDOWS_CERT_SHA1) {
    $baseArgs += @("/sha1", $env:WINDOWS_CERT_SHA1)
}
else {
    throw "Set WINDOWS_CERT_PATH or WINDOWS_CERT_SHA1 before signing."
}

foreach ($artifact in $targets) {
    if (!(Test-Path $artifact)) {
        throw "Artifact not found: $artifact"
    }
    Write-Host "Signing $artifact"
    & $signTool @baseArgs $artifact
}
