import { validateRealm } from './query.js';
import type { TradeRealm } from './query.js';
import { tradeLog } from './log.js';
export { scopeFromTradeUrl } from './tradeUrl.js';

type LeagueEntry = { id: string; realm?: string; text?: string };
type Catalog = { entries: LeagueEntry[]; expires: number };

export class LeagueDirectory {
  private readonly cached = new Map<TradeRealm['game'], Catalog>();
  private readonly pending = new Map<TradeRealm['game'], Promise<Catalog>>();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async refresh(game: TradeRealm['game']): Promise<Catalog> {
    const running = this.pending.get(game);
    if (running) return running;

    const request = this.fetchCatalog(game);
    this.pending.set(game, request);
    try {
      const result = await request;
      this.cached.set(game, result);
      return result;
    } finally {
      this.pending.delete(game);
    }
  }

  private async fetchCatalog(game: TradeRealm['game']): Promise<Catalog> {
    const endpoint = game === 'poe2' ? 'trade2' : 'trade';
    const response = await this.fetcher(`https://www.pathofexile.com/api/${endpoint}/data/leagues`, {
      headers: { 'User-Agent': process.env.POE_TRADE_USER_AGENT || 'pob-local-trade/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`Trade leagues returned HTTP ${response.status}.`);
    const data = await response.json() as { result?: LeagueEntry[] };
    if (!Array.isArray(data?.result) || data.result.length === 0) throw new Error('The trade site returned no league list.');
    return { entries: data.result, expires: Date.now() + 300_000 };
  }

  async list(scope: TradeRealm, force = false): Promise<{
    leagues: Array<{ id: string; label: string }>; stale: boolean;
  }> {
    validateRealm(scope);
    let catalog = this.cached.get(scope.game);
    let stale = false;
    if (force || !catalog || catalog.expires <= Date.now()) {
      const started = Date.now();
      try {
        catalog = await this.refresh(scope.game);
        tradeLog('leagues', 'catalog_loaded', { game: scope.game, count: catalog.entries.length, elapsedMs: Date.now() - started });
      } catch {
        tradeLog('leagues', 'catalog_unavailable', { game: scope.game, cached: !!catalog, elapsedMs: Date.now() - started });
        if (!catalog) throw new Error('The Path of Exile trade league list is unavailable.');
        stale = true;
      }
    }
    const leagues = new Map<string, string>();
    for (const entry of catalog.entries) {
      if (!entry || (entry.realm ?? 'pc') !== scope.realm || typeof entry.id !== 'string' || !entry.id.trim()) continue;
      if (!leagues.has(entry.id)) leagues.set(entry.id, typeof entry.text === 'string' && entry.text.trim() ? entry.text : entry.id);
    }
    return { leagues: [...leagues].map(([id, label]) => ({ id, label })), stale };
  }
}
