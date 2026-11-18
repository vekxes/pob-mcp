const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = join(__dirname, '../../apps/trade-desktop/browser-session.cjs');
const poe = 'https://www.pathofexile.com';

function fixture() {
  const requests = [];
  const sockets = [];
  const windows = [];
  const profile = new EventEmitter();
  let signedIn = true;
  profile.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url !== `${poe}/api/profile`) return Response.json({ result: [] });
    return signedIn ? Response.json({ name: 'Example#1234' }) : new Response(null, { status: 401 });
  };
  profile.cookies = new EventEmitter();
  profile.cookies.flushStore = async () => {};
  profile.setPermissionRequestHandler = () => {};
  profile.setPermissionCheckHandler = () => {};
  profile.clearData = async () => { signedIn = false; };

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openChild = handler; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed === true; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    setMenu() {}
    setTitle() {}
    loadURL(url) { this.url = url; return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }

  const electron = {
    BrowserWindow,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    net: { WebSocket: class extends EventTarget {
      constructor(url, options) { super(); sockets.push({ url, options }); }
    } },
    session: { fromPath(path) { assert.equal(path, 'example-profile'); return profile; } },
  };
  const module = { exports: {} };
  runInNewContext(readFileSync(source, 'utf8'), {
    module,
    require: name => name === 'electron' ? electron : require(name),
    AbortSignal, Headers, Response, URL, clearTimeout, setTimeout,
  }, { filename: source });
  const transport = module.exports.createBrowserTradeSession({ profilePath: 'example-profile' });
  return { transport, requests, sockets, windows, profile, BrowserWindow };
}

test('login, trade HTTP and Live Search share an app-owned browser profile', async () => {
  const { transport, requests, sockets, windows, profile } = fixture();
  transport.openLogin();
  assert.equal(windows[0].url, `${poe}/login`);
  assert.equal(windows[0].options.webPreferences.session, profile);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].openChild({ url: 'https://example.invalid/' }).action, 'deny');

  const statuses = [];
  transport.onChange(() => statuses.push(transport.getStatus()));
  assert.equal(await transport.getStatus(), 'connected');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(await statuses[0], 'connected');

  const searchUrl = `${poe}/api/trade/search/Covens`;
  await transport.fetch(searchUrl, {
    method: 'POST', body: '{"query":{}}',
    headers: { Cookie: 'synthetic-cookie-value', Authorization: 'synthetic-authorization' },
    redirect: 'follow',
  });
  assert.equal(requests[1].url, searchUrl);
  assert.equal(requests[1].options.credentials, 'include');
  assert.equal(requests[1].options.redirect, 'error');
  const headers = new Headers(requests[1].options.headers);
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('authorization'), null);

  transport.openSocket('wss://www.pathofexile.com/api/trade/live/Covens/testQuery');
  assert.equal(sockets[0].options.session, profile);
  assert.equal(sockets[0].options.useSessionCookies, true);
  assert.equal(sockets[0].options.origin, poe);

  await transport.clear();
  assert.equal(await transport.getStatus(), 'disconnected');
  assert.equal(await statuses.at(-1), 'disconnected');
});

test('unlisted targets and methods cannot use the PoE session', async () => {
  const { transport, requests, sockets } = fixture();
  await assert.rejects(() => transport.fetch('https://example.invalid/api/trade/search/Covens'));
  await assert.rejects(() => transport.fetch(`${poe}/api/trade/search/Covens`, { method: 'DELETE' }));
  await assert.rejects(() => transport.fetch(`${poe}/api/trade/search/Covens%2flogout`, { method: 'POST' }));
  await assert.rejects(() => transport.fetch(`${poe}/api/trade/whisper`, { method: 'POST' }));
  assert.throws(() => transport.openSocket(`wss://www.pathofexile.com/api/trade/search/Covens/testQuery`));
  assert.throws(() => transport.openSocket(`wss://www.pathofexile.com/api/trade/live/Covens/testQuery?redirect=https://example.invalid`));
  assert.equal(requests.length, 0);
  assert.equal(sockets.length, 0);
});

test('sign-out closes identity provider windows before clearing the profile', async () => {
  const { transport, windows, profile, BrowserWindow } = fixture();
  transport.openLogin();
  const popup = new BrowserWindow({});
  windows[0].webContents.emit('did-create-window', popup);
  profile.clearData = async () => {
    assert.equal(windows[0].isDestroyed(), true);
    assert.equal(popup.isDestroyed(), true);
  };
  await transport.clear();
});
