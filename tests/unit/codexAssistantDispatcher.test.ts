import { proposalContextMatches, publicProposal, validateAssistantReply } from '../../src/trade/assistant/dispatcher.js';
import type { AssistantStoredResult } from '../../src/trade/assistant/dispatcher.js';
import { tradeLink } from '../../src/trade/query.js';
import { tradeSearchFromUrl } from '../../src/trade/tradeUrl.js';

const scope = { game: 'poe1', realm: 'pc', league: 'Standard' } as const;
const alternate = { ...scope, league: 'Hardcore' };
const context = { scope, buildId: 'a'.repeat(24), revision: 'b'.repeat(64), slots: ['Ring 1'] };
const body = { query: { type: 'Gold Ring', filters: { trade_filters: { filters: { price: { option: 'divine', max: 5 } } } } } };
const link = tradeLink(scope, body);
const watchRevision = 'c'.repeat(64);
const watch = { id: 'watch-a', label: 'Ring', scope, status: 'active', revision: watchRevision };

const results = new Map<string, AssistantStoredResult>([
  ['result_1', {
    kind: 'pob',
    data: {
      buildId: context.buildId, revision: context.revision, mode: 'upgrade',
      rows: [
        { slot: 'Ring 1', item: 'Gold Ring', scope, body, link, warnings: [] },
        { slot: 'Ring 2', item: null, scope, warnings: [] },
      ],
    },
  }],
  ['result_2', { kind: 'watch_list', data: { watches: [watch] } }],
  ['result_3', {
    kind: 'trade_link',
    data: { scope: alternate, searchId: 'lookup', searchUrl: 'https://www.pathofexile.com/trade/search/Hardcore/lookup' },
  }],
]);

const reply = (proposals: unknown[], resultRefs: string[] = []) => ({ version: 1, message: 'Check the proposal', resultRefs, proposals });
const save = { kind: 'save_watch_from_result', resultRef: 'result_1', slot: 'Ring 1', label: null };
const pause = { kind: 'pause_watch', resultRef: 'result_2', watchId: watch.id };
const importLink = { kind: 'import_watch_link', resultRef: 'result_3', label: 'Saved link' };

test('uses trusted snapshots to form private actions and exposes only confirmation metadata', () => {
  const { proposals } = validateAssistantReply(reply([save, pause, importLink], ['result_1']), results, context);
  expect(proposals.map(publicProposal)).toEqual([
    {
      id: expect.any(String), kind: save.kind, label: 'Ring 1 · Gold Ring', scope, slot: 'Ring 1',
      filtersAvailable: true, budget: { currency: 'divine', max: 5 },
    },
    { id: expect.any(String), kind: pause.kind, label: watch.label, scope, status: 'active' },
    {
      id: expect.any(String), kind: importLink.kind, label: importLink.label, scope: alternate, filtersAvailable: false,
      searchUrl: 'https://www.pathofexile.com/trade/search/Hardcore/lookup',
    },
  ]);
  expect(proposals.map(proposal => proposal.action)).toEqual([
    { kind: 'create', scope, source: { body, searchUrl: link }, label: 'Ring 1 · Gold Ring' },
    { kind: 'pause', watchId: watch.id, expectedRevision: watchRevision },
    { kind: 'create', scope: alternate, source: { searchId: 'lookup', searchUrl: 'https://www.pathofexile.com/trade/search/Hardcore/lookup' }, label: importLink.label },
  ]);
});

test('rejects unsupported writes, unproven results, and repeated changes to the same target', () => {
  for (const proposals of [
    [{ ...save, body }],
    [{ ...pause, kind: 'resume_watch' }],
    [{ ...importLink, url: link }],
    [{ ...pause, watchId: 'watch-other' }],
    [{ ...pause, resultRef: 'result_1' }],
    [{ ...save, slot: 'Ring 2' }],
    [{ ...save, resultRef: 'absent' }],
    [pause, { ...pause, kind: 'remove_watch' }],
  ]) {
    expect(() => validateAssistantReply(reply(proposals), results, context)).toThrow();
  }
});

test('rechecks the active build, league, and slot relevant to the confirmed action', () => {
  const { proposals: [fromBuild, fromWatch, imported] } = validateAssistantReply(reply([save, pause, importLink]), results, context);
  expect(proposalContextMatches(fromBuild, context, { ...context, revision: 'new-revision' })).toBe(false);
  expect(proposalContextMatches(fromBuild, context, { ...context, scope: alternate })).toBe(false);
  expect(proposalContextMatches(fromBuild, context, { ...context, slots: undefined })).toBe(false);
  expect(proposalContextMatches(fromBuild, context, { ...context, slots: ['Ring 1', 'Ring 2'] })).toBe(true);
  expect(proposalContextMatches(fromWatch, context, { ...context, scope: alternate })).toBe(false);
  expect(proposalContextMatches(imported, context, { ...context, scope: alternate })).toBe(true);
});

test('explains why an already paused target cannot be proposed for pausing', () => {
  const snapshots = new Map<string, AssistantStoredResult>([
    ['result_2', { kind: 'watch_list', data: { watches: [{ ...watch, status: 'paused' }] } }],
  ]);
  expect(() => validateAssistantReply(reply([pause]), snapshots, context)).toThrow('Этот шаблон Live Search сейчас не запущен.');
  expect(validateAssistantReply(reply([{ ...pause, kind: 'remove_watch' }]), snapshots, context).proposals[0].action)
    .toEqual({ kind: 'remove', watchId: watch.id, expectedRevision: watchRevision });
});

test('preserves filters from the canonical import preview and rejects a mismatched snapshot', () => {
  const imported = tradeSearchFromUrl('https://www.pathofexile.com/trade/search/Standard?'
    + new URLSearchParams({ q: JSON.stringify({ query: { term: 'Gold Ring' } }) }));
  const snapshots = new Map<string, AssistantStoredResult>([
    ['result_3', { kind: 'trade_link', data: imported }],
  ]);
  const { proposals: [proposal] } = validateAssistantReply(reply([importLink]), snapshots, context);
  expect(publicProposal(proposal).filtersAvailable).toBe(true);
  expect(proposal.action).toMatchObject({
    kind: 'create', source: { searchUrl: imported.searchUrl, body: { query: { term: 'Gold Ring' } } },
  });
  snapshots.set('result_3', { kind: 'trade_link', data: { ...imported, scope: alternate } });
  expect(() => validateAssistantReply(reply([importLink]), snapshots, context)).toThrow();
  snapshots.set('result_3', { kind: 'trade_link', data: { ...imported, body } });
  expect(() => validateAssistantReply(reply([importLink]), snapshots, context)).toThrow();
});

test('a confirmed PoB set save keeps the current league, exact slots and both budget levels', () => {
  const buildOptions = {
    mode: 'upgrade' as const, budget: { currency: 'divine', max: 5 },
    budgets: { 'Ring 1': { currency: 'chaos', max: 90 } },
  };
  const current = { ...context, buildOptions };
  const { proposals: [proposal] } = validateAssistantReply(reply([{ kind: 'save_pob_set', label: 'Bossing' }]), results, current);
  expect(publicProposal(proposal)).toMatchObject({
    kind: 'save_pob_set', label: 'Bossing', scope, slots: ['Ring 1'], ...buildOptions,
  });
  expect(proposal.action).toEqual({
    kind: 'save_pob_set', label: 'Bossing', draft: { ...context, ...buildOptions },
  });
  expect(proposalContextMatches(proposal, current, { ...current, scope: alternate })).toBe(false);
  expect(proposalContextMatches(proposal, current, { ...current, buildOptions: { ...buildOptions, budget: { currency: 'divine', max: 6 } } })).toBe(false);
  expect(proposalContextMatches(proposal, current, current)).toBe(true);
});

test('opening and edits use a server-observed set version even in a different league', () => {
  const saved = {
    id: 'set-1', version: 'version-1', label: 'Bossing', buildLabel: 'Imported build', scope: alternate,
    slots: ['Ring 1'], budget: { currency: 'chaos', max: 45 }, mode: 'upgrade',
  };
  const available = new Map<string, AssistantStoredResult>([['result_1', { kind: 'pob_set_list', data: { sets: [saved] } }]]);
  const target = { resultRef: 'result_1', setId: saved.id };
  const opened = validateAssistantReply(reply([{ kind: 'open_pob_set', ...target }]), available, context).proposals[0];
  expect(opened.action).toEqual({ kind: 'open_pob_set', setId: saved.id, expectedVersion: saved.version });
  expect(proposalContextMatches(opened, context, { ...context, scope: alternate })).toBe(true);
  const renamed = validateAssistantReply(reply([{ kind: 'rename_pob_set', ...target, label: 'New name' }]), available, context).proposals[0];
  expect(publicProposal(renamed)).toMatchObject({ label: 'New name', setLabel: saved.label, scope: alternate });
  expect(() => validateAssistantReply(reply([{ kind: 'remove_pob_set', ...target, expectedVersion: 'guessed' }]), available, context)).toThrow();
});
