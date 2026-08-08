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

function Assert-SourceRuntime {
    # (a) Built artifact must exist and be non-empty. smoke:runtime rebuilds it,
    # but preflight may run on a machine that skipped the build.
    $runtimeDir = Join-Path $ProjectRoot "runtime\kimi-code\apps\desktop-runtime"
    $distEntry = Join-Path $runtimeDir "dist\main.mjs"
    if (!(Test-Path $distEntry)) {
        throw "Source Runtime artifact missing: $distEntry. Run 'npm run runtime:install' then 'npm run runtime:build' (or 'npm run smoke:runtime') first."
    }
    $distInfo = Get-Item $distEntry
    if ($distInfo.Length -le 0) {
        throw "Source Runtime artifact is empty: $distEntry. Re-run 'npm run runtime:build'."
    }
    Write-Host "Source Runtime artifact present: $distEntry ($($distInfo.Length) bytes)"

    # (b) Frozen source commit: runtime/UPSTREAM.md's Commit row must equal
    # KIMI_SOURCE_COMMIT in apps/desktop-runtime/src/protocol.ts. smoke:runtime
    # also covers the handshake commit; this is the offline static twin.
    $upstreamFile = Join-Path $ProjectRoot "runtime\UPSTREAM.md"
    if (!(Test-Path $upstreamFile)) {
        throw "Missing runtime\UPSTREAM.md; cannot verify the frozen source commit."
    }
    $upstreamLine = Get-Content $upstreamFile | Where-Object { $_ -match "^\| Commit \|" } | Select-Object -First 1
    if (-not $upstreamLine -or $upstreamLine -notmatch "[0-9a-f]{40}") {
        throw "runtime\UPSTREAM.md has no valid frozen Commit row."
    }
    $frozenCommit = [regex]::Match($upstreamLine, "[0-9a-f]{40}").Value

    $protocolFile = Join-Path $runtimeDir "src\protocol.ts"
    if (!(Test-Path $protocolFile)) {
        throw "Missing $protocolFile; cannot verify the artifact source commit."
    }
    $constantLine = Get-Content $protocolFile | Where-Object { $_ -match "KIMI_SOURCE_COMMIT\s*=" } | Select-Object -First 1
    if (-not $constantLine -or $constantLine -notmatch "[0-9a-f]{40}") {
        throw "protocol.ts has no KIMI_SOURCE_COMMIT constant."
    }
    $sourceCommit = [regex]::Match($constantLine, "[0-9a-f]{40}").Value
    if ($frozenCommit -ne $sourceCommit) {
        throw "Source commit mismatch: UPSTREAM.md=$frozenCommit, protocol.ts=$sourceCommit. Re-sync the freeze and rebuild."
    }
    Write-Host "Source commit verified: $frozenCommit (UPSTREAM.md == KIMI_SOURCE_COMMIT)."

    # (c) No PATH 'kimi' dependency in production paths. The needle list lives
    # in this file, so exclude this script from its own scan.
    foreach ($needle in @("KIMI_CODE_BIN", "resolve_acp_command", "kimi acp")) {
        $hits = & rg -n --fixed-strings $needle -g "!release-preflight.ps1" `
            (Join-Path $ProjectRoot "src-tauri\src") `
            (Join-Path $ProjectRoot "package.json") `
            (Join-Path $ProjectRoot "scripts") 2>$null
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) {
            $hits | ForEach-Object { Write-Host $_ }
            throw "PATH 'kimi' dependency '$needle' found in production paths. The product must not depend on an installed CLI."
        }
        if ($exitCode -gt 1) {
            throw "rg scan for '$needle' failed with exit code $exitCode."
        }
    }
    Write-Host "No PATH 'kimi' dependency markers found (KIMI_CODE_BIN / resolve_acp_command / kimi acp)."

    # (d) No ACP entry points left, and the old ACP smoke script is gone.
    foreach ($needle in @("AcpProcessManager", "AcpDesktopClient", "acp_translate", "acp_desktop", "acp_capabilities")) {
        $hits = & rg -n --fixed-strings $needle (Join-Path $ProjectRoot "src-tauri\src") 2>$null
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) {
            $hits | ForEach-Object { Write-Host $_ }
            throw "ACP entry '$needle' still present in src-tauri/src."
        }
        if ($exitCode -gt 1) {
            throw "rg scan for '$needle' failed with exit code $exitCode."
        }
    }
    if (Test-Path (Join-Path $ProjectRoot "scripts\acp-smoke.mjs")) {
        throw "Stale ACP smoke script still exists: scripts\acp-smoke.mjs"
    }
    Write-Host "No ACP entries remain (AcpProcessManager / AcpDesktopClient / acp_translate / acp_desktop / acp_capabilities; acp-smoke.mjs absent)."

    # (e) SEA sidecar release pair: whenever a built sidecar exists under
    # src-tauri\binaries, its sibling release manifest must exist, parse as
    # JSON, and carry the frozen commit (release-macos.sh emits both together).
    # Dev-only checkpoints build no sidecar, so the check self-skips then.
    $binariesDir = Join-Path $ProjectRoot "src-tauri\binaries"
    $sidecars = @()
    if (Test-Path $binariesDir) {
        $sidecars = @(Get-ChildItem -Path $binariesDir -File |
            Where-Object { $_.Name -like "desktop-runtime-*" -and $_.Name -notlike "*.manifest.json" })
    }
    foreach ($sidecar in $sidecars) {
        $manifestPath = "$($sidecar.FullName).manifest.json"
        if (!(Test-Path $manifestPath)) {
            throw "Source Runtime sidecar is missing its release manifest: $($sidecar.FullName). Expected $manifestPath (run 'npm run release:macos' or build the SEA sidecar + manifest together)."
        }
        try {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
        } catch {
            throw "Source Runtime release manifest is not valid JSON: $manifestPath ($($_.Exception.Message))"
        }
        $manifestCommit = [string]$manifest.kimiSource.commit
        if ($manifestCommit -ne $frozenCommit) {
            throw "Source Runtime release manifest commit mismatch: $manifestCommit (manifest) vs $frozenCommit (UPSTREAM.md): $manifestPath"
        }
        Write-Host "Source Runtime release manifest present and pinned: $manifestPath ($manifestCommit)"
    }
    if (-not $sidecars) {
        Write-Host "No SEA sidecar built; skipping the release-manifest pairing check."
    }
    Write-Host "Source Runtime release checks passed."
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
    Invoke-Step "Checking Source Runtime prerequisite" {
        Assert-SourceRuntime
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
        try {
            Invoke-Native "npm" @("run", "rust:test")
        } catch {
            # 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND means some imported DLL
            # lacks an entry point; dump the import table and probe every
            # imported function to pinpoint the missing one.
            $exe = Get-ChildItem -Path (Join-Path $ProjectRoot "src-tauri\target\debug\deps\app_lib-*.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($exe) {
                $dumpbin = Get-ChildItem -Path "C:\Program Files\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($dumpbin) {
                    Write-Host "==> dumpbin /imports $($exe.Name)"
                    (& $dumpbin.FullName /imports $exe.FullName 2>&1) | Select-Object -First 500
                } else {
                    Write-Warning "dumpbin not found; cannot inspect imports."
                }
                Write-Host "==> per-import entry point probe"
                & (Join-Path $PSScriptRoot "pe-import-check.ps1") -Path $exe.FullName
            }
            throw
        }
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
