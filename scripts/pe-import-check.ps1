<#
.SYNOPSIS
    Parse the PE import table of an executable and probe every named import
    with LoadLibrary + TryGetExport to find the entry point behind a
    0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND startup crash.
#>
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = "Stop"
$bytes = [System.IO.File]::ReadAllBytes($Path)

$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
$numSections = [BitConverter]::ToUInt16($bytes, $peOffset + 6)
$sizeOptHeader = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
$optOffset = $peOffset + 24
$magic = [BitConverter]::ToUInt16($bytes, $optOffset)
$is64 = ($magic -eq 0x20B)
if (-not $is64 -and $magic -ne 0x10B) {
    Write-Error "Not a PE32/PE32+ image (magic 0x$('{0:X}' -f $magic))."
}

# Data directory index 1 = import table. PE32: optional header + 96; PE32+: + 112.
$importDirRva = if ($is64) { [BitConverter]::ToUInt32($bytes, $optOffset + 120) } else { [BitConverter]::ToUInt32($bytes, $optOffset + 104) }

$sectionOffset = $optOffset + $sizeOptHeader
$sections = @()
for ($i = 0; $i -lt $numSections; $i++) {
    $so = $sectionOffset + ($i * 40)
    $sections += ,@{
        VirtualSize = [BitConverter]::ToUInt32($bytes, $so + 8)
        VirtualAddress = [BitConverter]::ToUInt32($bytes, $so + 12)
        SizeOfRawData = [BitConverter]::ToUInt32($bytes, $so + 16)
        PointerToRawData = [BitConverter]::ToUInt32($bytes, $so + 20)
    }
}

function RvaToOffset([uint32]$rva) {
    foreach ($s in $sections) {
        $end = $s.VirtualAddress + [Math]::Max($s.VirtualSize, $s.SizeOfRawData)
        if ($rva -ge $s.VirtualAddress -and $rva -lt $end) {
            return [int]($s.PointerToRawData + ($rva - $s.VirtualAddress))
        }
    }
    return -1
}

function Read-CString([int]$startOffset, [int]$maxLength) {
    $end = $startOffset
    while ($end -lt $bytes.Length -and ($end - $startOffset) -lt $maxLength -and $bytes[$end] -ne 0) {
        $end++
    }
    return [System.Text.Encoding]::ASCII.GetString($bytes, $startOffset, $end - $startOffset)
}

$offset = RvaToOffset $importDirRva
if ($offset -lt 0) {
    Write-Host "No import table found."
    exit 1
}

$descSize = 20
$step = if ($is64) { 8 } else { 4 }
$ordinalFlag = if ($is64) { [uint64]0x8000000000000000 } else { [uint64]0x80000000 }
$dllsChecked = 0
$missing = 0

for ($d = 0; $d -lt 64; $d++) {
    $base = $offset + ($d * $descSize)
    $nameRva = [BitConverter]::ToUInt32($bytes, $base + 12)
    $oftRva = [BitConverter]::ToUInt32($bytes, $base)
    $ftRva = [BitConverter]::ToUInt32($bytes, $base + 16)
    if ($nameRva -eq 0 -and $oftRva -eq 0 -and $ftRva -eq 0) { break }
    if ($nameRva -eq 0) { continue }

    $nameOff = RvaToOffset $nameRva
    if ($nameOff -lt 0) { continue }
    $dllName = Read-CString $nameOff 256

    $thunkRva = if ($oftRva -ne 0) { $oftRva } else { $ftRva }
    $thunkOff = RvaToOffset $thunkRva
    if ($thunkOff -lt 0) { continue }

    $funcs = @()
    for ($t = 0; $t -lt 512; $t++) {
        $to = $thunkOff + ($t * $step)
        if (($to + $step) -gt $bytes.Length) { break }
        $val = if ($is64) { [BitConverter]::ToUInt64($bytes, $to) } else { [uint64][BitConverter]::ToUInt32($bytes, $to) }
        if ($val -eq 0) { break }
        if (($val -band $ordinalFlag) -ne 0) {
            $funcs += "#$($val -band 0xFFFF)"
        } else {
            $hintOff = RvaToOffset ([uint32]($val -band 0xFFFFFFFF))
            if ($hintOff -lt 0) { continue }
            $funcs += Read-CString ($hintOff + 2) 256
        }
    }

    try {
        $handle = [System.Runtime.InteropServices.NativeLibrary]::Load($dllName)
    } catch {
        Write-Host "DLL LOAD FAIL: $dllName"
        $missing++
        continue
    }
    $dllsChecked++
    foreach ($fn in $funcs) {
        if ($fn.StartsWith("#")) { continue }
        $exportPtr = [IntPtr]::Zero
        $ok = [System.Runtime.InteropServices.NativeLibrary]::TryGetExport($handle, $fn, [ref]$exportPtr)
        if (-not $ok) {
            Write-Host "MISSING ENTRY: $dllName!$fn"
            $missing++
        }
    }
    Write-Host "CHECKED: $dllName ($($funcs.Count) imports)"
}

Write-Host "PE import check done: $dllsChecked DLLs checked, $missing missing entries."
if ($missing -gt 0) { exit 2 }
