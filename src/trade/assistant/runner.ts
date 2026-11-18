import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { tradeLog } from '../log.js';
import { guideDomains, webResearchSources } from './research.js';
import type { ResearchSource } from './research.js';

const MAX_OUTPUT_BYTES = 1_048_576;
// Allow a full editor note and user message, including JSON escapes, slot budgets and instructions.
const MAX_PROMPT_BYTES = 192 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const mcpServers = [
  { name: 'assistant_pob', namespace: 'pob', tools: ['prepare_slots', 'list_sets'], researchTools: ['describe_build'] },
  { name: 'assistant_trade', namespace: 'trade', tools: ['list_watches', 'describe_trade_link'], researchTools: ['ninja_prices', 'official_statistics'] },
] as const;
type AssistantServer = typeof mcpServers[number]['name'];

const inheritedEnv = new Set([
  'APPDATA', 'CODEX_HOME', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LOCALAPPDATA', 'LOGNAME',
  'PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'USERPROFILE', 'WINDIR',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
]);
const disabledFeatures = [
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'goals',
  'hooks', 'memories', 'shell_tool', 'view_image', 'request_permissions_tool',
];
const forbiddenItems = new Set(['command_execution', 'file_change', 'collab_tool_call', 'dynamic_tool_call']);
const safeName = /^[a-zA-Z0-9_-]{1,80}$/;

export type CodexProgress = { type: 'turn.started' | 'web.completed' } | {
  type: 'tool.started' | 'tool.completed'; server: AssistantServer; tool: string;
};

export type CodexResult = { response: unknown; threadId?: string; researchSources?: ResearchSource[] };

export type CodexRunOptions = {
  jobId: string;
  codexExecutable: string;
  cwd: string;
  schemaPath: string;
  mcpPath: string;
  origin: string;
  capability: string;
  prompt: string;
  research?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: CodexProgress) => void;
  timeoutMs?: number;
};

const messages = {
  invalid_configuration: 'Проверь установку Codex CLI и настройки изолированного помощника.',
  spawn_failed: 'Не удалось запустить Codex CLI.',
  cancelled: 'Запрос отменён.',
  timeout: 'Codex не успел завершить запрос.',
  output_limit: 'Ответ Codex превысил допустимый размер.',
  invalid_output: 'Codex вернул неполный или некорректный ответ.',
  turn_failed: 'Codex не смог завершить запрос.',
  exit_failed: 'Codex CLI завершился с ошибкой.',
  isolation_failed: 'Во время запуска Codex обнаружен инструмент вне разрешённого контура.',
} as const;

export class CodexRunError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'CodexRunError';
  }
}

function executableArgs(options: CodexRunOptions, cwd: string) {
  const args = [
    '--ask-for-approval', 'never', 'exec', '--cd', cwd, '--skip-git-repo-check', '--ignore-user-config',
    '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--json', '--output-schema', options.schemaPath,
    '-c', options.research ? 'web_search="live"' : 'web_search="disabled"',
    '-c', 'agents.enabled=false', '-c', 'features.code_mode.enabled=false',
    '-c', 'shell_environment_policy.inherit="none"', '-c', 'project_doc_max_bytes=0',
  ];
  if (options.research) args.push('-c', `tools.web_search.allowed_domains=${JSON.stringify(guideDomains)}`);
  for (const feature of disabledFeatures) args.push('--disable', feature);
  for (const { name, namespace, tools, researchTools } of mcpServers) {
    const allowed = options.research ? [...tools, ...researchTools] : [...tools];
    const key = `mcp_servers.${name}`;
    args.push(
      '-c', `${key}.command=${JSON.stringify(process.env.POE_TRADE_NODE_EXE || process.execPath)}`,
      '-c', `${key}.args=${JSON.stringify([options.mcpPath, namespace])}`,
      '-c', `${key}.env_vars=["POE_ASSISTANT_ORIGIN","POE_ASSISTANT_CAPABILITY"]`,
      '-c', `${key}.required=true`,
      '-c', `${key}.enabled_tools=${JSON.stringify(allowed)}`,
    );
    for (const tool of allowed) args.push('-c', `${key}.tools.${tool}.approval_mode="approve"`);
  }
  return [...args, '-'];
}

export function codexEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => inheritedEnv.has(name.toUpperCase())));
}

function validateConfiguration(options: CodexRunOptions): string {
  try {
    const cwd = realpathSync(options.cwd);
    const paths = [options.codexExecutable, options.mcpPath, options.schemaPath];
    const origin = new URL(options.origin);
    if (!isAbsolute(options.cwd) || !statSync(cwd).isDirectory()
      || paths.some(path => !isAbsolute(path) || !statSync(path).isFile())
      || basename(options.mcpPath) !== 'mcp.js'
      || ['AGENTS.md', 'AGENTS.override.md', '.git', '.codex', '.agents'].some(name => existsSync(join(cwd, name)))
      || origin.origin !== options.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
      || !safeName.test(options.jobId) || !/^[a-f0-9]{64}$/.test(options.capability)
      || !options.prompt.trim() || Buffer.byteLength(options.prompt) > MAX_PROMPT_BYTES
      || (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > DEFAULT_TIMEOUT_MS))) {
      throw new CodexRunError('invalid_configuration');
    }
    return cwd;
  } catch {
    throw new CodexRunError('invalid_configuration');
  }
}

function stopChild(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    return;
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    child.kill('SIGKILL');
    return;
  }
  const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], {
    shell: false, stdio: 'ignore', windowsHide: true,
  });
  killer.once('error', () => child.kill('SIGKILL'));
  killer.once('exit', code => { if (code !== 0) child.kill('SIGKILL'); });
}

class CodexOutput {
  readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private threadId?: string;
  private message?: string;
  private completed = false;
  private readonly researchSources = new Map<string, ResearchSource>();
  bytes = 0;

  constructor(private readonly progress?: CodexRunOptions['onProgress'], private readonly research = false) {}

  consume(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > MAX_OUTPUT_BYTES) throw new CodexRunError('output_limit');
    const lines = (this.pending + this.decoder.decode(chunk, { stream: true })).split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.readLine(line);
  }

  finish(): CodexResult {
    this.readLine(this.pending + this.decoder.decode());
    if (!this.completed || !this.message) throw new CodexRunError('invalid_output');
    const response: unknown = JSON.parse(this.message);
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new CodexRunError('invalid_output');
    return { response, threadId: this.threadId, ...(this.research && { researchSources: [...this.researchSources.values()] }) };
  }

  private readLine(line: string): void {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {
      type?: string; thread_id?: string;
      item?: Record<string, unknown> & { type?: string; text?: string; server?: string; tool?: string };
    } | null;
    if (!event || typeof event.type !== 'string') throw new CodexRunError('invalid_output');
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string' && safeName.test(event.thread_id)) this.threadId = event.thread_id;
        break;
      case 'turn.started':
        this.progress?.({ type: 'turn.started' });
        break;
      case 'turn.completed':
        this.completed = true;
        break;
      case 'turn.failed':
      case 'error':
        throw new CodexRunError('turn_failed');
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item;
        if (!item?.type) throw new CodexRunError('invalid_output');
        if (forbiddenItems.has(item.type)) throw new CodexRunError('isolation_failed');
        if (item.type === 'web_search') {
          if (!this.research) throw new CodexRunError('isolation_failed');
          if (event.type === 'item.completed') {
            for (const source of webResearchSources(item)) {
              if (!this.researchSources.has(source.url) && this.researchSources.size < 40) this.researchSources.set(source.url, source);
            }
            this.progress?.({ type: 'web.completed' });
          }
        }
        if (item.type === 'mcp_tool_call') {
          const server = mcpServers.find(({ name, tools, researchTools }) =>
            name === item.server && [...tools, ...(this.research ? researchTools : [])].some(tool => tool === item.tool));
          if (!server || typeof item.tool !== 'string') throw new CodexRunError('isolation_failed');
          if (event.type !== 'item.updated') {
            this.progress?.({ type: event.type === 'item.started' ? 'tool.started' : 'tool.completed', server: server.name, tool: item.tool });
          }
        }
        if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') this.message = item.text;
        break;
      }
    }
  }
}

export async function runCodex(options: CodexRunOptions): Promise<CodexResult> {
  const startedAt = Date.now();
  const output = new CodexOutput(options.onProgress, options.research);
  const jobId = safeName.test(options.jobId) ? options.jobId : undefined;
  try {
    if (options.signal?.aborted) throw new CodexRunError('cancelled');
    const cwd = validateConfiguration(options);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.codexExecutable, executableArgs(options, cwd), {
        cwd, env: { ...codexEnvironment(), POE_ASSISTANT_ORIGIN: options.origin, POE_ASSISTANT_CAPABILITY: options.capability },
        shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      throw new CodexRunError('spawn_failed');
    }
    tradeLog('assistant', 'codex_started', { jobId });
    const result = await new Promise<CodexResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: CodexRunError) => {
        if (settled) return;
        cleanup();
        stopChild(child);
        child.stdin?.destroy();
        child.stdout?.destroy();
        reject(error);
      };
      const onAbort = () => fail(new CodexRunError('cancelled'));
      const timer = setTimeout(() => fail(new CodexRunError('timeout')), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const processOutput = (error: unknown) => fail(error instanceof CodexRunError ? error : new CodexRunError('invalid_output'));

      child.once('error', () => fail(new CodexRunError('spawn_failed')));
      // An early CLI exit can close stdin before the prompt is written. The exit status is authoritative.
      child.stdin?.on('error', () => undefined);
      child.stdout?.on('error', () => fail(new CodexRunError('invalid_output')));
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        try { output.consume(chunk); } catch (error) { processOutput(error); }
      });
      child.once('close', code => {
        if (settled) return;
        if (code !== 0) {
          fail(new CodexRunError('exit_failed'));
          return;
        }
        try {
          const answer = output.finish();
          cleanup();
          resolve(answer);
        } catch (error) { processOutput(error); }
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      else child.stdin?.end(options.prompt, 'utf8');
    });
    tradeLog('assistant', 'codex_completed', { jobId, elapsedMs: Date.now() - startedAt, outputBytes: output.bytes });
    return result;
  } catch (error) {
    const failure = error instanceof CodexRunError ? error : new CodexRunError('exit_failed');
    tradeLog('assistant', 'codex_failed', { jobId, code: failure.code, elapsedMs: Date.now() - startedAt, outputBytes: output.bytes });
    throw failure;
  }
}
