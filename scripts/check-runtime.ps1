param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [string]$Mode = "dev",
    [string]$ConfigFile,
    [string]$DownloadUrl,
    [switch]$Gui,
    [switch]$ShowLoading
)

$ErrorActionPreference = "Stop"

if (-not $ConfigFile) {
    $ConfigFile = Join-Path $env:USERPROFILE ".kimi\config.toml"
}

if (-not $DownloadUrl) {
    $DownloadUrl = $env:KIMI_LEGACY_CLI_DOWNLOAD_URL
}
if (-not $DownloadUrl) {
    $DownloadUrl = $env:KIMI_CODE_DOWNLOAD_URL
}
if (-not $DownloadUrl) {
    $DownloadUrl = "https://moonshotai.github.io/kimi-cli/"
}

$projectRootPath = (Resolve-Path $ProjectRoot).Path
$sidecarExe = Join-Path $projectRootPath "src-tauri\sidecar\kimi-sidecar-x86_64-pc-windows-msvc.exe"
$sidecarManifest = Join-Path $projectRootPath "src-tauri\sidecar\kimi-sidecar.manifest.json"
$allowUnconfigured = $env:KIMI_ALLOW_UNCONFIGURED_START -eq "1"
$promptMissingCliRaw = [Environment]::GetEnvironmentVariable("KIMI_PROMPT_MISSING_CLI")
$promptMissingCli = $true
if (-not [string]::IsNullOrWhiteSpace($promptMissingCliRaw)) {
    $promptMissingCli = $promptMissingCliRaw.Trim().ToLowerInvariant() -notin @("0", "false", "no")
}

$issues = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$incompatibleCliDetails = New-Object System.Collections.Generic.List[string]
$guiAvailable = $false
$loadingForm = $null
$loadingLabel = $null

function Initialize-Gui {
    if (-not $Gui -or $script:guiAvailable) {
        return $script:guiAvailable
    }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()
        $script:guiAvailable = $true
    }
    catch {
        $script:guiAvailable = $false
    }

    return $script:guiAvailable
}

function Show-LoadingForm {
    if (-not $ShowLoading -or -not (Initialize-Gui)) {
        return
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Kimi Code Desktop"
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "FixedDialog"
    $form.ControlBox = $false
    $form.Width = 430
    $form.Height = 155
    $form.TopMost = $true

    $title = New-Object System.Windows.Forms.Label
    $title.Text = "Checking Kimi Code Desktop runtime..."
    $title.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
    $title.AutoSize = $true
    $title.Left = 22
    $title.Top = 18
    $form.Controls.Add($title)

    $label = New-Object System.Windows.Forms.Label
    $label.Text = "Preparing startup checks"
    $label.AutoSize = $true
    $label.Left = 24
    $label.Top = 52
    $form.Controls.Add($label)

    $progress = New-Object System.Windows.Forms.ProgressBar
    $progress.Left = 24
    $progress.Top = 84
    $progress.Width = 365
    $progress.Height = 18
    $progress.Style = "Marquee"
    $progress.MarqueeAnimationSpeed = 35
    $form.Controls.Add($progress)

    $script:loadingForm = $form
    $script:loadingLabel = $label
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
}

function Update-LoadingStatus {
    param([string]$Text)

    if ($script:loadingForm -and -not $script:loadingForm.IsDisposed) {
        $script:loadingLabel.Text = $Text
        [System.Windows.Forms.Application]::DoEvents()
    }
}

function Close-LoadingForm {
    if ($script:loadingForm -and -not $script:loadingForm.IsDisposed) {
        $script:loadingForm.Close()
        $script:loadingForm.Dispose()
        $script:loadingForm = $null
        $script:loadingLabel = $null
        [System.Windows.Forms.Application]::DoEvents()
    }
}

function Show-StartupAttentionDialog {
    param(
        [string[]]$Issues,
        [string[]]$Warnings,
        [bool]$HasBlockingIssues,
        [string]$Url
    )

    if (-not (Initialize-Gui)) {
        if ($HasBlockingIssues) {
            return "exit"
        }
        return "continue"
    }

    Close-LoadingForm

    if ($HasBlockingIssues) {
        $script:startupDialogChoice = "exit"
    }
    else {
        $script:startupDialogChoice = "continue"
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Kimi Code Desktop setup"
    $form.StartPosition = "CenterScreen"
    $form.FormBorderStyle = "Sizable"
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.Width = 500
    $form.Height = 330
    $form.MinimumSize = New-Object System.Drawing.Size(460, 300)
    $form.TopMost = $false

    $title = New-Object System.Windows.Forms.Label
    if ($HasBlockingIssues) {
        $title.Text = "Setup needed before Kimi Code Desktop can be used"
    }
    else {
        $title.Text = "Legacy kimi-cli is not available"
    }
    $title.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
    $title.AutoSize = $true
    $title.Left = 18
    $title.Top = 16
    $form.Controls.Add($title)

    $body = New-Object System.Windows.Forms.Label
    if ($HasBlockingIssues) {
        $body.Text = "The app may open, but chat/session features are likely unavailable until the items below are fixed."
    }
    else {
        $body.Text = "The app can continue, but login/setup from inside the app may not work until the legacy Python kimi-cli runtime is installed."
    }
    $body.Left = 18
    $body.Top = 46
    $body.Width = 445
    $body.Height = 40
    $form.Controls.Add($body)

    $details = New-Object System.Windows.Forms.TextBox
    $details.Multiline = $true
    $details.ReadOnly = $true
    $details.ScrollBars = "Vertical"
    $details.Left = 18
    $details.Top = 94
    $details.Width = 445
    $details.Height = 125
    $details.Anchor = "Top,Left,Right,Bottom"

    $detailLines = New-Object System.Collections.Generic.List[string]
    if ($Issues.Count -gt 0) {
        $detailLines.Add("Errors:")
        foreach ($issue in $Issues) {
            $detailLines.Add(" - $issue")
        }
        $detailLines.Add("")
    }
    if ($Warnings.Count -gt 0) {
        $detailLines.Add("Warnings:")
        foreach ($warning in $Warnings) {
            $detailLines.Add(" - $warning")
        }
        $detailLines.Add("")
    }
    $detailLines.Add("Legacy kimi-cli setup page: $Url")
    $details.Text = $detailLines -join [Environment]::NewLine
    $form.Controls.Add($details)

    $downloadButton = New-Object System.Windows.Forms.Button
    $downloadButton.Text = "Open legacy kimi-cli"
    $downloadButton.Width = 160
    $downloadButton.Height = 32
    $downloadButton.Left = 18
    $downloadButton.Top = 236
    $downloadButton.Anchor = "Left,Bottom"
    $downloadButton.Add_Click({
        try {
            Start-Process $Url
        }
        catch {
            [System.Windows.Forms.MessageBox]::Show("Could not open: $Url", "Kimi Code Desktop") | Out-Null
        }
        $script:startupDialogChoice = "download"
        $form.Close()
    })
    $form.Controls.Add($downloadButton)

    $continueButton = New-Object System.Windows.Forms.Button
    if ($HasBlockingIssues) {
        $continueButton.Text = "Open Anyway"
    }
    else {
        $continueButton.Text = "Continue"
    }
    $continueButton.Width = 120
    $continueButton.Height = 32
    $continueButton.Left = 213
    $continueButton.Top = 236
    $continueButton.Anchor = "Right,Bottom"
    $continueButton.Add_Click({
        $script:startupDialogChoice = "continue"
        $form.Close()
    })
    $form.Controls.Add($continueButton)

    $exitButton = New-Object System.Windows.Forms.Button
    $exitButton.Text = "Exit"
    $exitButton.Width = 120
    $exitButton.Height = 32
    $exitButton.Left = 343
    $exitButton.Top = 236
    $exitButton.Anchor = "Right,Bottom"
    $exitButton.Add_Click({
        $script:startupDialogChoice = "exit"
        $form.Close()
    })
    $form.Controls.Add($exitButton)

    if ($HasBlockingIssues) {
        $form.AcceptButton = $downloadButton
    }
    else {
        $form.AcceptButton = $continueButton
    }
    $form.CancelButton = $exitButton
    $form.ShowDialog() | Out-Null
    $form.Dispose()

    return $script:startupDialogChoice
}

function Add-UniqueCandidate {
    param(
        [System.Collections.Generic.List[string]]$Candidates,
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return
    }

    $trimmed = $Value.Trim().Trim('"')
    foreach ($candidate in $Candidates) {
        if ($candidate -ieq $trimmed) {
            return
        }
    }
    $Candidates.Add($trimmed)
}

function Get-KimiCliCandidates {
    $candidates = New-Object System.Collections.Generic.List[string]

    Add-UniqueCandidate $candidates $env:KIMI_CLI_BIN

    $pathCommand = Get-Command kimi -ErrorAction SilentlyContinue
    if ($pathCommand -and $pathCommand.Source) {
        Add-UniqueCandidate $candidates $pathCommand.Source
    }

    if ($env:USERPROFILE) {
        Add-UniqueCandidate $candidates (Join-Path $env:USERPROFILE ".local\bin\kimi.exe")
        Add-UniqueCandidate $candidates (Join-Path $env:USERPROFILE ".kimi\Scripts\kimi.exe")
    }

    if ($env:APPDATA) {
        Add-UniqueCandidate $candidates (Join-Path $env:APPDATA "uv\tools\kimi-cli\Scripts\kimi.exe")
    }

    return $candidates
}

function Get-KimiCliVersionSummary {
    param([string]$Program)

    foreach ($versionArg in @("--version", "version")) {
        try {
            $output = & $Program $versionArg 2>&1
            if ($LASTEXITCODE -eq 0) {
                $summary = (($output | Out-String).Trim() -replace '\s+', ' ')
                if (-not [string]::IsNullOrWhiteSpace($summary)) {
                    return $summary
                }
            }
        }
        catch {
            # Try the next version command.
        }
    }

    return "version unavailable"
}

function Test-LegacyKimiInfoOutput {
    param([string]$OutputText)

    if ([string]::IsNullOrWhiteSpace($OutputText)) {
        return $false
    }

    return $OutputText -match 'kimi-cli version\s*:' -and
        $OutputText -match 'wire protocol\s*:' -and
        $OutputText -match 'python version\s*:'
}

function Get-LegacyKimiInfoVersion {
    param([string]$OutputText)

    $match = [regex]::Match($OutputText, '(?im)^\s*kimi-cli version\s*:\s*(?<version>\S+)')
    if ($match.Success) {
        return $match.Groups["version"].Value
    }
    return "legacy runtime"
}

function Test-KimiCliCandidate {
    param([string]$Candidate)

    $program = $Candidate

    if ($Candidate -match '[\\/:]') {
        if (!(Test-Path $Candidate)) {
            return $null
        }
    }
    else {
        $command = Get-Command $Candidate -ErrorAction SilentlyContinue
        if (-not $command) {
            return $null
        }
        if ($command.Source) {
            $program = $command.Source
        }
    }

    try {
        $infoOutput = & $program info 2>&1
        $infoText = ($infoOutput | Out-String)
        if ($LASTEXITCODE -eq 0 -and (Test-LegacyKimiInfoOutput $infoText)) {
            $version = Get-LegacyKimiInfoVersion $infoText
            return [pscustomobject]@{
                Program = $program
                Version = $version
            }
        }

        $summary = Get-KimiCliVersionSummary $program
        $script:incompatibleCliDetails.Add("$program ($summary)")
        return $null
    }
    catch {
        $summary = Get-KimiCliVersionSummary $program
        if ($summary -ne "version unavailable") {
            $script:incompatibleCliDetails.Add("$program ($summary)")
        }
        return $null
    }
}

function Resolve-KimiCli {
    foreach ($candidate in Get-KimiCliCandidates) {
        $result = Test-KimiCliCandidate $candidate
        if ($result) {
            return $result
        }
    }
    return $null
}

function Get-TomlScalarValues {
    param(
        [string]$Content,
        [string]$Key
    )

    $pattern = '(?m)^\s*' + [regex]::Escape($Key) + '\s*=\s*(?:"(?<dq>[^"]*)"|''(?<sq>[^'']*)''|(?<bare>[^\s#]+))'
    $values = New-Object System.Collections.Generic.List[string]
    foreach ($match in [regex]::Matches($Content, $pattern)) {
        $value = $match.Groups["dq"].Value
        if (-not $match.Groups["dq"].Success) {
            $value = $match.Groups["sq"].Value
        }
        if (-not $match.Groups["dq"].Success -and -not $match.Groups["sq"].Success) {
            $value = $match.Groups["bare"].Value
        }
        $values.Add($value)
    }
    return $values
}

function Test-AnyNonEmptyTomlScalar {
    param(
        [string]$Content,
        [string]$Key
    )

    foreach ($value in Get-TomlScalarValues $Content $Key) {
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $true
        }
    }
    return $false
}

function Get-FirstNonEmptyTomlScalar {
    param(
        [string]$Content,
        [string]$Key
    )

    foreach ($value in Get-TomlScalarValues $Content $Key) {
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
    }
    return ""
}

function Test-RuntimeEnvCredentials {
    $keys = @(
        "KIMI_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "VERTEXAI_PROJECT"
    )

    foreach ($key in $keys) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $true
        }
    }
    return $false
}

function Test-KimiCredentialFiles {
    if (-not $env:USERPROFILE) {
        return $false
    }

    $credentialsDir = Join-Path $env:USERPROFILE ".kimi\credentials"
    if (!(Test-Path $credentialsDir)) {
        return $false
    }

    $credentialFile = Get-ChildItem -LiteralPath $credentialsDir -File -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $credentialFile
}

Show-LoadingForm
Write-Host "[INFO] Runtime check mode: $Mode"

Update-LoadingStatus "Checking desktop sidecar"
if (!(Test-Path $sidecarExe)) {
    $issues.Add("Desktop sidecar is missing: $sidecarExe")
}
else {
    $sidecarItem = Get-Item -LiteralPath $sidecarExe
    Write-Host "[OK] Sidecar found: $($sidecarItem.FullName)"
}

Update-LoadingStatus "Reading sidecar manifest"
if (Test-Path $sidecarManifest) {
    try {
        $manifest = Get-Content -LiteralPath $sidecarManifest -Raw | ConvertFrom-Json
        if ($manifest.kimiCliVersion) {
            Write-Host "[OK] Bundled kimi-cli version: $($manifest.kimiCliVersion)"
        }
        else {
            $warnings.Add("Sidecar manifest exists but does not record a kimi-cli version.")
        }
    }
    catch {
        $warnings.Add("Sidecar manifest is not valid JSON: $sidecarManifest")
    }
}
else {
    $warnings.Add("Sidecar manifest not found: $sidecarManifest")
}

Update-LoadingStatus "Checking external legacy Kimi CLI"
$kimiCli = Resolve-KimiCli
if ($kimiCli) {
    Write-Host "[OK] External legacy Kimi CLI: $($kimiCli.Program) ($($kimiCli.Version))"
}
elseif ($incompatibleCliDetails.Count -gt 0) {
    $warnings.Add("Found external 'kimi' command, but it is not the legacy Python kimi-cli runtime required by Kimi Code Desktop login/setup: $($incompatibleCliDetails -join '; ')")
}
else {
    $warnings.Add("External legacy 'kimi' command was not found. The in-app Kimi login button requires the Python kimi-cli runtime.")
}

$configReady = $false
$hasConfigApiKey = $false
$hasConfigEnv = $false

Update-LoadingStatus "Checking config.toml"
if (!(Test-Path $ConfigFile)) {
    $issues.Add("Kimi config not found: $ConfigFile")
}
else {
    $configText = Get-Content -LiteralPath $ConfigFile -Raw
    $defaultModel = Get-FirstNonEmptyTomlScalar $configText "default_model"
    $hasProviderSection = [regex]::IsMatch($configText, '(?m)^\s*\[providers\.[^\]]+\]')
    $hasModelSection = [regex]::IsMatch($configText, '(?m)^\s*\[models\.[^\]]+\]')
    $hasConfigApiKey = Test-AnyNonEmptyTomlScalar $configText "api_key"
    $hasConfigEnv = [regex]::IsMatch($configText, '(?m)^\s*env\s*=\s*(\{[^\}]+\}|\[[^\]]+\]|"[^"]+"|''[^'']+'')') -or
        [regex]::IsMatch($configText, '(?m)^\s*\[providers\.[^\]]+\.env\]')

    if ([string]::IsNullOrWhiteSpace($defaultModel)) {
        $issues.Add("config.toml has no default_model.")
    }

    if (-not $hasProviderSection) {
        $issues.Add("config.toml has no [providers.*] section.")
    }

    if (-not $hasModelSection) {
        $issues.Add("config.toml has no [models.*] section.")
    }

    $configReady = -not [string]::IsNullOrWhiteSpace($defaultModel) -and $hasProviderSection -and $hasModelSection
    if ($configReady) {
        Write-Host "[OK] Config structure looks usable: $ConfigFile"
    }
}

Update-LoadingStatus "Checking credential sources"
$hasRuntimeEnvCredentials = Test-RuntimeEnvCredentials
$hasCredentialFiles = Test-KimiCredentialFiles
$hasCredentialSource = $hasConfigApiKey -or $hasConfigEnv -or $hasRuntimeEnvCredentials -or $hasCredentialFiles

if ($configReady -and $hasCredentialSource) {
    Write-Host "[OK] Credential source detected without printing secrets."
}
elseif ($configReady -and $kimiCli) {
    $warnings.Add("No credential source was detected. Launch can continue because a compatible legacy Kimi CLI is available for login/setup.")
}
elseif ($configReady) {
    $issues.Add("No credential source was detected and no compatible legacy Kimi CLI is available for login/setup.")
}

foreach ($warning in $warnings) {
    Write-Host "[WARN] $warning"
}

if ($issues.Count -gt 0) {
    foreach ($issue in $issues) {
        Write-Host "[ERROR] $issue"
    }

    if ($allowUnconfigured) {
        Close-LoadingForm
        Write-Host "[WARN] KIMI_ALLOW_UNCONFIGURED_START=1 is set; continuing despite startup check errors."
        exit 0
    }

    Write-Host "[ERROR] Kimi Code Desktop would likely open without being usable."
    Write-Host "[ERROR] Fix the items above, or set KIMI_ALLOW_UNCONFIGURED_START=1 to open the UI anyway."
    $choice = Show-StartupAttentionDialog -Issues $issues.ToArray() -Warnings $warnings.ToArray() -HasBlockingIssues $true -Url $DownloadUrl
    if ($choice -eq "continue") {
        Write-Host "[WARN] User chose to open the UI despite startup check errors."
        exit 0
    }
    if ($choice -eq "download") {
        Write-Host "[INFO] Opened legacy kimi-cli setup page: $DownloadUrl"
    }
    exit 1
}

if (-not $kimiCli -and $promptMissingCli) {
    $choice = Show-StartupAttentionDialog -Issues @() -Warnings $warnings.ToArray() -HasBlockingIssues $false -Url $DownloadUrl
    if ($choice -eq "continue") {
        Write-Host "[WARN] Continuing without external Kimi Code CLI."
    }
    elseif ($choice -eq "download") {
        Write-Host "[INFO] Opened legacy kimi-cli setup page: $DownloadUrl"
        exit 1
    }
    else {
        Write-Host "[INFO] Startup cancelled."
        exit 1
    }
}

Close-LoadingForm
Write-Host "[OK] Runtime readiness check passed."
exit 0
