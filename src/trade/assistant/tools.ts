import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TradeApi } from '../api.js';
import type { PobAdapter } from '../pobAdapter.js';
import { validateBudget } from '../query.js';
import type { Budget, TradeScope } from '../query.js';
import type { WatchService } from '../watchService.js';
import { watchRevision } from '../watchService.js';
import type { AssistantStoredResult } from './dispatcher.js';
import type { PobSetDraft, PobSetService } from './pobSets.js';
import { ResearchGgg } from './researchGgg.js';
import { ResearchNinja, ninjaPriceCategories } from './researchNinja.js';
import type { NinjaPriceCategory } from './researchNinja.js';
import { researchSource } from './research.js';
import type { ResearchSource } from './research.js';

export type AssistantNamespace = 'pob' | 'trade';
export type AssistantContext = {
  scope: TradeScope;
  buildId?: string;
  revision?: string;
  slots?: string[];
  buildOptions?: Pick<PobSetDraft, 'mode' | 'budget' | 'budgets'>;
};
type AssistantReadApi = Pick<TradeApi, 'call' | 'previewWatchImport' | 'researchBuild'> & { pobSets: Pick<PobSetService, 'list'> };
type RecordResult = (kind: AssistantStoredResult['kind'], data: unknown) => string;
type RecordSource = (source: ResearchSource) => void;

const MAX_SLOTS = 24;
const MAX_WATCHES = 50;
const ninja = new ResearchNinja();
const official = new ResearchGgg();
const officialKinds = ['currency_exchange', 'league', 'ladder', 'equipment_sample'] as const;

export const assistantTools: Record<AssistantNamespace, Tool[]> = {
  pob: [{
    name: 'prepare_slots',
    description: 'Prepare PoB trade searches for the selected build and league. Use match for similar gear or upgrade for weighted improvements. Omit budget to use the current shared budget. A supplied budget overrides the shared budget only; saved per-slot budgets still take priority.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { enum: ['match', 'upgrade'] },
        slots: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 120 }, minItems: 1, maxItems: MAX_SLOTS },
        budget: {
          type: 'object',
          properties: {
            currency: { type: 'string', pattern: '^[a-z0-9_-]{1,40}$', description: 'Omit for equivalent price limits.' },
            min: { type: 'number', minimum: 0 },
            max: { type: 'number', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  }, {
    name: 'list_sets',
    description: 'List saved PoB sets across leagues with their names, identifiers, slots, mode and budgets. Use the resultRef and set id to propose opening, renaming or deleting a set.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'describe_build',
    description: 'Read the opened PoB revision: class, ascendancy, skills, equipped items and key calculated stats. No build export.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
  trade: [{
    name: 'list_watches',
    description: 'List saved Live Search templates and their current statuses for the selected league.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'describe_trade_link',
    description: 'Preview an official PoE Trade search link supplied by the user. Returns its scope and whether filters are available. Use the resultRef to propose importing a template.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', minLength: 1, maxLength: 60_000 } },
      required: ['url'],
      additionalProperties: false,
    },
  }, {
    name: 'ninja_prices',
    description: 'Read public poe.ninja economy estimates for the selected league and exact item or currency names. Price and listing observations are not usage statistics.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        category: { enum: [...ninjaPriceCategories] },
        names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
      },
      required: ['category'],
      additionalProperties: false,
    },
  }, {
    name: 'official_statistics',
    description: 'Read the official GGG currency-exchange statistics for the current game and league, optionally filtered by a currency. League and ladder access report the official availability. Exchange volumes are not character equipment usage.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { enum: [...officialKinds] },
        text: { type: 'string', maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  }],
};

const toolErrors = {
  unknown_tool: 'This operation is unavailable to the assistant.',
  invalid_arguments: 'Choose supported arguments within the selected PoB context.',
  build_required: 'Import a PoB build in the application before preparing trades.',
  pob_unsupported_game: 'The current PoB engine supports Path of Exile 1 builds.',
  pob_unavailable: 'PoB could not prepare searches for the selected build.',
  pob_sets_unavailable: 'The saved PoB sets could not be read.',
  trade_unavailable: 'The local Trade service could not list the saved templates.',
  trade_link_invalid: 'Paste an official PoE Trade link for a completed search.',
  trade_link_not_provided: 'Use the complete trade link supplied in the current request.',
  research_disabled: 'Enable web and public-data research in the app for this operation.',
  ninja_unavailable: 'The documented poe.ninja economy endpoint did not provide data for that category and league.',
  official_unavailable: 'The official Path of Exile data is unavailable for that request.',
} as const;

export type AssistantToolErrorCode = keyof typeof toolErrors;

export function isAssistantToolErrorCode(value: unknown): value is AssistantToolErrorCode {
  return typeof value === 'string' && Object.hasOwn(toolErrors, value);
}

export class AssistantToolError extends Error {
  constructor(readonly code: AssistantToolErrorCode) {
    super(toolErrors[code]);
    this.name = 'AssistantToolError';
  }
}

export function isAssistantNamespace(value: unknown): value is AssistantNamespace {
  return value === 'pob' || value === 'trade';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnly(object: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(object).every(key => keys.includes(key));
}

function isSlot(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && !!value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function isBudget(value: unknown): value is Budget {
  if (!isObject(value) || !hasOnly(value, ['currency', 'min', 'max'])) return false;
  try { validateBudget(value); return true; }
  catch { return false; }
}

function displayText(value: string, length: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length);
}

async function prepareSlots(
  api: Pick<TradeApi, 'call'>,
  context: AssistantContext,
  args: Record<string, unknown>,
  recordResult?: RecordResult,
) {
  const { mode, budget } = args;
  const slots = args.slots === undefined ? context.slots : args.slots;
  if (!hasOnly(args, ['mode', 'slots', 'budget']) || (mode !== 'match' && mode !== 'upgrade')
      || (budget !== undefined && !isBudget(budget))) {
    throw new AssistantToolError('invalid_arguments');
  }
  if (slots !== undefined && (!Array.isArray(slots) || !slots.length || slots.length > MAX_SLOTS
      || !slots.every(slot => isSlot(slot) && (!context.slots || context.slots.includes(slot))))) {
    throw new AssistantToolError('invalid_arguments');
  }
  if (context.scope.game !== 'poe1') throw new AssistantToolError('pob_unsupported_game');
  if (!context.buildId || !context.revision) throw new AssistantToolError('build_required');
  const defaultBudget = budget ?? context.buildOptions?.budget;
  const slotBudgets = Object.entries(context.buildOptions?.budgets ?? {}).filter(([slot]) => !slots || slots.includes(slot));
  const result = await api.call('trade_for_build', {
    scope: context.scope, buildId: context.buildId, revision: context.revision, mode,
    ...(slots && { slots: [...new Set(slots)] }),
    ...(defaultBudget !== undefined && { budget: defaultBudget }),
    ...(slotBudgets.length > 0 && { budgets: Object.fromEntries(slotBudgets) }),
  }).catch(() => { throw new AssistantToolError('pob_unavailable'); }) as Awaited<ReturnType<PobAdapter['prepare']>>;
  const rows = result.rows.slice(0, MAX_SLOTS).map(row => {
    const trade = 'body' in row ? row.body.query.filters?.trade_filters : undefined;
    const price = trade?.disabled ? undefined : trade?.filters?.price;
    const effectiveBudget = price && {
      ...(price.option !== undefined && { currency: price.option }),
      ...(price.min !== undefined && { min: price.min }),
      ...(price.max !== undefined && { max: price.max }),
    };
    return {
      slot: displayText(row.slot, 120),
      item: row.item ? displayText(row.item, 180) : null,
      ready: 'link' in row && Boolean(row.link),
      warningCount: row.warnings.length,
      ...(isBudget(effectiveBudget) && { budget: effectiveBudget }),
    };
  });
  const resultRef = recordResult?.('pob', result);
  return { mode, ...(defaultBudget !== undefined && { budget: defaultBudget }), rows, ...(resultRef !== undefined && { resultRef }) };
}

async function listWatches(api: Pick<TradeApi, 'call'>, context: AssistantContext, args: Record<string, unknown>, recordResult?: RecordResult) {
  if (Object.keys(args).length) throw new AssistantToolError('invalid_arguments');
  const result = await api.call('trade_watch_list', {}).catch(() => {
    throw new AssistantToolError('trade_unavailable');
  }) as { watches: ReturnType<WatchService['list']>; directLive: boolean };
  const { game, realm, league } = context.scope;
  const watches = result.watches.filter(watch =>
    watch.scope.game === game && watch.scope.realm === realm && watch.scope.league === league
  );
  const snapshot = watches.slice(0, MAX_WATCHES).map(watch => ({
    id: watch.id, label: displayText(watch.label, 120), scope: { game, realm, league },
    status: watch.status, revision: watchRevision(watch),
  }));
  const resultRef = recordResult?.('watch_list', { watches: snapshot });
  return {
    directLive: result.directLive,
    count: watches.length,
    truncated: watches.length > MAX_WATCHES,
    watches: snapshot.map(({ id, label, scope, status }) => ({ id, label, scope, status })),
    ...(resultRef !== undefined && { resultRef }),
  };
}

async function describeTradeLink(api: AssistantReadApi, args: Record<string, unknown>, recordResult?: RecordResult) {
  const { url } = args;
  if (!hasOnly(args, ['url']) || typeof url !== 'string' || !url.trim() || url.length > 60_000) {
    throw new AssistantToolError('invalid_arguments');
  }
  const preview = await api.previewWatchImport(url).catch(() => { throw new AssistantToolError('trade_link_invalid'); });
  const resultRef = recordResult?.('trade_link', preview);
  return {
    scope: preview.scope, filtersAvailable: !!preview.body,
    ...(resultRef !== undefined && { resultRef }),
  };
}

function listPobSets(api: AssistantReadApi, args: Record<string, unknown>, recordResult?: RecordResult) {
  if (Object.keys(args).length) throw new AssistantToolError('invalid_arguments');
  let all: ReturnType<PobSetService['list']>;
  try { all = api.pobSets.list(); }
  catch { throw new AssistantToolError('pob_sets_unavailable'); }
  const sets = all.slice(0, 50);
  const resultRef = recordResult?.('pob_set_list', { sets });
  return {
    count: all.length,
    truncated: sets.length < all.length,
    sets: sets.map(({ id, label, buildLabel, scope, mode, slots, budget, budgets }) =>
      ({ id, label, buildLabel, scope, mode, slots, budget, budgets })),
    ...(resultRef !== undefined && { resultRef }),
  };
}

async function describeBuild(api: AssistantReadApi, context: AssistantContext, args: Record<string, unknown>) {
  if (Object.keys(args).length) throw new AssistantToolError('invalid_arguments');
  if (context.scope.game !== 'poe1') throw new AssistantToolError('pob_unsupported_game');
  if (!context.buildId || !context.revision) throw new AssistantToolError('build_required');
  return api.researchBuild({ buildId: context.buildId, revision: context.revision })
    .catch(() => { throw new AssistantToolError('pob_unavailable'); });
}

async function ninjaPrices(context: AssistantContext, args: Record<string, unknown>, recordSource: RecordSource) {
  const { category, names } = args;
  if (!hasOnly(args, ['category', 'names']) || !ninjaPriceCategories.some(value => value === category)
      || (names !== undefined && (!Array.isArray(names) || !names.length || names.length > 10
        || !names.every(name => typeof name === 'string' && !!name.trim() && name.length <= 120)))) {
    throw new AssistantToolError('invalid_arguments');
  }
  const data = await ninja.prices(context.scope, { category: category as NinjaPriceCategory, names })
    .catch(() => { throw new AssistantToolError('ninja_unavailable'); });
  const source = researchSource('economy', data.source.url, data.source.title);
  if (source) recordSource(source);
  return data;
}

async function officialStatistics(context: AssistantContext, args: Record<string, unknown>, recordSource: RecordSource) {
  const { kind, text, limit } = args;
  if (!hasOnly(args, ['kind', 'text', 'limit']) || !officialKinds.some(value => value === kind)
      || (text !== undefined && (typeof text !== 'string' || text.length > 100))
      || (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20))) {
    throw new AssistantToolError('invalid_arguments');
  }
  const data = await official.lookup(context.scope, { kind: kind as typeof officialKinds[number], text, limit })
    .catch(() => { throw new AssistantToolError('official_unavailable'); });
  const source = researchSource('official', data.source.url, data.status === 'ok' ? 'GGG · публичная статистика' : 'GGG · документация API');
  if (source) recordSource(source);
  return data;
}

export async function callAssistantTool(
  api: AssistantReadApi,
  context: AssistantContext,
  input: unknown,
  recordResult?: RecordResult,
  recordSource?: RecordSource,
): Promise<Record<string, unknown>> {
  if (!isObject(input) || !hasOnly(input, ['namespace', 'name', 'args']) || !isObject(input.args)) {
    throw new AssistantToolError('invalid_arguments');
  }
  const { namespace, name, args } = input;
  if (namespace === 'pob' && name === 'prepare_slots') return prepareSlots(api, context, args, recordResult);
  if (namespace === 'pob' && name === 'list_sets') return listPobSets(api, args, recordResult);
  if (namespace === 'trade' && name === 'list_watches') return listWatches(api, context, args, recordResult);
  if (namespace === 'trade' && name === 'describe_trade_link') return describeTradeLink(api, args, recordResult);
  if (namespace === 'pob' && name === 'describe_build') {
    if (!recordSource) throw new AssistantToolError('research_disabled');
    return describeBuild(api, context, args);
  }
  if (namespace === 'trade' && name === 'ninja_prices') {
    if (!recordSource) throw new AssistantToolError('research_disabled');
    return ninjaPrices(context, args, recordSource);
  }
  if (namespace === 'trade' && name === 'official_statistics') {
    if (!recordSource) throw new AssistantToolError('research_disabled');
    return officialStatistics(context, args, recordSource);
  }
  throw new AssistantToolError('unknown_tool');
}
