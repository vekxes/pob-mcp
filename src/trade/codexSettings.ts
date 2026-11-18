import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { tradeLog } from './log.js';

export class CodexSettingsError extends Error {}

function executableFile(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return;
  const path = value.trim().replace(/^"([^"]+)"$/, '$1');
  const expected = process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (!isAbsolute(path) || basename(path).toLowerCase() !== expected) return;
  return path;
}

export class CodexSettings {
  private saved?: string;

  constructor(private readonly file: string, private readonly environment = '') {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      this.saved = normalizePath(value?.path);
      if (value?.path !== null && !this.saved) tradeLog('settings', 'codex_read_failed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') tradeLog('settings', 'codex_read_failed');
    }
  }

  get executable(): string | undefined {
    const path = this.saved ?? this.environment;
    return executableFile(path) ? path : undefined;
  }

  status() {
    return {
      path: this.saved ?? this.environment,
      source: this.saved ? 'saved' : this.environment ? 'environment' : 'none',
      configured: Boolean(this.executable),
    };
  }

  save(value: unknown): void {
    const path = value === null ? undefined : normalizePath(value);
    if (value !== null && (!path || !executableFile(path))) {
      const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
      throw new CodexSettingsError(`Укажи абсолютный путь к доступному файлу ${name}.`);
    }
    if (path === this.saved) return;
    const pending = `${this.file}.${randomUUID()}`;
    try {
      writeFileSync(pending, JSON.stringify({ path: path ?? null }), { flag: 'wx', mode: 0o600 });
      renameSync(pending, this.file);
    } catch (error) {
      try { unlinkSync(pending); } catch {}
      throw error;
    }
    this.saved = path;
  }
}
