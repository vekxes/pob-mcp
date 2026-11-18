$ErrorActionPreference = 'Stop'

function Get-TradeAlertBatch($cursor, $journal) {
    $latest = [long]$journal.latestCursor
    if ($null -eq $cursor -or $latest -lt $cursor) {
        return @{ Cursor = $latest; Count = 0 }
    }
    return @{ Cursor = [long]$journal.nextCursor; Count = @($journal.events).Count }
}

function Invoke-TradeService([string]$path, [hashtable]$body) {
    $connection = [IO.File]::ReadAllText($descriptor) | ConvertFrom-Json
    $token = [string]$connection.token
    if ($token -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid local Trade connection.' }

    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$origin$path")
    try {
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token)
        if ($body) {
            $json = ConvertTo-Json -InputObject $body -Depth 5 -Compress
            $request.Content = [System.Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            if (!$response.IsSuccessStatusCode) { throw 'The local Trade service did not accept the request.' }
            $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        } finally { $response.Dispose() }
    } finally { $request.Dispose() }
}

$port = if ($env:POE_TRADE_PORT) { [double]$env:POE_TRADE_PORT } else { 48217 }
if ($port -lt 1024 -or $port -gt 65535 -or [Math]::Floor($port) -ne $port) { throw 'Invalid POE_TRADE_PORT.' }
$port = [int]$port
$origin = "http://127.0.0.1:$port"
$tradeHome = if ($env:POE_TRADE_HOME) { $env:POE_TRADE_HOME } else { Join-Path $env:LOCALAPPDATA 'PoELocalTrade' }
$descriptor = Join-Path $tradeHome 'connection.json'
$settingsPath = Join-Path $tradeHome "tray-alerts-$port.txt"
$launcher = Join-Path $PSScriptRoot 'Start-Trade.ps1'
$workingDirectory = (Get-Location).ProviderPath
$desktopPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = [Threading.Mutex]::new($false, "Global\PoETradeTray-$userSid-$port")
$ownsMutex = $false
$client = $context = $menu = $icon = $appIcon = $timer = $null

try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) { return }

    Add-Type -AssemblyName System.Net.Http, System.Windows.Forms, System.Drawing
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(5)

    $context = [Windows.Forms.ApplicationContext]::new()
    $icon = [Windows.Forms.NotifyIcon]::new()
    $appIcon = [Drawing.Icon]::new((Join-Path $PSScriptRoot 'poe-trade.ico'), [Windows.Forms.SystemInformation]::SmallIconSize)
    $icon.Icon = $appIcon
    $icon.Text = 'PoE Trade'
    $menu = [Windows.Forms.ContextMenuStrip]::new()
    $open = $menu.Items.Add('Открыть PoE Trade')
    $alerts = $menu.Items.Add('Уведомления Windows')
    $alerts.CheckOnClick = $true
    try { $alerts.Checked = [IO.File]::ReadAllText($settingsPath) -eq 'True' } catch {}
    $stop = $menu.Items.Add('Остановить сервис и выйти')
    $exit = $menu.Items.Add('Выйти из трея')
    $icon.ContextMenuStrip = $menu

    $openApp = {
        Start-Process -FilePath $desktopPowerShell -WindowStyle Hidden -WorkingDirectory $workingDirectory `
            -ArgumentList "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$launcher`" -OpenExisting"
    }
    $open.add_Click($openApp)
    $icon.add_DoubleClick($openApp)
    $icon.add_BalloonTipClicked($openApp)
    $exit.add_Click({ $context.ExitThread() })
    $stop.add_Click({
        try {
            $null = Invoke-TradeService '/stop'
            $context.ExitThread()
        } catch {
            $icon.ShowBalloonTip(4000, 'PoE Trade', 'Не удалось остановить локальный сервис.', [Windows.Forms.ToolTipIcon]::Warning)
        }
    })

    $state = @{ Cursor = $null; Failures = 0 }
    $poll = {
        $cursor = if ($alerts.Checked) { $state.Cursor }
        $after = if ($null -eq $cursor) { 0 } else { $cursor }
        $limit = if ($null -eq $cursor) { 1 } else { 200 }
        try {
            $journal = (Invoke-TradeService '/api' @{ name = 'trade_watch_events'; args = @{ after = $after; limit = $limit } }).data
            $batch = Get-TradeAlertBatch $cursor $journal
            $state.Cursor = $batch.Cursor
            $state.Failures = 0
        } catch {
            $state.Failures++
            if ($state.Failures -ge 3) { $context.ExitThread() }
            return
        }
        if ($alerts.Checked -and $batch.Count -gt 0) {
            $icon.ShowBalloonTip(5000, 'PoE Trade Live Search', "Новых совпадений: $($batch.Count)", [Windows.Forms.ToolTipIcon]::Info)
        }
    }
    $alerts.add_Click({
        $state.Cursor = $null
        try { [IO.File]::WriteAllText($settingsPath, [string]$alerts.Checked) }
        catch {
            $icon.ShowBalloonTip(4000, 'PoE Trade', 'Настройка действует до выхода из трея.', [Windows.Forms.ToolTipIcon]::Warning)
        }
        if ($alerts.Checked) { & $poll }
    })

    $timer = [Windows.Forms.Timer]::new()
    $timer.Interval = 3000
    $timer.add_Tick($poll)
    $icon.Visible = $true
    & $poll
    $timer.Start()
    [Windows.Forms.Application]::Run($context)
} finally {
    if ($timer) { $timer.Dispose() }
    if ($icon) { $icon.Visible = $false; $icon.Dispose() }
    if ($appIcon) { $appIcon.Dispose() }
    if ($menu) { $menu.Dispose() }
    if ($context) { $context.Dispose() }
    if ($client) { $client.Dispose() }
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
