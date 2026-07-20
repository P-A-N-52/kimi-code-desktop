param(
    [string]$Workspace,
    [switch]$RunCommands,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not $Workspace) {
    $Workspace = Split-Path -Parent $PSScriptRoot
}

$workspacePath = (Resolve-Path $Workspace).Path

function Join-WorkspacePath {
    param([string]$RelativePath)
    return Join-Path $workspacePath $RelativePath
}

function Assert-File {
    param(
        [string]$RelativePath,
        [string]$Purpose
    )

    $fullPath = Join-WorkspacePath $RelativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "$Purpose is missing: $fullPath"
    }
    Write-Host "[OK] $Purpose`: $fullPath"
}

function Assert-JsonFile {
    param(
        [string]$RelativePath,
        [string]$Purpose
    )

    $fullPath = Join-WorkspacePath $RelativePath
    Assert-File $RelativePath $Purpose

    $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $fullPath
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "$Purpose is empty: $fullPath"
    }

    try {
        $null = $raw | ConvertFrom-Json
    }
    catch {
        throw "$Purpose is not valid JSON: $fullPath. $($_.Exception.Message)"
    }

    Write-Host "[OK] $Purpose parses as JSON."
}

function Assert-JsonLinesFile {
    param(
        [string]$RelativePath,
        [string]$Purpose
    )

    $fullPath = Join-WorkspacePath $RelativePath
    Assert-File $RelativePath $Purpose

    $lineNumber = 0
    $nonEmptyLines = 0
    foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $fullPath) {
        $lineNumber += 1
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $null = $line | ConvertFrom-Json
        }
        catch {
            throw "$Purpose contains invalid JSON on line $lineNumber`: $($_.Exception.Message)"
        }

        $nonEmptyLines += 1
    }

    if ($nonEmptyLines -eq 0) {
        throw "$Purpose has no JSONL entries: $fullPath"
    }

    Write-Host "[OK] $Purpose parses as JSONL ($nonEmptyLines entries)."
}

function Assert-ContractMapping {
    param([string]$RelativePath)

    $requiredCommands = @(
        "list_sessions",
        "get_session",
        "create_session",
        "replay_session_history",
        "wire_connect",
        "wire_send",
        "wire_disconnect",
        "wire_status",
        "get_global_config",
        "update_global_config",
        "get_config_toml",
        "update_config_toml",
        "get_mcp_config",
        "update_mcp_config",
        "upload_session_file",
        "get_git_diff_stats",
        "fork_session",
        "generate_title"
    )
    $classificationPattern = "direct ACP|ACP plus local desktop helper|Kimi Code server or file index needed|legacy-only for now|unknown, needs spike"
    $fullPath = Join-WorkspacePath $RelativePath
    $lines = Get-Content -Encoding UTF8 -LiteralPath $fullPath

    foreach ($command in $requiredCommands) {
        $matchingLines = @($lines | Where-Object { $_ -match [regex]::Escape($command) })
        if ($matchingLines.Count -eq 0) {
            throw "ACP contract mapping is missing Tauri command '$command'."
        }

        $classifiedLines = @($matchingLines | Where-Object { $_ -match $classificationPattern })
        if ($classifiedLines.Count -eq 0) {
            throw "ACP contract mapping for '$command' does not use an allowed classification."
        }
    }

    Write-Host "[OK] ACP contract mapping covers $($requiredCommands.Count) Tauri commands with allowed classifications."
}

function Invoke-CheckedCommand {
    param(
        [string]$Label,
        [string]$Command,
        [string[]]$Arguments = @()
    )

    $commandText = (@($Command) + $Arguments) -join " "
    if ($DryRun) {
        Write-Host "[DRY-RUN] $Label`: $commandText"
        return
    }

    Write-Host "[RUN] $Label`: $commandText"
    Push-Location $workspacePath
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Label failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
    Write-Host "[OK] $Label"
}

function Get-GitChangedPaths {
    Push-Location $workspacePath
    try {
        $lines = git status --porcelain=v1 --untracked-files=all
        if ($LASTEXITCODE -ne 0) {
            throw "git status failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.Length -lt 4) {
            continue
        }

        $path = $line.Substring(3).Trim()
        if ($path.Contains(" -> ")) {
            $path = ($path -split " -> ")[-1].Trim()
        }
        $paths.Add($path.Replace("\", "/"))
    }

    return $paths
}

function Assert-MilestoneScope {
    $allowedPaths = @(
        ".gitignore",
        "package.json",
        "docs/plans/2026-07-08-kimi-code-acp-migration-ui.md",
        "docs/plans/2026-07-08-kimi-acp-runtime-adapter-milestone1.md",
        "docs/plans/cursor-acp-milestone0.prompt.md",
        "docs/plans/cursor-acp-milestone1.prompt.md",
        "scripts/run-cursor-acp-milestone0.ps1",
        "scripts/run-cursor-plan.ps1",
        "scripts/verify-cursor-acp-milestone0.ps1",
        "scripts/acp-smoke.mjs",
        "docs/acp-contract.md",
        "src-tauri/src/runtime_backend.rs",
        "src-tauri/src/acp.rs",
        "src-tauri/src/acp_translate.rs",
        "src-tauri/src/commands.rs",
        "src-tauri/src/runtime_check.rs",
        "src-tauri/src/lib.rs"
    )

    if ($DryRun) {
        Write-Host "[DRY-RUN] Allowed changed files for Cursor ACP Milestone 0:"
        $allowedPaths | ForEach-Object { Write-Host "  $_" }
        return
    }

    $changedPaths = Get-GitChangedPaths
    $outOfScope = @($changedPaths | Where-Object { $allowedPaths -notcontains $_ })

    if ($outOfScope.Count -gt 0) {
        throw "Cursor Milestone 0 changed files outside the approved scope: $($outOfScope -join ', ')"
    }

    Write-Host "[OK] Changed files are within the approved Milestone 0 scope."
}

Write-Host "[INFO] Workspace: $workspacePath"
Write-Host "[INFO] DryRun: $DryRun"
Write-Host "[INFO] RunCommands: $RunCommands"

Assert-File "docs/plans/2026-07-08-kimi-code-acp-migration-ui.md" "ACP migration plan"
Assert-File "docs/plans/cursor-acp-milestone0.prompt.md" "Cursor Milestone 0 prompt"
Assert-File "scripts/run-cursor-acp-milestone0.ps1" "Cursor Milestone 0 runner"
Assert-MilestoneScope

$cursorStdout = Join-WorkspacePath "tmp/cursor-acp-milestone-0.out.jsonl"
$cursorStderr = Join-WorkspacePath "tmp/cursor-acp-milestone-0.err.log"

if (Test-Path -LiteralPath $cursorStdout -PathType Leaf) {
    Write-Host "[OK] Cursor stdout exists: $cursorStdout"
}
else {
    Write-Host "[INFO] Cursor stdout is not present yet: $cursorStdout"
}

if (Test-Path -LiteralPath $cursorStderr -PathType Leaf) {
    Write-Host "[OK] Cursor stderr exists: $cursorStderr"
}
else {
    Write-Host "[INFO] Cursor stderr is not present yet: $cursorStderr"
}

if ($DryRun) {
    Write-Host "[DRY-RUN] Post-Cursor artifact checks:"
    Write-Host "  tmp/cursor-acp-milestone-0.out.jsonl (valid JSONL)"
    Write-Host "  tmp/cursor-acp-milestone-0.err.log"
    Write-Host "  scripts/acp-smoke.mjs"
    Write-Host "  docs/acp-contract.md"
    Write-Host "  docs/acp-contract.md mapping table classifications"
    Write-Host "  tmp/acp-smoke-report.json (valid JSON)"
    Write-Host "  package.json script: smoke:acp"
}
else {
    Assert-JsonLinesFile "tmp/cursor-acp-milestone-0.out.jsonl" "Cursor stream-json stdout"
    Assert-File "tmp/cursor-acp-milestone-0.err.log" "Cursor stderr log"
    Assert-File "scripts/acp-smoke.mjs" "ACP smoke script produced by Cursor"
    Assert-File "docs/acp-contract.md" "ACP contract document produced by Cursor"
    Assert-ContractMapping "docs/acp-contract.md"
    Assert-JsonFile "tmp/acp-smoke-report.json" "ACP smoke report produced by smoke:acp"

    $packageJsonPath = Join-WorkspacePath "package.json"
    $packageJson = Get-Content -Raw -Encoding UTF8 -LiteralPath $packageJsonPath | ConvertFrom-Json
    if (-not $packageJson.scripts.'smoke:acp') {
        throw "package.json does not define scripts.smoke:acp."
    }
    Write-Host "[OK] package.json defines smoke:acp."
}

if ($RunCommands) {
    Invoke-CheckedCommand "ACP smoke" "npm" @("run", "smoke:acp")
    Invoke-CheckedCommand "Frontend tests" "npm" @("test")
    Invoke-CheckedCommand "Frontend build" "npm" @("run", "build")
    Invoke-CheckedCommand "Rust check" "cargo" @("check", "--manifest-path", "src-tauri/Cargo.toml")
}
elseif ($DryRun) {
    Write-Host "[DRY-RUN] Command checks available with -RunCommands:"
    Write-Host "  npm run smoke:acp"
    Write-Host "  npm test"
    Write-Host "  npm run build"
    Write-Host "  cargo check --manifest-path src-tauri/Cargo.toml"
}
else {
    Write-Host "[INFO] Skipped command checks. Re-run with -RunCommands to execute them."
}

Write-Host "[OK] Cursor ACP Milestone 0 verification script completed."
