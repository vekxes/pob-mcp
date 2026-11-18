import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runCodex } from '../../src/trade/assistant/runner.js';
import { tradeLog } from '../../src/trade/log.js';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('../../src/trade/log.js', () => ({ tradeLog: jest.fn() }));

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = jest.fn();

  emitLine(event: unknown) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

const spawnMock = jest.mocked(spawn);
const folder = mkdtempSync(join(tmpdir(), 'poe-codex-runner-'));
const schemaPath = join(folder, 'result.json');
const mcpPath = join(folder, 'mcp.js');
const options = {
  jobId: '2ce26585-622e-41fe-a6a9-9180b62973b6',
  codexExecutable: process.execPath,
  cwd: folder,
  schemaPath,
  mcpPath,
  origin: 'http://127.0.0.1:48217',
  capability: 'a'.repeat(64),
  prompt: 'Тест с кириллицей\nи новой строкой',
};

beforeAll(() => {
  writeFileSync(schemaPath, '{}');
  writeFileSync(mcpPath, '');
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));
beforeEach(() => {
  spawnMock.mockReset();
  jest.mocked(tradeLog).mockClear();
});

function fakeProcess() {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child as never);
  return child;
}

test('uses stdin and isolated MCP configuration, then reassembles split UTF-8 JSONL', async () => {
  const child = fakeProcess();
  const sent: Buffer[] = [];
  child.stdin.on('data', chunk => sent.push(chunk));
  const progress = jest.fn();
  const original = process.env.POE_SESSION_ID;
  process.env.POE_SESSION_ID = 'poe-cookie-test-marker';
  let result: ReturnType<typeof runCodex>;
  try {
    result = runCodex({ ...options, onProgress: progress });
  } finally {
    if (original === undefined) delete process.env.POE_SESSION_ID;
    else process.env.POE_SESSION_ID = original;
  }

  const [, args, childOptions] = spawnMock.mock.calls[0] as unknown as [string, string[], { shell: boolean; env: NodeJS.ProcessEnv }];
  expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--json', '--output-schema']));
  expect(args).toEqual(expect.arrayContaining([
    'project_doc_max_bytes=0',
    'mcp_servers.assistant_pob.enabled_tools=["prepare_slots","list_sets"]',
    'mcp_servers.assistant_pob.tools.prepare_slots.approval_mode="approve"',
    'mcp_servers.assistant_pob.tools.list_sets.approval_mode="approve"',
    'mcp_servers.assistant_trade.enabled_tools=["list_watches","describe_trade_link"]',
    'mcp_servers.assistant_trade.tools.list_watches.approval_mode="approve"',
    'mcp_servers.assistant_trade.tools.describe_trade_link.approval_mode="approve"',
  ]));
  expect(args.filter(arg => arg.includes('approval_mode='))).toHaveLength(4);
  expect(args.join('\n')).not.toContain(options.capability);
  expect(args.at(-1)).toBe('-');
  expect(childOptions.shell).toBe(false);
  expect(childOptions.env).toMatchObject({ POE_ASSISTANT_CAPABILITY: options.capability, POE_ASSISTANT_ORIGIN: options.origin });
  expect(childOptions.env.POE_SESSION_ID).toBeUndefined();
  expect(Buffer.concat(sent).toString()).toBe(options.prompt);

  child.emitLine({ type: 'thread.started', thread_id: 'safe-thread-1' });
  child.emitLine({ type: 'turn.started' });
  child.emitLine({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'assistant_pob', tool: 'prepare_slots' } });
  const response = { version: 1, message: 'Билд загружен', resultRefs: [], proposals: [] };
  const line = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } }));
  for (const byte of line) child.stdout.write(Buffer.from([byte]));
  child.stdout.write('\n');
  child.stdout.write(JSON.stringify({ type: 'turn.completed' }));
  child.emit('close', 0);

  await expect(result).resolves.toEqual({ response, threadId: 'safe-thread-1' });
  expect(progress.mock.calls).toEqual([[{ type: 'turn.started' }], [{ type: 'tool.completed', server: 'assistant_pob', tool: 'prepare_slots' }]]);
});

test('rejects a workspace with local project instructions before starting Codex', async () => {
  const cwd = join(folder, 'project');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'AGENTS.md'), 'synthetic-instructions-marker');
  await expect(runCodex({ ...options, cwd, timeoutMs: 10 })).rejects.toMatchObject({ code: 'invalid_configuration' });
  expect(spawnMock).not.toHaveBeenCalled();
});

test('sends a full multilingual note and user message through stdin', async () => {
  const child = fakeProcess();
  const prompt = JSON.stringify({ buildNotes: '機'.repeat(12_000), userMessage: 'ы'.repeat(8_000) });
  const received: Buffer[] = [];
  child.stdin.on('data', chunk => received.push(chunk));
  const result = runCodex({ ...options, prompt });
  child.emitLine({ type: 'item.completed', item: { type: 'agent_message', text: '{"version":1}' } });
  child.emitLine({ type: 'turn.completed' });
  child.emit('close', 0);

  await expect(result).resolves.toMatchObject({ response: { version: 1 } });
  expect(Buffer.concat(received).toString('utf8')).toBe(prompt);
});

test.each([
  { type: 'command_execution', command: 'synthetic-marker' },
  { type: 'web_search' },
  { type: 'mcp_tool_call', server: 'unrelated-global-mcp', tool: 'synthetic-marker' },
  { type: 'mcp_tool_call', server: 'assistant_trade', tool: 'trade_watch_start' },
])('rejects an unexpected tool surface %j', async item => {
  const child = fakeProcess();
  const result = runCodex(options);
  child.emitLine({ type: 'item.started', item });
  await expect(result).rejects.toMatchObject({ code: 'isolation_failed' });
});

test('opt-in research enables hosted search and collects only allowlisted source URLs', async () => {
  const child = fakeProcess();
  const result = runCodex({ ...options, research: true });
  const config = spawnMock.mock.calls[0][1] as string[];
  expect(config).toEqual(expect.arrayContaining(['web_search="live"', expect.stringContaining('tools.web_search.allowed_domains=')]));
  child.emitLine({
    type: 'item.completed',
    item: { type: 'web_search', results: [
      { url: 'https://www.poewiki.net/wiki/Vortex', title: 'Vortex' },
      { url: 'https://poewiki.net.example.test/fake', title: 'Lookalike' },
      { url: 'file:///hidden', title: 'Private file' },
    ] },
  });
  child.emitLine({ type: 'item.completed', item: { type: 'agent_message', text: '{"version":1}' } });
  child.emitLine({ type: 'turn.completed' });
  child.emit('close', 0);
  await expect(result).resolves.toMatchObject({
    researchSources: [{ kind: 'guide', url: 'https://www.poewiki.net/wiki/Vortex', title: 'Vortex' }],
  });
});

test('fails closed on abnormal or incomplete structured output', async () => {
  const child = fakeProcess();
  const result = runCodex(options);
  child.emitLine({ type: 'turn.started' });
  child.emitLine({ type: 'item.completed', item: { type: 'agent_message', text: '{"version":1}' } });
  child.stderr.write('sensitive-stderr-marker');
  child.emit('close', 0);
  await expect(result).rejects.toMatchObject({ code: 'invalid_output' });
  expect(tradeLog).toHaveBeenLastCalledWith('assistant', 'codex_failed', expect.objectContaining({ code: 'invalid_output' }));
  expect(JSON.stringify(jest.mocked(tradeLog).mock.calls)).not.toMatch(/sensitive-stderr-marker|Тест с кириллицей/);
});

test('bounds output and supports abort or timeout without stdout completion', async () => {
  const oversized = fakeProcess();
  const limited = runCodex(options);
  oversized.stdout.write(Buffer.alloc(1_048_577, 65));
  await expect(limited).rejects.toMatchObject({ code: 'output_limit' });

  fakeProcess();
  const controller = new AbortController();
  const cancelled = runCodex({ ...options, signal: controller.signal });
  controller.abort('ignored-error-marker');
  await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });

  fakeProcess();
  await expect(runCodex({ ...options, timeoutMs: 5 })).rejects.toMatchObject({ code: 'timeout' });
});
