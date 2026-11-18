const { app, BrowserWindow, dialog, shell } = require('electron');
const { mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createBrowserTradeSession } = require('./browser-session.cjs');

const dataHome = resolve(process.env.POE_TRADE_HOME || join(process.env.LOCALAPPDATA || homedir(), 'PoELocalTrade'));
const userData = join(dataHome, 'desktop');
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setName('PoE Trade');
app.setPath('userData', userData);
app.setAppUserModelId('PoELocalTrade.Desktop');

let service;
let dashboard;
let stopped = false;

function showDashboard() {
  if (!service) return;
  if (dashboard) {
    if (dashboard.isMinimized()) dashboard.restore();
    dashboard.focus();
    return;
  }
  const origin = new URL(service.url).origin;
  dashboard = new BrowserWindow({
    title: 'PoE Trade', width: 1260, height: 860, minWidth: 700, minHeight: 520,
    icon: join(__dirname, 'poe-trade.ico'), show: false, autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:poe-trade-dashboard', sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  dashboard.webContents.on('will-navigate', (event, address) => {
    if (new URL(address).origin !== origin) event.preventDefault();
  });
  dashboard.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.protocol === 'https:') void shell.openExternal(target.href).catch(() => undefined);
    return { action: 'deny' };
  });
  dashboard.on('closed', () => { dashboard = undefined; });
  dashboard.once('ready-to-show', () => dashboard?.show());
  void dashboard.loadURL(service.url).catch(() => {
    dialog.showErrorBox('PoE Trade', 'Не удалось открыть интерфейс локального сервиса.');
  });
}

async function browseCodex(currentPath) {
  if (!dashboard || dashboard.isDestroyed()) return;
  const result = await dialog.showOpenDialog(dashboard, {
    title: 'Выбрать Codex CLI', defaultPath: currentPath || undefined, properties: ['openFile'],
    ...(process.platform === 'win32' && { filters: [{ name: 'Исполняемые файлы', extensions: ['exe'] }] }),
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function browseIntegration(field, currentPath) {
  if (!dashboard || dashboard.isDestroyed()) return;
  const titles = {
    buildsDirectory: 'Выбрать папку билдов PoB',
    sourceDirectory: 'Выбрать папку Path of Building',
    mcpConfig: 'Выбрать config.toml для MCP',
  };
  const config = field === 'mcpConfig';
  const result = await dialog.showOpenDialog(dashboard, {
    title: titles[field], defaultPath: currentPath || undefined, properties: [config ? 'openFile' : 'openDirectory'],
    ...(config && { filters: [{ name: 'Конфигурация Codex', extensions: ['toml'] }] }),
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function start() {
  const { connectLocal, stopLocal } = await import('../../build/trade/localConnection.js');
  const { startTradeDaemon } = await import('../../build/trade/daemon.js');
  const { setTradeLogPath, tradeLog } = await import('../../build/trade/log.js');
  setTradeLogPath(join(dataHome, 'service.log'));

  const running = await connectLocal(false).catch(() => undefined);
  if (running && !running.browserAvailable) {
    tradeLog('desktop', 'upgrading_headless_service');
    await stopLocal(running);
  }
  const browserSession = createBrowserTradeSession({ profilePath: join(userData, 'poe-profile'), log: tradeLog });
  const onStopped = () => {
    stopped = true;
    app.quit();
  };
  // The previously running Node service may still be releasing its listener after /stop.
  for (let attempt = 0; ; attempt++) {
    try {
      service = await startTradeDaemon({ browserSession, browseCodex, browseIntegration, onStopped });
      break;
    } catch (error) {
      if (!running || running.browserAvailable || error.code !== 'EADDRINUSE' || attempt >= 15) throw error;
      await delay(100);
    }
  }
  showDashboard();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showDashboard);
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (!service || stopped) return;
    event.preventDefault();
    void service.close();
  });
  void app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('PoE Trade', 'Не удалось запустить настольный сервис. Подробности в service.log.');
    app.exit(1);
  });
}
