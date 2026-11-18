import { describe, it, expect } from '@jest/globals';
import { gunzipSync } from 'node:zlib';
import { handleGenerateWeightedTradeQuery, toStatFilters } from '../../src/handlers/tradeHandlers.js';
import type { PoBLuaApiClient } from '../../src/pobLuaBridge.js';

describe('generate_weighted_trade_query', () => {
  it('encodes the inner PoB query in the browser link and preserves the API request body', async () => {
    const weights = { status: { option: 'online' }, stats: [{ type: 'weight', filters: [{ id: 'explicit.stat_3372524247', value: { weight: 2 } }] }] };
    const body = { query: weights, sort: { 'statgroup.0': 'desc' }, engine: 'new' };
    const client = { generateWeightedTradeQuery: async () => ({ query: body }) } as unknown as PoBLuaApiClient;
    const result = await handleGenerateWeightedTradeQuery({ getLuaClient: () => client, ensureLuaClient: async () => {} }, {
      slot: 'Ring 1', league: 'Hardcore Standard',
    });
    const output = result.content[0].text;
    const url = new URL(output.match(/^Trade site link: (\S+)/m)![1]);
    expect(url.origin).toBe('https://www.pathofexile.com');
    expect(url.pathname).toMatch(/^\/trade\/search\/Hardcore%20Standard\/[A-Za-z0-9_-]+={0,2}$/);
    expect(url.search).toBe('');
    expect(JSON.parse(gunzipSync(Buffer.from(url.pathname.split('/').at(-1)!, 'base64url')).toString())).toEqual(weights);
    expect(JSON.parse(output.split('Request body:\n')[1])).toEqual(body);
  });
});

describe('toStatFilters', () => {
  it('returns an empty array when neither stats nor mods are provided', () => {
    expect(toStatFilters(undefined, undefined)).toEqual([]);
    expect(toStatFilters([], [])).toEqual([]);
  });

  it('returns stats[] as-is when only stats are provided (handler-native shape)', () => {
    const stats = [
      { id: 'explicit.stat_3372524247', min: 35 },
      { id: 'explicit.stat_3299347043', min: 90, max: 200 },
    ];
    expect(toStatFilters(stats, undefined)).toEqual(stats);
  });

  it('maps mods[].stat_id to stats[].id when only mods are provided (MCP-schema shape)', () => {
    const mods = [
      { stat_id: 'explicit.stat_3372524247', min: 35 },
      { stat_id: 'explicit.stat_3299347043', min: 90, max: 200 },
    ];
    expect(toStatFilters(undefined, mods)).toEqual([
      { id: 'explicit.stat_3372524247', min: 35 },
      { id: 'explicit.stat_3299347043', min: 90, max: 200 },
    ]);
  });

  it('prefers stats over mods when both are provided', () => {
    const stats = [{ id: 'explicit.stat_A', min: 1 }];
    const mods = [{ stat_id: 'explicit.stat_B', min: 2 }];
    expect(toStatFilters(stats, mods)).toEqual(stats);
  });

  it('preserves missing min/max when mapping mods to stats', () => {
    const mods = [{ stat_id: 'explicit.stat_X' }];
    expect(toStatFilters(undefined, mods)).toEqual([
      { id: 'explicit.stat_X', min: undefined, max: undefined },
    ]);
  });
});
