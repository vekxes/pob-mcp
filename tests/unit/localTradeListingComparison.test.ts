import { TradeProvider } from '../../src/trade/provider.js';
import { buildTradeQuery } from '../../src/trade/query.js';
import type { TradeScope } from '../../src/trade/query.js';

const scope = { game: 'poe1', realm: 'pc', league: 'Standard' } as const;
const clipboard = [
  'Item Class: Rings', 'Rarity: Rare', 'Ash Band', 'Gold Ring', '--------',
  'Item Level: 86', '--------', '20% increased Rarity of Items found (implicit)', '--------',
  '+81 to maximum Life', '+13% to Chaos Resistance (crafted)', '--------', 'Corrupted',
].join('\n');
const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');

async function offers(tradeScope: TradeScope, items: { text?: unknown; identified?: boolean }[]) {
  const ids = items.map((_, index) => `offer-${index}`);
  const fetcher = jest.spyOn(global, 'fetch')
    .mockRejectedValue(new Error('Unexpected test fetch'))
    .mockResolvedValueOnce(Response.json({ id: 'listing-search', result: ids, total: ids.length }))
    .mockResolvedValueOnce(Response.json({ result: items.map(({ text, identified }, index) => ({
      id: ids[index], item: { name: 'Ash Band', typeLine: 'Gold Ring', identified, extended: { text } }, listing: {},
    })) }));
  const originalEnv = process.env;
  process.env = { ...originalEnv, POE_TRADE_ENABLED: 'true', POE_SESSION_ID: '' };
  try {
    const provider = new TradeProvider();
    const result = await provider.search(tradeScope, buildTradeQuery({ scope: tradeScope, base: 'Gold Ring' }));
    const watch = await provider.fetch(tradeScope, 'listing-search', ids);
    return { result, watch };
  } finally {
    fetcher.mockRestore();
    process.env = originalEnv;
  }
}

test('projects canonical PoE 1 clipboard item text on offers only', async () => {
  const raw = `${clipboard}\n--------\nNote: seller metadata\n`;
  const { result, watch } = await offers(scope, [{ text: encode(raw.replaceAll('\n', '\r\n')) }]);
  expect(result.status).toBe('ok');
  expect(result.listings).toMatchObject([{ id: 'offer-0', itemText: clipboard }]);
  expect(watch).toHaveLength(1);
  expect(watch[0]).not.toHaveProperty('itemText');
});

test('retains offers with missing or unusable clipboard text', async () => {
  const invalid = [
    {}, { text: 42 }, { text: `${encode(clipboard)}!` }, { text: encode('listing metadata') },
    { text: encode(clipboard.replace('Rarity: Rare', 'Rarity: Currency')) },
    { text: encode(clipboard), identified: false },
    { text: encode(`${clipboard}\n\u0000`) },
    { text: encode(`${clipboard}\n--------\nNote: seller metadata\n--------\nCorrupted`) },
    { text: Buffer.concat([Buffer.from(clipboard), Buffer.from([0xff])]).toString('base64') },
    { text: encode(`${clipboard}\n${'x'.repeat(10_240)}`) },
  ];
  const { result } = await offers(scope, invalid);
  expect(result.status).toBe('ok');
  expect(result.listings).toHaveLength(invalid.length);
  for (const listing of result.listings) expect(listing).not.toHaveProperty('itemText');
});

test('does not project a PoE 2 offer as a PoE 1 PoB item', async () => {
  const { result } = await offers({ ...scope, game: 'poe2', realm: 'poe2' }, [{ text: encode(clipboard) }]);
  expect(result.status).toBe('ok');
  expect(result.listings).toHaveLength(1);
  expect(result.listings[0]).not.toHaveProperty('itemText');
});
