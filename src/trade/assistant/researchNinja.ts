import { validateScope } from '../query.js';
import type { TradeScope } from '../query.js';

const origin = 'https://poe.ninja';
const categoryTypes = {
  currency: { poe1: 'Currency', poe2: 'Currency' },
  unique_weapon: { poe1: 'UniqueWeapon', poe2: 'UniqueWeapons' },
  unique_armour: { poe1: 'UniqueArmour', poe2: 'UniqueArmours' },
  unique_accessory: { poe1: 'UniqueAccessory', poe2: 'UniqueAccessories' },
  unique_flask: { poe1: 'UniqueFlask', poe2: 'UniqueFlasks' },
  unique_jewel: { poe1: 'UniqueJewel', poe2: 'UniqueJewels' },
  skill_gem: { poe1: 'SkillGem', poe2: undefined },
  base_type: { poe1: 'BaseType', poe2: undefined },
} as const;

export type NinjaPriceCategory = keyof typeof categoryTypes;
export const ninjaPriceCategories = Object.keys(categoryTypes) as NinjaPriceCategory[];

const errors = {
  invalid_arguments: 'Choose a poe.ninja market category and up to ten exact item names.',
  unsupported_scope: 'poe.ninja economy estimates are unavailable for the selected game or platform.',
  unsupported_category: 'poe.ninja does not provide this market category for the selected game.',
  league_unavailable: 'The selected league is absent from the poe.ninja economy catalog.',
  source_unavailable: 'The public poe.ninja economy source is temporarily unavailable.',
} as const;

export class ResearchNinjaError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code]);
  }
}

type RecordObject = Record<string, unknown>;
type CachedResponse = {
  data: unknown;
  cacheControl: string;
  observedAt: number;
  checkedAt: number;
  expires: number;
  etag?: string;
};
type NinjaPriceLine = {
  name: string;
  price: { amount: number; currency: string };
  baseType?: string;
  variant?: string;
  listings?: number;
  observations?: number;
  gemLevel?: number;
  gemQuality?: number;
  links?: number;
  corrupted?: boolean;
};

const maxResponseBytes = 4 * 1024 * 1024;
const defaultMaxAge = 300;
const maxCacheEntries = 48;

function record(value: unknown): RecordObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordObject : undefined;
}

function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160) || undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function fold(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function itemRows(value: unknown, game: TradeScope['game'], category: NinjaPriceCategory): NinjaPriceLine[] {
  const data = record(value);
  if (!Array.isArray(data?.lines)) throw new ResearchNinjaError('source_unavailable');
  const currency = game === 'poe1' && category !== 'currency' ? 'chaos' : record(data.core)?.primary;
  if (typeof currency !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(currency)) {
    throw new ResearchNinjaError('source_unavailable');
  }
  const metadata = data.items ?? record(data.core)?.items;
  const currencyNames = new Map<string, string>();
  if (category === 'currency' && Array.isArray(metadata)) {
    for (const entry of metadata) {
      const item = record(entry);
      const name = label(item?.name);
      if (typeof item?.id === 'string' && name) currencyNames.set(item.id, name);
    }
  }
  const prices: NinjaPriceLine[] = [];
  for (const entry of data.lines) {
    const line = record(entry);
    if (!line) continue;
    const name = category === 'currency' && typeof line.id === 'string' ? currencyNames.get(line.id) : label(line.name);
    const amount = game === 'poe1' && category !== 'currency' ? line.chaosValue : line.primaryValue;
    if (!name || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) continue;
    prices.push({
      name, price: { amount, currency },
      baseType: label(line.baseType), variant: label(line.variant), listings: count(line.listingCount),
      observations: count(line.count), gemLevel: count(line.gemLevel), gemQuality: count(line.gemQuality),
      links: count(line.links), corrupted: typeof line.corrupted === 'boolean' ? line.corrupted : undefined,
    });
  }
  return prices;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > maxResponseBytes) {
    await response.body?.cancel();
    throw new ResearchNinjaError('source_unavailable');
  }
  const buffers: Buffer[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new ResearchNinjaError('source_unavailable');
      }
      buffers.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export class ResearchNinja {
  private readonly cache = new Map<string, CachedResponse>();
  private readonly pending = new Map<string, Promise<CachedResponse>>();

  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async prices(scope: TradeScope, { category, names = [] }: { category: NinjaPriceCategory; names?: string[] }) {
    try { validateScope(scope); }
    catch { throw new ResearchNinjaError('unsupported_scope'); }
    if (scope.realm !== 'pc' && scope.realm !== 'poe2') throw new ResearchNinjaError('unsupported_scope');
    if (!Object.hasOwn(categoryTypes, category) || !Array.isArray(names) || names.length > 10
        || !names.every(name => typeof name === 'string' && !!name.trim() && name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(name))) {
      throw new ResearchNinjaError('invalid_arguments');
    }
    const type = categoryTypes[category][scope.game];
    if (!type) throw new ResearchNinjaError('unsupported_category');
    const base = `${origin}/${scope.game}/api/economy/`;
    const catalog = (await this.load(base + 'leagues')).data;
    if (!Array.isArray(catalog)) throw new ResearchNinjaError('source_unavailable');
    const candidates = catalog.map(record).filter(candidate =>
      candidate && typeof candidate.id === 'string' && !!candidate.id && candidate.id.length <= 120);
    const leagueId = candidates.find(candidate => candidate?.id === scope.league)?.id
      ?? candidates.find(candidate => candidate?.name === scope.league)?.id;
    if (typeof leagueId !== 'string') throw new ResearchNinjaError('league_unavailable');
    const endpoint = category === 'currency' ? 'exchange/current/overview' : 'stash/current/item/overview';
    const url = `${base}${endpoint}?${new URLSearchParams({ league: leagueId, type })}`;
    const snapshot = await this.load(url);
    const all = itemRows(snapshot.data, scope.game, category);
    const requested = new Map(names.map(name => [fold(name.trim()), name.trim()]));
    const matching = requested.size ? all.filter(item => requested.has(fold(item.name))) : all;
    const firstByName = new Map<string, (typeof matching)[number]>();
    if (requested.size) {
      for (const item of matching) {
        const key = fold(item.name);
        if (!firstByName.has(key)) firstByName.set(key, item);
      }
    }
    const primary = new Set(firstByName.values());
    const items = primary.size && matching.length > 20
      ? [...primary, ...matching.filter(item => !primary.has(item))].slice(0, 20)
      : matching.slice(0, 20);
    return {
      kind: 'market_estimates' as const,
      source: { title: 'poe.ninja Economy', url },
      scope: { game: scope.game, realm: scope.realm, league: scope.league },
      leagueId, category,
      observedAt: new Date(snapshot.observedAt).toISOString(), checkedAt: new Date(snapshot.checkedAt).toISOString(),
      matchingEstimates: matching.length, truncated: matching.length > 20,
      missingNames: [...requested].filter(([key]) => !firstByName.has(key)).map(([, name]) => name),
      items,
      note: 'Estimated market prices only. Listing and observation counts measure price evidence, not player equipment usage.',
    };
  }

  private load(url: string): Promise<CachedResponse> {
    const cached = this.cache.get(url);
    if (cached && cached.expires > this.now()) return Promise.resolve(cached);
    const running = this.pending.get(url);
    if (running) return running;
    const request = this.fetchResponse(url, cached).finally(() => this.pending.delete(url));
    this.pending.set(url, request);
    return request;
  }

  private async fetchResponse(url: string, cached?: CachedResponse): Promise<CachedResponse> {
    try {
      const headers = new Headers({
        Accept: 'application/json',
        'User-Agent': process.env.POE_NINJA_USER_AGENT || 'pob-local-trade/1.0 (+https://github.com/ianderse/pob-mcp)',
      });
      if (cached?.etag) headers.set('If-None-Match', cached.etag);
      const response = await this.fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const unchanged = response.status === 304 && !!cached;
      if (!unchanged && !response.ok) {
        await response.body?.cancel();
        throw new ResearchNinjaError('source_unavailable');
      }
      const data = unchanged ? cached.data : await readJson(response);
      const checkedAt = this.now();
      const cacheControl = response.headers.get('cache-control') ?? (unchanged ? cached.cacheControl : '');
      const noStore = /\bno-store\b/i.test(cacheControl);
      const age = Math.max(0, Number(response.headers.get('age')) || 0);
      const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl)?.[1] ?? defaultMaxAge);
      const expires = /\bno-cache\b/i.test(cacheControl) ? checkedAt : checkedAt + Math.max(0, maxAge - age) * 1_000;
      const result: CachedResponse = {
        data, cacheControl, checkedAt, expires, observedAt: unchanged ? cached.observedAt : checkedAt,
        etag: response.headers.get('etag') ?? (unchanged ? cached.etag : undefined),
      };
      this.cache.delete(url);
      if (!noStore) {
        this.cache.set(url, result);
        if (this.cache.size > maxCacheEntries) {
          const oldest = this.cache.keys().next().value;
          if (oldest) this.cache.delete(oldest);
        }
      }
      return result;
    } catch {
      throw new ResearchNinjaError('source_unavailable');
    }
  }
}
