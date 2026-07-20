param(
    [string]$Workspace,
    [string]$PlanPath = "docs/plans/2026-07-08-kimi-code-acp-migration-ui.md",
    [string]$PromptFile = "docs/plans/cursor-acp-milestone0.prompt.md",
    [int]$TimeoutSeconds = 2400,
    [string]$Model = "auto",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ($TimeoutSeconds -lt 1800) {
    throw "TimeoutSeconds must be at least 1800 seconds (30 minutes)."
}

if (-not $Workspace) {
    $Workspace = Split-Path -Parent $PSScriptRoot
}

$workspacePath = (Resolve-Path $Workspace).Path
$planFullPath = Join-Path $workspacePath $PlanPath
$promptFullPath = Join-Path $workspacePath $PromptFile

if (-not (Test-Path -LiteralPath $planFullPath)) {
    throw "Plan file not found: $planFullPath"
}

if (-not (Test-Path -LiteralPath $promptFullPath)) {
    throw "Cursor prompt file not found: $promptFullPath"
}

function ConvertTo-PowerShellLiteral {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function ConvertTo-PowerShellArrayLiteral {
    param([string[]]$Values)
    if ($Values.Count -eq 0) {
        return "@()"
    }

    $quoted = $Values | ForEach-Object { ConvertTo-PowerShellLiteral $_ }
    return "@(" + ($quoted -join ", ") + ")"
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
    }

    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$cursorAgent = Get-Command cursor-agent -ErrorAction SilentlyContinue
if (-not $cursorAgent) {
    throw "cursor-agent was not found on PATH."
}

function Invoke-CursorAgent {
    param([string[]]$AgentArgs)

    if ($cursorAgent.Source -like "*.ps1") {
        return & powershell -NoProfile -ExecutionPolicy Bypass -File $cursorAgent.Source @AgentArgs 2>&1
    }

    return & $cursorAgent.Source @AgentArgs 2>&1
}

Write-Host "[INFO] Checking cursor-agent model availability..."
$modelsOutput = Invoke-CursorAgent @("models")
if ($LASTEXITCODE -ne 0) {
    $modelsText = ($modelsOutput | Out-String).Trim()
    throw "Failed to list cursor-agent models: $modelsText"
}

$modelsText = ($modelsOutput | Out-String)
$modelPattern = "(?m)^" + [regex]::Escape($Model) + "\s+-\s+"
if ($modelsText -notmatch $modelPattern) {
    throw "cursor-agent model '$Model' was not found. Run `cursor-agent models` to inspect available models."
}
Write-Host "[OK] Cursor model available: $Model"

$tmpDir = Join-Path $workspacePath "tmp"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$stdoutPath = Join-Path $tmpDir "cursor-acp-milestone-0.out.jsonl"
$stderrPath = Join-Path $tmpDir "cursor-acp-milestone-0.err.log"
$exitCodePath = Join-Path $tmpDir "cursor-acp-milestone-0.exitcode.txt"
$invokeScriptPath = Join-Path $tmpDir "cursor-acp-milestone-0.invoke.ps1"
$promptText = Get-Content -Raw -Encoding UTF8 -LiteralPath $promptFullPath

$arguments = @(
    "--print",
    "--output-format",
    "stream-json",
    "--model",
    $Model,
    "--trust",
    "--workspace",
    $workspacePath,
    "--",
    $promptText
)

$agentProcessFilePath = $cursorAgent.Source
$launcherArguments = @()
if ($cursorAgent.Source -like "*.ps1") {
    $agentProcessFilePath = "powershell"
    $launcherArguments = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $cursorAgent.Source
    )
}
$agentProcessArguments = $launcherArguments + $arguments

Write-Host "[INFO] Workspace: $workspacePath"
Write-Host "[INFO] Plan: $planFullPath"
Write-Host "[INFO] Prompt: $promptFullPath"
Write-Host "[INFO] Cursor agent: $($cursorAgent.Source)"
Write-Host "[INFO] Process: $agentProcessFilePath"
Write-Host "[INFO] Model: $Model"
Write-Host "[INFO] Timeout: $TimeoutSeconds seconds"
Write-Host "[INFO] Stdout: $stdoutPath"
Write-Host "[INFO] Stderr: $stderrPath"

if ($DryRun) {
    Write-Host "[DRY-RUN] process arguments:"
    $agentProcessArguments | ForEach-Object { Write-Host "  $_" }
    exit 0
}

Remove-Item -LiteralPath $stdoutPath, $stderrPath, $exitCodePath, $invokeScriptPath -Force -ErrorAction SilentlyContinue

$invokeScript = @"
`$ErrorActionPreference = "Stop"
`$exitCode = 1

try {
    Set-Location -LiteralPath $(ConvertTo-PowerShellLiteral $workspacePath)
    `$promptText = Get-Content -Raw -Encoding UTF8 -LiteralPath $(ConvertTo-PowerShellLiteral $promptFullPath)
    `$agentArgs = @(
        "--print",
        "--output-format",
        "stream-json",
        "--model",
        $(ConvertTo-PowerShellLiteral $Model),
        "--trust",
        "--workspace",
        $(ConvertTo-PowerShellLiteral $workspacePath),
        "--",
        `$promptText
    )
    `$processFile = $(ConvertTo-PowerShellLiteral $agentProcessFilePath)
    `$processArgs = $(ConvertTo-PowerShellArrayLiteral $launcherArguments) + `$agentArgs
    & `$processFile @processArgs
    if (`$null -eq `$LASTEXITCODE) {
        `$exitCode = 0
    }
    else {
        `$exitCode = `$LASTEXITCODE
    }
}
catch {
    [Console]::Error.WriteLine(`$_.Exception.ToString())
    `$exitCode = 1
}
finally {
    Set-Content -LiteralPath $(ConvertTo-PowerShellLiteral $exitCodePath) -Value `$exitCode -Encoding ASCII
}

exit `$exitCode
"@

Set-Content -LiteralPath $invokeScriptPath -Value $invokeScript -Encoding UTF8

$process = Start-Process `
    -FilePath "powershell" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $invokeScriptPath) `
    -WorkingDirectory $workspacePath `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath

try {
    $completed = $process.WaitForExit([int]($TimeoutSeconds * 1000))
    if (-not $completed) {
        Stop-ProcessTree -ProcessId $process.Id
        throw "cursor-agent timed out after $TimeoutSeconds seconds. See $stdoutPath and $stderrPath."
    }

    if (-not (Test-Path -LiteralPath $exitCodePath -PathType Leaf)) {
        throw "cursor-agent did not write an exit code. See $stdoutPath and $stderrPath."
    }

    $exitCodeText = (Get-Content -Raw -Encoding ASCII -LiteralPath $exitCodePath).Trim()
    $exitCode = 1
    if (-not [int]::TryParse($exitCodeText, [ref]$exitCode)) {
        throw "cursor-agent wrote an invalid exit code '$exitCodeText'. See $stdoutPath and $stderrPath."
    }

    if ($exitCode -ne 0) {
        throw "cursor-agent failed with exit code $exitCode. See $stdoutPath and $stderrPath."
    }

    Write-Host "[OK] cursor-agent completed successfully."
    Write-Host "[OK] Output: $stdoutPath"
}
finally {
    if (-not $process.HasExited) {
        Stop-ProcessTree -ProcessId $process.Id
    }
}
