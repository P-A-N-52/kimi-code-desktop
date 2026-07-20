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
    $ConfigFile = Join-Path $env:USERPROFILE ".kimi-code\config.toml"
}

if (-not $DownloadUrl) {
    $DownloadUrl = $env:KIMI_CODE_DOWNLOAD_URL
}
if (-not $DownloadUrl) {
    $DownloadUrl = "https://moonshotai.github.io/kimi-cli/"
}

$allowUnconfigured = $env:KIMI_ALLOW_UNCONFIGURED_START -eq "1"
$promptMissingCliRaw = [Environment]::GetEnvironmentVariable("KIMI_PROMPT_MISSING_CLI")
$promptMissingCli = $true
if (-not [string]::IsNullOrWhiteSpace($promptMissingCliRaw)) {
    $promptMissingCli = $promptMissingCliRaw.Trim().ToLowerInvariant() -notin @("0", "false", "no")
}

$issues = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
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
        $title.Text = "Kimi Code CLI is not available"
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
        $body.Text = "The app can continue, but login/setup from inside the app may not work until Kimi Code CLI is installed."
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
    $detailLines.Add("Kimi Code CLI setup page: $Url")
    $details.Text = $detailLines -join [Environment]::NewLine
    $form.Controls.Add($details)

    $downloadButton = New-Object System.Windows.Forms.Button
    $downloadButton.Text = "Open Kimi Code CLI"
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

function Resolve-KimiCodeProgram {
    $program = $env:KIMI_CODE_BIN
    if (-not [string]::IsNullOrWhiteSpace($program)) {
        return $program.Trim().Trim('"')
    }

    $command = Get-Command kimi -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        return $command.Source
    }

    return "kimi"
}

function Test-KimiCodeCli {
    param([string]$Program)

    try {
        $versionOutput = & $Program --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{
                Ok = $false
                Error = "``$Program --version`` failed: $(($versionOutput | Out-String).Trim())"
            }
        }

        $helpOutput = & $Program acp --help 2>&1
        if ($LASTEXITCODE -ne 0) {
            return [pscustomobject]@{
                Ok = $false
                Error = "``$Program acp --help`` failed: $(($helpOutput | Out-String).Trim())"
            }
        }

        $helpText = (($helpOutput | Out-String).Trim()).ToLowerInvariant()
        if ($helpText -notmatch "acp" -and $helpText -notmatch "agent client protocol") {
            return [pscustomobject]@{
                Ok = $false
                Error = "``$Program acp --help`` did not look like an ACP entrypoint"
            }
        }

        return [pscustomobject]@{
            Ok = $true
            Version = (($versionOutput | Out-String).Trim() -replace '\s+', ' ')
        }
    }
    catch {
        return [pscustomobject]@{
            Ok = $false
            Error = "Failed to run Kimi Code CLI ``$Program``: $($_.Exception.Message)"
        }
    }
}

Show-LoadingForm
Write-Host "[INFO] Runtime check mode: $Mode"

Update-LoadingStatus "Checking Kimi Code CLI"
$kimiProgram = Resolve-KimiCodeProgram
$kimiCheck = Test-KimiCodeCli -Program $kimiProgram
if ($kimiCheck.Ok) {
    Write-Host "[OK] Kimi Code CLI: $kimiProgram ($($kimiCheck.Version))"
}
else {
    $issues.Add($kimiCheck.Error)
    Write-Host "[ERROR] $($kimiCheck.Error)"
}

Update-LoadingStatus "Checking Kimi Code config"
if (!(Test-Path $ConfigFile)) {
    $warnings.Add("Kimi Code config not found: $ConfigFile. Run ``kimi login`` or ``kimi migrate`` if migrating from legacy.")
    Write-Host "[WARN] Kimi Code config not found: $ConfigFile"
}
else {
    try {
        $null = Get-Content -LiteralPath $ConfigFile -Raw | Out-Null
        Write-Host "[OK] Kimi Code config found: $ConfigFile"
    }
    catch {
        $issues.Add("Failed to read Kimi Code config: $ConfigFile")
        Write-Host "[ERROR] Failed to read Kimi Code config: $ConfigFile"
    }
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
        Write-Host "[INFO] Opened Kimi Code CLI setup page: $DownloadUrl"
    }
    exit 1
}

if (-not $kimiCheck.Ok -and $promptMissingCli) {
    $choice = Show-StartupAttentionDialog -Issues @() -Warnings $warnings.ToArray() -HasBlockingIssues $false -Url $DownloadUrl
    if ($choice -eq "continue") {
        Write-Host "[WARN] Continuing without Kimi Code CLI."
    }
    elseif ($choice -eq "download") {
        Write-Host "[INFO] Opened Kimi Code CLI setup page: $DownloadUrl"
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
