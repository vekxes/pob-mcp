import { gzipSync } from 'node:zlib';
import { TradeQueryBuilder } from '../services/tradeQueryBuilder.js';
import type { TradeQuery } from '../types/tradeTypes.js';

export interface TradeScope {
  game: 'poe1' | 'poe2';
  realm: 'pc' | 'xbox' | 'sony' | 'poe2';
  league: string;
}
export type TradeRealm = Omit<TradeScope, 'league'>;

export interface Budget {
  currency?: string;
  min?: number;
  max?: number;
}

export interface SearchFilters {
  scope: TradeScope;
  name?: string;
  base?: string;
  mods?: { id: string; min?: number; max?: number }[];
  budget?: Budget;
  status?: NonNullable<TradeQuery['query']['status']>['option'];
  sort?: 'asc' | 'desc';
}

const statuses = new Set(['available', 'online', 'onlineleague', 'securable', 'any']);
const statId = /^[a-z]+\.[a-z0-9_]+$/;
const currencyId = /^[a-z0-9_-]{1,40}$/;

export function validateRealm(scope: TradeRealm): void {
  if (!scope || !((scope.game === 'poe1' && ['pc', 'xbox', 'sony'].includes(scope.realm))
      || (scope.game === 'poe2' && scope.realm === 'poe2'))) {
    throw new Error('Choose a valid game and platform.');
  }
}

export function validateScope(scope: TradeScope): void {
  validateRealm(scope);
  if (typeof scope.league !== 'string' || !scope.league.trim() || scope.league.length > 100
      || /[\/\\\u0000-\u001f]/.test(scope.league) || ['.', '..'].includes(scope.league)) {
    throw new Error('Choose a valid game, realm and league.');
  }
}

function validateRange(min?: number, max?: number): void {
  if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max))
      || (min !== undefined && max !== undefined && min > max)) {
    throw new Error('Minimum and maximum must be finite and in order.');
  }
}

export function validateBudget(budget: Budget): void {
  if (!budget || (budget.currency === undefined && budget.min === undefined && budget.max === undefined)
      || (budget.currency !== undefined && (typeof budget.currency !== 'string' || !currencyId.test(budget.currency)))) {
    throw new Error('Choose a valid currency.');
  }
  validateRange(budget.min, budget.max);
  if ((budget.min ?? 0) < 0 || (budget.max ?? 0) < 0) {
    throw new Error('Choose a valid currency and a positive or zero budget.');
  }
}

export function withBudget<T extends { query: TradeQuery['query'] }>(body: T, budget?: Budget): T {
  if (budget === undefined) return body;
  validateBudget(budget);
  const result = structuredClone(body);
  const filters = result.query.filters ??= {};
  const trade = filters.trade_filters ??= {};
  (trade.filters ??= {}).price = {
    ...(budget.currency !== undefined && { option: budget.currency }),
    ...(budget.min !== undefined && { min: budget.min }),
    ...(budget.max !== undefined && { max: budget.max }),
  };
  return result;
}

export function buildTradeQuery(filters: SearchFilters): TradeQuery {
  validateScope(filters.scope);
  const name = filters.name?.trim();
  const base = filters.base?.trim();
  const mods = filters.mods ?? [];
  if (!Array.isArray(mods) || (!name && !base && !mods.length)
      || (name?.length ?? 0) > 200 || (base?.length ?? 0) > 200 || mods.length > 30) {
    throw new Error('Enter an item name, base or up to 30 modifiers.');
  }
  if ((filters.status !== undefined && !statuses.has(filters.status))
      || (filters.sort !== undefined && !['asc', 'desc'].includes(filters.sort))) {
    throw new Error('Choose a valid availability and sort order.');
  }
  for (const mod of mods) {
    if (typeof mod?.id !== 'string' || !statId.test(mod.id)) throw new Error('Enter a valid trade stat ID.');
    validateRange(mod.min, mod.max);
  }

  const builder = new TradeQueryBuilder()
    .withOnlineStatus(filters.status ?? 'available')
    .withSort('price', filters.sort ?? 'asc');
  if (name) builder.withName(name);
  if (mods.length) builder.withStats(mods);
  const body = builder.build();
  if (base) body.query.type = base;
  return withBudget(body, filters.budget);
}

export function validateTradeBody(body: TradeQuery): void {
  const query = body?.query;
  if (!query || typeof query !== 'object' || Array.isArray(query) || JSON.stringify(body).length > 60_000
      || (query.status && !statuses.has(query.status.option))
      || !(query.name || query.type || query.stats?.some(group => group.filters?.length)
        || query.filters?.type_filters?.filters?.category?.option)) {
    throw new Error('Provide a valid filtered trade request.');
  }
  for (const group of query.stats ?? []) {
    validateRange(group.value?.min, group.value?.max);
    for (const filter of group.filters ?? []) {
      if (typeof filter.id !== 'string' || !statId.test(filter.id)) throw new Error('Enter a valid trade stat ID.');
      validateRange(filter.value?.min, filter.value?.max);
    }
  }
  const price = query.filters?.trade_filters?.filters?.price;
  if (price) {
    validateRange(price.min, price.max);
    if ((price.min ?? 0) < 0 || (price.max ?? 0) < 0
        || (price.option !== undefined && (typeof price.option !== 'string' || !currencyId.test(price.option)))) {
      throw new Error('Choose a valid currency and budget.');
    }
  }
  if (body.sort && !Object.values(body.sort).every(order => order === 'asc' || order === 'desc')) {
    throw new Error('Choose a valid sort order.');
  }
}

export function validateTradeSearchId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length > 16_384 || !/^[A-Za-z0-9_-]+={0,2}$/.test(id)) {
    throw new Error('Invalid trade search ID.');
  }
}

export function tradeSearchBase(scope: TradeScope): string {
  validateScope(scope);
  const site = scope.game === 'poe2' ? 'trade2' : 'trade';
  const realm = scope.realm === 'pc' ? '' : `/${scope.realm}`;
  return `https://www.pathofexile.com/${site}/search${realm}/${encodeURIComponent(scope.league)}`;
}

export function tradeLink(scope: TradeScope, body: { query: TradeQuery['query'] }, searchId?: string): string {
  if (searchId !== undefined) validateTradeSearchId(searchId);
  const token = searchId ?? gzipSync(JSON.stringify(body.query)).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_');
  return `${tradeSearchBase(scope)}/${token}`;
}
