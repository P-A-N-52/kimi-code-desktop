$ErrorActionPreference = "Stop"

$processes = @(Get-Process kimi-code-desktop -ErrorAction SilentlyContinue)
if ($processes.Count -eq 0) {
    exit 1
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class KimiWindowFocus {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$processIds = @{}
foreach ($process in $processes) {
    $processIds[[uint32]$process.Id] = $true
}

$target = [IntPtr]::Zero
$callback = [KimiWindowFocus+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)

    if (-not [KimiWindowFocus]::IsWindowVisible($hWnd)) {
        return $true
    }

    [uint32]$ownerPid = 0
    [void][KimiWindowFocus]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
    if (-not $processIds.ContainsKey($ownerPid)) {
        return $true
    }

    $classBuilder = [System.Text.StringBuilder]::new(256)
    [void][KimiWindowFocus]::GetClassName($hWnd, $classBuilder, $classBuilder.Capacity)
    $className = $classBuilder.ToString()

    $titleBuilder = [System.Text.StringBuilder]::new(256)
    [void][KimiWindowFocus]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)
    $title = $titleBuilder.ToString()

    if ($className -eq "Tauri Window" -or $title -eq "Kimi Code") {
        $script:target = $hWnd
        return $false
    }

    return $true
}

[void][KimiWindowFocus]::EnumWindows($callback, [IntPtr]::Zero)

if ($target -eq [IntPtr]::Zero) {
    exit 2
}

[void][KimiWindowFocus]::ShowWindow($target, 9)
[void][KimiWindowFocus]::SetForegroundWindow($target)
exit 0
