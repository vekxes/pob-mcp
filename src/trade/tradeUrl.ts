import { gunzipSync } from 'node:zlib';
import type { TradeQuery } from '../types/tradeTypes.js';
import { tradeSearchBase, validateScope, validateTradeSearchId } from './query.js';
import type { TradeScope } from './query.js';

function parseTradeUrl(value: string) {
  const invalid = () => new Error('Вставь ссылку на поиск с сайта PoE Trade.');
  if (typeof value !== 'string' || value.length > 60_000) throw invalid();
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || (url.hostname !== 'pathofexile.com' && !url.hostname.endsWith('.pathofexile.com'))) throw invalid();
    const [site, section, ...segments] = url.pathname.split('/').slice(1).filter(Boolean);
    if (section !== 'search' || (site !== 'trade' && site !== 'trade2')) throw invalid();

    const game = site === 'trade2' ? 'poe2' : 'poe1';
    let realm: TradeScope['realm'] = 'pc';
    if (game === 'poe2') {
      if (segments.shift() !== 'poe2') throw invalid();
      realm = 'poe2';
    } else if (segments[0] === 'pc' || segments[0] === 'xbox' || segments[0] === 'sony') {
      realm = segments.shift() as 'pc' | 'xbox' | 'sony';
    }
    if (segments.length === 3 && segments[2] === 'live') segments.pop();
    if (segments.length < 1 || segments.length > 2) throw invalid();
    const scope = { game, realm, league: decodeURIComponent(segments[0]) } satisfies TradeScope;
    validateScope(scope);
    return { scope, url, searchId: segments[1] && decodeURIComponent(segments[1]) };
  } catch {
    throw invalid();
  }
}

export function scopeFromTradeUrl(value: string): TradeScope {
  return parseTradeUrl(value).scope;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function tradeBodyFromPayload(value: unknown): TradeQuery {
  const wrapped = record(value) && record(value.query) ? value : undefined;
  const query = wrapped ? wrapped.query : value;
  if (!record(query) || !['name', 'type', 'term', 'filters', 'stats', 'status'].some(key => Object.hasOwn(query, key))) {
    throw new Error('В ссылке нет фильтров поиска PoE Trade.');
  }
  const body = { query, sort: wrapped?.sort ?? { price: 'asc' } };
  if (JSON.stringify(body).length > 60_000) throw new Error('Фильтры поиска PoE Trade слишком велики.');
  return body as TradeQuery;
}

export function tradeSearchFromUrl(value: string) {
  const { scope, url, searchId } = parseTradeUrl(value);
  const base = tradeSearchBase(scope);
  const inline = url.searchParams.get('q');
  if (inline !== null) {
    let payload: unknown;
    try { payload = JSON.parse(inline); }
    catch { throw new Error('Не удалось прочитать фильтры в ссылке PoE Trade.'); }
    return { scope, searchUrl: `${base}?${new URLSearchParams({ q: inline })}`, body: tradeBodyFromPayload(payload) };
  }
  if (!searchId) throw new Error('Сначала выполни поиск на PoE Trade, затем скопируй его ссылку.');
  validateTradeSearchId(searchId);
  const searchUrl = `${base}/${searchId}`;
  const decoded = Buffer.from(searchId, 'base64url');
  if (decoded[0] === 0x1f && decoded[1] === 0x8b) {
    let payload: unknown;
    try { payload = JSON.parse(gunzipSync(decoded, { maxOutputLength: 60_000 }).toString('utf8')); }
    catch { throw new Error('Не удалось прочитать сжатые фильтры из ссылки PoE Trade.'); }
    return { scope, searchUrl, body: tradeBodyFromPayload(payload) };
  }
  return { scope, searchUrl, searchId };
}
