param(
    [switch]$SkipSecretScan,
    [switch]$SkipTauriBuild
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TauriConfig = Join-Path $ProjectRoot "src-tauri\tauri.conf.json"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    Write-Host ""
    Write-Host "==> $Name"
    & $Action
}

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

function Test-SecretScanExcludedPath {
    param([string]$RelativePath)

    $normalized = $RelativePath -replace '\\', '/'
    return (
        $normalized -match '(^|/)node_modules(/|$)' -or
        $normalized -match '(^|/)dist(/|$)' -or
        $normalized -match '(^|/)src-tauri/target(/|$)' -or
        $normalized -match '(^|/)src-tauri/gen(/|$)'
    )
}

function Invoke-SecretScanPowerShell {
    $pattern = "(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY)"
    $matches = @()

    Get-ChildItem -Path $ProjectRoot -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            $relativePath = $_.FullName.Substring($ProjectRoot.Length).TrimStart('\', '/')
            if (Test-SecretScanExcludedPath $relativePath) {
                return
            }

            $results = Select-String -Path $_.FullName -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
            if ($results) {
                $matches += $results
            }
        }

    if ($matches.Count -gt 0) {
        $matches | ForEach-Object { Write-Host "$($_.Path):$($_.LineNumber):$($_.Line.Trim())" }
        throw "High-confidence secret pattern found. Review the matches before release."
    }

    Write-Host "No high-confidence secrets found (PowerShell fallback scan)."
}

function Invoke-SecretScan {
    if ($SkipSecretScan) {
        Write-Host "Secret scan skipped by request."
        return
    }

    $pattern = "(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY)"
    $rg = Get-Command rg -ErrorAction SilentlyContinue
    if (-not $rg) {
        $choco = Get-Command choco -ErrorAction SilentlyContinue
        if ($choco) {
            Write-Host "ripgrep not found; installing via Chocolatey..."
            Invoke-Native "choco" @("install", "ripgrep", "-y", "--no-progress")
            $rg = Get-Command rg -ErrorAction SilentlyContinue
        }
    }

    if (-not $rg) {
        Write-Warning "ripgrep is not installed; using PowerShell fallback secret scan."
        Invoke-SecretScanPowerShell
        return
    }

    $args = @(
        "-n",
        "-i",
        $pattern,
        "-g", "!node_modules",
        "-g", "!dist",
        "-g", "!src-tauri/target",
        "-g", "!src-tauri/gen"
    )

    $output = & rg @args 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        $output | ForEach-Object { Write-Host $_ }
        throw "High-confidence secret pattern found. Review the matches before release."
    }
    if ($exitCode -gt 1) {
        $output | ForEach-Object { Write-Host $_ }
        throw "Secret scan failed with exit code $exitCode."
    }

    Write-Host "No high-confidence secrets found."
}

function Test-CargoClippy {
    $oldErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & cargo clippy --version 2>$null | Out-Null
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }

    return $exitCode -eq 0
}

function Assert-KimiCodeCli {
    $program = $env:KIMI_CODE_BIN
    if ([string]::IsNullOrWhiteSpace($program)) {
        $command = Get-Command kimi -ErrorAction SilentlyContinue
        if ($command -and $command.Source) {
            $program = $command.Source
        } else {
            $program = "kimi"
        }
    }

    Write-Host "Checking Kimi Code CLI: $program"
    Invoke-Native $program @("--version")
    Invoke-Native $program @("acp", "--help")
    Write-Host "Kimi Code CLI checks passed."
}

function Assert-TauriWindowUrls {
    if (!(Test-Path $TauriConfig)) {
        throw "Missing Tauri config: $TauriConfig"
    }

    $config = Get-Content $TauriConfig -Raw | ConvertFrom-Json
    $windows = @($config.app.windows)
    if (-not $windows) {
        Write-Host "No Tauri app windows declared."
        return
    }

    foreach ($window in $windows) {
        $label = if ($window.label) { $window.label } else { "<unnamed>" }
        $url = $window.url

        if ($null -eq $url -or [string]::IsNullOrWhiteSpace([string]$url)) {
            Write-Host "Tauri window '$label' uses the default local entry: index.html"
            continue
        }

        $urlText = ([string]$url).Trim()
        if ($urlText -match "^[A-Za-z][A-Za-z0-9+.-]*://") {
            throw "Invalid Tauri window url for '$label': $urlText. Packaged releases must use 'index.html' or another relative app asset path."
        }
    }

    Write-Host "Tauri window URLs are local asset paths."
}

function Invoke-GitQuiet {
    param([string[]]$GitArgs)

    $oldErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & git @GitArgs 2>$null
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }

    [pscustomobject]@{
        ExitCode = $exitCode
        Output = $output
    }
}

function Show-GitState {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        Write-Warning "git is not installed; release metadata will not include a commit hash."
        return
    }

    $insideWorkTree = Invoke-GitQuiet -GitArgs @("rev-parse", "--is-inside-work-tree")
    if ($insideWorkTree.ExitCode -ne 0) {
        Write-Warning "This project is not inside a git repository."
        return
    }

    $headCheck = Invoke-GitQuiet -GitArgs @("rev-parse", "--verify", "HEAD")
    if ($headCheck.ExitCode -ne 0) {
        Write-Warning "Git repository has no commits yet."
    } else {
        $head = Invoke-GitQuiet -GitArgs @("rev-parse", "--short", "HEAD")
        if ($head.ExitCode -eq 0 -and $head.Output) {
            Write-Host "Git HEAD: $($head.Output)"
        }
    }

    $gitStatus = Invoke-GitQuiet -GitArgs @("status", "--short")
    $status = @($gitStatus.Output)
    if ($status) {
        Write-Warning "Working tree has uncommitted changes:"
        $status | Select-Object -First 30 | ForEach-Object { Write-Host "  $_" }
        if ($status.Count -gt 30) {
            Write-Host "  ... $($status.Count - 30) more entries"
        }
        Write-Warning @"
Public releases should use a clean working tree and an annotated version tag.
Commit or stash local changes, run 'npm run version:set <version>', commit the
version bump, tag with 'git tag v<version>', then build or push the tag.
The release manifest will record dirty=true until the tree is clean.
"@
    } else {
        Write-Host "Git working tree is clean."
    }
}

Push-Location $ProjectRoot
try {
    Invoke-Step "Checking Kimi Code CLI prerequisite" {
        Assert-KimiCodeCli
    }

    Invoke-Step "Checking Tauri packaged window entry" {
        Assert-TauriWindowUrls
    }

    Invoke-Step "Frontend unit tests" {
        Invoke-Native "npm" @("run", "test")
    }

    Invoke-Step "Version alignment check" {
        Invoke-Native "node" @("scripts/sync-version.js")
    }

    Invoke-Step "Frontend production build" {
        Invoke-Native "npm" @("run", "build")
    }

    Invoke-Step "Rust check" {
        Invoke-Native "npm" @("run", "rust:check")
    }

    Invoke-Step "Rust clippy lint gate" {
        if (-not (Test-CargoClippy)) {
            throw "cargo-clippy is not installed. Run: rustup component add clippy"
        }
        Invoke-Native "npm" @("run", "rust:clippy")
    }

    Invoke-Step "Rust unit tests" {
        Invoke-Native "npm" @("run", "rust:test")
    }

    if (-not $SkipTauriBuild) {
        Invoke-Step "Tauri no-bundle release build" {
            Invoke-Native "npm" @("run", "desktop:release")
        }
    } else {
        Write-Host ""
        Write-Host "==> Tauri no-bundle release build (skipped; caller will produce release artifacts)"
    }

    Invoke-Step "Dependency audit gate" {
        Invoke-Native "npm" @("audit", "--audit-level=high")
    }

    Invoke-Step "High-confidence secret scan" {
        Invoke-SecretScan
    }

    Invoke-Step "Git release traceability" {
        Show-GitState
    }
}
finally {
    Pop-Location
}
