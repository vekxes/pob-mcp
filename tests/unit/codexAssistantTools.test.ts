import { assistantTools, callAssistantTool } from '../../src/trade/assistant/tools.js';

const scope = { game: 'poe1', realm: 'pc', league: 'Standard' } as const;
const context = { scope, buildId: 'test-build', revision: 'test-revision', slots: ['Ring 1', 'Ring 2'] };
const pobSets = { list: jest.fn(() => []) };
const researchBuild = jest.fn();

test('PoB only sends the selected build, league and slots to the shared read operation', async () => {
  const result = {
    buildId: context.buildId,
    revision: context.revision,
    mode: 'upgrade',
    rows: [
      {
        slot: 'Ring 1', item: 'Bramble Band', body: { query: { type: 'Gold Ring' } },
        link: 'https://www.pathofexile.com/trade/search/Standard/query', warnings: ['private tool detail'],
      },
      { slot: 'Ring 2', item: 'Ruby Ring', warnings: [] },
    ],
  };
  const api = { call: jest.fn().mockResolvedValue(result), previewWatchImport: jest.fn(), pobSets, researchBuild };
  const record = jest.fn(() => 'result_1');

  const summary = await callAssistantTool(api, context, {
    namespace: 'pob', name: 'prepare_slots', args: { mode: 'upgrade', budget: { currency: 'divine', max: 5 } },
  }, record);

  expect(api.call).toHaveBeenCalledWith('trade_for_build', {
    buildId: context.buildId, revision: context.revision, scope, mode: 'upgrade', slots: context.slots,
    budget: { currency: 'divine', max: 5 },
  });
  expect(record).toHaveBeenCalledWith('pob', result);
  expect(summary).toEqual({
    mode: 'upgrade',
    budget: { currency: 'divine', max: 5 },
    rows: [
      { slot: 'Ring 1', item: 'Bramble Band', ready: true, warningCount: 1 },
      { slot: 'Ring 2', item: 'Ruby Ring', ready: false, warningCount: 0 },
    ],
    resultRef: 'result_1',
  });
});

test.each([
  { explicit: undefined, expectedDefault: { currency: 'chaos', min: 10, max: 45 } },
  { explicit: { currency: 'exalted', max: 20 }, expectedDefault: { currency: 'exalted', max: 20 } },
])('preserves saved per-slot budgets with a contextual or explicit default ($expectedDefault.currency)', async ({ explicit, expectedDefault }) => {
  const opened = {
    ...context,
    slots: ['Ring 1', 'Ring 2', 'Amulet'],
    buildOptions: {
      mode: 'upgrade' as const,
      budget: { currency: 'chaos', min: 10, max: 45 },
      budgets: { 'Ring 2': { currency: 'divine', min: 1, max: 3 }, Amulet: { currency: 'chaos', max: 60 } },
    },
  };
  const slots = ['Ring 2', 'Ring 1'];
  const ringTwoBudget = opened.buildOptions.budgets['Ring 2'];
  const row = (slot: string, { currency, min, max }: { currency: string; min?: number; max: number }) => ({
    slot, item: 'Ruby Ring', warnings: [], link: 'https://www.pathofexile.com/trade/search/Standard/query',
    body: { query: { type: 'Ruby Ring', filters: { trade_filters: { filters: { price: { option: currency, min, max } } } } } },
  });
  const result = { mode: 'upgrade', rows: [row('Ring 2', ringTwoBudget), row('Ring 1', expectedDefault)] };
  const api = { call: jest.fn().mockResolvedValue(result), previewWatchImport: jest.fn(), pobSets, researchBuild };
  const summary = await callAssistantTool(api, opened, {
    namespace: 'pob', name: 'prepare_slots', args: { mode: 'upgrade', slots, ...(explicit && { budget: explicit }) },
  });

  expect(api.call).toHaveBeenCalledWith('trade_for_build', {
    buildId: context.buildId, revision: context.revision, scope, mode: 'upgrade', slots,
    budget: expectedDefault, budgets: { 'Ring 2': ringTwoBudget },
  });
  expect(summary).toEqual({
    mode: 'upgrade', budget: expectedDefault, rows: [
      { slot: 'Ring 2', item: 'Ruby Ring', ready: true, warningCount: 0, budget: ringTwoBudget },
      { slot: 'Ring 1', item: 'Ruby Ring', ready: true, warningCount: 0, budget: expectedDefault },
    ],
  });
});

test('Trade sends bounded template metadata without query bodies, search URLs or raw errors', async () => {
  const watch = { id: 'watch-1', label: 'Ring search', scope, status: 'paused' };
  const api = { previewWatchImport: jest.fn(), pobSets, researchBuild, call: jest.fn().mockResolvedValue({
    directLive: false,
    watches: [
      {
        ...watch, body: { raw: 'private query' }, searchUrl: 'private search URL', reason: 'private error',
        scope: { ...scope, unsupported: 'private scope data' },
      },
      { ...watch, id: 'another-watch', scope: { ...scope, league: 'Hardcore' } },
    ],
  }) };

  await expect(callAssistantTool(api, context, { namespace: 'trade', name: 'list_watches', args: {} }))
    .resolves.toEqual({ directLive: false, count: 1, truncated: false, watches: [watch] });
  expect(api.call).toHaveBeenCalledWith('trade_watch_list', {});
});

test('assistant MCP views allowlist both tool names and selected input fields', async () => {
  const api = { call: jest.fn(), previewWatchImport: jest.fn(), pobSets, researchBuild };
  expect(assistantTools.pob.map(tool => tool.name)).toEqual(['prepare_slots', 'list_sets', 'describe_build']);
  expect(assistantTools.trade.map(tool => tool.name)).toEqual(['list_watches', 'describe_trade_link', 'ninja_prices', 'official_statistics']);
  await expect(callAssistantTool(api, context, { namespace: 'pob', name: 'describe_build', args: {} }))
    .rejects.toMatchObject({ code: 'research_disabled' });

  await expect(callAssistantTool(api, context, { namespace: 'trade', name: 'trade_watch_resume', args: {} }))
    .rejects.toMatchObject({ code: 'unknown_tool' });
  await expect(callAssistantTool(api, context, { namespace: 'pob', name: 'list_watches', args: {} }))
    .rejects.toMatchObject({ code: 'unknown_tool' });
  await expect(callAssistantTool(api, context, {
    namespace: 'pob', name: 'prepare_slots', args: { mode: 'match', buildId: 'different-build' },
  })).rejects.toMatchObject({ code: 'invalid_arguments' });
  await expect(callAssistantTool(api, context, {
    namespace: 'pob', name: 'prepare_slots', args: { mode: 'match', slots: ['Weapon 1'] },
  })).rejects.toMatchObject({ code: 'invalid_arguments' });
  await expect(callAssistantTool(api, context, {
    namespace: 'pob', name: 'prepare_slots', args: { mode: 'match', slots: null },
  })).rejects.toMatchObject({ code: 'invalid_arguments' });
  expect(api.call).not.toHaveBeenCalled();
});

test('assistant tools mask sensitive failures from the backing services', async () => {
  const api = { call: jest.fn().mockRejectedValue(new Error('private file or upstream response')), previewWatchImport: jest.fn(), pobSets, researchBuild };
  await expect(callAssistantTool(api, context, { namespace: 'pob', name: 'prepare_slots', args: { mode: 'match' } }))
    .rejects.toThrow('PoB could not prepare searches for the selected build.');
});

test('import preview records the checked query for the app and returns only league metadata to Codex', async () => {
  const url = 'https://www.pathofexile.com/trade/search/Standard/example';
  const source = { scope, searchUrl: url, body: { query: { type: 'Gold Ring' } } };
  const api = { call: jest.fn(), previewWatchImport: jest.fn().mockResolvedValue(source), pobSets, researchBuild };
  const record = jest.fn(() => 'result_2');
  await expect(callAssistantTool(api, context, { namespace: 'trade', name: 'describe_trade_link', args: { url } }, record))
    .resolves.toEqual({ scope, filtersAvailable: true, resultRef: 'result_2' });
  expect(api.previewWatchImport).toHaveBeenCalledWith(url);
  expect(record).toHaveBeenCalledWith('trade_link', source);
  expect(api.call).not.toHaveBeenCalled();
});

test('the assistant can discover saved sets in another league while source and version stay on the server', async () => {
  const saved = {
    id: 'set-1', version: 'secret-version', sourceRevision: 'source-digest', updatedAt: '2026-11-18',
    label: 'Ring shopping', buildLabel: 'Test build', scope: { ...scope, league: 'Hardcore' },
    mode: 'upgrade' as const, slots: ['Ring 1'], budget: { currency: 'chaos', max: 80 },
  };
  const api = { call: jest.fn(), previewWatchImport: jest.fn(), researchBuild, pobSets: { list: jest.fn(() => [saved]) } };
  const record = jest.fn(() => 'result_1');
  const summary = await callAssistantTool(api, context, { namespace: 'pob', name: 'list_sets', args: {} }, record);
  expect(record).toHaveBeenCalledWith('pob_set_list', { sets: [saved] });
  expect(summary).toMatchObject({ count: 1, resultRef: 'result_1', sets: [{ id: saved.id, scope: saved.scope, budget: saved.budget }] });
  expect(JSON.stringify(summary)).not.toContain(saved.version);
  expect(JSON.stringify(summary)).not.toContain(saved.sourceRevision);
});
