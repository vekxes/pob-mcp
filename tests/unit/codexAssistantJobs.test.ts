import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantJobs } from '../../src/trade/assistant/jobs.js';
import { tradeSearchFromUrl } from '../../src/trade/tradeUrl.js';
import { tradeLink } from '../../src/trade/query.js';
import { runCodex } from '../../src/trade/assistant/runner.js';
import type { CodexRunOptions, CodexResult } from '../../src/trade/assistant/runner.js';
import type { BuildNoteQuote } from '../../src/trade/assistant/buildNotes.js';

jest.mock('../../src/trade/assistant/runner.js', () => ({
  runCodex: jest.fn(),
  CodexRunError: class extends Error {},
}));
jest.mock('../../src/trade/log.js', () => ({ tradeLog: jest.fn() }));

const run = jest.mocked(runCodex);
const scope = { game: 'poe1', realm: 'pc', league: 'Standard' };
const input = { text: 'Read saved searches', requestId: 'request-1', context: { scope } };
const loadedContext = { scope, buildId: 'a'.repeat(24), revision: '1'.repeat(64) };

async function fixture(api = jest.fn()) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'pob-assistant-job-test-'));
  const mutations = jest.fn(() => ({ kind: 'create' as const, watchId: 'saved-watch' }));
  const readBuildNotes = jest.fn(() => ({ text: 'Keep 100% spell suppression.', version: 'notes-v1' }));
  const append = jest.fn((_revision: string, _version: string | null, _quotes: BuildNoteQuote[]) => ({
    added: 1, view: { text: 'Updated notes', version: 'notes-v2' },
  }));
  const services = {
    call: api, watches: { applyAssistantAction: mutations },
    pobSets: { list: jest.fn(() => []), apply: jest.fn() },
    previewWatchImport: async (searchUrl: string) => tradeSearchFromUrl(searchUrl),
    researchBuild: jest.fn(),
    readBuildNotes, buildNotes: { append },
  };
  const jobs = new AssistantJobs(services, {
    workspaceRoot, codexExecutable: process.execPath, schemaPath: join(workspaceRoot, 'schema.json'),
    researchSchemaPath: join(workspaceRoot, 'research.schema.json'),
    mcpPath: join(workspaceRoot, 'mcp.js'), origin: 'http://127.0.0.1:48217',
  });
  return {
    jobs, api, mutations, readBuildNotes, append,
    async dispose() {
      await jobs.close();
      await rmdir(workspaceRoot);
    },
  };
}

test.each([false, true])('uses local build notes and only appends exact current user statements (research %s)', async research => {
  const { jobs, append, readBuildNotes, dispose } = await fixture();
  const owner = new AbortController();
  const gameplay = 'Cold damage over time cannot critically strike here.';
  let observe!: (options: CodexRunOptions) => void;
  const observing = new Promise<CodexRunOptions>(resolve => { observe = resolve; });
  run.mockImplementationOnce(async options => {
    observe(options);
    return { response: {
      version: 1, message: 'I will account for that mechanic.', resultRefs: [], proposals: [],
      ...(research && { recommendations: [] }), buildNoteQuotes: [
        { text: gameplay, reaffirm: false }, { text: 'Invented by a guide.', reaffirm: true },
      ],
    } };
  });
  try {
    const job = jobs.start('owner', owner.signal, { ...input, context: loadedContext, research, text: gameplay });
    const options = await observing;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(readBuildNotes).toHaveBeenCalledWith(loadedContext.buildId, loadedContext.revision);
    expect(options.prompt).toContain('Keep 100% spell suppression.');
    expect(append).toHaveBeenCalledWith(loadedContext.revision, 'notes-v1', [{ text: gameplay, reaffirm: false }]);
    const view = jobs.get('owner', job.id);
    expect(view).toMatchObject({ status: 'completed', buildNotes: { added: 1 } });
    expect(view.response).not.toHaveProperty('buildNoteQuotes');
  } finally {
    await dispose();
  }
});

test('continues the chat only in the owning window and the same league and build revision', async () => {
  const { jobs, dispose } = await fixture();
  const lifetime = new AbortController();
  async function ask(owner: string, requestId: string, text: string, context = loadedContext) {
    let entered!: (options: CodexRunOptions) => void;
    const started = new Promise<CodexRunOptions>(resolve => { entered = resolve; });
    run.mockImplementationOnce(async options => {
      entered(options);
      return { response: { version: 1, message: 'Keep the existing Vortex setup.', resultRefs: [], proposals: [] } };
    });
    const job = jobs.start(owner, lifetime.signal, { text, context, requestId });
    const { prompt } = await started;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(jobs.get(owner, job.id).status).toBe('completed');
    await jobs.close();
    return JSON.parse(prompt.split('\n').at(-1)!);
  }
  try {
    const question = 'What should I prioritize in this build?';
    await ask('owner', 'first', question);
    const followup = await ask('owner', 'followup', 'Why that setup?');
    expect(followup.previousTurns).toEqual([{ question, answer: 'Keep the existing Vortex setup.' }]);
    expect(await ask('another-window', 'other', 'What about me?')).not.toHaveProperty('previousTurns');
    expect(await ask('owner', 'new-revision', 'What about now?', { ...loadedContext, revision: '2'.repeat(64) }))
      .not.toHaveProperty('previousTurns');
  } finally {
    await dispose();
  }
});

test('never changes build notes when no build is open or after cancellation', async () => {
  const { jobs, append, readBuildNotes, dispose } = await fixture();
  const owner = new AbortController();
  let observe!: () => void;
  const observing = new Promise<void>(resolve => { observe = resolve; });
  const reply = { response: { version: 1, message: 'Okay', resultRefs: [], proposals: [],
    buildNoteQuotes: [{ text: input.text, reaffirm: false }] } };
  run.mockImplementationOnce(async () => { observe(); return reply; });
  try {
    const noBuild = jobs.start('owner', owner.signal, input);
    await observing;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(jobs.get('owner', noBuild.id).status).toBe('completed');
    expect(readBuildNotes).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();

    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    let finish!: (result: CodexResult) => void;
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; started(); }));
    const requested = jobs.start('second-owner', owner.signal, { ...input, context: loadedContext });
    await start;
    jobs.cancel('second-owner', requested.id);
    finish(reply);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(jobs.get('second-owner', requested.id).status).toBe('cancelled');
    expect(append).not.toHaveBeenCalled();
  } finally {
    await dispose();
  }
});

test('closing the owning window cancels the job and revokes its MCP capability', async () => {
  const { jobs, api, dispose } = await fixture(jest.fn().mockResolvedValue({ watches: [], directLive: false }));
  let onStarted!: (options: CodexRunOptions) => void;
  const started = new Promise<CodexRunOptions>(resolve => { onStarted = resolve; });
  run.mockImplementationOnce(options => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    onStarted(options);
  }));
  const owner = new AbortController();
  try {
    const job = jobs.start('owner', owner.signal, input);
    const { capability } = await started;
    const header = 'Bearer ' + capability;
    expect(() => jobs.get('another-window', job.id)).toThrow();
    const tool = { namespace: 'trade', name: 'list_watches', args: {} };
    await expect(jobs.callTool(header, tool)).resolves.toMatchObject({ count: 0 });
    owner.abort();
    expect(jobs.get('owner', job.id).status).toBe('cancelled');
    expect(jobs.hasCapability(header)).toBe(false);
    await expect(jobs.callTool(header, tool)).rejects.toMatchObject({ status: 401 });
    expect(api).toHaveBeenCalledTimes(1);
  } finally {
    await dispose();
  }
});

test('a schema-shaped response cannot claim a local result the tool did not create', async () => {
  const { jobs, dispose } = await fixture();
  const owner = new AbortController();
  let finish!: (result: CodexResult) => void;
  let onStarted!: () => void;
  const started = new Promise<void>(resolve => { onStarted = resolve; });
  run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; onStarted(); }));
  try {
    const job = jobs.start('owner', owner.signal, input);
    await started;
    finish({ response: { version: 1, message: 'Claimed data', resultRefs: ['result_1'], proposals: [] } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(jobs.get('owner', job.id)).toMatchObject({ status: 'failed', errorCode: 'invalid_reply' });
  } finally {
    await dispose();
  }
});

test('an import preview only reaches the watch service after confirmation from its owning window', async () => {
  const { jobs, dispose, mutations } = await fixture();
  let options!: CodexRunOptions;
  let finish!: (result: CodexResult) => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const url = 'https://www.pathofexile.com/trade/search/Standard/FakeSearch';
  const nested = 'https://www.pathofexile.com/trade/search/Standard/Nested';
  run.mockImplementationOnce(running => new Promise(resolve => {
    options = running;
    finish = resolve;
    notifyStarted();
  }));
  const owner = new AbortController();
  try {
    const job = jobs.start('owner', owner.signal, { ...input, text: `Import “${url}”, not https://example.test/${nested}` });
    await started;
    await expect(jobs.callTool('Bearer ' + options.capability, {
      namespace: 'trade', name: 'describe_trade_link', args: { url: url + '2' },
    })).rejects.toMatchObject({ code: 'trade_link_not_provided' });
    await expect(jobs.callTool('Bearer ' + options.capability, {
      namespace: 'trade', name: 'describe_trade_link', args: { url: nested },
    })).rejects.toMatchObject({ code: 'trade_link_not_provided' });
    const preview = await jobs.callTool('Bearer ' + options.capability, {
      namespace: 'trade', name: 'describe_trade_link', args: { url },
    }) as { resultRef: string };
    finish({ response: {
      version: 1, message: 'Confirm import', resultRefs: [],
      proposals: [{ kind: 'import_watch_link', resultRef: preview.resultRef, label: 'Imported search' }],
    } });
    await new Promise<void>(resolve => setImmediate(resolve));
    const completed = jobs.get('owner', job.id);
    expect(completed.status).toBe('completed');
    expect(completed.proposals).toEqual([expect.objectContaining({ kind: 'import_watch_link', label: 'Imported search' })]);
    expect(completed.proposals[0]).not.toHaveProperty('action');
    expect(mutations).not.toHaveBeenCalled();
    const request = { proposalId: completed.proposals[0].id, idempotencyKey: 'confirm-1', context: { scope } };
    await expect(jobs.apply('another-window', owner.signal, job.id, request)).rejects.toThrow();
    expect(mutations).not.toHaveBeenCalled();
    await expect(jobs.apply('owner', owner.signal, job.id, request)).resolves.toEqual({ kind: 'create', watchId: 'saved-watch' });
    expect(mutations).toHaveBeenCalledTimes(1);
    owner.abort();
    await expect(jobs.apply('owner', owner.signal, job.id, request)).rejects.toThrow();
  } finally {
    await dispose();
  }
});

test('selecting a displayed PoB result prepares one confirmation and saves its exact query only when applied', async () => {
  const context = {
    scope: { game: 'poe1', realm: 'pc', league: 'Hardcore Standard' } as const,
    buildId: 'a'.repeat(24), revision: 'b'.repeat(64), slots: ['Ring 2'],
  };
  const body = {
    query: { type: 'Gold Ring', filters: { trade_filters: { filters: { price: { option: 'divine', min: 1, max: 3 } } } } },
  };
  const row = { slot: 'Ring 2', item: 'Gold Ring', scope: context.scope, body, link: tradeLink(context.scope, body), warnings: [] };
  const { jobs, dispose, mutations } = await fixture(jest.fn().mockResolvedValue({ ...context, mode: 'upgrade', rows: [row] }));
  let notifyStarted!: (options: CodexRunOptions) => void;
  let finish!: (result: CodexResult) => void;
  const started = new Promise<CodexRunOptions>(resolve => { notifyStarted = resolve; });
  run.mockImplementationOnce(options => new Promise(resolve => { finish = resolve; notifyStarted(options); }));
  const owner = new AbortController();
  try {
    const job = jobs.start('owner', owner.signal, { ...input, context });
    const options = await started;
    const result = await jobs.callTool('Bearer ' + options.capability, {
      namespace: 'pob', name: 'prepare_slots', args: { mode: 'upgrade' },
    }) as { resultRef: string };
    finish({ response: { version: 1, message: 'Search prepared', resultRefs: [result.resultRef], proposals: [] } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(jobs.get('owner', job.id).status).toBe('completed');
    const request = { resultRef: result.resultRef, slot: row.slot, context };
    expect(() => jobs.proposeSlot('other-window', owner.signal, job.id, request)).toThrow();
    expect(() => jobs.proposeSlot('owner', owner.signal, job.id, { ...request, resultRef: 'invented' })).toThrow();
    expect(() => jobs.proposeSlot('owner', owner.signal, job.id, { ...request, slot: 'Ring 1' })).toThrow();
    expect(() => jobs.proposeSlot('owner', owner.signal, job.id, { ...request, context: { ...context, revision: 'c'.repeat(64) } })).toThrow();
    const proposal = jobs.proposeSlot('owner', owner.signal, job.id, request);
    expect(jobs.proposeSlot('owner', owner.signal, job.id, request)).toEqual(proposal);
    expect(proposal).toMatchObject({
      kind: 'save_watch_from_result', slot: row.slot, scope: row.scope, budget: { currency: 'divine', min: 1, max: 3 },
    });
    expect(proposal).not.toHaveProperty('action');
    expect(mutations).not.toHaveBeenCalled();
    await jobs.apply('owner', owner.signal, job.id, { proposalId: proposal.id, idempotencyKey: 'confirm-slot', context });
    expect(mutations).toHaveBeenCalledTimes(1);
    expect(mutations).toHaveBeenCalledWith({ kind: 'create', scope: row.scope, source: { body, searchUrl: row.link }, label: 'Ring 2 · Gold Ring' },
      expect.objectContaining({ proposalId: proposal.id }));
  } finally {
    await dispose();
  }
});
