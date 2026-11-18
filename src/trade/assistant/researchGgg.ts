import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfiguredPoBLayout } from '../../utils/pobLayout.js';
import { tradeLog } from '../log.js';
import { validateScope } from '../query.js';
import type { TradeScope } from '../query.js';

const reference = 'https://www.pathofexile.com/developer/docs/reference';
const exchangeBase = 'https://web.poecdn.com/api/currency-exchange';
const hourSeconds = 3600;
const maximumDigestBytes = 16 * 1024 * 1024;
const currencyLabels = new Map([
  ['Metadata/Items/Currency/CurrencyRerollRare', 'Chaos Orb'],
  ['Metadata/Items/Currency/CurrencyAddModToRare', 'Exalted Orb'],
  ['Metadata/Items/Currency/CurrencyModValues', 'Divine Orb'],
]);
const restricted = {
  league: {
    section: 'leagues',
    note: 'The documented league API requires service:leagues. GGG does not allow service scopes for desktop Public Clients.',
  },
  ladder: {
    section: 'get-league-ladder',
    note: 'The documented ladder API requires service:leagues:ladder. GGG does not allow service scopes for desktop Public Clients.',
  },
  equipment_sample: {
    section: 'account-characters',
    note: 'The documented character API uses account:characters for the authorized account. It does not provide a public sample of other players’ equipment.',
  },
} as const;

export type GggResearchKind = 'currency_exchange' | keyof typeof restricted;
export type GggResearchRequest = { kind: GggResearchKind; text?: string; limit?: number };
type Currency = { id: string; name: string };
type ExchangeEntry = { currencyPair: [Currency, Currency]; volumeTraded: [number | null, number | null] };
type Marketplace = ExchangeEntry & { league: string };
type ExchangeRead =
  | { status: 'ok'; markets: Marketplace[]; observedAt: string }
  | { status: 'unavailable'; reason: 'rate_limited' | 'source_unavailable'; observedAt: string };
export type GggResearchResult = {
  status: 'ok' | 'no_data' | 'unavailable' | 'authorization_required';
  scope: TradeScope;
  kind: GggResearchKind;
  source: {
    provider: 'pathofexile.com';
    url: string;
    kind: 'currency_exchange' | 'official_api_documentation';
    observedAt: string;
  };
  entries: ExchangeEntry[];
  hourStart?: string;
  hourEnd?: string;
  totalMatches?: number;
  reason?: 'rate_limited' | 'source_unavailable';
  note?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function currencyId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && /^Metadata\/[\w/.-]+$/.test(value);
}

function loadPoe1CurrencyNames(): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  try {
    const file = readFileSync(join(resolveConfiguredPoBLayout().src, 'Data', 'CurrencyNames.lua'), 'utf8');
    for (const [, id, name] of file.matchAll(/^\s*\["(Metadata\/[\w/.-]+)"\]\s*=\s*"((?:[^"\\\r\n]|\\["\\])+)"\s*,\s*$/gm)) {
      names.set(id, name.replace(/\\(["\\])/g, '$1'));
    }
  } catch {
    // The public digest remains usable by its upstream item IDs without an installed PoB.
  }
  return names;
}

function normalizeMarket(value: unknown, names: ReadonlyMap<string, string>): Marketplace[] {
  if (!isRecord(value) || typeof value.league !== 'string' || !isRecord(value.volume_traded)
      || !Array.isArray(value.market_pair) || value.market_pair.length !== 2) return [];
  const [first, second] = value.market_pair;
  if (!currencyId(first) || !currencyId(second)) return [];
  const currency = (id: string) => ({ id, name: names.get(id) ?? currencyLabels.get(id) ?? id });
  const volume = (id: string) => {
    const amount = (value.volume_traded as Record<string, unknown>)[id];
    return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
  };
  return [{
    league: value.league,
    currencyPair: [currency(first), currency(second)],
    volumeTraded: [volume(first), volume(second)],
  }];
}

async function readDigest(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty currency exchange response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumDigestBytes) {
        await reader.cancel();
        throw new Error('Currency exchange response exceeded the size limit.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

export class ResearchGgg {
  private readonly cache = new Map<TradeScope['realm'], { hour: number; expires: number; read: Promise<ExchangeRead> }>();
  private poe1CurrencyNames?: ReadonlyMap<string, string>;
  private retryAt = 0;

  constructor(private readonly fetcher: typeof fetch = fetch, private readonly clock: () => number = Date.now) {}

  async lookup(scope: TradeScope, input: GggResearchRequest): Promise<GggResearchResult> {
    validateScope(scope);
    const { kind, limit = 8 } = input;
    if ((kind !== 'currency_exchange' && !Object.hasOwn(restricted, kind))
        || !Number.isInteger(limit) || limit < 1 || limit > 20
        || (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > 120))) {
      throw new Error('Choose a supported Path of Exile research mode and a result limit from 1 to 20.');
    }
    const observedAt = new Date(this.clock()).toISOString();
    if (kind !== 'currency_exchange') {
      const { section, note } = restricted[kind];
      return {
        status: 'authorization_required', scope, kind, entries: [], note,
        source: { provider: 'pathofexile.com', kind: 'official_api_documentation', url: reference + '#' + section, observedAt },
      };
    }

    const hour = Math.floor(this.clock() / (hourSeconds * 1000)) * hourSeconds - hourSeconds;
    const url = `${exchangeBase}${scope.realm === 'pc' ? '' : '/' + scope.realm}/${hour}`;
    const digest = await this.exchange(scope.realm, hour, url);
    const source = { provider: 'pathofexile.com', kind: 'currency_exchange', url, observedAt: digest.observedAt } as const;
    const period = {
      hourStart: new Date(hour * 1000).toISOString(),
      hourEnd: new Date((hour + hourSeconds) * 1000).toISOString(),
    };
    if (digest.status === 'unavailable') {
      return { status: 'unavailable', scope, kind, source, entries: [], reason: digest.reason, ...period };
    }
    const terms = input.text?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const matched = digest.markets.filter(({ league, currencyPair }) =>
      league === scope.league && currencyPair.some(({ id, name }) => [id, name].some(label =>
        terms.every(term => label.toLowerCase().includes(term)))));
    return {
      status: matched.length ? 'ok' : 'no_data', scope, kind, source, ...period, totalMatches: matched.length,
      entries: matched.slice(0, limit).map(({ currencyPair, volumeTraded }) => ({ currencyPair, volumeTraded })),
      note: 'Volumes use the units of each currency in pair order for the completed UTC hour and league. The digest names currencies by item ID. Search by that ID when a display name is unavailable. These totals describe exchange activity only.',
    };
  }

  private exchange(realm: TradeScope['realm'], hour: number, url: string): Promise<ExchangeRead> {
    const now = this.clock();
    const existing = this.cache.get(realm);
    if (existing?.hour === hour && existing.expires > now) return existing.read;
    if (now < this.retryAt) {
      return Promise.resolve({ status: 'unavailable', reason: 'rate_limited', observedAt: new Date(now).toISOString() });
    }
    const entry = { hour, expires: (hour + 2 * hourSeconds) * 1000, read: this.fetchExchange(realm, hour, url) };
    this.cache.set(realm, entry);
    void entry.read.then(result => {
      if (result.status === 'unavailable') {
        entry.expires = result.reason === 'rate_limited' ? this.retryAt : this.clock() + 60_000;
      }
    });
    return entry.read;
  }

  private async fetchExchange(realm: TradeScope['realm'], hour: number, url: string): Promise<ExchangeRead> {
    const started = this.clock();
    const observedAt = new Date(started).toISOString();
    try {
      const response = await this.fetcher(url, {
        headers: { 'User-Agent': process.env.POE_TRADE_USER_AGENT || 'pob-local-trade/1.0' },
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          const value = response.headers.get('Retry-After') ?? '';
          const retryAt = /^\d+$/.test(value) ? this.clock() + Number(value) * 1000 : Date.parse(value);
          this.retryAt = Math.max(this.retryAt, Number.isFinite(retryAt) ? retryAt : this.clock() + 60_000, this.clock() + 1000);
          tradeLog('research-ggg', 'currency_rate_limited', { realm });
          return { status: 'unavailable', reason: 'rate_limited', observedAt };
        }
        throw new Error('Currency exchange request failed.');
      }
      const data = await readDigest(response);
      if (!isRecord(data) || !Array.isArray(data.markets) || typeof data.next_change_id !== 'number'
          || !Number.isSafeInteger(data.next_change_id) || data.next_change_id < hour) {
        throw new Error('Unexpected currency exchange response.');
      }
      const names = realm === 'poe2' ? currencyLabels : (this.poe1CurrencyNames ??= loadPoe1CurrencyNames());
      const markets = data.markets.flatMap(market => normalizeMarket(market, names));
      tradeLog('research-ggg', 'currency_read', { realm, entries: markets.length, elapsedMs: this.clock() - started });
      return { status: 'ok', markets, observedAt };
    } catch {
      tradeLog('research-ggg', 'currency_unavailable', { realm, elapsedMs: this.clock() - started });
      return { status: 'unavailable', reason: 'source_unavailable', observedAt };
    }
  }
}
