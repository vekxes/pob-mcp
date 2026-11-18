$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$installer = Join-Path $repo 'apps/trade-desktop/Install-TradeShortcut.ps1'
$expected = Join-Path $repo 'build/trade/PoE Trade.exe'
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$folder = Join-Path $temp ('PoE Trade Shortcut ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder | Out-Null
$path = Join-Path $folder 'PoE Trade.lnk'
$shell = New-Object -ComObject WScript.Shell

try {
    & $installer -DesktopDirectory $folder | Out-Null
    & $installer -DesktopDirectory $folder | Out-Null
    $shortcut = $shell.CreateShortcut($path)
    if ($shortcut.TargetPath -ne $expected -or $shortcut.WorkingDirectory -ne $repo -or $shortcut.IconLocation -ne "$expected,0") {
        throw 'Desktop shortcut did not preserve its executable, working directory and icon after reinstall.'
    }
    if ($shortcut.Arguments) { throw 'The desktop shortcut should require no command-line arguments.' }

    Add-Type -AssemblyName System.Drawing
    $icon = [Drawing.Icon]::ExtractAssociatedIcon($expected)
    try {
        if ($null -eq $icon -or $icon.Width -lt 16) { throw 'Windows did not find the embedded application icon.' }
    } finally {
        if ($icon) { $icon.Dispose() }
    }

    $isolatedRoot = Join-Path $folder 'Launcher checkout'
    $isolatedBinary = Join-Path $isolatedRoot 'build/trade'
    $isolatedApp = Join-Path $isolatedRoot 'apps/trade-desktop'
    New-Item -ItemType Directory -Path $isolatedBinary, $isolatedApp -Force | Out-Null
    Copy-Item -LiteralPath $expected -Destination $isolatedBinary
    $stub = @'
param([switch]$ShowErrors)
if (!$ShowErrors) { exit 9 }
Set-Content -LiteralPath 'launcher-ran.txt' -Value 'Opened from a path with spaces' -Encoding Ascii
'@
    Set-Content -LiteralPath (Join-Path $isolatedApp 'Start-Trade.ps1') -Value $stub -Encoding Ascii
    $process = Start-Process -FilePath (Join-Path $isolatedBinary 'PoE Trade.exe') -WindowStyle Hidden -PassThru
    try {
        if (!$process.WaitForExit(10000)) {
            $process.Kill()
            throw 'The Windows launcher did not exit after starting the companion.'
        }
        $marker = Join-Path $isolatedRoot 'launcher-ran.txt'
        if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $marker)) {
            throw 'The Windows launcher did not run the script from its checkout directory.'
        }
    } finally { $process.Dispose() }

    $different = Join-Path $env:SystemRoot 'System32/notepad.exe'
    $shortcut.TargetPath = $different
    $shortcut.Save()
    $rejected = $false
    try { & $installer -DesktopDirectory $folder | Out-Null } catch { $rejected = $true }
    if (!$rejected -or $shell.CreateShortcut($path).TargetPath -ne $different) {
        throw 'The installer replaced an unrelated shortcut with the same name.'
    }
    Write-Output 'Desktop shortcut, launch with spaces, embedded icon, reinstall and conflict checks passed.'
} finally {
    $resolved = (Resolve-Path -LiteralPath $folder).Path
    $prefix = $temp.TrimEnd('\') + '\'
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
