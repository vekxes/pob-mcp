import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBuildsDirectory, resolveConfiguredPoBLayout } from '../utils/pobLayout.js';
import { tradeLog } from './log.js';

export class IntegrationSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export type PobPaths = { buildsDirectory: string; sourceDirectory: string };

export function defaultPobPaths(): PobPaths {
  const sibling = fileURLToPath(new URL('../../../PathOfBuilding/src/', import.meta.url));
  const sourceDirectory = process.platform === 'win32' && !process.env.POB_PATH && !process.env.POB_FORK_PATH
    && existsSync(join(sibling, 'HeadlessWrapper.lua')) ? sibling : resolveConfiguredPoBLayout().src;
  return { buildsDirectory: resolve(process.env.POB_DIRECTORY || defaultBuildsDirectory()), sourceDirectory: resolve(sourceDirectory) };
}

export function pobLuaCommand(): string | undefined {
  if (process.env.POB_CMD) return process.env.POB_CMD;
  const bundled = fileURLToPath(new URL('../../../pob-runtime/ucrt64/bin/luajit.exe', import.meta.url));
  return process.platform === 'win32' && existsSync(bundled) ? bundled : undefined;
}

function absolutePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return;
  const path = value.trim().replace(/^"([^"]+)"$/, '$1');
  if (isAbsolute(path)) return resolve(path);
}

export function configPath(value: unknown): string {
  const path = absolutePath(value);
  if (!path || basename(path).toLowerCase() !== 'config.toml') {
    throw new IntegrationSettingsError('Укажи абсолютный путь к файлу config.toml.');
  }
  return path;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function configuredDirectory(value: unknown, kind: 'builds' | 'source'): string | undefined {
  if (value === null || (typeof value === 'string' && !value.trim())) return;
  const path = absolutePath(value);
  if (!path || !isDirectory(path)) throw new IntegrationSettingsError('Выбери существующую папку PoB.');
  if (kind === 'builds') return path;
  for (const directory of [path, join(path, 'src')]) {
    try {
      if (statSync(join(directory, 'HeadlessWrapper.lua')).isFile()) return directory;
    } catch {}
  }
  throw new IntegrationSettingsError('Выбери папку PoB с HeadlessWrapper.lua в корне или в подпапке src.');
}

type Preferences = Partial<PobPaths & { configPath: string }>;

export class IntegrationSettings {
  private saved: Preferences = {};

  constructor(private readonly file: string) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      const path = absolutePath(value?.configPath);
      this.saved = {
        buildsDirectory: absolutePath(value?.buildsDirectory), sourceDirectory: absolutePath(value?.sourceDirectory),
        configPath: path && basename(path).toLowerCase() === 'config.toml' ? path : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') tradeLog('settings', 'integration_read_failed');
    }
  }

  get pob(): PobPaths {
    const defaults = defaultPobPaths();
    return { buildsDirectory: this.saved.buildsDirectory ?? defaults.buildsDirectory,
      sourceDirectory: this.saved.sourceDirectory ?? defaults.sourceDirectory };
  }

  get mcpConfigPath(): string {
    return this.saved.configPath ?? join(absolutePath(process.env.CODEX_HOME) ?? join(homedir(), '.codex'), 'config.toml');
  }

  savePob(builds: unknown, source: unknown): void {
    this.write({ ...this.saved, buildsDirectory: configuredDirectory(builds, 'builds'),
      sourceDirectory: configuredDirectory(source, 'source') });
  }

  saveConfigPath(path: string): void {
    if (path !== this.saved.configPath) this.write({ ...this.saved, configPath: path });
  }

  private write(value: Preferences): void {
    const staging = `${this.file}.${randomUUID()}`;
    try {
      writeFileSync(staging, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      renameSync(staging, this.file);
    } catch (error) {
      try { unlinkSync(staging); } catch {}
      throw error;
    }
    this.saved = value;
  }
}
