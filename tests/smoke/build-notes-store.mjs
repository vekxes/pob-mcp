import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BuildNoteError, BuildNotesService } from '../../build/trade/assistant/buildNotes.js';

const revision = '1a'.repeat(32);
const otherRevision = '2b'.repeat(32);

test('notes are isolated by revision and survive closing the store', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pob-build-notes-'));
  const path = join(folder, 'trade.sqlite');
  let notes = new BuildNotesService(path);
  try {
    assert.deepEqual(notes.read(revision), { text: '', version: null });
    const saved = notes.replace(revision, null, 'First line\r\n\tSecond line\rLast line');
    assert.equal(saved.text, 'First line\n\tSecond line\nLast line');
    assert.equal(typeof saved.version, 'string');
    assert.deepEqual(notes.read(otherRevision), { text: '', version: null });
    const other = notes.replace(otherRevision, null, 'Separate build');

    notes.close();
    notes = new BuildNotesService(path);
    assert.deepEqual(notes.read(revision), saved);
    assert.deepEqual(notes.read(otherRevision), other);

    const cleared = notes.replace(revision, saved.version, '');
    notes.close();
    notes = new BuildNotesService(path);
    assert.deepEqual(notes.read(revision), cleared);
    assert.deepEqual(notes.append(revision, null, ['Job started before notes existed']), {
      added: 0, view: cleared, skipped: 'stale',
    });
  } finally {
    notes.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('saving and clearing notes invalidate competing edits and in-flight appends', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'pob-build-notes-conflict-'));
  const path = join(folder, 'trade.sqlite');
  const editor = new BuildNotesService(path);
  const assistant = new BuildNotesService(path);
  try {
    const initial = editor.read(revision);
    const saved = editor.replace(revision, initial.version, 'Manual note');
    assert.throws(() => assistant.replace(revision, initial.version, 'Competing edit'), {
      status: 409,
    });
    assert.deepEqual(assistant.append(revision, initial.version, ['Stale job']), {
      added: 0, view: saved, skipped: 'stale',
    });
    const cleared = editor.replace(revision, saved.version, '');
    assert.equal(cleared.text, '');
    assert.notEqual(cleared.version, null);
    assert.notEqual(cleared.version, saved.version);
    assert.deepEqual(assistant.append(revision, saved.version, ['Stale after clearing']), {
      added: 0, view: cleared, skipped: 'stale',
    });
    assert.deepEqual(assistant.read(revision), cleared);
  } finally {
    assistant.close();
    editor.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('appending preserves manual text and flattens each new unique quote into one bullet', () => {
  const notes = new BuildNotesService(':memory:');
  try {
    const initial = 'Manual heading\n\nAlready  noted\n  * Earlier bullet\n';
    const saved = notes.replace(revision, null, initial);
    const appended = notes.append(revision, saved.version, [
      'Already noted', 'Earlier bullet', '  Get\r\nspell suppression\tfirst  ', 'Get spell suppression first', ' ',
    ]);
    assert.equal(appended.added, 1);
    assert.equal(appended.view.text, `${initial}- Get spell suppression first`);
    assert.notEqual(appended.view.version, saved.version);
    assert.deepEqual(notes.append(revision, appended.view.version, ['Get\nspell suppression first']), {
      added: 0, view: appended.view,
    });
    assert.deepEqual(notes.append(revision, saved.version, ['Overlapping job']), {
      added: 0, view: appended.view, skipped: 'stale',
    });
  } finally {
    notes.close();
  }
});

test('invalid inputs and overflowing appends leave the last saved notes intact', () => {
  const notes = new BuildNotesService(':memory:');
  try {
    const invalid = error => error instanceof BuildNoteError && error.status === 400;
    assert.throws(() => notes.read(revision.toUpperCase()), invalid);
    assert.throws(() => notes.read(`${revision}\n`), invalid);
    assert.throws(() => notes.replace(revision, null, 'x'.repeat(12001)), invalid);
    assert.throws(() => notes.replace(revision, null, 'A\u0000B'), invalid);
    const saved = notes.replace(revision, null, 'x'.repeat(11995));
    assert.deepEqual(notes.append(revision, saved.version, ['a', 'Too long']), {
      added: 0, view: saved, skipped: 'full',
    });
    const full = notes.replace(revision, saved.version, 'x'.repeat(12000));
    const edited = notes.replace(revision, full.version, 'Shorter notes');
    assert.equal(edited.text, 'Shorter notes');
  } finally {
    notes.close();
  }
});

test('an explicit return to an earlier rule gives that rule priority again', () => {
  const notes = new BuildNotesService(':memory:');
  try {
    const strong = 'Keep 100% spell suppression.';
    const relaxed = '80% spell suppression is enough for this build.';
    const first = notes.append(revision, null, [strong]);
    const second = notes.append(revision, first.view.version, [relaxed]);
    assert.equal(notes.append(revision, second.view.version, [strong]).added, 0);

    const restored = notes.append(revision, second.view.version, [{ text: strong, reaffirm: true }]);
    assert.equal(restored.added, 1);
    assert.equal(restored.view.text, `- ${strong}\n- ${relaxed}\n- ${strong}`);
    assert.equal(notes.append(revision, restored.view.version, [{ text: strong, reaffirm: true }]).added, 0);
  } finally {
    notes.close();
  }
});
