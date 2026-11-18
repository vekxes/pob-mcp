import { gunzipSync } from 'node:zlib';
import { buildTradeQuery, tradeLink, validateTradeBody, withBudget } from '../../src/trade/query.js';
import { TradeProvider } from '../../src/trade/provider.js';
import { LeagueDirectory, scopeFromTradeUrl } from '../../src/trade/leagues.js';
import { tradeSearchFromUrl } from '../../src/trade/tradeUrl.js';
import type { BrowserTradeSession } from '../../src/trade/browserSession.js';

const scope = { game: 'poe1', realm: 'pc', league: 'Hardcore Standard' } as const;

test('trade leagues follow the site order and keep the exact ID for each realm', async () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(Response.json({ result: [
    { id: 'Covens', text: 'Ковены', realm: 'pc' },
    { id: 'Console Covens', text: 'Console', realm: 'xbox' },
    { id: 'Standard', text: 'Standard', realm: 'pc' },
  ] }));
  const directory = new LeagueDirectory(fetcher);
  const pc = await directory.list({ game: 'poe1', realm: 'pc' });
  expect(pc.leagues).toEqual([{ id: 'Covens', label: 'Ковены' }, { id: 'Standard', label: 'Standard' }]);
  const xbox = await directory.list({ game: 'poe1', realm: 'xbox' });
  expect(xbox.leagues.map(league => league.id)).toEqual(['Console Covens']);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('an unavailable league refresh preserves the last verified choices and marks them stale', async () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(Response.json({ result: [{ id: 'Forbidden Rites', realm: 'poe2' }] }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  const directory = new LeagueDirectory(fetcher);
  const scope = { game: 'poe2', realm: 'poe2' } as const;
  expect(await directory.list(scope)).toEqual({ leagues: [{ id: 'Forbidden Rites', label: 'Forbidden Rites' }], stale: false });
  expect(await directory.list(scope, true)).toEqual({ leagues: [{ id: 'Forbidden Rites', label: 'Forbidden Rites' }], stale: true });
});

test('a PoE Trade link supplies the game, platform and exact league', () => {
  expect(scopeFromTradeUrl('https://ru.pathofexile.com/trade2/search/poe2/HC%20Forbidden%20Rites/abc')).toEqual({
    game: 'poe2', realm: 'poe2', league: 'HC Forbidden Rites',
  });
  expect(scopeFromTradeUrl('https://www.pathofexile.com/trade/search/xbox/Hardcore%20Covens')).toEqual({
    game: 'poe1', realm: 'xbox', league: 'Hardcore Covens',
  });
  expect(() => scopeFromTradeUrl('https://pathofexile.com.example.test/trade/search/Standard')).toThrow(/trade/i);
});

test('encodes the trade site query and keeps named stat and price filters', () => {
  const body = buildTradeQuery({
    scope, base: 'Gold Ring', mods: [{ id: 'explicit.stat_3299347043', min: 65 }],
    budget: { currency: 'divine', max: 3 },
  });
  const url = new URL(tradeLink(scope, body));
  expect(url.pathname).toMatch(/^\/trade\/search\/Hardcore%20Standard\//);
  const decoded = JSON.parse(gunzipSync(Buffer.from(url.pathname.split('/').at(-1)!, 'base64url')).toString());
  expect(decoded).toMatchObject({
    type: 'Gold Ring',
    stats: [{ type: 'and', filters: [{ id: 'explicit.stat_3299347043', value: { min: 65 } }] }],
    filters: { trade_filters: { filters: { price: { max: 3, option: 'divine' } } } },
  });
});

test('PoE 2 browser links carry the PoE 2 realm', () => {
  const poe2 = { game: 'poe2', realm: 'poe2', league: 'Standard' } as const;
  const url = tradeLink(poe2, buildTradeQuery({ scope: poe2, base: 'Gold Ring' }));
  expect(url).toMatch(/^https:\/\/www\.pathofexile\.com\/trade2\/search\/poe2\/Standard\//);
});

test('imports a compressed PoE Trade link with live suffix without an upstream lookup', () => {
  const input = { game: 'poe2', realm: 'poe2', league: 'HC Forbidden Rites' } as const;
  const body = buildTradeQuery({ scope: input, base: 'Gold Ring', budget: { currency: 'exalted', max: 3 } });
  const searchUrl = tradeLink(input, body);
  expect(tradeSearchFromUrl(searchUrl + '/live')).toEqual({ scope: input, searchUrl, body });
  expect(() => tradeSearchFromUrl('https://pathofexile.com.example.test/trade/search/Standard/test')).toThrow(/trade/i);
  expect(() => tradeSearchFromUrl('https://www.pathofexile.com/trade/search/Standard')).toThrow(/сначала/i);
});

test('trade links accept long opaque search IDs returned by the site', () => {
  const id = 'a'.repeat(147);
  const body = buildTradeQuery({ scope, name: 'Tabula Rasa' });
  expect(tradeLink(scope, body, id)).toBe(`https://www.pathofexile.com/trade/search/Hardcore%20Standard/${id}`);
  expect(() => tradeLink(scope, body, 'unsafe/id')).toThrow(/search ID/);
});

test('a slot budget leaves the weighted group and sort intact', () => {
  const query = {
    query: { status: { option: 'available' as const }, stats: [{ type: 'weight' as const, filters: [] }] },
    sort: { 'statgroup.0': 'desc' }, engine: 'new',
  };
  expect(withBudget(query, { currency: 'divine', max: 2 })).toMatchObject({
    query: { stats: query.query.stats, filters: { trade_filters: { filters: { price: { max: 2 } } } } },
    sort: query.sort, engine: 'new',
  });
  expect(query.query).not.toHaveProperty('filters');
});

test('uses the official equivalent and combined buyout currency filters', () => {
  const equivalent = buildTradeQuery({ scope, base: 'Gold Ring', budget: { min: 10, max: 40 } });
  expect(equivalent.query.filters?.trade_filters?.filters?.price).toStrictEqual({ min: 10, max: 40 });
  const combined = buildTradeQuery({ scope, base: 'Gold Ring', budget: { currency: 'chaos_divine' } });
  expect(combined.query.filters?.trade_filters?.filters?.price).toStrictEqual({ option: 'chaos_divine' });
  expect(() => validateTradeBody(combined)).not.toThrow();
});

test('the desktop can search anonymously and needs a verified session for Live Search', () => {
  const variables = ['POE_TRADE_ENABLED', 'POE_TRADE_LIVE_ENABLED'] as const;
  const previous = variables.map(key => process.env[key]);
  const browser: BrowserTradeSession = {
    fetch, openSocket: url => new WebSocket(url), getStatus: async () => 'disconnected',
    openLogin() {}, async clear() {}, onChange: () => () => {},
  };
  try {
    for (const key of variables) delete process.env[key];
    expect(new TradeProvider().directSearch).toBe(false);
    const service = new TradeProvider(browser);
    expect(service.directSearch).toBe(true);
    expect(service.directLive).toBe(false);
    service.updateBrowserSession('connected');
    expect(service.directLive).toBe(true);
    service.updateBrowserSession('disconnected');
    expect(service.directSearch).toBe(true);
    expect(service.directLive).toBe(false);

    process.env.POE_TRADE_ENABLED = 'false';
    const disabled = new TradeProvider(browser);
    disabled.updateBrowserSession('connected');
    expect(disabled.directSearch).toBe(false);
    expect(disabled.directLive).toBe(false);
  } finally {
    variables.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('keeps the original search link when PoE Trade asks for fewer filters or a session', async () => {
  const fetcher = jest.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({
    error: { code: 2, message: 'Query is too complex. Please reduce the amount of filters used.\nLogging in will increase this limit.' },
  }, { status: 400 }));
  const previous = process.env.POE_TRADE_ENABLED;
  process.env.POE_TRADE_ENABLED = 'true';
  try {
    const query = buildTradeQuery({ scope, base: 'Gold Ring' });
    expect(await new TradeProvider().search(scope, query)).toMatchObject({
      status: 'unavailable', warningCode: 'complex_query', searchUrl: tradeLink(scope, query), listings: [],
    });
  } finally {
    if (previous === undefined) delete process.env.POE_TRADE_ENABLED;
    else process.env.POE_TRADE_ENABLED = previous;
    fetcher.mockRestore();
  }
});

test('requires an item or a bounded stat search and rejects reversed ranges', () => {
  expect(() => buildTradeQuery({ scope })).toThrow();
  expect(() => buildTradeQuery({
    scope, base: 'Gold Ring', mods: [{ id: 'explicit.stat_1', min: 40, max: 5 }],
  })).toThrow();
  expect(() => buildTradeQuery({
    scope, base: 'Gold Ring', budget: {},
  })).toThrow(/currency/i);
});

test('direct search projects advertised item details and keeps watch summaries free of contact data', async () => {
  const listedAt = '2026-11-18T10:30:00Z';
  const fetcher = jest.spyOn(global, 'fetch')
    .mockRejectedValue(new Error('Unexpected test fetch'))
    .mockResolvedValueOnce(Response.json({ id: 'listing-search', result: ['one'], total: 157, inexact: true }))
    .mockResolvedValueOnce(Response.json({ result: [{
      id: 'one',
      item: {
        name: 'Ash Band', typeLine: 'Gilded Gold Ring', baseType: 'Gold Ring', ilvl: 84,
        rarity: 'Rare', corrupted: true, identified: false, note: 'private-fixture-note',
        properties: [
          { name: 'Quality', type: 6, values: [['+20%', 1]], displayMode: 0 },
          { name: 'Armour', values: [['125', 0]], displayMode: 0 },
          { name: 'Grants Level %0 Skill', values: [['18', 0]], displayMode: 3 },
        ],
        implicitMods: ['+12% to Fire Resistance'],
        explicitMods: [
          '+70 to maximum Life',
          { description: '+33 to Dexterity', flags: { fractured: true }, hash: 'private-fixture-hash' },
          { description: 'Adds 10 to 15 [ColdDamage|Cold Damage]', domain: 'desecrated' },
          { description: '+11% to Cold Resistance', flags: { crafted: true } },
          { hash: 'private-fixture-malformed-mod' },
        ],
        enchantMods: ['Anointed enchantment'], runeMods: ['Socketed rune'],
        craftedMods: ['+11% to Cold Resistance'], fracturedMods: ['+33 to Dexterity'],
        bondedMods: ['A bonded modifier'], scourgeMods: ['A scourge modifier'],
        crucibleMods: ['A Crucible modifier'], utilityMods: ['A utility modifier'],
      },
      listing: {
        indexed: listedAt, price: { amount: 2.5, currency: 'divine', type: '~price' },
        account: { name: 'Seller#1234', lastCharacterName: 'private-fixture-character', online: { status: 'afk' } },
        stash: { name: 'private-fixture-stash', x: 3, y: 2 },
        whisper: 'private-fixture-whisper', whisper_token: 'private-fixture-whisper-token',
      },
    }] }));
  const originalEnv = process.env;
  process.env = { ...originalEnv, POE_TRADE_ENABLED: 'true', POE_SESSION_ID: '' };
  try {
    const provider = new TradeProvider();
    const result = await provider.search(scope, buildTradeQuery({ scope, base: 'Gold Ring' }));
    expect(result).toMatchObject({ status: 'ok', total: 157, inexact: true });
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      id: 'one', name: 'Ash Band', base: 'Gold Ring', typeLine: 'Gilded Gold Ring', itemLevel: 84,
      quality: '+20%', rarity: 'rare', flags: expect.arrayContaining(['corrupted', 'unidentified', 'fractured', 'desecrated']),
      indexed: listedAt, price: { amount: 2.5, currency: 'divine' }, seller: { name: 'Seller#1234', status: 'afk' },
      properties: [
        { name: 'Quality', values: ['+20%'] },
        { name: 'Armour', values: ['125'] },
        { name: 'Grants Level 18 Skill', values: [] },
      ],
      modGroups: expect.arrayContaining([
        { type: 'implicit', lines: ['+12% to Fire Resistance'] },
        { type: 'explicit', lines: ['+70 to maximum Life'] },
        { type: 'fractured', lines: ['+33 to Dexterity'] },
        { type: 'desecrated', lines: ['Adds 10 to 15 Cold Damage'] },
        { type: 'crafted', lines: ['+11% to Cold Resistance'] },
        { type: 'enchant', lines: ['Anointed enchantment'] },
        { type: 'rune', lines: ['Socketed rune'] },
        { type: 'bonded', lines: ['A bonded modifier'] },
        { type: 'scourge', lines: ['A scourge modifier'] },
        { type: 'crucible', lines: ['A Crucible modifier'] },
        { type: 'utility', lines: ['A utility modifier'] },
      ]),
    });
    expect(JSON.stringify(result)).not.toMatch(/private-fixture|\[object Object\]/);

    const [match] = await provider.fetch(scope, 'listing-search', ['one']);
    expect(match).toMatchObject({ name: 'Ash Band', indexed: listedAt, mods: expect.arrayContaining(['+33 to Dexterity']) });
    expect(match).not.toHaveProperty('seller');
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    process.env = originalEnv;
    fetcher.mockRestore();
  }
});

test('direct search preserves search order when listings trade away and supports incomplete fetch entries', async () => {
  const poe2 = { game: 'poe2', realm: 'poe2', league: 'Standard' } as const;
  const fetcher = jest.spyOn(global, 'fetch')
    .mockRejectedValue(new Error('Unexpected test fetch'))
    .mockResolvedValueOnce(Response.json({ id: 'listing-search', result: ['gone', 'magic', 'normal'], total: 3 }))
    .mockResolvedValueOnce(Response.json({ result: [
      null,
      { id: 'normal', item: { baseType: 'Gold Ring' }, listing: {} },
      { id: 'unexpected', item: { baseType: 'Not Requested' }, listing: {} },
      { id: 'magic', item: { name: '', typeLine: 'Gilded Gold Ring', baseType: 'Gold Ring', frameType: 1 }, listing: {
        price: { amount: 'unknown', currency: 'divine' }, indexed: 'unknown', account: { name: 'Seller#1234' },
      } },
    ] }));
  const originalEnv = process.env;
  process.env = { ...originalEnv, POE_TRADE_ENABLED: 'true', POE_SESSION_ID: '' };
  try {
    const result = await new TradeProvider().search(poe2, buildTradeQuery({ scope: poe2, base: 'Gold Ring' }));
    expect(result).toMatchObject({ status: 'ok', total: 3 });
    expect(result.listings).toHaveLength(2);
    expect(result.listings[0]).toMatchObject({
      id: 'magic', name: 'Gilded Gold Ring', base: 'Gold Ring', rarity: 'magic',
      seller: { name: 'Seller#1234', status: 'offline' }, price: undefined, indexed: undefined,
    });
    expect(result.listings[1]).toMatchObject({ id: 'normal', name: 'Gold Ring', seller: undefined });
  } finally {
    process.env = originalEnv;
    fetcher.mockRestore();
  }
});

test('a WebSocket upgrade with a rejected session does not activate Live Search', async () => {
  class TradeSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        this.dispatchEvent(new Event('open'));
        this.dispatchEvent(new MessageEvent('message', { data: '{"auth":false}' }));
      });
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const originalSocket = global.WebSocket;
  const originalEnv = process.env;
  global.WebSocket = TradeSocket as unknown as typeof WebSocket;
  process.env = { ...originalEnv, POE_TRADE_ENABLED: 'true', POE_TRADE_LIVE_ENABLED: 'true', POE_SESSION_ID: 'fixture-session' };
  const search = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    id: 'query-id', result: [], total: 0,
  })));
  try {
    const provider = new TradeProvider();
    const socket = await provider.subscribe(scope, buildTradeQuery({ scope, base: 'Gold Ring' }), {
      matches: async () => {}, disconnected: () => {},
    }, new AbortController().signal);
    await expect(socket.ready).rejects.toThrow(/session|auth/i);
  } finally {
    search.mockRestore();
    global.WebSocket = originalSocket;
    process.env = originalEnv;
  }
});
