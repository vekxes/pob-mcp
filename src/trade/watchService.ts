import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { TradeQuery } from '../types/tradeTypes.js';
import type { TradeProvider } from './provider.js';
import { tradeLink, tradeSearchBase, validateTradeSearchId } from './query.js';
import type { TradeScope } from './query.js';
import { tradeLog } from './log.js';

type SqlValue = string | number | null;
type Statement = {
  get(...values: SqlValue[]): Record<string, unknown> | undefined;
  all(...values: SqlValue[]): Record<string, unknown>[];
  run(...values: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
};
type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};
type WatchStatus = 'connecting' | 'active' | 'paused' | 'disconnected' | 'unavailable';
const watchRevisionKey = Symbol('watchRevision');
export type Watch = {
  id: string;
  label: string;
  scope: TradeScope;
  body?: TradeQuery;
  searchUrl: string;
  searchId?: string;
  status: WatchStatus;
  reason?: string;
  [watchRevisionKey]?: string;
};
export type WatchSource = Pick<Watch, 'body' | 'searchId' | 'searchUrl'>;
export type AssistantWatchAction =
  | { kind: 'create'; scope: TradeScope; source: WatchSource; label?: string }
  | { kind: 'pause' | 'remove'; watchId: string; expectedRevision: string };
export type AssistantWatchClaim = { key: string; proposalId: string; jobId: string };
export type AssistantWatchResult = { kind: AssistantWatchAction['kind']; watchId: string };
export class AssistantWatchActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function watchRevision(watch: Watch): string {
  return watch[watchRevisionKey] ?? digest(watch);
}

function withRevision(watch: Watch, revision: unknown): Watch {
  if (typeof revision === 'string') Object.defineProperty(watch, watchRevisionKey, { value: revision });
  return watch;
}

function readWatch(row: Record<string, unknown>): Watch {
  return withRevision(JSON.parse(String(row.saved)) as Watch, row.assistant_revision);
}
type ActiveWatch = {
  controller: AbortController;
  inFlight: Set<string>;
  pending: Promise<void>;
  epoch: number;
  generation: number;
};
type WatchEvent = {
  watchId: string;
  kind: 'listing' | 'match_signal';
  source: 'trade_site';
  observedAt: string;
  listingId: string;
  searchUrl: string;
  name?: string;
  price?: { amount: number; currency: string };
  mods?: string[];
};

export class WatchService extends EventEmitter {
  private readonly db: Database;
  private readonly active = new Map<string, ActiveWatch>();
  private readonly epochs = new Map<string, number>();
  private tradeSessionGeneration = 0;
  private closed = false;

  constructor(path: string, private readonly provider: Pick<TradeProvider, 'directLive' | 'subscribe' | 'fetch' | 'resolveSearch'>) {
    super();
    // node:sqlite is only required by the Node 24 companion entry point.
    const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as { DatabaseSync: new (path: string) => Database };
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, saved TEXT NOT NULL, assistant_revision TEXT);
      CREATE TABLE IF NOT EXISTS watch_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id TEXT NOT NULL,
        listing_id TEXT NOT NULL,
        body TEXT NOT NULL,
        UNIQUE (watch_id, listing_id)
      );
      CREATE TABLE IF NOT EXISTS assistant_watch_actions (
        key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        UNIQUE (job_id, proposal_id)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(watches)').all().some(column => column.name === 'assistant_revision')) {
      this.db.exec('ALTER TABLE watches ADD COLUMN assistant_revision TEXT');
    }
    const watches = this.list();
    for (const watch of watches) {
      if (watch.status === 'connecting' || watch.status === 'active') {
        this.save({ ...watch, status: 'disconnected', reason: 'The companion restarted. Select Resume to reconnect.' });
      }
    }
    tradeLog('live-search', 'store_opened', { templates: watches.length });
  }

  private save(watch: Watch): Watch {
    const saved = this.writeWatch(watch);
    this.watchChanged(saved);
    return saved;
  }

  private writeWatch(watch: Watch): Watch {
    const revision = randomBytes(32).toString('hex');
    this.db.prepare(`
      INSERT INTO watches (id, saved, assistant_revision) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET saved = excluded.saved, assistant_revision = excluded.assistant_revision
    `).run(watch.id, JSON.stringify(watch), revision);
    return withRevision({ ...watch }, revision);
  }

  private watchChanged(watch: Watch): void {
    tradeLog('live-search', 'state', { id: watch.id, status: watch.status, game: watch.scope.game, hasFilters: !!watch.body });
    this.emit('state', watch);
  }

  list(): Watch[] {
    return this.db.prepare('SELECT saved, assistant_revision FROM watches ORDER BY rowid DESC').all().map(readWatch);
  }

  private find(id: string): Watch | undefined {
    const row = this.db.prepare('SELECT saved, assistant_revision FROM watches WHERE id = ?').get(id);
    return row && readWatch(row);
  }

  private get(id: string): Watch {
    const watch = this.find(id);
    if (!watch) throw new Error('Unknown saved search.');
    return watch;
  }

  saveSearch(scope: TradeScope, body: TradeQuery, label?: string): Watch {
    return this.saveImported(scope, { body, searchUrl: tradeLink(scope, body) }, label);
  }

  saveImported(scope: TradeScope, source: WatchSource, label?: string): Watch {
    const watch = this.newWatch(scope, source, label);
    if (!watch) throw new Error('Remove a saved search before creating another.');
    return this.save(watch);
  }

  private newWatch(scope: TradeScope, source: WatchSource, label?: string): Watch | undefined {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM watches').get();
    if (Number(count?.count ?? 0) >= 200) return;
    const item = source.body?.query.name || source.body?.query.type;
    return {
      ...source, id: randomUUID(), scope,
      label: label?.trim().slice(0, 120) || (typeof item === 'string' && item.slice(0, 120)) || 'PoE Trade',
      status: 'paused',
    };
  }

  applyAssistantAction(action: AssistantWatchAction, claim: AssistantWatchClaim): AssistantWatchResult {
    const { key, jobId, proposalId } = claim;
    if (![key, jobId, proposalId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value))) {
      throw new AssistantWatchActionError(400, 'Некорректный идентификатор подтверждения.');
    }
    const actionHash = digest(action);
    let changed: Watch | undefined;
    let result: AssistantWatchResult;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare(`
        SELECT key, job_id, proposal_id, action_hash, result FROM assistant_watch_actions
        WHERE key = ? OR (job_id = ? AND proposal_id = ?)
      `).get(key, jobId, proposalId);
      if (previous) {
        if (previous.key !== key || previous.job_id !== jobId || previous.proposal_id !== proposalId
            || previous.action_hash !== actionHash) {
          throw new AssistantWatchActionError(409, 'Это подтверждение уже связано с другим применением.');
        }
        result = JSON.parse(String(previous.result)) as AssistantWatchResult;
        this.db.exec('COMMIT');
        return result;
      }
      if (action.kind === 'create') {
        const watch = this.newWatch(action.scope, action.source, action.label);
        if (!watch) throw new AssistantWatchActionError(409, 'Достигнут предел сохранённых шаблонов Live Search.');
        changed = this.writeWatch(watch);
        result = { kind: 'create', watchId: changed.id };
      } else {
        const watch = this.find(action.watchId);
        if (!watch || watchRevision(watch) !== action.expectedRevision) {
          throw new AssistantWatchActionError(409, 'Шаблон Live Search изменился. Запроси новое предложение.');
        }
        if (action.kind === 'pause') {
          if (watch.status !== 'active' && watch.status !== 'connecting') {
            throw new AssistantWatchActionError(409, 'Этот шаблон сейчас не запущен.');
          }
          changed = this.writeWatch({ ...watch, status: 'paused', reason: undefined });
        } else {
          this.db.prepare('DELETE FROM watches WHERE id = ?').run(watch.id);
        }
        result = { kind: action.kind, watchId: watch.id };
      }
      this.db.prepare('INSERT INTO assistant_watch_actions VALUES (?, ?, ?, ?, ?)')
        .run(key, jobId, proposalId, actionHash, JSON.stringify(result));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Network and UI effects follow the durable state transition and its idempotency record.
    if (result.kind !== 'create') this.stopSession(result.watchId);
    if (changed) this.watchChanged(changed);
    else this.watchRemoved(result.watchId);
    return result;
  }

  start(scope: TradeScope, body: TradeQuery, label?: string): Watch {
    if (this.provider.directLive && this.active.size >= 4) throw new Error('Pause a running search to start another.');
    return this.resume(this.saveSearch(scope, body, label).id);
  }

  resume(id: string, windowLifetime?: AbortSignal): Watch {
    windowLifetime?.throwIfAborted();
    const watch = this.get(id);
    if (this.active.has(id)) return watch;
    if (!this.provider.directLive) {
      return this.save({ ...watch, status: 'unavailable', reason: 'Use Live Search on the trade site or configure direct Live Search.' });
    }
    if (this.active.size >= 4) throw new Error('Pause a running search to start another.');
    const session = {
      controller: new AbortController(), inFlight: new Set<string>(),
      pending: Promise.resolve(), epoch: this.epochs.get(watch.id) ?? 0, generation: this.tradeSessionGeneration,
    };
    this.active.set(id, session);
    windowLifetime?.addEventListener('abort', () => {
      if (!this.closed && this.active.get(id) === session) this.stop(id);
    }, { once: true, signal: session.controller.signal });
    const connecting = this.save({ ...watch, status: 'connecting', reason: undefined });
    void this.connect(connecting, session);
    return connecting;
  }

  private async connect(watch: Watch, session: ActiveWatch): Promise<void> {
    const isCurrent = () => !this.closed && this.active.get(watch.id) === session;
    const disconnect = (reason: string) => {
      if (!isCurrent()) return;
      this.active.delete(watch.id);
      session.controller.abort();
      this.save({ ...watch, status: 'disconnected', reason });
    };
    try {
      const body = watch.body ?? (watch.searchId && await this.provider.resolveSearch(watch.scope, watch.searchId));
      if (!isCurrent()) return;
      if (!body) {
        disconnect('PoE Trade не вернул фильтры. Попробуй снова или запусти Live Search на сайте.');
        return;
      }
      if (!watch.body) watch = this.save({ ...watch, body });
      const socket = await this.provider.subscribe(watch.scope, body, {
        disconnected: () => disconnect('The trade site closed the connection. Select Resume to reconnect.'),
        matches: (ids, queryId) => isCurrent() ? this.recordMatches(watch, session, ids, queryId) : Promise.resolve(),
      }, session.controller.signal);
      try {
        await socket.ready;
        if (isCurrent()) this.save({ ...watch, status: 'active' });
      } finally {
        if (!isCurrent()) socket.close();
      }
    } catch (error) {
      disconnect(error instanceof Error ? error.message : 'Could not start Live Search.');
    }
  }

  private recordMatches(watch: Watch, session: ActiveWatch, ids: string[], queryId: string): Promise<void> {
    const seen = this.db.prepare('SELECT 1 FROM watch_events WHERE watch_id = ? AND listing_id = ?');
    const newIds = [...new Set(ids)].filter(id => !session.inFlight.has(id) && !seen.get(watch.id, id));
    if (!newIds.length) return Promise.resolve();
    newIds.forEach(id => session.inFlight.add(id));
    const received = new Date();
    const observedAt = received.toISOString();
    const detailDeadline = received.getTime() + 2_500;
    const allowed = () => !this.closed && session.generation === this.tradeSessionGeneration
      && (this.epochs.get(watch.id) ?? 0) === session.epoch;
    const operation = session.pending.then(async () => {
      for (let index = 0; index < newIds.length && allowed(); index += 10) {
        const batch = newIds.slice(index, index + 10);
        let timeout: NodeJS.Timeout | undefined;
        const remaining = detailDeadline - Date.now();
        const listings = remaining <= 0 ? [] : await Promise.race([
          this.provider.fetch(watch.scope, queryId, batch).catch(() => []),
          new Promise<[]>(resolve => { timeout = setTimeout(() => resolve([]), remaining); }),
        ]).finally(() => clearTimeout(timeout));
        if (!allowed()) break;
        const records = new Map(listings.map(listing => [listing.id, listing]));
        const insert = this.db.prepare('INSERT OR IGNORE INTO watch_events(watch_id, listing_id, body) VALUES (?, ?, ?)');
        validateTradeSearchId(queryId);
        const searchUrl = `${tradeSearchBase(watch.scope)}/${queryId}`;
        let recorded = 0;
        for (const id of batch) {
          const listing = records.get(id);
          const event: WatchEvent = {
            watchId: watch.id, listingId: id, observedAt, searchUrl, source: 'trade_site',
            kind: listing ? 'listing' : 'match_signal',
            name: listing?.name, price: listing?.price, mods: listing?.mods,
          };
          const row = insert.run(watch.id, id, JSON.stringify(event));
          if (row.changes) {
            recorded++;
            this.emit('event', { ...event, eventId: Number(row.lastInsertRowid) });
          }
        }
        if (recorded) tradeLog('live-search', 'matches_recorded', { id: watch.id, count: recorded, listings: listings.length });
      }
    }).finally(() => newIds.forEach(id => session.inFlight.delete(id)));
    session.pending = operation.catch(() => undefined);
    return operation;
  }

  stop(id: string): Watch {
    const watch = this.get(id);
    this.stopSession(id);
    return this.save({ ...watch, status: 'paused', reason: undefined });
  }

  disconnectForSessionChange(): void {
    this.tradeSessionGeneration++;
    const ids = [...this.active.keys()];
    for (const id of ids) this.stopSession(id);
    for (const id of ids) {
      try {
        this.save({ ...this.get(id), status: 'disconnected', reason: 'Сессия PoE Trade изменилась. Запусти поиск снова.' });
      } catch {
        tradeLog('live-search', 'session_change_state_failed', { id });
      }
    }
  }

  private stopSession(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    const session = this.active.get(id);
    this.active.delete(id);
    session?.controller.abort();
  }

  remove(id: string): { id: string } {
    this.get(id);
    this.stopSession(id);
    this.db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    this.watchRemoved(id);
    return { id };
  }

  private watchRemoved(id: string): void {
    tradeLog('live-search', 'template_removed', { id });
    this.emit('state');
  }

  events(after = 0, limit = 50) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('Use a nonnegative event cursor and a limit from 1 to 200.');
    }
    const events = this.db.prepare('SELECT cursor, body FROM watch_events WHERE cursor > ? ORDER BY cursor LIMIT ?')
      .all(after, limit).map(row => ({ ...JSON.parse(String(row.body)) as WatchEvent, eventId: Number(row.cursor) }));
    const latestCursor = Number(this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS latest FROM watch_events').get()?.latest ?? 0);
    return { events, nextCursor: events.at(-1)?.eventId ?? after, latestCursor };
  }

  close(): void {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    this.active.clear();
    this.db.close();
  }
}
