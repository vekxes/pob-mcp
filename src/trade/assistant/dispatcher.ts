import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TradeQuery } from '../../types/tradeTypes.js';
import { tradeLink, validateScope, validateTradeBody } from '../query.js';
import type { TradeScope } from '../query.js';
import { tradeBodyFromPayload, tradeSearchFromUrl } from '../tradeUrl.js';
import type { AssistantWatchAction } from '../watchService.js';
import type { AssistantContext } from './tools.js';
import { validatePobSetDraft } from './pobSets.js';
import type { PobSetAction, PobSetDraft, PobSetSummary } from './pobSets.js';

export type AssistantStoredResult = { kind: 'pob' | 'trade_link' | 'watch_list' | 'pob_set_list'; data: unknown };

type ModelProposal =
  | { kind: 'save_watch_from_result'; resultRef: string; slot: string; label: string | null }
  | { kind: 'import_watch_link'; resultRef: string; label: string | null }
  | { kind: 'pause_watch' | 'remove_watch'; resultRef: string; watchId: string }
  | { kind: 'save_pob_set'; label: string }
  | { kind: 'open_pob_set' | 'remove_pob_set'; resultRef: string; setId: string }
  | { kind: 'rename_pob_set'; resultRef: string; setId: string; label: string };

export type AssistantReply = { version: 1; message: string; resultRefs: string[]; proposals: ModelProposal[] };

export type AssistantProposal = {
  id: string;
  kind: ModelProposal['kind'];
  label: string;
  scope: TradeScope;
  slot?: string;
  status?: string;
  filtersAvailable?: boolean;
  searchUrl?: string;
  setLabel?: string;
  buildLabel?: string;
  slots?: PobSetDraft['slots'];
  mode?: PobSetDraft['mode'];
  budget?: PobSetDraft['budget'];
  budgets?: PobSetDraft['budgets'];
  action: AssistantWatchAction | PobSetAction;
};

const statuses = new Set(['connecting', 'active', 'paused', 'disconnected', 'unavailable']);

export class AssistantReplyError extends Error {
  constructor(message = 'Codex вернул ответ с неверной структурой или предложил действие без проверенного результата.') {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 120): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function sameScope(left: TradeScope, right: TradeScope): boolean {
  return left.game === right.game && left.realm === right.realm && left.league === right.league;
}

function scopeFrom(object: unknown): TradeScope {
  if (!record(object)) throw new AssistantReplyError();
  const scope = { game: object.game, realm: object.realm, league: object.league } as TradeScope;
  validateScope(scope);
  return scope;
}

function parseProposal(value: unknown): ModelProposal {
  if (!record(value)) throw new AssistantReplyError();
  const { kind, resultRef, slot, label, watchId, setId } = value;
  const size = Object.keys(value).length;
  if (kind === 'save_pob_set' && size === 2 && text(label)) return { kind, label: label.trim() };
  if (!text(resultRef)) throw new AssistantReplyError();
  if (text(setId)) {
    if ((kind === 'open_pob_set' || kind === 'remove_pob_set') && size === 3) return { kind, resultRef, setId };
    if (kind === 'rename_pob_set' && size === 4 && text(label)) return { kind, resultRef, setId, label: label.trim() };
  }
  if (kind === 'pause_watch' || kind === 'remove_watch') {
    if (size === 3 && text(watchId)) return { kind, resultRef, watchId };
    throw new AssistantReplyError();
  }
  if (label === null || text(label)) {
    if (kind === 'import_watch_link' && size === 3) return { kind, resultRef, label };
    if (kind === 'save_watch_from_result' && size === 4 && text(slot)) return { kind, resultRef, slot, label };
  }
  throw new AssistantReplyError();
}

export function pobSetDraft(context: AssistantContext): PobSetDraft | undefined {
  if (!context.buildId || !context.revision || !context.slots?.length || !context.buildOptions) return;
  return validatePobSetDraft({
    ...context.buildOptions, scope: context.scope, buildId: context.buildId, revision: context.revision, slots: context.slots,
  });
}

function setPreview({ scope, mode, slots, budget, budgets }: PobSetDraft | PobSetSummary) {
  return { scope, mode, slots, ...(budget && { budget }), ...(budgets && { budgets }) };
}

function trustedProposal(proposal: ModelProposal, snapshots: ReadonlyMap<string, AssistantStoredResult>, context: AssistantContext): AssistantProposal {
  const base = { id: randomUUID(), kind: proposal.kind };
  if (proposal.kind === 'save_pob_set') {
    const draft = pobSetDraft(context);
    if (!draft) throw new AssistantReplyError('Загрузи билд PoB и выбери слоты, чтобы сохранить комплект.');
    return { ...base, ...setPreview(draft), label: proposal.label, action: { kind: proposal.kind, label: proposal.label, draft } };
  }
  const snapshot = snapshots.get(proposal.resultRef);
  if (!snapshot || !record(snapshot.data)) throw new AssistantReplyError();
  const data = snapshot.data;
  if ('setId' in proposal) {
    if (snapshot.kind !== 'pob_set_list' || !Array.isArray(data.sets)) throw new AssistantReplyError();
    const target = data.sets.find(set => record(set) && set.id === proposal.setId) as PobSetSummary | undefined;
    if (!target || !text(target.version) || !text(target.label)) throw new AssistantReplyError();
    const subject = { setId: target.id, expectedVersion: target.version };
    const action: PobSetAction = proposal.kind === 'rename_pob_set'
      ? { kind: proposal.kind, ...subject, label: proposal.label }
      : { kind: proposal.kind, ...subject };
    return {
      ...base, ...setPreview(target), setLabel: target.label, buildLabel: target.buildLabel,
      label: proposal.kind === 'rename_pob_set' ? proposal.label : target.label, action,
    };
  }
  if (proposal.kind === 'save_watch_from_result') {
    if (snapshot.kind !== 'pob' || !context.buildId || !context.revision
        || data.buildId !== context.buildId || data.revision !== context.revision || !Array.isArray(data.rows)
        || (context.slots && !context.slots.includes(proposal.slot))) throw new AssistantReplyError();
    const row: unknown = data.rows.find(row => record(row) && row.slot === proposal.slot);
    if (!record(row) || !record(row.body)) throw new AssistantReplyError();
    const scope = scopeFrom(row.scope);
    if (!sameScope(scope, context.scope)) throw new AssistantReplyError();
    const body = row.body as unknown as TradeQuery;
    validateTradeBody(body);
    const searchUrl = tradeLink(scope, body);
    if (row.link !== searchUrl) throw new AssistantReplyError();
    const label = proposal.label?.trim() || (text(row.item, 240) ? `${proposal.slot} · ${row.item}`.slice(0, 120) : proposal.slot);
    const price = body.query.filters?.trade_filters?.filters?.price;
    const budget = price && (price.option !== undefined || price.min !== undefined || price.max !== undefined) ? {
      ...(price.option !== undefined && { currency: price.option }),
      ...(price.min !== undefined && { min: price.min }),
      ...(price.max !== undefined && { max: price.max }),
    } : undefined;
    return {
      ...base, label, scope, slot: proposal.slot, filtersAvailable: true, ...(budget && { budget }),
      action: { kind: 'create', scope, source: { body, searchUrl }, label },
    };
  }
  if (proposal.kind === 'import_watch_link') {
    if (snapshot.kind !== 'trade_link' || typeof data.searchUrl !== 'string') throw new AssistantReplyError();
    const parsed = tradeSearchFromUrl(data.searchUrl);
    const scope = scopeFrom(data.scope);
    if (parsed.searchUrl !== data.searchUrl || parsed.searchId !== data.searchId || !sameScope(scope, parsed.scope)) {
      throw new AssistantReplyError();
    }
    const body = data.body === undefined ? undefined : tradeBodyFromPayload(data.body);
    if (parsed.body && JSON.stringify(parsed.body) !== JSON.stringify(body)) throw new AssistantReplyError();
    const item = body?.query.name || body?.query.type;
    const label = proposal.label?.trim() || (text(item, 240) ? item.slice(0, 120) : 'PoE Trade');
    return {
      ...base, label, scope, filtersAvailable: !!body, searchUrl: parsed.searchUrl,
      action: {
        kind: 'create', scope, label,
        source: { searchUrl: parsed.searchUrl, ...(parsed.searchId && { searchId: parsed.searchId }), ...(body && { body }) },
      },
    };
  }
  if (snapshot.kind !== 'watch_list' || !Array.isArray(data.watches)) throw new AssistantReplyError();
  const watch: unknown = data.watches.find(watch => record(watch) && watch.id === proposal.watchId);
  if (!record(watch) || !text(watch.label) || typeof watch.status !== 'string' || !statuses.has(watch.status)
      || typeof watch.revision !== 'string' || !/^[a-f0-9]{64}$/.test(watch.revision)) throw new AssistantReplyError();
  const scope = scopeFrom(watch.scope);
  if (!sameScope(scope, context.scope)) throw new AssistantReplyError();
  if (proposal.kind === 'pause_watch' && watch.status !== 'active' && watch.status !== 'connecting') {
    throw new AssistantReplyError('Этот шаблон Live Search сейчас не запущен.');
  }
  return {
    ...base, label: watch.label, scope, status: watch.status,
    action: {
      kind: proposal.kind === 'pause_watch' ? 'pause' : 'remove',
      watchId: proposal.watchId, expectedRevision: watch.revision,
    },
  };
}

export function validateAssistantReply(
  value: unknown, available: ReadonlyMap<string, AssistantStoredResult>, context: AssistantContext,
): { response: AssistantReply; proposals: AssistantProposal[] } {
  if (!record(value) || Object.keys(value).length !== 4 || value.version !== 1
      || typeof value.message !== 'string' || !value.message.trim() || value.message.length > 12_000
      || !Array.isArray(value.proposals) || value.proposals.length > 6
      || !Array.isArray(value.resultRefs) || value.resultRefs.length > 10
      || new Set(value.resultRefs).size !== value.resultRefs.length
      || !value.resultRefs.every(ref => typeof ref === 'string' && available.has(ref))) throw new AssistantReplyError();

  const targets = new Set<string>();
  try {
    const modelProposals = value.proposals.map(parseProposal);
    const proposals = modelProposals.map(proposal => {
      const trusted = trustedProposal(proposal, available, context);
      const { action, slot } = trusted;
      const target = action.kind === 'create' ? `create:${slot ?? ''}:${action.source.searchUrl}`
        : action.kind === 'save_pob_set' ? 'save_pob_set'
        : 'setId' in action ? `set:${action.setId}` : `watch:${action.watchId}`;
      if (targets.has(target)) throw new AssistantReplyError();
      targets.add(target);
      return trusted;
    });
    return { response: { version: 1, message: value.message, resultRefs: value.resultRefs, proposals: modelProposals }, proposals };
  } catch (error) {
    if (error instanceof AssistantReplyError) throw error;
    throw new AssistantReplyError();
  }
}

export function publicProposal({ action: _action, ...preview }: AssistantProposal): Omit<AssistantProposal, 'action'> {
  return preview;
}

export function prepareSlotProposal(
  resultRef: string, slot: string, snapshots: ReadonlyMap<string, AssistantStoredResult>, context: AssistantContext,
): AssistantProposal {
  return trustedProposal({ kind: 'save_watch_from_result', resultRef, slot, label: null }, snapshots, context);
}

export function proposalContextMatches(proposal: AssistantProposal, original: AssistantContext, current: AssistantContext): boolean {
  if (proposal.action.kind === 'save_pob_set') return isDeepStrictEqual(proposal.action.draft, pobSetDraft(current));
  if ('setId' in proposal.action) return true;
  if (proposal.kind === 'import_watch_link') return true;
  if (!sameScope(proposal.scope, current.scope)) return false;
  if (proposal.kind !== 'save_watch_from_result') return true;
  return original.buildId === current.buildId && original.revision === current.revision
    && (current.slots ? proposal.slot !== undefined && current.slots.includes(proposal.slot) : original.slots === undefined);
}
