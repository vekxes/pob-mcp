import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fetchPobShareCode, parsePobShareInput } from '../services/pobShareFetch.js';
import { parseItem } from '../services/itemParser.js';
import { normalizeEol } from '../pobLuaBridge.js';
import { resolveBuildFile } from '../utils/pathSanitizer.js';
import { listPobBuildFiles } from '../utils/buildFiles.js';
import { defaultPobPaths, pobLuaCommand } from './integrationSettings.js';
import type { PobPaths } from './integrationSettings.js';
import { tradeLog } from './log.js';
import { buildTradeQuery, tradeLink, validateScope, withBudget } from './query.js';
import type { Budget, SearchFilters, TradeScope } from './query.js';
import type { TradeQuery } from '../types/tradeTypes.js';

type Mod = { line: string; type: string };
type Gear = { id: number; slot: string; name?: string; baseName?: string; rarity?: string; raw?: string; shown?: boolean; mods: Mod[] };
type PobSlot = {
  slot: string;
  item: string | null;
  details?: { rarity?: string; itemLevel?: number; quality?: number; mods: Mod[] };
};
export type PobBuildSnapshot = { kind: 'xml' | 'code'; value: string };
export type ImportedPobBuild = { buildId: string; revision: string; label: string; slots: PobSlot[] };
export type PobResearchProfile = {
  className?: string;
  ascendancy?: string;
  level?: number;
  treeVersion?: string;
  mainSkill?: string;
  skills: string[];
  supportGems: string[];
  gear: { slot: string; name: string; base?: string; rarity?: string }[];
  stats: Record<string, number>;
};
type Build = { id: string; revision: string; label: string; source: PobBuildSnapshot };
export type BuildSource = { kind: 'xml' | 'code' | 'file' | 'link'; value: string; name?: string };
export type BuildTrade = {
  buildId: string;
  revision: string;
  scope: TradeScope;
  mode: 'match' | 'upgrade';
  slots?: string[];
  budget?: Budget;
  budgets?: Record<string, Budget>;
};

const MAX_BUILD_BYTES = 2_000_000;

class BuildContextLost extends Error {}

function slotName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && value.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(value);
}

function buildRevision(source: PobBuildSnapshot): string {
  return createHash('sha256').update(source.kind).update(source.value).digest('hex');
}

function uniqueName({ name, baseName }: Pick<Gear, 'name' | 'baseName'>): string | undefined {
  // PoB appends the display base with its parenthesized variant removed.
  const suffix = baseName ? `, ${baseName.replace(/ \(.+\)/, '')}` : undefined;
  return suffix && name?.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function researchName(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const name = value.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]|:\/\/|[A-Za-z]:[\\/]|^[\\/]/.test(name)) return;
  return name;
}

function researchNames(values: unknown[]): string[] {
  return [...new Set(values.map(researchName).filter((value): value is string => value !== undefined))].slice(0, 24);
}

function childEnv(paths: PobPaths): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && !/^POE_(SESSION|TRADE)/i.test(entry[0]),
  ));
  const command = pobLuaCommand();
  return { ...env, POB_PATH: paths.sourceDirectory, POB_DIRECTORY: paths.buildsDirectory,
    ...(command && { POB_CMD: command }), POB_LUA_ENABLED: 'true', POE_TRADE_ENABLED: 'false' };
}

export class PobAdapter {
  private client?: Client;
  private appliedPaths?: PobPaths;
  private operationPaths?: PobPaths;
  private queue: Promise<unknown> = Promise.resolve();
  private loaded?: string;
  private readonly builds = new Map<string, Build & {
    slots: ImportedPobBuild['slots']; emptyTreeJewelSlots: Set<string>;
  }>();

  constructor(private readonly resolveMods: (scope: TradeScope, mods: Mod[]) => Promise<{
    filters: NonNullable<SearchFilters['mods']>; warnings: string[];
  }>, private readonly paths: () => PobPaths = defaultPobPaths) {}

  async listBuildFiles(): Promise<string[]> {
    const files = await listPobBuildFiles(this.paths().buildsDirectory);
    return files.sort(new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare);
  }

  private run<T>(name: 'import_build' | 'prepare_trade' | 'research_profile' | 'simulate' | 'close', operation: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(async () => {
      const started = performance.now();
      tradeLog('pob', 'operation_started', { operation: name });
      try {
        this.operationPaths = this.paths();
        const result = await operation();
        tradeLog('pob', 'operation_completed', { operation: name, durationMs: Math.round(performance.now() - started) });
        return result;
      } catch (error) {
        tradeLog('pob', 'operation_failed', { operation: name, durationMs: Math.round(performance.now() - started) });
        throw error;
      } finally {
        this.operationPaths = undefined;
      }
    });
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  private get activePaths(): PobPaths {
    return this.operationPaths ?? this.paths();
  }

  private async call(name: string, args: Record<string, unknown> = {}) {
    if (!this.client) {
      tradeLog('pob', 'connect_started');
      const client = new Client({ name: 'local-trade', version: '1.0.0' });
      const paths = this.activePaths;
      const transport = new StdioClientTransport({
        command: process.env.POE_TRADE_NODE_EXE || process.execPath,
        args: [fileURLToPath(new URL('../index.js', import.meta.url))],
        env: childEnv(paths),
        // The legacy bridge can include raw build and item data in its diagnostics.
        stderr: 'ignore',
      });
      client.onclose = () => {
        if (this.client === client) {
          this.client = undefined;
          this.loaded = undefined;
          tradeLog('pob', 'disconnected', { expected: false });
        }
      };
      try {
        await client.connect(transport);
      } catch (error) {
        tradeLog('pob', 'connect_failed');
        await client.close().catch(() => undefined);
        throw error;
      }
      this.client = client;
      this.appliedPaths = paths;
      tradeLog('pob', 'connected');
    }
    const client = this.client;
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (error) {
      tradeLog('pob', 'tool_failed', { tool: name, reason: 'transport' });
      await this.disconnect(client).catch(() => undefined);
      throw new BuildContextLost(error instanceof Error ? error.message : String(error));
    }
    const text = Array.isArray(result.content)
      ? result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      : '';
    if (result.isError) {
      // The MCP server can stay connected while a restarted Lua process holds only its bootstrap build.
      if (text.includes('The PoB Lua bridge crashed and was restarted.')) {
        tradeLog('pob', 'tool_failed', { tool: name, reason: 'bridge_restarted' });
        this.loaded = undefined;
        throw new BuildContextLost(text);
      }
      if (/PoB API exited|the PoB bridge was terminated/.test(text)) {
        tradeLog('pob', 'tool_failed', { tool: name, reason: 'bridge_exited' });
        await this.disconnect(client).catch(() => undefined);
        throw new BuildContextLost(text);
      }
      tradeLog('pob', 'tool_failed', { tool: name, reason: 'tool_error' });
      throw new Error(text || `PoB failed in ${name}.`);
    }
    return { text, data: result.structuredContent as Record<string, unknown> | undefined };
  }

  private async disconnect(client: Client): Promise<void> {
    if (this.client === client) {
      this.client = undefined;
      this.loaded = undefined;
    }
    await client.close();
    tradeLog('pob', 'disconnected', { expected: true });
  }

  private async load(build: Build): Promise<void> {
    const current = this.activePaths;
    if (this.client && (current.buildsDirectory !== this.appliedPaths?.buildsDirectory
      || current.sourceDirectory !== this.appliedPaths.sourceDirectory)) {
      await this.disconnect(this.client);
    }
    if (this.loaded === build.id) return;
    this.loaded = undefined;
    if (build.source.kind === 'xml') {
      await this.call('lua_load_build', { build_xml: build.source.value, name: build.label });
    } else {
      await this.call('lua_import_code', { code: build.source.value, name: build.label });
    }
    this.loaded = build.id;
  }

  private async withBuild<T>(build: Build, operation: () => Promise<T>): Promise<T> {
    try {
      await this.load(build);
      return await operation();
    } catch (error) {
      if (!(error instanceof BuildContextLost)) throw error;
      tradeLog('pob', 'build_context_retry');
      await this.load(build);
      return operation();
    }
  }

  private async gear() {
    const items = (await this.call('get_equipped_items')).data?.items;
    if (!Array.isArray(items)) throw new Error('PoB MCP returned no structured gear. Rebuild the companion and PoB MCP.');
    return items as Gear[];
  }

  importBuild(input: BuildSource) {
    return this.run('import_build', async () => {
      if (typeof input?.value !== 'string' || !input.value.trim() || Buffer.byteLength(input.value) > MAX_BUILD_BYTES) {
        throw new Error('Provide a PoB export, XML or build file.');
      }
      if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 200 || /[\u0000-\u001f\u007f]/.test(input.name))) {
        throw new Error('Enter a build name of up to 200 characters.');
      }
      const value = input.value.trim();
      const label = input.name?.trim() || (input.kind === 'file' ? value : 'Imported PoB build');
      let source: Build['source'];
      switch (input.kind) {
        case 'file': {
          const file = resolveBuildFile(value, this.activePaths.buildsDirectory);
          const info = await stat(file);
          if (!info.isFile() || info.size > MAX_BUILD_BYTES) throw new Error('Choose a PoB XML file under 2 MB.');
          source = { kind: 'xml', value: await readFile(file, 'utf8') };
          break;
        }
        case 'link':
          source = { kind: 'code', value: await fetchPobShareCode(parsePobShareInput(value)) };
          break;
        case 'xml':
        case 'code':
          source = { kind: input.kind, value };
          break;
        default:
          throw new Error('Unknown PoB import kind.');
      }
      if (source.kind === 'xml') source.value = normalizeEol(source.value.trim());
      if (!source.value || Buffer.byteLength(source.value) > MAX_BUILD_BYTES) throw new Error('Choose a PoB export under 2 MB.');
      return this.importSnapshot(source, label, buildRevision(source));
    });
  }

  private async importSnapshot(source: PobBuildSnapshot, label: string, revision: string): Promise<ImportedPobBuild> {
    const id = createHash('sha256').update(label).update(revision).digest('hex').slice(0, 24);
    const build = { id, revision, label, source };
    const gear = await this.withBuild(build, () => this.gear());
    const slots: ImportedPobBuild['slots'] = [];
    const emptyTreeJewelSlots = new Set<string>();
    for (const { slot, id: itemId, name, baseName, shown, rarity, raw, mods } of gear) {
      if (itemId > 0) {
        const item = name || baseName || null;
        const parsed = raw ? parseItem(raw) : undefined;
        const itemLevel = Number(parsed?.meta.get('Item Level'));
        const quality = parsed?.quality;
        slots.push({ slot, item, ...(item && { details: {
          rarity: rarity ?? parsed?.rarity,
          itemLevel: Number.isSafeInteger(itemLevel) ? itemLevel : undefined,
          quality: quality !== undefined && Number.isFinite(quality) ? quality : undefined,
          mods: parsed?.mods.map(({ text, type }) => ({ line: text, type })) ?? mods ?? [],
        } }) });
      } else if (shown !== false) {
        // ItemsTab names passive tree sockets "Jewel " followed by the node ID.
        if (/^Jewel \d+$/.test(slot)) emptyTreeJewelSlots.add(slot);
        else slots.push({ slot, item: null });
      }
    }
    this.builds.set(id, { ...build, slots, emptyTreeJewelSlots });
    return { buildId: id, revision, label, slots };
  }

  snapshotForSet(buildId: string, revision: string, slots: string[]): { source: PobBuildSnapshot; label: string } {
    const build = this.findBuild(buildId, revision);
    if (!slots.every(slot => build.slots.some(entry => entry.slot === slot))) {
      throw new Error('Select slots from the active PoB build.');
    }
    return { source: { ...build.source }, label: build.label };
  }

  hasBuild(buildId: string, revision: string): boolean {
    return this.builds.get(buildId)?.revision === revision;
  }

  isEmptyTreeJewelSlot(buildId: string, revision: string, slot: string): boolean {
    const build = this.builds.get(buildId);
    return build?.revision === revision && build.emptyTreeJewelSlots.has(slot);
  }

  restoreSetBuild(source: PobBuildSnapshot, label: string, revision: string): Promise<ImportedPobBuild> {
    return this.run('import_build', () => {
      if ((source.kind !== 'xml' && source.kind !== 'code') || !source.value
          || Buffer.byteLength(source.value) > MAX_BUILD_BYTES || buildRevision(source) !== revision) {
        throw new Error('The saved PoB build does not match its revision.');
      }
      return this.importSnapshot(source, label, revision);
    });
  }

  private findBuild(id: string, revision: string) {
    const build = this.builds.get(id);
    if (!build || build.revision !== revision) throw new Error('Import the build again to select its current revision.');
    return build;
  }

  researchProfile(input: { buildId: string; revision: string }): Promise<PobResearchProfile> {
    return this.run('research_profile', () => this.withBuild(this.findBuild(input.buildId, input.revision), async () => {
      const { data } = await this.call('lua_get_build_snapshot');
      if (!data || !Array.isArray(data.gear) || !Array.isArray(data.skills) || !Array.isArray(data.supportGems)
          || !data.stats || typeof data.stats !== 'object' || Array.isArray(data.stats)) {
        throw new Error('PoB MCP returned no structured build profile.');
      }
      const mainSkill = researchName(data.mainSkill);
      const gear: PobResearchProfile['gear'] = [];
      for (const item of data.gear.slice(0, 24)) {
        const slot = researchName(item?.slot);
        const rarity = researchName(item?.rarity);
        const base = researchName(item?.baseName);
        const title = researchName(item?.name);
        // Keep named uniques for matching guides, plus known bases for other gear.
        const name = rarity?.toLowerCase() === 'unique' ? uniqueName({ name: title, baseName: base }) ?? base : base ?? title;
        if (slot && name) gear.push({ slot, name, base, rarity });
      }
      const stats = Object.fromEntries(Object.entries(data.stats).filter(
        (entry): entry is [string, number] => /^[A-Za-z][A-Za-z0-9]{0,70}$/.test(entry[0])
          && typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ));
      return {
        className: researchName(data.className),
        ascendancy: researchName(data.ascendancy),
        level: typeof data.level === 'number' && Number.isInteger(data.level) && data.level >= 1 && data.level <= 100 ? data.level : undefined,
        treeVersion: researchName(data.treeVersion),
        mainSkill,
        skills: researchNames([mainSkill, ...data.skills]),
        supportGems: researchNames(data.supportGems),
        gear,
        stats,
      };
    }));
  }

  prepare(input: BuildTrade) {
    return this.run('prepare_trade', async () => {
      validateScope(input?.scope);
      if (input.scope.game !== 'poe1') throw new Error('The configured PoB engine supports PoE 1.');
      if (input.mode !== 'match' && input.mode !== 'upgrade') throw new Error('Choose match or upgrade mode.');
      if (input.slots !== undefined && (!Array.isArray(input.slots) || !input.slots.every(slotName))) {
        throw new Error('Choose PoB slots as an array of slot names.');
      }
      if (input.budgets !== undefined && (!input.budgets || typeof input.budgets !== 'object' || Array.isArray(input.budgets))) {
        throw new Error('Provide per-slot budgets as an object keyed by PoB slot name.');
      }
      const build = this.findBuild(input.buildId, input.revision);
      const gear = await this.withBuild(build, () => this.gear());
      const slots = input.slots ?? gear.filter(item => item.id > 0).map(item => item.slot);
      const rows = [];
      for (const slot of new Set(slots)) {
        const entry = gear.find(item => item.slot === slot);
        const item = entry?.id ? (entry.name || entry.baseName || null) : null;
        const budget = input.budgets && Object.hasOwn(input.budgets, slot) ? input.budgets[slot] : input.budget;
        const row = { slot, item, scope: input.scope };
        if (!entry) {
          rows.push({ ...row, warnings: ['Unknown PoB slot.'] });
          continue;
        }
        if (!entry.id) {
          rows.push({ ...row, warnings: ['No equipped item in this slot.'] });
          continue;
        }
        const warnings: string[] = [];
        try {
          if (budget !== undefined && (!budget || typeof budget !== 'object' || Array.isArray(budget))) {
            throw new Error('Provide a valid budget with a currency for this slot.');
          }
          let body: TradeQuery;
          if (input.mode === 'upgrade') {
            if (entry.shown === false) throw new Error('Enable this slot in PoB and reimport to calculate an upgrade.');
            const result = await this.withBuild(build, () => this.call('generate_weighted_trade_query', { slot }));
            const native = result.data?.query as TradeQuery | undefined;
            if (!native || !Array.isArray(native.query?.stats) || !native.query.stats.some(group =>
              group.type === 'weight' && !group.disabled && group.filters?.some(filter => !filter.disabled),
            )) {
              throw new Error('PoB returned no weighted filters for this slot.');
            }
            if (typeof result.data?.warning === 'string') warnings.push(result.data.warning);
            if (entry.rarity?.toLowerCase() === 'unique' && native.query.filters?.type_filters?.filters?.rarity?.option === 'nonunique') {
              warnings.push('PoB is weighing non-unique replacements for this slot.');
            }
            body = withBudget(native, budget);
          } else {
            const unique = entry.rarity?.toLowerCase() === 'unique';
            const name = unique ? uniqueName(entry) : undefined;
            const base = unique ? undefined : entry.baseName;
            if (unique ? !name : !base) throw new Error('PoB returned no searchable item name or base.');
            const matched = await this.resolveMods(input.scope, entry.mods);
            warnings.push(...matched.warnings);
            if (entry.mods.length && !matched.filters.length) {
              if (!unique) throw new Error('Choose at least one modifier filter to match this item on its base.');
              warnings.push('Search matches the unique name. Review its modifier rolls on the trade site.');
            } else if (matched.warnings.length) {
              warnings.push('Search includes only the resolved modifiers.');
            }
            body = buildTradeQuery({
              scope: input.scope,
              name,
              base,
              budget,
              mods: matched.filters,
            });
          }
          rows.push({ ...row, body, link: tradeLink(input.scope, body), warnings });
        } catch (error) {
          rows.push({ ...row, warnings: [...warnings, error instanceof Error ? error.message : String(error)] });
        }
      }
      tradeLog('pob', 'slot_queries_prepared', {
        mode: input.mode, slots: rows.length, queries: rows.filter(row => 'link' in row).length,
      });
      return { buildId: build.id, revision: build.revision, mode: input.mode, rows };
    });
  }

  simulate(input: { buildId: string; revision: string; slot: string; itemText: string }) {
    return this.run('simulate', async () => {
      if (typeof input?.itemText !== 'string' || !input.itemText.trim() || input.itemText.includes('\0') || Buffer.byteLength(input.itemText) > 40_000) {
        throw new Error('Paste item text copied from Trade or the game.');
      }
      if (!slotName(input.slot)) throw new Error('Choose an active PoB slot.');
      return this.withBuild(this.findBuild(input.buildId, input.revision), async () => {
        if (!(await this.gear()).some(item => item.slot === input.slot && item.shown !== false)) {
          throw new Error('Choose an active PoB slot.');
        }
        const result = await this.call('lua_simulate', { slotName: input.slot, itemText: input.itemText.trim() });
        return { report: result.text };
      });
    });
  }

  async close(): Promise<void> {
    await this.run('close', async () => {
      if (this.client) await this.disconnect(this.client);
    });
  }
}
