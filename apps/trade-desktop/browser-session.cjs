const { BrowserWindow, dialog, net, session } = require('electron');

const poeOrigin = 'https://www.pathofexile.com';
const loginHosts = new Set([
  'www.pathofexile.com', 'pathofexile.com',
  'steamcommunity.com', 'www.steamcommunity.com', 'store.steampowered.com',
  'www.epicgames.com', 'accounts.epicgames.com',
  'login.live.com', 'account.live.com', 'www.xbox.com',
  'id.sonyentertainmentnetwork.com', 'my.account.sony.com', 'ca.account.sony.com',
]);
const idPattern = /^[A-Za-z0-9_-]+={0,2}$/;
const poe1Realms = new Set(['xbox', 'sony']);

function allowedLoginUrl(address) {
  const url = URL.parse(address);
  return url?.protocol === 'https:' && !url.port && !url.username && !url.password
    && loginHosts.has(url.hostname);
}

function parseTradeUrl(address, protocol) {
  const url = new URL(address);
  if (url.protocol !== protocol || url.hostname !== 'www.pathofexile.com'
      || url.port || url.username || url.password || url.hash) {
    throw new Error('Invalid PoE Trade destination.');
  }
  const [api, game, route, ...parts] = url.pathname.slice(1).split('/').map(decodeURIComponent);
  if (api !== 'api' || !['trade', 'trade2'].includes(game)
      || parts.some(part => !part || /[/\\\u0000-\u001f]/.test(part) || part === '.' || part === '..')) {
    throw new Error('Invalid PoE Trade route.');
  }
  return { url, game, route, parts };
}

function validSearchPath(game, parts, withId) {
  if (game === 'trade2' && parts.shift() !== 'poe2') return false;
  if (game === 'trade' && parts.length > (withId ? 2 : 1) && poe1Realms.has(parts[0])) parts.shift();
  return parts.length === (withId ? 2 : 1) && parts[0].length <= 100
    && (!withId || idPattern.test(parts[1]));
}

function createBrowserTradeSession({ profilePath, log = () => {} }) {
  const profile = session.fromPath(profilePath);
  profile.setPermissionRequestHandler((_contents, _permission, accept) => accept(false));
  profile.setPermissionCheckHandler(() => false);
  profile.on('will-download', event => event.preventDefault());
  const listeners = new Set();
  const loginWindows = new Set();
  let window;
  let current = { status: 'unavailable' };
  let validUntil = 0;
  let revision = 0;
  let pending;
  let refreshTimer;
  let clearing;

  async function request(url, init) {
    const response = await profile.fetch(url, {
      ...init, credentials: 'include', cache: 'no-store', bypassCustomProtocolHandlers: true,
    });
    if (!response.headers.has('set-cookie') && !response.headers.has('set-cookie2')) return response;
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    headers.delete('set-cookie2');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  async function verifyProfile() {
    try {
      const response = await request(poeOrigin + '/api/profile', {
        headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(6000),
      });
      const isJson = /\bapplication\/json\b/i.test(response.headers.get('content-type') ?? '');
      const location = response.headers.get('location');
      const redirect = location ? URL.parse(location, poeOrigin) : null;
      if (response.status === 401 || (response.status === 403 && isJson)
          || (response.status >= 300 && response.status < 400
              && redirect?.origin === poeOrigin && /^\/login(?:\/|$)/.test(redirect.pathname))) {
        await response.body?.cancel();
        return { status: 'disconnected' };
      }
      if (!response.ok || !isJson) {
        await response.body?.cancel();
        return { status: 'unavailable' };
      }
      const data = await response.json();
      if (typeof data?.name !== 'string' || !data.name.trim()) return { status: 'disconnected' };
      return { status: 'connected', name: data.name };
    } catch {
      return { status: 'unavailable' };
    }
  }

  function publish(result) {
    const changed = current.status !== result.status || current.name !== result.name;
    current = result;
    if (!changed) return;
    log('trade-session', 'browser_status', { status: current.status });
    for (const listener of listeners) listener();
  }

  function getStatus() {
    if (clearing) return Promise.resolve('disconnected');
    if (Date.now() < validUntil) return Promise.resolve(current.status);
    if (pending) return pending;
    const startedAt = revision;
    pending = verifyProfile().then(async result => {
      if (startedAt !== revision) return getStatus();
      if (result.status === 'connected' && current.status !== 'connected') {
        await profile.cookies.flushStore().catch(() => log('trade-session', 'browser_profile_flush_failed'));
      }
      if (startedAt !== revision) return getStatus();
      pending = undefined;
      validUntil = Date.now() + (result.status === 'connected' ? 60_000 : 15_000);
      publish(result);
      return current.status;
    });
    return pending;
  }

  function invalidateStatus() {
    revision++;
    validUntil = 0;
    pending = undefined;
  }

  function refreshStatusSoon() {
    if (clearing) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      invalidateStatus();
      void getStatus();
    }, 250);
    refreshTimer.unref();
  }

  profile.cookies.on('changed', (_event, cookie, cause) => {
    if (cookie.name === 'POESESSID' && /(?:^|\.)pathofexile\.com$/.test(cookie.domain ?? '')
        && !cause?.startsWith('inserted-no-') && (window || current.status === 'connected')) {
      refreshStatusSoon();
    }
  });

  const webPreferences = { session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false };
  const windowOptions = { width: 1040, height: 760, title: 'Вход в Path of Exile · www.pathofexile.com', webPreferences };

  function bindLoginWindow(loginWindow) {
    if (clearing) {
      loginWindow.destroy();
      return;
    }
    loginWindows.add(loginWindow);
    loginWindow.once('closed', () => loginWindows.delete(loginWindow));
    const { webContents } = loginWindow;
    loginWindow.setMenu(null);
    webContents.on('page-title-updated', event => event.preventDefault());
    function restrictNavigation(event, address) {
      if (event.isMainFrame === false) return;
      if (!allowedLoginUrl(event.url ?? address)) event.preventDefault();
    }
    webContents.on('will-navigate', restrictNavigation);
    webContents.on('will-redirect', restrictNavigation);
    webContents.setWindowOpenHandler(({ url }) => !clearing && allowedLoginUrl(url)
      ? { action: 'allow', overrideBrowserWindowOptions: windowOptions }
      : { action: 'deny' });
    webContents.on('did-create-window', bindLoginWindow);
    webContents.on('did-navigate', (event, address) => {
      const url = URL.parse(event.url ?? address);
      if (url && allowedLoginUrl(url.href)) {
        loginWindow.setTitle('Вход в Path of Exile · ' + url.hostname);
        if (url.origin === poeOrigin && (url.pathname.startsWith('/my-account') || url.pathname.startsWith('/account/'))) {
          refreshStatusSoon();
        }
      }
    });
    webContents.on('did-finish-load', () => log('trade-session', 'browser_page_loaded'));
  }

  return {
    async fetch(address, init = {}) {
      if (clearing) throw new Error('The PoE Trade profile is signing out.');
      const { url, game, route, parts } = parseTradeUrl(address, 'https:');
      const method = init.method ?? 'GET';
      const fetching = route === 'fetch' && parts.length === 1 && method === 'GET';
      const ids = fetching ? parts[0].split(',') : [];
      const allowed = fetching
        ? ids.length <= 10 && ids.every(id => idPattern.test(id))
          && [...url.searchParams].every(([key, value]) => key === 'query' && idPattern.test(value)
            || key === 'realm' && (value === 'poe2' || poe1Realms.has(value)))
        : !url.search && (
          route === 'search' && (
            method === 'POST' && validSearchPath(game, [...parts], false) && typeof init.body === 'string'
            || method === 'GET' && validSearchPath(game, [...parts], true)
          )
          || route === 'data' && method === 'GET' && parts.length === 1 && ['leagues', 'stats'].includes(parts[0])
        );
      if (!allowed) throw new Error('Invalid PoE Trade request.');
      const response = await request(url.href, {
        method, redirect: 'error', signal: init.signal,
        headers: { Accept: 'application/json', ...(method === 'POST' && { 'Content-Type': 'application/json' }) },
        body: method === 'POST' ? init.body : undefined,
      });
      if (current.status === 'connected' && [401, 403].includes(response.status)) refreshStatusSoon();
      return response;
    },

    openSocket(address) {
      if (clearing) throw new Error('The PoE Trade profile is signing out.');
      const { url, game, route, parts } = parseTradeUrl(address, 'wss:');
      if (route !== 'live' || url.search || !validSearchPath(game, parts, true)) {
        throw new Error('Invalid PoE Live Search request.');
      }
      const socket = new net.WebSocket(url.href, { session: profile, useSessionCookies: true, origin: poeOrigin });
      socket.addEventListener('error', refreshStatusSoon, { once: true });
      return socket;
    },

    getStatus,

    openLogin() {
      if (clearing) throw new Error('The PoE Trade profile is signing out.');
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        return;
      }
      const loginWindow = new BrowserWindow(windowOptions);
      window = loginWindow;
      bindLoginWindow(loginWindow);
      loginWindow.once('closed', () => {
        window = undefined;
        refreshStatusSoon();
      });
      log('trade-session', 'browser_login_opened');
      void loginWindow.loadURL(poeOrigin + '/login').catch(error => {
        if (loginWindow.isDestroyed()) return;
        const code = /^ERR_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'load_failed';
        log('trade-session', 'browser_login_load_failed', { code });
        void dialog.showMessageBox(loginWindow, {
          type: 'warning', message: 'Страница входа Path of Exile недоступна.',
          detail: 'Закрой окно и попробуй открыть вход ещё раз.',
        }).catch(() => {});
      });
    },

    clear() {
      if (clearing) return clearing;
      invalidateStatus();
      clearTimeout(refreshTimer);
      clearing = Promise.resolve().then(async () => {
        publish({ status: 'disconnected' });
        for (const loginWindow of loginWindows) {
          if (!loginWindow.isDestroyed()) loginWindow.destroy();
        }
        await profile.clearData();
        await profile.cookies.flushStore();
        validUntil = Date.now() + 15_000;
      }).finally(() => { clearing = undefined; });
      return clearing;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createBrowserTradeSession };
