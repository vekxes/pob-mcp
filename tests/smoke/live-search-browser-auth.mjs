import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scope = { game: 'poe1', realm: 'pc', league: 'Covens' };
const queryId = 'w'.repeat(147);

class FixtureSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  sendFrame(frame) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

class BrowserFixture {
  #status = 'disconnected';
  #listeners = new Set();
  loginRequests = 0;
  sockets = [];

  async fetch(input, options) {
    const url = new URL(input);
    assert.equal(url.origin, 'https://www.pathofexile.com');
    assert.equal(new Headers(options.headers).has('cookie'), false, 'The daemon must leave cookies in the browser transport.');
    if (this.#status !== 'connected') return Response.json({ error: { message: 'Login required' } }, { status: 403 });
    if (url.pathname === '/api/trade/search/Covens') {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).query.type, 'Gold Ring');
      return Response.json({ id: queryId, result: ['existing-ring'], total: 1 });
    }
    if (url.pathname === '/api/trade/fetch/new-ring') {
      assert.equal(options.method, 'GET');
      assert.equal(url.searchParams.get('query'), queryId);
      return Response.json({ result: [{
        id: 'new-ring',
        item: { name: 'Fixture Ring', typeLine: 'Gold Ring', explicitMods: ['+73 to maximum Life'] },
        listing: { indexed: '2026-11-18T12:00:00Z', price: { amount: 2, currency: 'divine' } },
      }] });
    }
    throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  }

  openSocket(url) {
    assert.equal(this.#status, 'connected');
    assert.equal(url, `wss://www.pathofexile.com/api/trade/live/Covens/${queryId}`);
    const socket = new FixtureSocket();
    this.sockets.push(socket);
    return socket;
  }

  async getStatus() { return this.#status; }

  openLogin() { this.loginRequests++; }

  completeSignIn() { this.#changeStatus('connected'); }

  async clear() { this.#changeStatus('disconnected'); }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changeStatus(status) {
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }
}

async function eventually(probe, description) {
  const deadline = Date.now() + 8_000;
  do {
    const value = await probe();
    if (value) return value;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(description);
}

test('browser login authorizes a Live Search socket and clearing the session closes it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pob-browser-live-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  Object.assign(process.env, {
    POE_TRADE_PORT: String(port), POE_TRADE_HOME: folder, POE_SESSION_ID: '', POE_ASSISTANT_CODEX: '',
    POE_TRADE_ENABLED: 'true', POE_TRADE_LIVE_ENABLED: 'true',
  });

  const browser = new BrowserFixture();
  const origin = `http://127.0.0.1:${port}`;
  const mcp = new Client({ name: 'browser-live-smoke', version: '1.0.0' });
  let daemon;
  let stream;
  try {
    const { startTradeDaemon } = await import('../../build/trade/daemon.js');
    assert.equal(typeof startTradeDaemon, 'function', 'The daemon must accept the desktop browser session.');
    daemon = await startTradeDaemon({ browserSession: browser });
    const headers = {
      Authorization: `Bearer ${new URL(daemon.url).hash.slice(1)}`,
      'Content-Type': 'application/json',
    };
    const events = await fetch(origin + '/events', { headers, signal: AbortSignal.timeout(20_000) });
    assert.equal(events.status, 200);
    stream = events.body.getReader();
    assert.match(await stream.read().then(({ value }) => Buffer.from(value).toString()), /"kind":"ready"/);
    const appHeaders = { ...headers, Origin: origin, 'X-PoE-Trade-Window': events.headers.get('X-PoE-Trade-Window') };

    const read = async (path, options) => {
      const response = await fetch(origin + path, { headers, ...options, signal: AbortSignal.timeout(8_000) });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result.data;
    };
    const call = (name, args = {}) => read('/api', {
      method: 'POST', headers: appHeaders, body: JSON.stringify({ name, args }),
    });
    const session = () => read('/trade-session');
    const sessionAction = action => read('/trade-session', {
      method: 'POST', headers: appHeaders, body: JSON.stringify({ action }),
    });

    assert.equal((await session()).directLive, false);
    const saved = await call('trade_watch_save', { scope, base: 'Gold Ring', label: 'Ring fixture' });
    const resume = () => call('trade_watch_resume', { watchId: saved.id });
    const watch = async () => (await call('trade_watch_list')).watches.find(item => item.id === saved.id);
    assert.equal(saved.status, 'paused');
    assert.equal((await resume()).status, 'unavailable', 'An anonymous watch must not open a socket.');
    assert.equal(browser.sockets.length, 0);

    await sessionAction('login');
    assert.equal(browser.loginRequests, 1);
    assert.equal((await session()).connected, false, 'Opening the official browser must not imply a completed login.');
    browser.completeSignIn();
    assert.equal((await session()).directLive, true);
    assert.equal((await resume()).status, 'connecting');
    const rejected = await eventually(() => browser.sockets[0], 'First authenticated socket was not opened.');
    rejected.open();
    assert.equal((await watch()).status, 'connecting', 'Transport open alone does not prove GGG accepted the session.');
    rejected.sendFrame({ auth: false });
    await eventually(async () => (await watch()).status === 'disconnected', 'Rejected authentication did not disconnect the watch.');
    assert.equal(rejected.readyState, WebSocket.CLOSED);
    assert.deepEqual((await call('trade_watch_events')).events, []);

    assert.equal((await resume()).status, 'connecting');
    const socket = await eventually(() => browser.sockets[1], 'Second socket was not opened.');
    socket.open();
    socket.sendFrame({ auth: true });
    await eventually(async () => (await watch()).status === 'active', 'The GGG authentication frame did not activate the watch.');
    socket.sendFrame({ new: ['existing-ring', 'new-ring', 'new-ring'] });
    socket.sendFrame({ new: ['new-ring'] });
    let notification = '';
    while (!notification.includes('{"kind":"event"}')) {
      const next = await stream.read();
      assert.equal(next.done, false);
      notification += Buffer.from(next.value).toString();
    }

    await mcp.connect(new StdioClientTransport({
      command: process.execPath, args: [fileURLToPath(new URL('../../build/trade/mcp.js', import.meta.url))],
      env: process.env, stderr: 'inherit',
    }));
    const journal = await call('trade_watch_events');
    assert.deepEqual((await mcp.callTool({ name: 'trade_watch_events' })).structuredContent, journal);
    assert.deepEqual(journal.events.map(({ kind, listingId, price }) => ({ kind, listingId, price })), [
      { kind: 'listing', listingId: 'new-ring', price: { amount: 2, currency: 'divine' } },
    ]);

    assert.equal((await sessionAction('logout')).directLive, false);
    assert.equal((await watch()).status, 'disconnected');
    assert.equal(socket.readyState, WebSocket.CLOSED);
    socket.sendFrame({ new: ['after-sign-out'] });
    assert.deepEqual(await call('trade_watch_events'), journal);
  } finally {
    await mcp.close();
    await stream?.cancel().catch(() => {});
    await daemon?.close();
    await rm(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
