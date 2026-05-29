param(
    [switch]$SkipSecretScan
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SidecarExe = Join-Path $ProjectRoot "src-tauri\sidecar\kimi-sidecar-x86_64-pc-windows-msvc.exe"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    Write-Host ""
    Write-Host "==> $Name"
    & $Action
}

function Invoke-SecretScan {
    if ($SkipSecretScan) {
        Write-Host "Secret scan skipped by request."
        return
    }

    $rg = Get-Command rg -ErrorAction SilentlyContinue
    if (-not $rg) {
        Write-Warning "ripgrep is not installed; skipping high-confidence secret scan."
        return
    }

    $pattern = "(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY)"
    $args = @(
        "-n",
        "-i",
        $pattern,
        "-g", "!node_modules",
        "-g", "!dist",
        "-g", "!src-tauri/target",
        "-g", "!src-tauri/gen",
        "-g", "!sidecar-adapter/.venv",
        "-g", "!sidecar-adapter/build",
        "-g", "!sidecar-adapter/dist"
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
    } else {
        Write-Host "Git working tree is clean."
    }
}

Push-Location $ProjectRoot
try {
    Invoke-Step "Checking required sidecar binary" {
        if (!(Test-Path $SidecarExe)) {
            throw "Missing sidecar executable: $SidecarExe. Run scripts\build-sidecar.ps1 before releasing."
        }
        $sizeMb = [math]::Round((Get-Item $SidecarExe).Length / 1MB, 2)
        Write-Host "Sidecar found: $SidecarExe ($sizeMb MiB)"
    }

    Invoke-Step "Frontend production build" {
        npm run build
    }

    Invoke-Step "Rust check" {
        npm run rust:check
    }

    Invoke-Step "Rust clippy lint gate" {
        if (-not (Test-CargoClippy)) {
            throw "cargo-clippy is not installed. Run: rustup component add clippy"
        }
        npm run rust:clippy
    }

    Invoke-Step "Python sidecar compile check" {
        Push-Location (Join-Path $ProjectRoot "sidecar-adapter")
        try {
            python -m compileall -q kimi_desktop_sidecar
        } finally {
            Pop-Location
        }
    }

    Invoke-Step "Python sidecar tests" {
        Push-Location (Join-Path $ProjectRoot "sidecar-adapter")
        try {
            uv run pytest -q
        } finally {
            Pop-Location
        }
    }

    Invoke-Step "Dependency audit gate" {
        npm audit --audit-level=high
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
