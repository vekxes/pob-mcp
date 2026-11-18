import Bottleneck from 'bottleneck';
import {
  TradeQuery,
  SearchResult,
  FetchResult,
  LeagueData,
  RateLimitInfo,
  CacheEntry,
  ItemListing,
  FetchedItemListing,
} from '../types/tradeTypes.js';

export function tradeModDescription(mod: unknown): string | undefined {
  if (typeof mod === 'string') return mod;
  if (!mod || typeof mod !== 'object' || !('description' in mod)) return undefined;
  return typeof mod.description === 'string' ? mod.description : undefined;
}

/**
 * GGG's /api/trade/fetch endpoint may return explicitMods/implicitMods/craftedMods
 * as plain strings or as rich objects `{ description, hash, mods: [...] }`.
 * Existing ItemListing consumers expect `string[]` for stat comparisons.
 */
export function normalizeModArray(mods: unknown): string[] {
  if (!Array.isArray(mods)) return [];
  return mods.map(mod => tradeModDescription(mod) ?? String(mod));
}

const MOD_FIELDS = ['explicitMods', 'implicitMods', 'craftedMods', 'enchantMods', 'fracturedMods', 'utilityMods'] as const;

function normalizeItemListing(listing: FetchedItemListing): ItemListing {
  if (!listing.item) return listing;
  const item = { ...listing.item };
  for (const field of MOD_FIELDS) {
    if (item[field] !== undefined) item[field] = normalizeModArray(item[field]);
  }
  return { ...listing, item };
}

/** 4xx or 429: retrying the identical request will not fix it. */
class FinalApiError extends Error {}

type TradeRequestSession = { id?: string; signal: AbortSignal };

/**
 * Client for interacting with the Path of Exile Trade API
 *
 * Features:
 * - Rate limiting (4 requests/second conservative estimate)
 * - Response caching with TTL
 * - Automatic retry with exponential backoff
 * - Rate limit header parsing
 */
export class TradeApiClient {
  private readonly baseUrl: string;
  private readonly realm?: 'xbox' | 'sony' | 'poe2';
  private readonly userAgent: string;
  private readonly fetchRequest: (url: string, options: RequestInit) => Promise<Response>;
  private readonly limiter: Bottleneck;
  #session?: TradeRequestSession;
  // Bounded LRU: entries are TTL-expiring listings/results, but TTL expiry
  // only happens on read — a client that searches many distinct queries
  // would otherwise accumulate cache entries for its whole lifetime.
  private static readonly MAX_CACHE_ENTRIES = 200;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly defaultCacheTTL: number;
  private rateLimitInfo: RateLimitInfo | null = null;
  // Transient failures (connection reset, timeout, 5xx) are retried with
  // exponential backoff. 429 is NOT retried here: the limiter hook honours
  // the server's Retry-After instead. Search POSTs are cheap and idempotent
  // in effect (a duplicate search costs one query, listings are read-only).
  private readonly retryMaxAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(options?: {
    requestsPerSecond?: number;
    cacheTTL?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    realm?: 'xbox' | 'sony' | 'poe2';
    userAgent?: string;
    session?: TradeRequestSession;
    fetchRequest?: (url: string, options: RequestInit) => Promise<Response>;
  }) {
    this.realm = options?.realm;
    this.#session = options?.session;
    this.fetchRequest = options?.fetchRequest ?? ((url, init) => fetch(url, init));
    this.baseUrl = this.realm === 'poe2'
      ? 'https://www.pathofexile.com/api/trade2'
      : 'https://www.pathofexile.com/api/trade';
    this.userAgent = options?.userAgent ?? 'pob-mcp-server/1.0';
    const requestsPerSecond = options?.requestsPerSecond || 4;
    this.defaultCacheTTL = (options?.cacheTTL || 300) * 1000; // Convert to ms
    this.retryMaxAttempts = 1 + Math.max(0, options?.maxRetries ?? 2);
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? 500;

    // Create rate limiter using token bucket algorithm
    this.limiter = new Bottleneck({
      reservoir: requestsPerSecond * 2, // Initial tokens
      reservoirRefreshAmount: requestsPerSecond,
      reservoirRefreshInterval: 1000, // Refill every second
      maxConcurrent: 1, // One request at a time
      minTime: Math.floor(1000 / requestsPerSecond), // Minimum time between requests
    });

    // Set up event handlers for better observability
    this.limiter.on('failed', async (error, jobInfo) => {
      if (error?.name === 'AbortError') return;
      const retryAfter = this.rateLimitInfo?.retryAfter;
      if (retryAfter && jobInfo.retryCount < 3) {
        console.error(`[TradeAPI] Request failed, retrying after ${retryAfter}ms (attempt ${jobInfo.retryCount + 1}/3)`);
        return retryAfter;
      }
    });

    this.limiter.on('retry', (_error, jobInfo) => {
      console.error(`[TradeAPI] Retrying request (attempt ${jobInfo.retryCount + 1})`);
    });
  }

  setSession(session: TradeRequestSession): void {
    this.#session = session;
    this.cache.clear();
  }

  /**
   * Search for items matching the given query
   */
  async searchItems(league: string, query: TradeQuery, fresh = false): Promise<SearchResult> {
    const session = this.#session;
    const cacheKey = `search:${league}:${JSON.stringify(query)}`;
    const cached = fresh ? undefined : this.getFromCache<SearchResult>(cacheKey);
    if (cached) {
      return cached;
    }

    const realm = this.realm ? `${this.realm}/` : '';
    const url = `${this.baseUrl}/search/${realm}${encodeURIComponent(league)}`;
    const result = await this.limiter.schedule(() =>
      this.makeRequest<SearchResult>('POST', url, session, query)
    );

    session?.signal.throwIfAborted();
    this.putInCache(cacheKey, result, this.defaultCacheTTL);
    return result;
  }

  async getSearchQuery(league: string, searchId: string): Promise<unknown> {
    const session = this.#session;
    const realm = this.realm ? `${this.realm}/` : '';
    const url = `${this.baseUrl}/search/${realm}${encodeURIComponent(league)}/${encodeURIComponent(searchId)}`;
    const result = await this.limiter.schedule(() => this.makeRequest<unknown>('GET', url, session, undefined, 8_000));
    session?.signal.throwIfAborted();
    return result;
  }

  /**
   * Fetch full item details for the given item IDs.
   * The Trade API caps one fetch request at 10 ids; larger lists are
   * batched into sequential requests (rate limiter already serializes them).
   */
  async fetchItems(itemIds: string[], queryId?: string): Promise<ItemListing[]> {
    return (await this.fetchRawItems(itemIds, queryId)).map(normalizeItemListing);
  }

  /** Preserve the official modifier flags and domains for listing displays. */
  async fetchRawItems(itemIds: string[], queryId?: string): Promise<FetchedItemListing[]> {
    const session = this.#session;
    if (itemIds.length === 0) {
      return [];
    }

    if (itemIds.length > 10) {
      const all: FetchedItemListing[] = [];
      for (let i = 0; i < itemIds.length; i += 10) {
        all.push(...(await this.fetchRawItems(itemIds.slice(i, i + 10), queryId)));
        session?.signal.throwIfAborted();
      }
      return all;
    }

    const cacheKey = `fetch:${queryId ?? ''}:${itemIds.join(',')}`;
    const cached = this.getFromCache<FetchedItemListing[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const idsParam = itemIds.join(',');
    const params = new URLSearchParams();
    if (queryId) params.set('query', queryId);
    if (this.realm) params.set('realm', this.realm);
    const url = `${this.baseUrl}/fetch/${idsParam}${params.size ? `?${params}` : ''}`;

    const result = await this.limiter.schedule(() =>
      this.makeRequest<FetchResult>('GET', url, session)
    );

    session?.signal.throwIfAborted();
    const items = (result.result ?? []).filter(item => item != null);
    this.putInCache(cacheKey, items, this.defaultCacheTTL);
    return items;
  }

  /**
   * Get available leagues
   * This data changes infrequently, so we cache it for 1 hour
   */
  async getLeagues(): Promise<LeagueData> {
    const session = this.#session;
    const cacheKey = 'leagues:all';
    const cached = this.getFromCache<LeagueData>(cacheKey, 3600000); // 1 hour
    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/data/leagues`;
    const result = await this.limiter.schedule(() =>
      this.makeRequest<LeagueData>('GET', url, session)
    );

    session?.signal.throwIfAborted();
    this.putInCache(cacheKey, result, 3600000); // Cache for 1 hour
    return result;
  }

  async getStatCatalog(): Promise<{ result: Array<{ entries: Array<{ id: string; text: string }> }> }> {
    type Catalog = { result: Array<{ entries: Array<{ id: string; text: string }> }> };
    const session = this.#session;
    const cacheKey = 'stats:catalog';
    const cached = this.getFromCache<Catalog>(cacheKey);
    if (cached) return cached;
    const result = await this.limiter.schedule(() => this.makeRequest<Catalog>('GET', this.baseUrl + '/data/stats', session));
    session?.signal.throwIfAborted();
    this.putInCache(cacheKey, result, 3_600_000);
    return result;
  }

  // ========================================
  // Private Methods
  // ========================================

  private async makeRequest<T>(
    method: 'GET' | 'POST',
    url: string,
    session: TradeRequestSession | undefined,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    session?.signal.throwIfAborted();
    const sessionId = session ? session.id : process.env.POE_SESSION_ID;
    const options: RequestInit = {
      method,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': this.userAgent,
        // The official Trade API rejects anonymous weighted-sum searches
        ...(sessionId ? { Cookie: `POESESSID=${sessionId}` } : {}),
      },
      // The 30s timeout lives on the per-attempt signal: without one, a
      // stalled connection blocked the whole queue (limiter maxConcurrent 1).
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    for (let attempt = 1; ; attempt++) {
      try {
        // Fresh timeout per attempt: an AbortSignal.timeout fires once, and a
        // reused (expired) signal would fail every retry instantly.
        session?.signal.throwIfAborted();
        const timeout = AbortSignal.timeout(timeoutMs);
        options.signal = session ? AbortSignal.any([session.signal, timeout]) : timeout;
        const response = await this.fetchRequest(url, options);
        session?.signal.throwIfAborted();

        // Parse rate limit headers
        this.updateRateLimitInfo(response);

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10) * 1000;
          this.rateLimitInfo = {
            limit: this.rateLimitInfo?.limit || 0,
            remaining: 0,
            retryAfter,
          };
          throw new FinalApiError(`Rate limited. Retry after ${retryAfter}ms`);
        }

        if (response.status >= 500) {
          // Cloudflare/origin flakes on the trade API are common; worth another attempt.
          const errorText = await response.text();
          throw new Error(`Trade API request failed (${response.status}): ${errorText}`);
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new FinalApiError(`Trade API request failed (${response.status}): ${errorText}`);
        }

        const data = await response.json() as T;
        session?.signal.throwIfAborted();
        return data;
      } catch (error) {
        session?.signal.throwIfAborted();
        // Network/timeout rejections (fetch throws TypeError/TimeoutError) and
        // 5xx arrive here as retryable; 4xx/429 are FinalApiError.
        if (error instanceof FinalApiError || attempt >= this.retryMaxAttempts) {
          throw error;
        }
        const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
        console.error(`[TradeAPI] transient failure, retrying in ${delayMs}ms (attempt ${attempt}/${this.retryMaxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private updateRateLimitInfo(response: Response): void {
    const limitHeader = response.headers.get('X-Rate-Limit-Ip');
    const stateHeader = response.headers.get('X-Rate-Limit-Ip-State');
    const retryAfterHeader = response.headers.get('Retry-After');

    if (limitHeader && stateHeader) {
      // Parse format: "limit:max:period"
      const [, maxRequests] = limitHeader.split(':').map(Number);
      // Parse format: "current:max:period"
      const [current] = stateHeader.split(':').map(Number);

      this.rateLimitInfo = {
        limit: maxRequests || 0,
        remaining: Math.max(0, (maxRequests || 0) - (current || 0)),
        retryAfter: retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : undefined,
      };
    }
  }

  private getFromCache<T>(key: string, customTTL?: number): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    const expiresAt = customTTL !== undefined ? entry.timestamp + customTTL : entry.expiresAt;
    if (now > expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Map iteration order is insertion order: re-inserting on hit makes the
    // eviction below drop stale-by-use entries instead of stale-by-insertion.
    this.cache.delete(key);
    this.cache.set(key, entry);

    // The key encodes the request shape, so hits always hold this T; the cache
    // itself only stores `unknown` envelopes.
    return entry.data as T;
  }

  private putInCache<T>(key: string, data: T, ttl: number): void {
    const now = Date.now();
    this.cache.set(key, {
      data,
      timestamp: now,
      expiresAt: now + ttl,
    });
    while (this.cache.size > TradeApiClient.MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}
