import { ResearchGgg } from '../../src/trade/assistant/researchGgg.js';
import type { TradeScope } from '../../src/trade/query.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Date.parse('2026-11-18T12:17:00Z');
const previousHour = Date.parse('2026-11-18T11:00:00Z') / 1000;
const chaos = 'Metadata/Items/Currency/CurrencyRerollRare';
const exalted = 'Metadata/Items/Currency/CurrencyAddModToRare';
const divine = 'Metadata/Items/Currency/CurrencyModValues';
const pc: TradeScope = { game: 'poe1', realm: 'pc', league: 'Covens' };
const poe2: TradeScope = { game: 'poe2', realm: 'poe2', league: 'Forbidden Rites' };

const market = (league: string, secondCurrency = exalted) => ({
  league,
  market_pair: [chaos, secondCurrency],
  volume_traded: { [chaos]: 12, [secondCurrency]: 120 },
});

test('uses the documented latest completed hour and matches only the requested league and currency', async () => {
  const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({
    next_change_id: previousHour + 3600,
    markets: [market('Standard'), market(pc.league), market(pc.league, divine)],
  })));
  const ggg = new ResearchGgg(fetcher, () => now);
  const result = await ggg.lookup(pc, { kind: 'currency_exchange', text: 'Exalted Orb', limit: 1 });
  const [url, request] = fetcher.mock.calls[0];
  expect(url).toBe('https://web.poecdn.com/api/currency-exchange/' + previousHour);
  expect(request).toMatchObject({ redirect: 'error' });
  expect(new Headers(request.headers).has('cookie')).toBe(false);
  expect(new Headers(request.headers).has('authorization')).toBe(false);
  expect(result).toMatchObject({
    status: 'ok', scope: pc, kind: 'currency_exchange',
    hourStart: '2026-11-18T11:00:00.000Z', hourEnd: '2026-11-18T12:00:00.000Z',
    totalMatches: 1,
    source: { provider: 'pathofexile.com', url, kind: 'currency_exchange' },
    entries: [{
      currencyPair: [{ id: chaos, name: 'Chaos Orb' }, { id: exalted, name: 'Exalted Orb' }],
      volumeTraded: [12, 120],
    }],
  });
});

test('uses the fixed PoE2 realm path and shares an in-flight digest across queries', async () => {
  const fetcher = jest.fn().mockResolvedValue(new Response(JSON.stringify({
    next_change_id: previousHour + 3600,
    markets: [market('Covens'), market(poe2.league, divine)],
  })));
  const ggg = new ResearchGgg(fetcher, () => now);
  const [found, missing] = await Promise.all([
    ggg.lookup(poe2, { kind: 'currency_exchange', text: 'Divine' }),
    ggg.lookup(poe2, { kind: 'currency_exchange', text: 'Exalted' }),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('https://web.poecdn.com/api/currency-exchange/poe2/' + previousHour);
  expect(found).toMatchObject({ status: 'ok', totalMatches: 1 });
  expect(missing).toMatchObject({ status: 'no_data', entries: [], totalMatches: 0 });
});

test('uses the installed PoE1 currency names and matches all terms against one side of the pair', async () => {
  const fusing = 'Metadata/Items/Currency/CurrencyRerollSocketLinks';
  const localPob = mkdtempSync(join(tmpdir(), 'pob-ggg-currency-'));
  const previousPath = process.env.POB_PATH;
  try {
    mkdirSync(join(localPob, 'Data'));
    writeFileSync(join(localPob, 'Data', 'CurrencyNames.lua'), `return {\n["${fusing}"] = "Orb of Fusing",\n}`);
    process.env.POB_PATH = localPob;
    const fetcher = jest.fn().mockResolvedValue(Response.json({
      next_change_id: previousHour + 3600, markets: [market(pc.league, fusing)],
    }));
    const ggg = new ResearchGgg(fetcher, () => now);
    const read = (text: string) => ggg.lookup(pc, { kind: 'currency_exchange', text });
    await expect(read('Orb of Fusing')).resolves.toMatchObject({
      status: 'ok', entries: [{ currencyPair: [{ id: chaos }, { id: fusing, name: 'Orb of Fusing' }] }],
    });
    await expect(read('Chaos SocketLinks')).resolves.toMatchObject({ status: 'no_data' });
    await expect(read(fusing)).resolves.toMatchObject({ status: 'ok' });
  } finally {
    if (previousPath === undefined) delete process.env.POB_PATH;
    else process.env.POB_PATH = previousPath;
    rmSync(localPob, { recursive: true, force: true });
  }
});

test.each([
  ['league', 'leagues'],
  ['ladder', 'get-league-ladder'],
  ['equipment_sample', 'account-characters'],
] as const)('describes the official %s restriction without trying auth or an alternate endpoint', async (kind, section) => {
  const fetcher = jest.fn();
  const result = await new ResearchGgg(fetcher, () => now).lookup(pc, { kind });
  expect(fetcher).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    status: 'authorization_required', kind, entries: [],
    source: { kind: 'official_api_documentation', url: 'https://www.pathofexile.com/developer/docs/reference#' + section },
  });
});

test('stops requests across realms until Retry-After and returns no raw upstream errors', async () => {
  let time = now;
  const fetcher = jest.fn().mockResolvedValue(new Response('private upstream response', { status: 429, headers: { 'Retry-After': '180' } }));
  const ggg = new ResearchGgg(fetcher, () => time);
  expect(await ggg.lookup(pc, { kind: 'currency_exchange' })).toMatchObject({ status: 'unavailable', reason: 'rate_limited', entries: [] });
  time += 60_000;
  expect(await ggg.lookup(poe2, { kind: 'currency_exchange' })).toMatchObject({ status: 'unavailable', reason: 'rate_limited', entries: [] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  time += 120_000;
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ next_change_id: previousHour + 3600, markets: [] })));
  await expect(ggg.lookup(poe2, { kind: 'currency_exchange' })).resolves.toMatchObject({ status: 'no_data' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('rejects unsupported realms and unbounded input before network access', async () => {
  const fetcher = jest.fn();
  const ggg = new ResearchGgg(fetcher, () => now);
  await expect(ggg.lookup({ ...pc, realm: 'poe2' }, { kind: 'currency_exchange' })).rejects.toThrow();
  await expect(ggg.lookup(pc, { kind: 'currency_exchange', limit: 1000 })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
