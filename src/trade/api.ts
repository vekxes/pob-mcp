import { PobAdapter } from './pobAdapter.js';
import type { PobPaths } from './integrationSettings.js';
import { LeagueDirectory } from './leagues.js';
import { scopeFromTradeUrl, tradeSearchFromUrl } from './tradeUrl.js';
import type { BuildSource, BuildTrade } from './pobAdapter.js';
import { TradeProvider } from './provider.js';
import { buildTradeQuery, validateScope, validateTradeBody } from './query.js';
import type { SearchFilters, TradeRealm, TradeScope } from './query.js';
import type { TradeQuery } from '../types/tradeTypes.js';
import { WatchService } from './watchService.js';
import type { WatchSource } from './watchService.js';
import { PobSetService } from './assistant/pobSets.js';
import { BuildNoteError, BuildNotesService } from './assistant/buildNotes.js';
import type { BrowserSessionStatus, BrowserTradeSession } from './browserSession.js';

const object = { type: 'object' } as const;
const string = { type: 'string' } as const;
const number = { type: 'number' } as const;
const budget = { ...object, properties: { currency: string, min: number, max: number },
  description: 'Omit currency for the trade site’s equivalent unit when min or max is supplied.' };
const scope = { ...object, properties: {
  game: { enum: ['poe1', 'poe2'] },
  realm: { enum: ['pc', 'xbox', 'sony', 'poe2'] },
  league: string,
}, required: ['game', 'realm', 'league'] };
const queryProperties = {
  scope, name: string, base: string, budget,
  status: { enum: ['available', 'online', 'onlineleague', 'securable', 'any'] },
  sort: { enum: ['asc', 'desc'] },
  mods: { type: 'array', items: { ...object, properties: { id: string, min: number, max: number }, required: ['id'] } },
  body: { ...object, description: 'A request body from trade_for_build. Use instead of name, base and mods.' },
};
const buildIdentity = { buildId: string, revision: string };

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, description, inputSchema: { ...object, properties, required } };
}

export const tradeTools = [
  tool('trade_list_leagues', 'List current leagues from the trade site in site order for the requested game and platform.', {
    game: scope.properties.game, realm: scope.properties.realm, refresh: { type: 'boolean' },
  }, ['game', 'realm']),
  tool('trade_scope_from_url', 'Read the exact game, platform and league selected in an official trade search URL.', {
    url: string,
  }, ['url']),
  tool('trade_search', 'Find current item listings or build an official trade-site link.', {
    ...queryProperties, limit: { type: 'integer', minimum: 1, maximum: 20 }, linkOnly: { type: 'boolean' },
  }, ['scope']),
  tool('trade_find_stats', 'Resolve a modifier name to candidate trade stat IDs.', { scope, text: string }, ['scope', 'text']),
  tool('trade_import_build', 'Import a PoB build into the local companion.', { kind: { enum: ['file', 'link', 'code', 'xml'] }, value: string, name: string }, ['kind', 'value']),
  tool('trade_for_build', 'Generate matching or native weighted searches for selected PoB gear slots.', {
    ...buildIdentity, scope, mode: { enum: ['match', 'upgrade'] }, slots: { type: 'array', items: string }, budget, budgets: object,
  }, ['buildId', 'revision', 'scope', 'mode']),
  tool('trade_simulate_item', 'Compare an item with the current item in a specific slot using PoB.', {
    ...buildIdentity, slot: string, itemText: string,
  }, ['buildId', 'revision', 'slot', 'itemText']),
  tool('trade_watch_save', 'Save a Live Search template for manual activation.', { ...queryProperties, label: string }, ['scope']),
  tool('trade_watch_import', 'Save a Live Search template from an official PoE Trade search URL.', { url: string, label: string }, ['url']),
  tool('trade_watch_start', 'Create a saved search and start Live Search when a provider is configured.', { ...queryProperties, label: string }, ['scope']),
  tool('trade_watch_stop', 'Pause a saved search.', { watchId: string }, ['watchId']),
  tool('trade_watch_resume', 'Resume a saved search.', { watchId: string }, ['watchId']),
  tool('trade_watch_remove', 'Remove a saved search from the active list.', { watchId: string }, ['watchId']),
  tool('trade_watch_list', 'Show saved searches and their current connection status.', {}),
  tool('trade_watch_events', 'Read the shared Live Search journal after an optional cursor.', { after: { type: 'integer' }, limit: { type: 'integer' } }),
];

export class TradeApi {
  readonly provider: TradeProvider;
  readonly watches: WatchService;
  readonly pobSets: PobSetService;
  readonly buildNotes: BuildNotesService;
  researchBuild(input: { buildId: string; revision: string }) {
    return this.pob.researchProfile(input);
  }
  private readonly leagues = new LeagueDirectory();
  private readonly pob: PobAdapter;

  constructor(databasePath: string, browserSession?: BrowserTradeSession, pobPaths?: () => PobPaths) {
    this.provider = new TradeProvider(browserSession);
    this.watches = new WatchService(databasePath, this.provider);
    this.pob = new PobAdapter((scope, mods) => this.provider.resolveMods(scope, mods), pobPaths);
    let notes: BuildNotesService | undefined;
    try {
      this.buildNotes = notes = new BuildNotesService(databasePath);
      this.pobSets = new PobSetService(databasePath, this.pob);
    } catch (error) {
      notes?.close();
      this.watches.close();
      throw error;
    }
  }

  updateBrowserSession(status: BrowserSessionStatus): void {
    this.provider.updateBrowserSession(status);
    this.watches.disconnectForSessionChange();
  }

  private notesRevision(buildId: unknown, revision: unknown): string {
    if (typeof buildId !== 'string' || !/^[a-f0-9]{24}$/.test(buildId)
        || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
      throw new BuildNoteError(400, 'Проверь идентификатор открытого билда.');
    }
    if (!this.pob.hasBuild(buildId, revision)) {
      throw new BuildNoteError(404, 'Открой билд снова, чтобы получить его заметки.');
    }
    return revision;
  }

  readBuildNotes(buildId: unknown, revision: unknown) {
    return this.buildNotes.read(this.notesRevision(buildId, revision));
  }

  listBuildFiles(): Promise<string[]> {
    return this.pob.listBuildFiles();
  }

  replaceBuildNotes({ buildId, revision, expectedVersion, text }: Record<string, unknown>) {
    if ((expectedVersion !== null && typeof expectedVersion !== 'string') || typeof text !== 'string') {
      throw new BuildNoteError(400, 'Проверь текст и версию заметок.');
    }
    return this.buildNotes.replace(this.notesRevision(buildId, revision), expectedVersion, text);
  }

  private requestBody(input: SearchFilters & { body?: TradeQuery }): TradeQuery {
    validateScope(input.scope);
    if (input.body === undefined) return buildTradeQuery(input);
    const body = input.body;
    validateTradeBody(body);
    return body;
  }

  async previewWatchImport(url: string): Promise<{ scope: TradeScope } & WatchSource> {
    const imported = tradeSearchFromUrl(url);
    const body = imported.searchId ? await this.provider.resolveSearch(imported.scope, imported.searchId) : imported.body;
    return { ...imported, body };
  }

  async call(name: string, args: Record<string, unknown>, windowLifetime?: AbortSignal): Promise<unknown> {
    const spec = tradeTools.find(item => item.name === name);
    if (!spec) throw new Error('Unknown Trade MCP tool.');
    for (const key of spec.inputSchema.required) {
      if (!Object.hasOwn(args, key) || args[key] == null) throw new Error(`Missing ${key}.`);
    }
    const search = args as unknown as SearchFilters & { body?: TradeQuery };
    switch (name) {
      case 'trade_list_leagues':
        return this.leagues.list(args as unknown as TradeRealm, args.refresh === true);
      case 'trade_scope_from_url':
        return { scope: scopeFromTradeUrl(args.url as string) };
      case 'trade_search': {
        const limit = args.limit === undefined ? 10 : args.limit;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Choose a listing limit from 1 to 20.');
        const body = this.requestBody(search);
        return { scope: search.scope, body, ...await this.provider.search(search.scope, body, limit, args.linkOnly === true) };
      }
      case 'trade_find_stats': {
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 200) throw new Error('Enter a modifier name.');
        return { stats: await this.provider.stats(args.scope as TradeScope, args.text.trim()) };
      }
      case 'trade_import_build':
        return this.pob.importBuild(args as unknown as BuildSource);
      case 'trade_for_build':
        return this.pob.prepare(args as unknown as BuildTrade);
      case 'trade_simulate_item':
        return this.pob.simulate(args as Parameters<PobAdapter['simulate']>[0]);
      case 'trade_watch_save':
        return this.watches.saveSearch(search.scope, this.requestBody(search), args.label as string | undefined);
      case 'trade_watch_import': {
        const imported = await this.previewWatchImport(args.url as string);
        return this.watches.saveImported(imported.scope, imported, args.label as string | undefined);
      }
      case 'trade_watch_start':
        return this.watches.start(search.scope, this.requestBody(search), args.label as string | undefined);
      case 'trade_watch_stop':
        return this.watches.stop(String(args.watchId));
      case 'trade_watch_resume':
        return this.watches.resume(String(args.watchId), windowLifetime);
      case 'trade_watch_remove':
        return this.watches.remove(String(args.watchId));
      case 'trade_watch_list':
        return { watches: this.watches.list(), directLive: this.provider.directLive };
      case 'trade_watch_events':
        return this.watches.events(args.after as number | undefined, args.limit as number | undefined);
    }
  }

  async close(): Promise<void> {
    this.buildNotes.close();
    this.pobSets.close();
    this.watches.close();
    await this.pob.close();
  }
}
