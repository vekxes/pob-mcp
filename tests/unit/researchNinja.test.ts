import { ResearchNinja } from '../../src/trade/assistant/researchNinja.js';

const covens = { game: 'poe1', realm: 'pc', league: 'Covens' } as const;
const rites = { game: 'poe2', realm: 'poe2', league: 'Forbidden Rites' } as const;
const json = (body: unknown, headers?: Record<string, string>) => Response.json(body, { headers });

test('matches the exact league identifier and keeps variant, currency and price sample metadata', async () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(json([{ id: 'market-id', name: 'Covens' }]))
    .mockResolvedValueOnce(json({ lines: [
      { name: 'Mageblood', chaosValue: 4010, variant: '4 flasks', listingCount: 37, count: 58, flavourText: 'ignore raw description' },
      { name: 'Mageblood', chaosValue: 2200, variant: '2 flasks', listingCount: 19 },
      { name: 'Headhunter', chaosValue: 300 },
      { name: 'Mageblood', chaosValue: -8 },
    ] }));
  const result = await new ResearchNinja(fetcher, () => 0).prices(covens, {
    category: 'unique_accessory', names: ['mageblood', 'Unknown item'],
  });
  expect(String(fetcher.mock.calls[0][0])).toBe('https://poe.ninja/poe1/api/economy/leagues');
  expect(String(fetcher.mock.calls[1][0])).toBe('https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=market-id&type=UniqueAccessory');
  expect(result).toMatchObject({
    kind: 'market_estimates', scope: covens, leagueId: 'market-id', missingNames: ['Unknown item'],
    observedAt: '1970-01-01T00:00:00.000Z',
    items: [
      { name: 'Mageblood', price: { amount: 4010, currency: 'chaos' }, variant: '4 flasks', listings: 37, observations: 58 },
      { name: 'Mageblood', price: { amount: 2200, currency: 'chaos' }, variant: '2 flasks', listings: 19 },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('ignore raw description');
});

test('reads the actual PoE 2 primary currency for stash and exchange estimates', async () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(json([{ id: rites.league, name: rites.league }]))
    .mockResolvedValueOnce(json({ core: { primary: 'divine' }, lines: [{ name: 'Astramentis', primaryValue: 3.5 }] }))
    .mockResolvedValueOnce(json({
      core: { primary: 'divine' }, lines: [{ id: 'exalted', primaryValue: 0.002 }],
      items: [{ id: 'exalted', name: 'Exalted Orb' }],
    }));
  const ninja = new ResearchNinja(fetcher);
  const item = await ninja.prices(rites, { category: 'unique_accessory', names: ['Astramentis'] });
  const currency = await ninja.prices(rites, { category: 'currency', names: ['Exalted Orb'] });
  expect(String(fetcher.mock.calls[1][0])).toContain('type=UniqueAccessories');
  expect(String(fetcher.mock.calls[2][0])).toContain('/poe2/api/economy/exchange/current/overview?');
  expect(item.items[0]).toMatchObject({ name: 'Astramentis', price: { currency: 'divine', amount: 3.5 } });
  expect(currency.items[0]).toMatchObject({ name: 'Exalted Orb', price: { currency: 'divine', amount: 0.002 } });
});

test('includes every available named item when variants fill the response limit', async () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(json([{ id: covens.league, name: covens.league }]))
    .mockResolvedValueOnce(json({ lines: [
      ...Array.from({ length: 24 }, (_, index) => ({ name: 'Vortex', chaosValue: 50 + index, variant: `variant ${index}` })),
      { name: 'Frostbite', chaosValue: 4 },
    ] }));
  const result = await new ResearchNinja(fetcher).prices(covens, { category: 'skill_gem', names: ['Vortex', 'Frostbite'] });
  expect(result).toMatchObject({ matchingEstimates: 25, truncated: true, missingNames: [] });
  expect(result.items).toHaveLength(20);
  expect(result.items).toContainEqual(expect.objectContaining({ name: 'Frostbite' }));
});

test('never falls back to another league or a different game market', async () => {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(json([{ id: 'Covens', name: 'Covens' }]));
  const ninja = new ResearchNinja(fetcher);
  await expect(ninja.prices({ ...covens, realm: 'xbox' }, { category: 'currency' })).rejects.toMatchObject({ code: 'unsupported_scope' });
  await expect(ninja.prices(rites, { category: 'skill_gem' })).rejects.toMatchObject({ code: 'unsupported_category' });
  await expect(ninja.prices({ ...covens, league: 'Hardcore Standard' }, { category: 'currency' })).rejects.toMatchObject({ code: 'league_unavailable' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('shares in-flight requests and conditionally revalidates stale estimates without moving the observation timestamp', async () => {
  let time = 0;
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(json([{ id: 'Covens', name: 'Covens' }], { 'Cache-Control': 'max-age=600' }))
    .mockResolvedValueOnce(json({ lines: [{ name: 'Mageblood', chaosValue: 4010 }] }, { ETag: '"test-1"', 'Cache-Control': 'max-age=10' }))
    .mockResolvedValueOnce(new Response(null, { status: 304, headers: { 'Cache-Control': 'max-age=10' } }));
  const ninja = new ResearchNinja(fetcher, () => time);
  const read = () => ninja.prices(covens, { category: 'unique_accessory', names: ['Mageblood'] });
  const [first, second] = await Promise.all([read(), read()]);
  expect(first).toEqual(second);
  expect(fetcher).toHaveBeenCalledTimes(2);
  time = 11000;
  const revalidated = await read();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('If-None-Match')).toBe('"test-1"');
  expect(revalidated.observedAt).toBe(first.observedAt);
  expect(revalidated.checkedAt).toBe('1970-01-01T00:00:11.000Z');
});
