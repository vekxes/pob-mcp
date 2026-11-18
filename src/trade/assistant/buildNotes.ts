import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

type SavedNotes = { text: string; version: string };
type NotesDatabase = {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(revision: string): SavedNotes | undefined;
    run(...values: string[]): unknown;
  };
  close(): void;
};

export type BuildNotesView = { text: string; version: string | null };
export type BuildNoteQuote = string | { text: string; reaffirm: boolean };
type AppendResult = { added: number; view: BuildNotesView; skipped?: 'stale' | 'full' };

export class BuildNoteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const maxNotesLength = 12_000;
const disallowedControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

function validateRevision(revision: string): void {
  if (typeof revision !== 'string' || revision.length !== 64 || !/^[a-f0-9]{64}$/u.test(revision)) {
    throw new BuildNoteError(400, 'Проверь ревизию билда PoB.');
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?|\u2028|\u2029/gu, '\n');
}

function compactWhitespace(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

export class BuildNotesService {
  private readonly db: NotesDatabase;
  private closed = false;

  constructor(databasePath: string) {
    // The desktop companion uses Node 24, which supplies node:sqlite.
    const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as {
      DatabaseSync: new (path: string) => NotesDatabase;
    };
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS build_notes (
          revision TEXT PRIMARY KEY NOT NULL,
          text TEXT NOT NULL,
          version TEXT NOT NULL
        );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  read(revision: string): BuildNotesView {
    validateRevision(revision);
    this.checkOpen();
    return this.select(revision);
  }

  replace(revision: string, expectedVersion: string | null, text: string): BuildNotesView {
    if (typeof text !== 'string') throw new BuildNoteError(400, 'Проверь текст заметок билда.');
    const normalized = normalizeNewlines(text);
    if (normalized.length > maxNotesLength || disallowedControls.test(normalized)) {
      throw new BuildNoteError(400, 'Заметки билда могут содержать до 12 000 символов, включая табуляцию и переносы строк.');
    }
    return this.transaction(revision, expectedVersion, current => {
      if (current.version !== expectedVersion) {
        throw new BuildNoteError(409, 'Заметки билда изменились. Обнови их перед сохранением.');
      }
      // Keep the row and rotate its version even when the editor clears every note.
      return this.save(revision, normalized);
    });
  }

  append(revision: string, expectedVersion: string | null, quotes: BuildNoteQuote[]): AppendResult {
    return this.transaction(revision, expectedVersion, current => {
      if (current.version !== expectedVersion) return { added: 0, view: current, skipped: 'stale' };

      const existing = new Set<string>();
      let latest = '';
      for (const line of current.text.split('\n')) {
        const normalized = compactWhitespace(line);
        if (!normalized) continue;
        latest = normalized.replace(/^(?:[-+*•]|\d+[.)]) /u, '');
        existing.add(normalized);
        existing.add(latest);
      }

      const bullets: string[] = [];
      const included = new Set<string>();
      for (const quote of quotes) {
        const value = typeof quote === 'string' ? quote : quote?.text;
        if (typeof value !== 'string') continue;
        const normalized = normalizeNewlines(value);
        if (disallowedControls.test(normalized)) continue;
        const line = compactWhitespace(normalized);
        const reaffirm = typeof quote !== 'string' && quote.reaffirm === true;
        if (!line || included.has(line) || (existing.has(line) && (!reaffirm || line === latest))) continue;
        included.add(line);
        bullets.push(`- ${line}`);
      }
      if (bullets.length === 0) return { added: 0, view: current };
      const separator = current.text && !current.text.endsWith('\n') ? '\n' : '';
      const text = current.text + separator + bullets.join('\n');
      if (text.length > maxNotesLength) return { added: 0, view: current, skipped: 'full' };
      return { added: bullets.length, view: this.save(revision, text) };
    });
  }

  private checkOpen(): void {
    if (this.closed) throw new BuildNoteError(503, 'Хранилище заметок билда закрыто.');
  }

  private select(revision: string): BuildNotesView {
    const row = this.db.prepare('SELECT text, version FROM build_notes WHERE revision = ?').get(revision);
    return row ? { text: row.text, version: row.version } : { text: '', version: null };
  }

  private save(revision: string, text: string): SavedNotes {
    const version = randomUUID();
    this.db.prepare(`
      INSERT INTO build_notes (revision, text, version) VALUES (?, ?, ?)
      ON CONFLICT(revision) DO UPDATE SET text = excluded.text, version = excluded.version
    `).run(revision, text, version);
    return { text, version };
  }

  private transaction<T>(revision: string, expectedVersion: string | null, change: (current: BuildNotesView) => T): T {
    validateRevision(revision);
    if (expectedVersion !== null && typeof expectedVersion !== 'string') {
      throw new BuildNoteError(400, 'Проверь версию заметок билда.');
    }
    this.checkOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = change(this.select(revision));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
