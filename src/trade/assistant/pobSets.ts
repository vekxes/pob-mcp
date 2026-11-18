import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tradeLog } from '../log.js';
import type { ImportedPobBuild, PobAdapter, PobBuildSnapshot } from '../pobAdapter.js';
import { validateBudget, validateScope } from '../query.js';
import type { Budget, TradeScope } from '../query.js';

type SqlValue = string | number | null;
type Row = Record<string, unknown>;
type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: SqlValue[]): Row | undefined;
    all(...values: SqlValue[]): Row[];
    run(...values: SqlValue[]): unknown;
  };
  close(): void;
};

export type PobSetDraft = {
  buildId: string;
  revision: string;
  scope: TradeScope;
  mode: 'match' | 'upgrade';
  slots: string[];
  budget?: Budget;
  budgets?: Record<string, Budget>;
};

export type PobSetSummary = Omit<PobSetDraft, 'buildId' | 'revision'> & {
  id: string;
  version: string;
  label: string;
  buildLabel: string;
  sourceRevision: string;
  updatedAt: string;
};

type SetTarget = { setId: string; expectedVersion: string };
export type PobSetAction =
  | { kind: 'save_pob_set'; label: string; draft: PobSetDraft }
  | ({ kind: 'open_pob_set' } & SetTarget)
  | ({ kind: 'remove_pob_set' } & SetTarget)
  | ({ kind: 'rename_pob_set'; label: string } & SetTarget);

export type PobSetClaim = { key: string; jobId: string; proposalId: string };
export type PobSetResult =
  | { kind: 'save_pob_set' | 'rename_pob_set'; setId: string; set: PobSetSummary }
  | { kind: 'remove_pob_set'; setId: string }
  | { kind: 'open_pob_set'; setId: string; set: PobSetSummary; build: ImportedPobBuild; skippedEmptyJewelSlots?: string[] };
type WriteAction = Exclude<PobSetAction, { kind: 'open_pob_set' }>;
type WriteResult = Exclude<PobSetResult, { kind: 'open_pob_set' }>;

export class PobSetError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnly(value: Row, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function budgetFrom(value: unknown): Budget {
  if (!record(value) || !hasOnly(value, ['currency', 'min', 'max'])) {
    throw new PobSetError(400, 'Проверь бюджет комплекта PoB.');
  }
  const budget = {
    ...(value.currency !== undefined && { currency: value.currency as Budget['currency'] }),
    ...(value.min !== undefined && { min: value.min as number }),
    ...(value.max !== undefined && { max: value.max as number }),
  };
  try {
    validateBudget(budget);
  } catch {
    throw new PobSetError(400, 'Проверь валюту и диапазон бюджета комплекта PoB.');
  }
  return budget;
}

export function validatePobSetDraft(value: unknown): PobSetDraft {
  if (!record(value) || !hasOnly(value, ['buildId', 'revision', 'scope', 'mode', 'slots', 'budget', 'budgets'])) {
    throw new PobSetError(400, 'Проверь настройки комплекта PoB.');
  }
  const { buildId, revision, scope, mode, slots, budget, budgets } = value;
  if (typeof buildId !== 'string' || !/^[a-f0-9]{24}$/.test(buildId)
      || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new PobSetError(400, 'Загрузи билд PoB перед сохранением комплекта.');
  }
  if (!record(scope) || !hasOnly(scope, ['game', 'realm', 'league']) || scope.game !== 'poe1') {
    throw new PobSetError(400, 'Выбери лигу Path of Exile 1 для комплекта PoB.');
  }
  const normalizedScope = { game: scope.game, realm: scope.realm, league: scope.league } as TradeScope;
  try {
    validateScope(normalizedScope);
  } catch {
    throw new PobSetError(400, 'Проверь платформу и лигу комплекта PoB.');
  }
  if (mode !== 'match' && mode !== 'upgrade') throw new PobSetError(400, 'Выбери режим поиска комплекта PoB.');
  if (!Array.isArray(slots) || !slots.length || slots.length > 24
      || !slots.every(slot => text(slot, 120)) || new Set(slots).size !== slots.length) {
    throw new PobSetError(400, 'Выбери от 1 до 24 разных слотов для комплекта PoB.');
  }
  const draft: PobSetDraft = { buildId, revision, scope: normalizedScope, mode, slots: [...slots] };
  if (budget !== undefined) draft.budget = budgetFrom(budget);
  if (budgets !== undefined) {
    if (!record(budgets) || !hasOnly(budgets, slots)) {
      throw new PobSetError(400, 'Укажи отдельные бюджеты только для выбранных слотов.');
    }
    draft.budgets = Object.fromEntries(slots.filter(slot => Object.hasOwn(budgets, slot)).map(slot => [slot, budgetFrom(budgets[slot])]));
    if (Object.keys(draft.budgets).length === 0) delete draft.budgets;
  }
  return draft;
}

function parseAction(value: unknown): PobSetAction {
  if (!record(value)) throw new PobSetError(400, 'Проверь действие с комплектом PoB.');
  const { kind, label, draft, setId, expectedVersion } = value;
  if (kind === 'save_pob_set' && text(label, 120) && hasOnly(value, ['kind', 'label', 'draft'])) {
    return { kind, label: label.trim(), draft: validatePobSetDraft(draft) };
  }
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (typeof setId === 'string' && uuid.test(setId) && typeof expectedVersion === 'string' && uuid.test(expectedVersion)) {
    if ((kind === 'open_pob_set' || kind === 'remove_pob_set') && hasOnly(value, ['kind', 'setId', 'expectedVersion'])) {
      return { kind, setId, expectedVersion };
    }
    if (kind === 'rename_pob_set' && text(label, 120) && hasOnly(value, ['kind', 'setId', 'expectedVersion', 'label'])) {
      return { kind, setId, expectedVersion, label: label.trim() };
    }
  }
  throw new PobSetError(400, 'Проверь действие, название и версию комплекта PoB.');
}

function decodeSet(row: Row): PobSetSummary {
  return JSON.parse(String(row.summary)) as PobSetSummary;
}

export class PobSetService {
  private readonly db: Database;
  private closed = false;

  constructor(path: string, private readonly pob: Pick<PobAdapter, 'snapshotForSet' | 'restoreSetBuild' | 'isEmptyTreeJewelSlot'>) {
    const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as { DatabaseSync: new (file: string) => Database };
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS pob_set_sources (
          revision TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('xml', 'code')), source TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pob_sets (
          id TEXT PRIMARY KEY, source_revision TEXT NOT NULL REFERENCES pob_set_sources(revision),
          summary TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assistant_pob_set_actions (
          key TEXT PRIMARY KEY, job_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
          action_hash TEXT NOT NULL, result TEXT NOT NULL, UNIQUE(job_id, proposal_id)
        );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  list(): PobSetSummary[] {
    return this.db.prepare('SELECT summary FROM pob_sets ORDER BY updated_at DESC, rowid DESC').all().map(decodeSet);
  }

  async apply(value: unknown, claim?: PobSetClaim, signal?: AbortSignal): Promise<PobSetResult> {
    const action = parseAction(value);
    if (claim && ![claim.key, claim.jobId, claim.proposalId]
      .every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value))) {
      throw new PobSetError(400, 'Проверь идентификатор подтверждения.');
    }
    signal?.throwIfAborted();
    if (this.closed) throw new PobSetError(503, 'Сервис PoE Trade остановлен.');
    if (action.kind === 'open_pob_set') {
      const set = this.currentSet(action);
      const snapshot = this.db.prepare('SELECT kind, source FROM pob_set_sources WHERE revision = ?').get(set.sourceRevision);
      if (!snapshot || (snapshot.kind !== 'xml' && snapshot.kind !== 'code') || typeof snapshot.source !== 'string') {
        throw new PobSetError(409, 'Снимок билда для комплекта PoB недоступен.');
      }
      const source: PobBuildSnapshot = { kind: snapshot.kind, value: snapshot.source };
      const build = await this.pob.restoreSetBuild(source, set.buildLabel, set.sourceRevision).catch(() => {
        throw new PobSetError(409, 'Не удалось восстановить сохранённую ревизию билда PoB.');
      });
      signal?.throwIfAborted();
      if (this.closed) throw new PobSetError(503, 'Сервис PoE Trade остановлен.');
      this.currentSet(action);
      const missing = set.slots.filter(slot => !build.slots.some(entry => entry.slot === slot));
      if (build.revision !== set.sourceRevision || missing.some(slot => !this.pob.isEmptyTreeJewelSlot(build.buildId, build.revision, slot))) {
        throw new PobSetError(409, 'Слоты сохранённого комплекта не совпадают с восстановленным билдом.');
      }
      tradeLog('pob-sets', 'opened', { setId: set.id, slots: set.slots.length });
      return { kind: action.kind, setId: set.id, set, build, ...(missing.length && { skippedEmptyJewelSlots: missing }) };
    }
    return this.write(action, claim);
  }

  private currentSet(target: SetTarget): PobSetSummary {
    const row = this.db.prepare('SELECT summary FROM pob_sets WHERE id = ?').get(target.setId);
    if (!row) throw new PobSetError(404, 'Комплект PoB не найден.');
    const set = decodeSet(row);
    if (set.version !== target.expectedVersion) {
      throw new PobSetError(409, 'Комплект PoB изменился. Обнови список или подготовь новое предложение.');
    }
    return set;
  }

  private write(action: WriteAction, claim?: PobSetClaim): WriteResult {
    const actionHash = claim && createHash('sha256').update(JSON.stringify(action)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    let result: WriteResult;
    try {
      if (claim) {
        const receipt = this.db.prepare(`
          SELECT key, job_id, proposal_id, action_hash, result FROM assistant_pob_set_actions
          WHERE key = ? OR (job_id = ? AND proposal_id = ?)
        `).get(claim.key, claim.jobId, claim.proposalId);
        if (receipt) {
          if (receipt.key !== claim.key || receipt.job_id !== claim.jobId || receipt.proposal_id !== claim.proposalId
              || receipt.action_hash !== actionHash) {
            throw new PobSetError(409, 'Это подтверждение уже связано с другим действием.');
          }
          result = JSON.parse(String(receipt.result)) as WriteResult;
          this.db.exec('COMMIT');
          return result;
        }
      }
      result = this.mutate(action);
      if (claim && actionHash) {
        this.db.prepare('INSERT INTO assistant_pob_set_actions VALUES (?, ?, ?, ?, ?)')
          .run(claim.key, claim.jobId, claim.proposalId, actionHash, JSON.stringify(result));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    tradeLog('pob-sets', 'changed', { setId: result.setId, kind: result.kind });
    return result;
  }

  private mutate(action: WriteAction): WriteResult {
    if (action.kind === 'save_pob_set') {
      const { buildId, revision, ...settings } = action.draft;
      let snapshot: ReturnType<PobAdapter['snapshotForSet']>;
      try {
        snapshot = this.pob.snapshotForSet(buildId, revision, settings.slots);
      } catch {
        throw new PobSetError(409, 'Активный билд или выбранные слоты недоступны. Загрузи билд PoB снова.');
      }
      this.db.prepare('INSERT OR IGNORE INTO pob_set_sources VALUES (?, ?, ?)')
        .run(revision, snapshot.source.kind, snapshot.source.value);
      const set: PobSetSummary = {
        id: randomUUID(), version: randomUUID(), label: action.label, buildLabel: snapshot.label,
        sourceRevision: revision, updatedAt: new Date().toISOString(), ...settings,
      };
      this.db.prepare('INSERT INTO pob_sets VALUES (?, ?, ?, ?)')
        .run(set.id, set.sourceRevision, JSON.stringify(set), set.updatedAt);
      return { kind: action.kind, setId: set.id, set };
    }
    const current = this.currentSet(action);
    if (action.kind === 'rename_pob_set') {
      const set = { ...current, label: action.label, version: randomUUID(), updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE pob_sets SET summary = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(set), set.updatedAt, set.id);
      return { kind: action.kind, setId: set.id, set };
    }
    this.db.prepare('DELETE FROM pob_sets WHERE id = ?').run(current.id);
    this.db.prepare(`
      DELETE FROM pob_set_sources WHERE revision = ? AND NOT EXISTS (
        SELECT 1 FROM pob_sets WHERE source_revision = ?
      )
    `).run(current.sourceRevision, current.sourceRevision);
    return { kind: action.kind, setId: current.id };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
