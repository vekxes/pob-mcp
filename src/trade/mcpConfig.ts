import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { codexEnvironment } from './assistant/runner.js';
import { configPath, IntegrationSettingsError, pobLuaCommand } from './integrationSettings.js';
import type { PobPaths } from './integrationSettings.js';
import { dataHome, port } from './localConnection.js';

const run = promisify(execFile);
const maxConfigSize = 2 * 1024 * 1024;
const servers = ['pob', 'poe-trade'] as const;
type ServerName = typeof servers[number];
type Server = { name: ServerName; script: string; env: Record<string, string> };
type Snapshot = { target: string; bytes: Buffer | null; mode: number };

function snapshot(path: string): Snapshot {
  let target: string;
  try { target = realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Resolve the parent (which may be a junction) even for a new config.
    return { target: join(realpathSync(dirname(path)), basename(path)), bytes: null, mode: 0o600 };
  }
  const info = statSync(target);
  if (!info.isFile() || info.size > maxConfigSize) throw new IntegrationSettingsError('Выбери обычный файл config.toml размером до 2 МБ.');
  return { target, bytes: readFileSync(target), mode: info.mode & 0o777 };
}

function selection(value: unknown, pob: PobPaths): Server[] {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length
      || !value.every(name => servers.includes(name))) {
    throw new IntegrationSettingsError('Выбери хотя бы один локальный MCP.');
  }
  const lua = pobLuaCommand();
  const definitions: Record<ServerName, Omit<Server, 'name'>> = {
    pob: {
      script: fileURLToPath(new URL('../index.js', import.meta.url)),
      env: { POB_DIRECTORY: pob.buildsDirectory, POB_PATH: pob.sourceDirectory, POB_LUA_ENABLED: 'true',
        ...(lua && { POB_CMD: lua }), ...(process.env.POB_PYTHON && { POB_PYTHON: process.env.POB_PYTHON }) },
    },
    'poe-trade': {
      script: fileURLToPath(new URL('./mcp.js', import.meta.url)),
      env: { POE_TRADE_HOME: resolve(dataHome), POE_TRADE_PORT: String(port) },
    },
  };
  return servers.filter(name => value.includes(name)).map(name => ({ name, ...definitions[name] }));
}

function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, '\\u007F');
}

function draft(pathInput: unknown, selected: unknown, pob: PobPaths) {
  const path = configPath(pathInput);
  const entries = selection(selected, pob);
  const command = process.env.POE_TRADE_NODE_EXE || process.execPath;
  if (!isAbsolute(command) || process.versions.electron && !process.env.POE_TRADE_NODE_EXE) {
    throw new IntegrationSettingsError('Запусти PoE Trade через ярлык, чтобы определить путь к Node.js.');
  }
  const current = snapshot(path);
  const snippet = entries.map(({ name, script, env }) => [
    `[mcp_servers.${name}]`, `command = ${tomlString(command)}`, `args = [${tomlString(script)}]`, '',
    `[mcp_servers.${name}.env]`, ...Object.entries(env).map(([name, value]) => `${name} = ${tomlString(value)}`),
  ].join('\n')).join('\n\n');
  const version = createHash('sha256').update(JSON.stringify([current.target, snippet, Boolean(current.bytes)]))
    .update(current.bytes ?? '').digest('hex');
  return { path, entries, command, current, snippet, version };
}

export function previewMcpConfig(path: unknown, selected: unknown, pob: PobPaths) {
  const plan = draft(path, selected, pob);
  return { path: plan.path, snippet: plan.snippet, version: plan.version };
}

export async function applyMcpConfig(path: unknown, selected: unknown, pob: () => PobPaths,
    version: unknown, executable: string | undefined, signal: AbortSignal) {
  const plan = draft(path, selected, pob());
  const conflict = () => new IntegrationSettingsError('Файл или настройки PoB изменились. Открой предварительный просмотр заново.', 409);
  if (version !== plan.version) throw conflict();
  if (!executable) throw new IntegrationSettingsError('Сначала укажи путь к Codex CLI в настройках.', 409);
  const work = await mkdtemp(join(resolve(tmpdir()), 'poe-codex-config-'));
  try {
    const staged = join(work, 'config.toml');
    if (plan.current.bytes) writeFileSync(staged, plan.current.bytes, { flag: 'wx', mode: 0o600 });
    for (const { name, script, env } of plan.entries) {
      try {
        const environment = Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
        await run(executable, ['mcp', 'add', name, ...environment, '--', plan.command, script], {
          cwd: work, env: { ...codexEnvironment(), CODEX_HOME: work }, windowsHide: true,
          timeout: 15_000, maxBuffer: 64_000, signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new IntegrationSettingsError('Codex CLI не смог подготовить config.toml. Проверь синтаксис файла и версию CLI.', 409);
      }
    }
    const updated = await readFile(staged);
    signal.throwIfAborted();
    const latest = draft(path, selected, pob());
    if (latest.version !== plan.version) throw conflict();
    const current = latest.current;
    if (current.bytes?.equals(updated)) return { path: plan.path };
    const suffix = randomUUID();
    const pending = `${current.target}.${suffix}.tmp`;
    const backup = current.bytes ? `${current.target}.${suffix}.bak` : undefined;
    try {
      writeFileSync(pending, updated, { flag: 'wx', mode: current.mode });
      if (current.bytes && backup) writeFileSync(backup, current.bytes, { flag: 'wx', mode: 0o600 });
      if (draft(path, selected, pob()).version !== plan.version) throw conflict();
      renameSync(pending, current.target);
    } catch (error) {
      try { unlinkSync(pending); } catch {}
      throw error;
    }
    return { path: plan.path, backup };
  } finally {
    // work is the exclusive directory created by mkdtemp for this call.
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
