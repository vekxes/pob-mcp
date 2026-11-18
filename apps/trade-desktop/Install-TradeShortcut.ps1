param(
    [string]$DesktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
)

$ErrorActionPreference = 'Stop'
if (!$DesktopDirectory -or !(Test-Path -LiteralPath $DesktopDirectory -PathType Container)) {
    throw 'The Windows desktop folder is unavailable.'
}

$desktop = (Resolve-Path -LiteralPath $DesktopDirectory).Path
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$output = Join-Path $root 'build/trade'
$executable = Join-Path $output 'PoE Trade.exe'
$shortcutPath = Join-Path $desktop 'PoE Trade.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.TargetPath -ne $executable) {
    throw "A different PoE Trade shortcut already exists at $shortcutPath."
}

$compiler = @('Framework64', 'Framework') | ForEach-Object {
    Join-Path $env:SystemRoot "Microsoft.NET/$_/v4.0.30319/csc.exe"
} | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (!$compiler) { throw 'The Windows .NET Framework C# compiler is unavailable.' }

$source = Join-Path $PSScriptRoot 'TradeLauncher.cs'
$icon = Join-Path $PSScriptRoot 'poe-trade.ico'
New-Item -ItemType Directory -Path $output -Force | Out-Null
& $compiler /nologo /target:winexe /optimize+ "/win32icon:$icon" "/out:$executable" /reference:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the PoE Trade launcher.' }

$shortcut.TargetPath = $executable
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$executable,0"
$shortcut.Description = 'Open PoE Trade Companion'
$shortcut.Arguments = ''
$shortcut.Save()
Write-Output $shortcutPath
