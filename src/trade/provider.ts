import { TradeApiClient, tradeModDescription } from '../services/tradeClient.js';
import { StatMapper } from '../services/statMapper.js';
import type { FetchedItemListing, FetchedTradeItem, ItemListing, TradeQuery } from '../types/tradeTypes.js';
import { tradeLink, validateScope, validateTradeSearchId } from './query.js';
import type { SearchFilters, TradeScope } from './query.js';
import { tradeBodyFromPayload } from './tradeUrl.js';
import { tradeLog } from './log.js';
import { decodeListingItemText } from './listingItemText.js';
import type { BrowserSessionStatus, BrowserTradeSession } from './browserSession.js';

type Stat = { id: string; text: string };
type Mod = { line: string; type: string };
type Listing = ReturnType<typeof summarizeListing>;
type Subscription = { ready: Promise<void>; close(): void };
export type WatchHandlers = {
  matches(ids: string[], queryId: string): Promise<void>;
  disconnected(): void;
};

function summarizeListing({ id, item, listing }: ItemListing) {
  return {
    id,
    name: item.name || item.typeLine,
    base: item.baseType || item.typeLine,
    price: listing.price && { amount: listing.price.amount, currency: listing.price.currency },
    indexed: listing.indexed,
    mods: [...(item.implicitMods ?? []), ...(item.explicitMods ?? []), ...(item.craftedMods ?? [])],
  };
}

const MOD_GROUPS = [
  'enchant', 'rune', 'implicit', 'explicit', 'fractured', 'crafted', 'desecrated', 'mutated', 'foulborn',
  'vestigial', 'rareonly', 'utility', 'bonded', 'scourge', 'crucible', 'cosmetic', 'veiled', 'logbook', 'ultimatum',
] as const;
const FOLDED_MOD_GROUPS = ['fractured', 'crafted', 'desecrated', 'mutated', 'vestigial', 'rareonly', 'enchant'] as const;
const RARITIES = ['normal', 'magic', 'rare', 'unique', 'gem', 'currency', 'divination-card', 'quest'] as const;

function listingText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, maxLength).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() || undefined;
}

function itemText(value: unknown, maxLength: number): string | undefined {
  return listingText(value, maxLength)?.replace(/<<set:[A-Z]+>>/g, '')
    .replace(/\[([\w][\w '’-]*)(?:\|([^\]\n]+))?\]/g, (_token, key, label) => label ?? key).trim() || undefined;
}

function publicMods(item: FetchedTradeItem) {
  const groups = new Map<string, Set<string>>();
  const mods: string[] = [];
  function add(type: string, value: unknown) {
    const line = itemText(tradeModDescription(value), 512);
    if (!line) return;
    const lines = groups.get(type) ?? new Set<string>();
    if (lines.size < 24) lines.add(line);
    groups.set(type, lines);
    return line;
  }

  for (const type of MOD_GROUPS) {
    const entries = item[`${type}Mods`];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries.slice(0, 24)) {
      if (type === 'logbook') {
        for (const line of Array.isArray(entry?.mods) ? entry.mods.slice(0, 8) : []) add(type, line);
        continue;
      }
      if (type === 'ultimatum' && typeof entry?.type === 'string' && Number.isSafeInteger(entry.tier)) {
        add(type, `${entry.type} (${entry.tier})`);
        continue;
      }
      // The legacy veiled values are video identifiers. Only show descriptions.
      if (type === 'veiled' && typeof entry === 'string') continue;
      const subtype = FOLDED_MOD_GROUPS.find(group => entry?.flags?.[group] === true)
        ?? FOLDED_MOD_GROUPS.find(group => entry?.domain === group);
      const line = add(subtype ?? type, entry);
      if (line && (type === 'implicit' || type === 'explicit' || type === 'crafted')) mods.push(line);
    }
  }

  return { mods, modGroups: MOD_GROUPS.flatMap(type => {
    const lines = groups.get(type);
    return lines ? [{ type, lines: [...lines] }] : [];
  }) };
}

function publicProperties(item: FetchedTradeItem) {
  const properties = Array.isArray(item.properties) ? item.properties.slice(0, 24) : [];
  const notable = Array.isArray(item.notableProperties) ? item.notableProperties.slice(0, 8) : [];
  const additional = Array.isArray(item.additionalProperties) ? item.additionalProperties.slice(0, 16) : [];
  let quality: string | undefined;
  const display = [...properties, ...notable, ...additional].flatMap(property => {
    if (!property || property.displayMode === 2 || property.displayMode === 4) return [];
    const name = itemText(property.name, 160) ?? '';
    const values = Array.isArray(property.values) ? property.values.slice(0, 6).map(entry =>
      Array.isArray(entry) ? itemText(entry[0], 128) : undefined
    ) : [];
    if (property.type === 6 || /^quality\b/i.test(name)) quality ??= values[0];
    if (property.displayMode === 3 && name) {
      return [{ name: name.replace(/%(\d+)/g, (token, index) => values[Number(index)] ?? token), values: [] }];
    }
    const present = values.filter((value): value is string => value !== undefined);
    if (name) return [{ name, values: present }];
    return present.length ? [{ name: present.join(' '), values: [] }] : [];
  });
  return { quality, properties: display.length ? display : undefined };
}

function searchListing({ id, item, listing }: FetchedItemListing, game: TradeScope['game']) {
  const typeLine = itemText(item.typeLine, 200);
  const base = itemText(item.baseType, 200) ?? typeLine;
  const name = itemText(item.name, 200) ?? typeLine ?? base;
  if (!name) return [];

  const currency = listingText(listing.price?.currency, 64);
  const amount = listing.price?.amount;
  const price = currency && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0
    ? { amount, currency } : undefined;
  const indexed = listingText(listing.indexed, 40);
  const sellerName = listingText(listing.account?.name, 128);
  const presence = listing.account?.online;
  const status = presence?.status === 'afk' ? 'afk' : presence ? 'online' : 'offline';
  const seller = sellerName ? { name: sellerName, status } : undefined;
  const itemLevel = [item.ilvl, item.itemLevel].find(level => level !== undefined && Number.isSafeInteger(level) && level > 0);
  const rarityName = listingText(item.rarity, 32)?.toLowerCase();
  const frameId = listingText(item.frameTypeId, 32)?.toLowerCase();
  const rarity = RARITIES.find(value => value === rarityName || value === frameId)
    ?? (item.frameType === 9 || item.frameType === 10 ? 'unique' : RARITIES[item.frameType]);
  const { mods, modGroups } = publicMods(item);
  const flags = [
    ...(['corrupted', 'split', 'synthesised', 'replica', 'sanctified', 'mutated', 'veiled', 'vestigial', 'unmodifiable'] as const)
      .filter(flag => item[flag] === true),
    ...(item.identified === false ? ['unidentified'] : []),
    ...(item.mirrored === true || item.duplicated === true ? ['mirrored'] : []),
    ...(item.doubleCorrupted === true ? ['doublecorrupted'] : []),
    ...(['fractured', 'desecrated'] as const).filter(flag => item[flag] === true || modGroups.some(group => group.type === flag)),
    ...(['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord'] as const)
      .filter(flag => item[flag] === true || item.influences?.[flag] === true),
  ];

  const comparisonText = game === 'poe1' && item.identified !== false ? decodeListingItemText(item.extended?.text) : undefined;
  return [{
    id, name, base, typeLine, price, indexed: indexed && Number.isFinite(Date.parse(indexed)) ? indexed : undefined,
    seller, itemLevel, rarity, flags, mods, modGroups, ...publicProperties(item),
    ...(comparisonText ? { itemText: comparisonText } : {}),
  }];
}

function statPattern(text: string): string {
  return text.trim().toLowerCase().replace(/[-+]?\d+(\.\d+)?/g, '#').replace(/\+(?=#)/g, '').replace(/\s+/g, ' ');
}

export class TradeProvider {
  private readonly clients = new Map<string, TradeApiClient>();
  private readonly catalogs = new Map<string, { expires: number; request: Promise<Stat[]> }>();
  private readonly mapper = new StatMapper();
  private readonly userAgent = process.env.POE_TRADE_USER_AGENT || 'pob-local-trade/1.0';
  private readonly searchPreference = process.env.POE_TRADE_ENABLED;
  private readonly livePreference = process.env.POE_TRADE_LIVE_ENABLED;
  readonly #sessionId: string | undefined;
  #sessionLifetime = new AbortController();
  browserStatus: BrowserSessionStatus = 'unavailable';

  constructor(private readonly browserSession?: BrowserTradeSession) {
    this.#sessionId = browserSession ? undefined : process.env.POE_SESSION_ID || undefined;
  }

  get sessionConnected(): boolean {
    return this.browserSession ? this.browserStatus === 'connected' : Boolean(this.#sessionId);
  }
  get directSearch(): boolean {
    return this.searchPreference === 'true' || (this.browserSession !== undefined && !this.searchPreference);
  }

  get directLive(): boolean {
    const enabled = this.browserSession ? this.livePreference !== 'false' : this.livePreference === 'true';
    return this.directSearch && enabled && this.sessionConnected;
  }

  updateBrowserSession(status: BrowserSessionStatus): void {
    const previous = this.#sessionLifetime;
    this.browserStatus = status;
    this.#sessionLifetime = new AbortController();
    for (const client of this.clients.values()) client.setSession({ signal: this.#sessionLifetime.signal });
    this.catalogs.clear();
    previous.abort();
  }

  private client(scope: TradeScope): TradeApiClient {
    validateScope(scope);
    const realm = scope.realm;
    const cached = this.clients.get(realm);
    if (cached) return cached;
    const client = new TradeApiClient({
      realm: realm === 'pc' ? undefined : realm,
      userAgent: this.userAgent,
      requestsPerSecond: 1,
      cacheTTL: 20,
      maxRetries: 1,
      session: { id: this.#sessionId, signal: this.#sessionLifetime.signal },
      fetchRequest: this.browserSession?.fetch.bind(this.browserSession),
    });
    this.clients.set(realm, client);
    return client;
  }

  async search(scope: TradeScope, body: TradeQuery, limit = 10, linkOnly = false) {
    const link = tradeLink(scope, body);
    if (!this.directSearch || linkOnly) return { status: 'browser', source: 'trade_site_link', searchUrl: link, listings: [], total: null };
    const started = Date.now();
    const lifetime = this.#sessionLifetime.signal;
    try {
      const client = this.client(scope);
      const result = await client.searchItems(scope.league, body);
      lifetime.throwIfAborted();
      if (!result.id) throw new Error('The trade site returned no search ID.');
      const searchUrl = tradeLink(scope, body, result.id);
      const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null;
      const count = { total, ...(result.inexact === true ? { inexact: true as const } : {}) };
      try {
        const ids = [...new Set((result.result ?? []).slice(0, limit)
          .filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)))];
        const items = await client.fetchRawItems(ids, result.id);
        lifetime.throwIfAborted();
        const byId = new Map(items.map(item => [item.id, item]));
        const listings = ids.flatMap(id => {
          const entry = byId.get(id);
          return entry?.item && entry.listing ? searchListing(entry, scope.game) : [];
        });
        tradeLog('trade', 'search_completed', { game: scope.game, listings: listings.length, elapsedMs: Date.now() - started });
        return { status: 'ok', source: 'trade_site', searchUrl, searchId: result.id, listings, ...count, observedAt: new Date().toISOString() };
      } catch (error) {
        lifetime.throwIfAborted();
        tradeLog('trade', 'listing_fetch_failed', { game: scope.game, elapsedMs: Date.now() - started });
        return { status: 'partial', source: 'trade_site', searchUrl, searchId: result.id, listings: [], ...count, ...tradeWarning(error) };
      }
    } catch (error) {
      tradeLog('trade', 'search_failed', { game: scope.game, elapsedMs: Date.now() - started });
      const warning = lifetime.aborted
        ? { warningCode: 'session_changed', warning: 'The trade session changed. Run the search again.' }
        : tradeWarning(error);
      return { status: 'unavailable', source: 'trade_site_link', searchUrl: link, listings: [], total: null, ...warning };
    }
  }

  async fetch(scope: TradeScope, queryId: string, ids: string[]): Promise<Listing[]> {
    const items = await this.client(scope).fetchItems(ids, queryId);
    return items.filter(item => item?.item && item.listing).map(summarizeListing);
  }

  async resolveSearch(scope: TradeScope, searchId: string): Promise<TradeQuery | undefined> {
    validateTradeSearchId(searchId);
    const started = Date.now();
    try {
      const body = tradeBodyFromPayload(await this.client(scope).getSearchQuery(scope.league, searchId));
      tradeLog('trade', 'search_resolved', { game: scope.game, realm: scope.realm, elapsedMs: Date.now() - started });
      return body;
    } catch {
      tradeLog('trade', 'search_unresolved', { game: scope.game, realm: scope.realm, elapsedMs: Date.now() - started });
      return undefined;
    }
  }

  private catalog(scope: TradeScope): Promise<Stat[]> {
    const key = scope.realm;
    const existing = this.catalogs.get(key);
    if (existing && existing.expires > Date.now()) return existing.request;
    const next = { expires: Number.POSITIVE_INFINITY, request: this.client(scope).getStatCatalog()
      .then(data => data.result.flatMap(group => group.entries)) };
    void next.request.then(
      () => { next.expires = Date.now() + 3_600_000; },
      () => { next.expires = Date.now() + 30_000; },
    );
    this.catalogs.set(key, next);
    return next.request;
  }

  async stats(scope: TradeScope, text: string): Promise<Stat[]> {
    validateScope(scope);
    if (this.directSearch) {
      try {
        return (await this.catalog(scope)).filter(entry =>
          [entry.id, entry.text].some(value => value.toLowerCase().includes(text.toLowerCase()))
        ).slice(0, 20);
      } catch (error) {
        if (scope.game === 'poe2') throw new Error(tradeError(error));
      }
    }
    if (scope.game === 'poe2') return [];
    return this.mapper.fuzzySearch(text, 20).map(item => ({ id: item.tradeId, text: item.pobName }));
  }

  async resolveMods(scope: TradeScope, mods: Mod[]): Promise<{
    filters: NonNullable<SearchFilters['mods']>; warnings: string[];
  }> {
    let catalog: Stat[] = [];
    if (this.directSearch) {
      try {
        catalog = await this.catalog(scope);
      } catch {
        // Keep uncatalogued modifiers visible to the caller.
      }
    }
    const filters = new Map<string, { id: string; min: number }>();
    const warnings: string[] = [];
    for (const mod of mods) {
      const values = mod.line.match(/[-+]?\d+(?:\.\d+)?/g);
      const pattern = statPattern(mod.line);
      let candidates = catalog.filter(entry => entry.id.startsWith(mod.type + '.') && statPattern(entry.text) === pattern);
      if (!catalog.length && scope.game === 'poe1' && mod.type === 'explicit') {
        candidates = this.mapper.fuzzySearch(pattern).filter(entry =>
          entry.category === 'pseudo' && entry.aliases.some(alias => statPattern(alias) === pattern)
        ).map(entry => ({ id: entry.tradeId, text: entry.pobName }));
      }
      if (candidates.length !== 1 || values?.length !== 1 || Number(values[0]) < 0) {
        warnings.push(`Select a trade filter for ${mod.line} (${mod.type}).`);
        continue;
      }
      const { id } = candidates[0];
      const min = Number(values[0]);
      const previous = filters.get(id);
      if (previous) {
        if (id.startsWith('pseudo.')) previous.min += min;
        else warnings.push(`Several item modifiers map to ${id}. Check the minimum.`);
      } else {
        filters.set(id, { id, min });
      }
    }
    return { filters: [...filters.values()], warnings };
  }

  async subscribe(scope: TradeScope, body: TradeQuery, handlers: WatchHandlers, watchLifetime: AbortSignal): Promise<Subscription> {
    const sessionId = this.#sessionId;
    if (!this.directLive) throw new Error('Direct Live Search is unavailable. Open the search on the trade site.');
    const signal = AbortSignal.any([watchLifetime, this.#sessionLifetime.signal]);
    signal.throwIfAborted();
    const result = await this.client(scope).searchItems(scope.league, body, true)
      .catch(error => { throw new Error(tradeError(error)); });
    signal.throwIfAborted();
    validateTradeSearchId(result.id);
    tradeLog('trade', 'live_connecting', { game: scope.game, realm: scope.realm });
    const baseline = new Set(result.result ?? []);
    const site = scope.game === 'poe2' ? 'trade2' : 'trade';
    const realm = scope.realm === 'pc' ? '' : `/${scope.realm}`;
    const address = `wss://www.pathofexile.com/api/${site}/live${realm}/${encodeURIComponent(scope.league)}/${result.id}`;
    // Node 24's WebSocket accepts request options in addition to protocols.
    const Socket = WebSocket as unknown as new (
      url: string, options: { headers: Record<string, string> },
    ) => WebSocket;
    let socket: WebSocket;
    try {
      socket = this.browserSession ? this.browserSession.openSocket(address) : new Socket(address, {
        headers: {
          'User-Agent': this.userAgent,
          Origin: 'https://www.pathofexile.com',
          Cookie: `POESESSID=${sessionId}`,
        },
      });
    } catch {
      throw new Error('Could not establish Live Search with the trade site.');
    }
    const close = () => {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    };
    signal.addEventListener('abort', close, { once: true });
    const ready = new Promise<void>((resolve, reject) => {
      let accepted = false;
      function approve() {
        if (accepted) return;
        accepted = true;
        clearTimeout(timeout);
        resolve();
      }
      function deny(reason: string) {
        clearTimeout(timeout);
        reject(new Error(reason));
        close();
      }
      const timeout = setTimeout(() => {
        deny('Live Search did not confirm the session.');
      }, 15_000);
      socket.addEventListener('message', event => {
        if (signal.aborted || typeof event.data !== 'string' || event.data.length > 1_000_000) return;
        let message: { auth?: unknown; error?: unknown; new?: unknown };
        try { message = JSON.parse(event.data); } catch { return; }
        if (message?.auth === false || message?.error) {
          deny('Live Search rejected the trade session.');
          return;
        }
        if (message?.auth === true) approve();
        if (!Array.isArray(message?.new)) return;
        const ids = [...new Set(message.new.filter((id: unknown): id is string =>
          typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
        ))];
        if (!ids.length) return;
        approve();
        const matches = ids.filter(id => !baseline.has(id));
        if (matches.length) void handlers.matches(matches, result.id).catch(() => close());
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', close);
        reject(new Error('The Live Search connection closed.'));
        if (accepted && !signal.aborted) handlers.disconnected();
      }, { once: true });
      socket.addEventListener('error', () => {
        deny('The trade site rejected or could not establish Live Search.');
      }, { once: true });
    });
    return { ready, close };
  }
}

const tradeWarnings = {
  rate_limited: 'The trade site rate-limited the request.',
  complex_query: 'The trade site rejected a complex query. Sign in or use fewer filters.',
  session_required: 'The trade site denied the request. Check session access or open the search in the browser.',
  expired: 'The trade search expired or could not be found.',
  unavailable: 'The trade site did not return results. Open the search in the browser.',
} as const;

function tradeWarning(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  let warningCode: keyof typeof tradeWarnings = 'unavailable';
  if (/\b429\b|rate limit/i.test(message)) warningCode = 'rate_limited';
  else if (/Query is too complex/i.test(message)) warningCode = 'complex_query';
  else if (/\b(401|403)\b/.test(message)) warningCode = 'session_required';
  else if (/\b404\b/.test(message)) warningCode = 'expired';
  return { warningCode, warning: tradeWarnings[warningCode] };
}

function tradeError(error: unknown): string {
  return tradeWarning(error).warning;
}
