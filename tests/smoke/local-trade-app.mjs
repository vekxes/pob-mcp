import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const folder = await mkdtemp(join(tmpdir(), 'pob-trade-app-'));
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const { port } = reservation.address();
await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()));
const origin = `http://127.0.0.1:${port}`;
const liveFixture = process.argv.includes('--live-fixture');
const env = {
  ...process.env, POE_TRADE_HOME: folder, POE_TRADE_PORT: String(port), POE_TRADE_ENABLED: 'false',
  POE_ASSISTANT_CODEX: '', POE_SESSION_ID: '',
  POB_DIRECTORY: resolve('tests/fixtures'),
  ...(liveFixture ? { POE_TRADE_ENABLED: 'true', POE_TRADE_LIVE_ENABLED: 'true', POE_SESSION_ID: 'offline_fixture' } : {}),
};
const fixtureBootstrap = `
  const localFetch = globalThis.fetch;
  const queryId = 'a'.repeat(147);
  let deferredLookups = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === '127.0.0.1') return localFetch(input, options);
    if (url.origin !== 'https://www.pathofexile.com') throw new Error('Unexpected fixture request');
    if (url.pathname.endsWith('/data/leagues')) return Response.json({ result: [
      { id: 'Covens', text: 'Ковены', realm: 'pc' }, { id: 'Standard', text: 'Standard', realm: 'pc' },
      { id: 'Console Covens', text: 'Console Covens', realm: 'xbox' },
    ] });
    if (url.pathname.endsWith('/short-id') && options.method === 'GET') return Response.json({
      query: { type: 'Gold Ring', filters: { misc_filters: { filters: { ilvl: { min: 85 } } } } },
      sort: { price: 'desc' },
    });
    if (url.pathname.endsWith('/expired-id') && options.method === 'GET') return new Response(null, { status: 404 });
    if (url.pathname.endsWith('/deferred-id') && options.method === 'GET') {
      if (deferredLookups++ === 0) return new Response(null, { status: 403 });
      return Response.json({ query: { type: 'Gold Ring' } });
    }
    if (url.pathname.includes('/search/')) return Response.json({ id: queryId, result: ['initial'], total: 1 });
    if (url.pathname.includes('/fetch/')) {
      const ids = url.pathname.split('/').at(-1).split(',');
      return Response.json({ result: ids.map(id => ({
        id, item: { name: 'Tabula Rasa', typeLine: 'Simple Robe', explicitMods: ['Fixture modifier'] },
        listing: { indexed: '2026-11-18T12:00:00Z', price: {
          amount: 3, currency: 'chaos',
        } },
      })) });
    }
    throw new Error('Unexpected fixture path');
  };
  globalThis.WebSocket = class FixtureSocket extends EventTarget {
    static CLOSING = 2;
    readyState = 1;
    constructor(address, options) {
      super();
      if (options.headers.Cookie !== 'POESESSID=offline_fixture' || !address.endsWith('/' + queryId)) {
        throw new Error('Fixture socket is missing its search ID or session');
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: '{"auth":true}' })));
      this.timer = setTimeout(() => {
        const event = () => new MessageEvent('message', { data: '{"new":["initial","new-item","new-item"]}' });
        this.dispatchEvent(event());
        this.dispatchEvent(event());
      }, 150);
    }
    close() {
      clearTimeout(this.timer);
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  };
  const { startTradeDaemon } = await import('./build/trade/daemon.js');
  await startTradeDaemon({ onStopped: () => process.exit(0) });
`;
const daemonArgs = liveFixture ? ['--input-type=module', '-e', fixtureBootstrap] : [resolve('build/trade/daemon.js')];
const daemon = spawn(process.execPath, daemonArgs, { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
const exited = once(daemon, 'exit');
const mcp = new Client({ name: 'trade-integration-smoke', version: '1.0.0' });
let headers;
const scope = { game: 'poe1', realm: 'pc', league: 'Standard' };
try {
  for (let attempt = 0; attempt < 40 && !headers; attempt++) {
    try {
      const data = JSON.parse(await readFile(join(folder, 'connection.json'), 'utf8'));
      headers = { Authorization: `Bearer ${data.token}`, 'Content-Type': 'application/json' };
    } catch {
      await delay(100);
    }
  }
  assert.ok(headers, 'The service must publish its authenticated connection.');
  const html = await (await fetch(origin)).text();
  assert.match(html, /Trade for these items/);
  assert.doesNotMatch(html, /data-page="search"/);
  assert.doesNotMatch(html, /data-page="assistant"/);
  assert.match(html, /id="assistant-toggle"[^>]*disabled/);
  assert.match(html, /<aside id="assistant"[^>]*hidden/);
  assert.match(html, /data-page="settings"/);
  const settingsSection = html.slice(html.indexOf('<section id="settings"'));
  for (const id of ['codex-path-form', 'trade-session-panel', 'league-link-form', 'refresh-leagues']) {
    assert.match(settingsSection, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="watch-import-form"/);
  assert.match(html, /id="trade-session-connect"/);
  assert.doesNotMatch(html, /POESESSID|trade-session-value/);
  assert.match(html, /rel="icon" href="\/icon\.ico"/);
  assert.match(html, /<select id="league"/);
  assert.match(html, /<select id="slot-picker"/);
  assert.match(html, /Создать поиск по выбранному слоту/);
  assert.doesNotMatch(html, /id="slot-toggle"|id="slot-selection-status"|Создать поиски по слотам/);
  assert.match(html, /id="slot-details"/);
  assert.doesNotMatch(html, /id="league-manual"/, 'League choice must use the official dropdown even when loading fails.');
  const appIcon = await fetch(origin + '/icon.ico');
  assert.equal(appIcon.headers.get('content-type'), 'image/x-icon');
  assert.deepEqual(Buffer.from(await appIcon.arrayBuffer()), await readFile('apps/trade-desktop/poe-trade.ico'));
  const unauthenticated = await fetch(origin + '/health');
  assert.equal(unauthenticated.status, 401);
  const currencyCatalog = origin + '/trade-currencies?game=';
  assert.equal((await fetch(currencyCatalog + 'poe1')).status, 401);
  assert.equal((await fetch(currencyCatalog + 'invalid', { headers })).status, 400);
  for (const [game, equivalent, pair, currency] of [
    ['poe1', 'Chaos Orb Equivalent', 'chaos_divine', 'chrome'],
    ['poe2', 'Exalted Orb Equivalent', 'exalted_divine', 'annul'],
  ]) {
    const response = await fetch(currencyCatalog + game, { headers });
    assert.equal(response.status, 200);
    const { options } = (await response.json()).data;
    assert.deepEqual(options[0], { id: null, label: equivalent });
    assert.equal(options[1].id, pair);
    assert.deepEqual(options.find(option => option.id === 'divine'), { id: 'divine', label: 'Divine Orb' });
    assert.ok(options.some(option => option.id === currency));
    assert.ok(!options.some(option => option.id === (game === 'poe1' ? 'annul' : 'chrome')));
  }
  const assistantStatus = await fetch(origin + '/assistant/status', { headers });
  assert.equal(assistantStatus.status, 200);
  assert.deepEqual((await assistantStatus.json()).data, { configured: false, ready: false, state: 'setup_required' });
  const assistantGateway = await fetch(origin + '/assistant/gateway', {
    method: 'POST', headers, body: JSON.stringify({ namespace: 'trade', name: 'list_watches', args: {} }),
  });
  assert.equal(assistantGateway.status, 401, 'The normal app credential must not authorize the assistant gateway.');
  const foreignOrigin = await fetch(origin + '/health', { headers: { ...headers, Origin: 'https://example.test' } });
  assert.equal(foreignOrigin.status, 403);
  const ui = async (name, args = {}, extraHeaders = {}) => {
    const response = await fetch(origin + '/api', {
      method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ name, args }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    return result.data;
  };
  assert.equal((await ui('trade_search', { scope, base: 'Gold Ring' })).status, liveFixture ? 'ok' : 'browser');
  const sessionUrl = origin + '/trade-session';
  const session = () => fetch(sessionUrl, { headers });
  const changeSession = (input, extraHeaders = {}) => fetch(sessionUrl, {
    method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(input),
  });
  assert.equal((await fetch(sessionUrl)).status, 401);
  const initialSession = await session();
  assert.equal(initialSession.status, 200);
  assert.equal(initialSession.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual((await initialSession.json()).data, {
    connected: liveFixture, directLive: liveFixture, browserAvailable: false,
    status: liveFixture ? 'connected' : 'unavailable',
  });
  assert.equal((await changeSession({ action: 'login' })).status, 403);
  assert.equal((await changeSession({ action: 'login' }, { Origin: origin })).status, 409);
  const stream = liveFixture ? (await fetch(origin + '/events', {
    headers, signal: AbortSignal.timeout(7_000),
  })).body.getReader() : undefined;
  const watch = await ui('trade_watch_start', { scope, name: 'Tabula Rasa' });
  assert.equal(watch.status, liveFixture ? 'connecting' : 'unavailable');
  await mcp.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve('build/trade/mcp.js')], env, stderr: 'inherit',
  }));
  assert.ok((await mcp.listTools()).tools.some(tool => tool.name === 'trade_for_build'));
  const template = await ui('trade_watch_save', { scope, name: 'Tabula Rasa', budget: { currency: 'chaos', max: 4 } });
  assert.equal(template.status, 'paused');
  assert.equal(template.body.query.filters.trade_filters.filters.price.max, 4);
  const list = await mcp.callTool({ name: 'trade_watch_list' });
  assert.deepEqual(list.structuredContent.watches.map(item => item.id), [template.id, watch.id]);
  const encoded = encodeURIComponent(JSON.stringify({ query: { name: 'Tabula Rasa' }, sort: { price: 'desc' } }));
  const inline = await ui('trade_watch_import', { url: `https://ru.pathofexile.com/trade/search/Standard?q=${encoded}`, label: 'Copied search' });
  assert.equal(inline.status, 'paused');
  assert.equal(inline.label, 'Copied search');
  assert.equal(inline.body.sort.price, 'desc');
  assert.equal(inline.body.query.name, 'Tabula Rasa');
  assert.equal(new URL(inline.searchUrl).hostname, 'www.pathofexile.com');
  const fromUrl = await ui('trade_scope_from_url', { url: 'https://ru.pathofexile.com/trade/search/sony/Hardcore%20Covens' });
  assert.deepEqual(fromUrl.scope, { game: 'poe1', realm: 'sony', league: 'Hardcore Covens' });
  if (liveFixture) {
    const copied = await ui('trade_watch_import', { url: 'https://www.pathofexile.com/trade2/search/poe2/Standard/short-id/live' });
    assert.deepEqual(copied.scope, { game: 'poe2', realm: 'poe2', league: 'Standard' });
    assert.equal(copied.body.query.filters.misc_filters.filters.ilvl.min, 85);
    assert.equal(copied.body.sort.price, 'desc');
    assert.equal(copied.status, 'paused');
    const reference = await ui('trade_watch_import', { url: 'https://www.pathofexile.com/trade/search/Standard/expired-id' });
    assert.equal(reference.status, 'paused');
    assert.equal(reference.body, undefined);
    assert.match(reference.searchUrl, /expired-id$/);
    const fromSite = await mcp.callTool({ name: 'trade_list_leagues', arguments: { game: 'poe1', realm: 'pc' } });
    assert.deepEqual(fromSite.structuredContent.leagues, [{ id: 'Covens', label: 'Ковены' }, { id: 'Standard', label: 'Standard' }]);
    assert.deepEqual((await ui('trade_list_leagues', { game: 'poe1', realm: 'xbox' })).leagues, [
      { id: 'Console Covens', label: 'Console Covens' },
    ]);
  }
  if (stream) {
    try {
      let contents = '';
      while (!contents.includes('{"kind":"event"}')) {
        const message = await stream.read();
        assert.equal(message.done, false);
        contents += Buffer.from(message.value).toString();
      }
      const uiJournal = await ui('trade_watch_events');
      const mcpJournal = (await mcp.callTool({ name: 'trade_watch_events' })).structuredContent;
      assert.deepEqual(uiJournal, mcpJournal);
      assert.equal(uiJournal.events.length, 1);
      assert.equal(uiJournal.events[0].listingId, 'new-item');
      assert.equal(uiJournal.events[0].price.amount, 3);
      console.log('Fixture Live Search authentication, SSE and MCP delivery passed.');
    } finally {
      await stream.cancel();
    }
    const windowStream = await fetch(origin + '/events', { headers });
    const windowId = windowStream.headers.get('X-PoE-Trade-Window');
    assert.ok(windowId);
    const activation = await ui('trade_watch_resume', { watchId: template.id }, { 'X-PoE-Trade-Window': windowId });
    assert.equal(activation.status, 'connecting');
    await windowStream.body.cancel();
    let persisted;
    for (let attempt = 0; attempt < 40; attempt++) {
      persisted = (await ui('trade_watch_list')).watches.find(item => item.id === template.id);
      if (persisted.status === 'paused') break;
      await delay(25);
    }
    assert.deepEqual(persisted, template, 'Closing the owning window must pause the original saved query.');
    const other = (await ui('trade_watch_list')).watches.find(item => item.id === watch.id);
    assert.equal(other.status, 'active', 'Closing the window must leave unrelated watches alone.');
    const deferred = await ui('trade_watch_import', { url: 'https://www.pathofexile.com/trade/search/Standard/deferred-id' });
    assert.equal(deferred.body, undefined);
    const retryStream = await fetch(origin + '/events', { headers });
    try {
      await ui('trade_watch_resume', { watchId: deferred.id }, { 'X-PoE-Trade-Window': retryStream.headers.get('X-PoE-Trade-Window') });
      let refreshed;
      for (let attempt = 0; attempt < 150; attempt++) {
        refreshed = (await ui('trade_watch_list')).watches.find(item => item.id === deferred.id);
        if (refreshed.status === 'active') break;
        await delay(30);
      }
      assert.equal(refreshed.status, 'active');
      assert.equal(refreshed.body.query.type, 'Gold Ring');
    } finally {
      await retryStream.body.cancel();
    }
    const authStream = await fetch(origin + '/events', { headers });
    try {
      const authHeaders = { Origin: origin, 'X-PoE-Trade-Window': authStream.headers.get('X-PoE-Trade-Window') };
      assert.equal((await changeSession({ action: 'login' }, { ...authHeaders, Origin: 'https://example.test' })).status, 403);
      assert.equal((await changeSession({ action: 'connect', sessionId: 'x'.repeat(1024) }, authHeaders)).status, 413);
      const rejected = await changeSession({ action: 'connect', sessionId: 'fixture;other=invalid' }, authHeaders);
      assert.equal(rejected.status, 400);
      assert.doesNotMatch(await rejected.text(), /fixture;other=invalid/);
      assert.equal((await changeSession({ action: 'login' }, authHeaders)).status, 503);
      assert.equal((await changeSession({ action: 'logout' }, authHeaders)).status, 503);
      assert.equal((await ui('trade_watch_list')).watches.find(item => item.id === watch.id).status, 'active');
    } finally {
      await authStream.body.cancel();
    }
    console.log('Protected browser sign-in routes reject manual sessions and headless control.');
  }
  if (!liveFixture && process.env.POB_PATH && process.env.POB_CMD) {
    const build = await ui('trade_import_build', { kind: 'file', value: 'occ-vortex.xml' });
    const input = { buildId: build.buildId, revision: build.revision, scope, budget: { max: 2, currency: 'divine' } };
    const match = await ui('trade_for_build', { ...input, mode: 'match', slots: ['Ring 1', 'Ring 2'] });
    assert.deepEqual(match.rows.map(row => row.slot), ['Ring 1', 'Ring 2']);
    assert.ok(match.rows.every(row => row.link), JSON.stringify(match.rows));
    const weighted = await ui('trade_for_build', { ...input, mode: 'upgrade', slots: ['Amulet'] });
    const body = weighted.rows[0].body;
    assert.ok(body, JSON.stringify(weighted.rows));
    assert.ok(body.query.stats.some(group => group.type === 'weight'));
    assert.equal(body.query.filters.trade_filters.filters.price.max, 2);
    console.log('Real PoB MCP build import, ring searches and weighted amulet passed.');
  }
  await fetch(origin + '/stop', { method: 'POST', headers });
  assert.equal((await exited)[0], 0);
  console.log('Authenticated desktop service and shared MCP watches passed.');
} finally {
  await mcp.close();
  if (daemon.exitCode === null) {
    daemon.kill();
    await exited;
  }
  // The OS can take a moment to close the SQLite sidecars after termination.
  await rm(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
