param([switch]$Stop, [switch]$OpenExisting, [switch]$ShowErrors)

$ErrorActionPreference = 'Stop'
trap {
    if (!$ShowErrors) { break }
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PoE Trade', 'OK', 'Error')
    exit 1
}

$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$bundledNode = Join-Path $project '../pob-runtime/node/node.exe'
$nodeExe = if (Test-Path -LiteralPath $bundledNode) { (Resolve-Path -LiteralPath $bundledNode).Path } else { (Get-Command node).Source }
if ([int]((& $nodeExe --version) -replace '^v(\d+)\..*$', '$1') -lt 24) {
    throw 'PoE Trade Companion requires Node 24 or newer.'
}

$entry = Join-Path $project 'build/trade/launcher.js'
if (!(Test-Path -LiteralPath $entry)) {
    Push-Location -LiteralPath $project
    try {
        & $nodeExe 'node_modules/typescript/bin/tsc'
        if ($LASTEXITCODE -ne 0) { throw 'Could not build the companion. Run npm install and npm run build.' }
    } finally { Pop-Location }
}

if ($Stop) {
    & $nodeExe $entry --stop
    if ($LASTEXITCODE -ne 0) { throw 'The local Trade service could not be stopped.' }
    return
}

# Honor explicit PoB configuration and discover the sibling checkout/runtime used by this workspace.
if (!$env:POB_PATH -and !$env:POB_FORK_PATH) {
    $pobSource = Join-Path $project '../PathOfBuilding/src'
    if (Test-Path -LiteralPath (Join-Path $pobSource 'HeadlessWrapper.lua')) {
        $env:POB_PATH = (Resolve-Path -LiteralPath $pobSource).Path
    }
}
if (!$env:POB_CMD) {
    $luaJit = Join-Path $project '../pob-runtime/ucrt64/bin/luajit.exe'
    if (Test-Path -LiteralPath $luaJit) { $env:POB_CMD = (Resolve-Path -LiteralPath $luaJit).Path }
}
if (!$env:POB_DIRECTORY) {
    $env:POB_DIRECTORY = Join-Path $env:USERPROFILE 'Documents/Path of Building/Builds'
}
if (!$env:POE_TRADE_ENABLED) {
    $env:POE_TRADE_ENABLED = 'true'
}

$electronPackage = Join-Path $project 'node_modules/electron'
$electron = Join-Path $electronPackage 'dist/electron.exe'
if (!(Test-Path -LiteralPath $electron)) {
    $installer = Join-Path $electronPackage 'install.js'
    if (!(Test-Path -LiteralPath $installer)) { throw 'Run npm install to install the Electron desktop dependency.' }
    & $nodeExe $installer
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $electron)) { throw 'Could not install Electron.' }
}

$env:POE_TRADE_NODE_EXE = $nodeExe
$desktopEntry = Join-Path $PSScriptRoot 'electron-main.cjs'
Start-Process -FilePath $electron -WindowStyle Normal -WorkingDirectory $project -ArgumentList "`"$desktopEntry`""
if (!$OpenExisting) {
    $desktopPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $tray = Join-Path $PSScriptRoot 'Tray.ps1'
    Start-Process -FilePath $desktopPowerShell -WindowStyle Hidden -WorkingDirectory $project `
        -ArgumentList "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -STA -File `"$tray`""
}
