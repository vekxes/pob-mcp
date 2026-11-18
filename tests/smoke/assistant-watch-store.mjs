import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TradeApi } from '../../build/trade/api.js';
import { buildTradeQuery, tradeLink } from '../../build/trade/query.js';
import * as watchModule from '../../build/trade/watchService.js';

const folder = await mkdtemp(join(tmpdir(), 'pob-assistant-watch-store-'));
const databasePath = join(folder, 'watches.sqlite');
const scope = { game: 'poe1', realm: 'pc', league: 'Standard' };
const body = buildTradeQuery({ scope, name: 'Tabula Rasa' });
const source = { searchUrl: tradeLink(scope, body), body };
const { WatchService, watchRevision } = watchModule;
const connections = new Map();
const provider = {
  directLive: true,
  async subscribe(_scope, value, handlers, signal) {
    connections.set(value.query.name, { handlers, signal });
    return { ready: Promise.resolve(), close() {} };
  },
  async fetch(_scope, _queryId, ids) {
    return ids.map(id => ({ id, name: 'Tabula Rasa' }));
  },
};

let watches;
let api;
try {
  const legacyPath = join(folder, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(legacyPath);
  const legacyWatch = { id: 'old-watch', label: 'Legacy template', scope, ...source, status: 'paused' };
  try {
    legacyDb.exec('CREATE TABLE watches (id TEXT PRIMARY KEY, saved TEXT NOT NULL)');
    legacyDb.prepare('INSERT INTO watches VALUES (?, ?)').run(legacyWatch.id, JSON.stringify(legacyWatch));
  } finally {
    legacyDb.close();
  }
  const restored = new WatchService(legacyPath, provider);
  try {
    const [watch] = restored.list();
    assert.deepEqual(watch, legacyWatch);
    assert.match(watchRevision(watch), /^[a-f0-9]{64}$/);
    const changed = restored.stop(watch.id);
    assert.deepEqual(JSON.parse(JSON.stringify(changed)), legacyWatch);
    assert.notEqual(watchRevision(changed), watchRevision(watch));
  } finally {
    restored.close();
  }

  api = new TradeApi(databasePath);
  const preview = await api.previewWatchImport(source.searchUrl);
  assert.deepEqual(preview, { ...source, scope });
  api.provider.resolveSearch = async () => undefined;
  const bareLink = 'https://www.pathofexile.com/trade/search/Standard/valid-id';
  const barePreview = await api.previewWatchImport(bareLink);
  assert.deepEqual(barePreview, { scope, searchUrl: bareLink, searchId: 'valid-id', body: undefined });
  assert.equal(api.watches.list().length, 0, 'Showing a preview must not add a template.');
  await api.close();
  api = undefined;

  watches = new WatchService(databasePath, provider);
  const create = { kind: 'create', scope, source, label: 'Assistant template' };
  const createClaim = { key: 'key-create', proposalId: 'proposal-create', jobId: 'job-1' };
  const created = watches.applyAssistantAction(create, createClaim);
  assert.equal(watches.list()[0].status, 'paused');
  assert.equal(connections.size, 0, 'Assistant-created templates start paused.');
  assert.deepEqual(watches.applyAssistantAction(create, createClaim), created);
  assert.throws(() => watches.applyAssistantAction(create, { ...createClaim, key: 'another-key' }), { status: 409 });
  assert.throws(() => watches.applyAssistantAction({ ...create, label: 'Different action' }, createClaim), { status: 409 });
  assert.equal(watches.list().length, 1);

  const original = watches.list()[0];
  const originalRevision = watchRevision(original);
  assert.equal(JSON.stringify(original).includes(originalRevision), false);
  const activePromise = once(watches, 'state');
  watches.resume(created.watchId);
  await activePromise;
  await new Promise(resolve => setImmediate(resolve));
  const active = watches.list()[0];
  assert.equal(active.status, 'active');
  assert.notEqual(watchRevision(active), originalRevision);
  const connection = connections.get('Tabula Rasa');
  await connection.handlers.matches(['first-match'], 'query');

  const pause = { kind: 'pause', watchId: created.watchId, expectedRevision: watchRevision(active) };
  const pauseClaim = { key: 'key-pause', proposalId: 'proposal-pause', jobId: 'job-1' };
  const testDb = new DatabaseSync(databasePath);
  try {
    testDb.exec(`
      CREATE TRIGGER reject_assistant_write BEFORE INSERT ON assistant_watch_actions
      BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END
    `);
    assert.throws(() => watches.applyAssistantAction(pause, pauseClaim), /synthetic ledger failure/);
    assert.equal(watches.list()[0].status, 'active');
    assert.equal(connection.signal.aborted, false, 'A rolled-back pause must preserve the live subscription.');
    testDb.exec('DROP TRIGGER reject_assistant_write');
  } finally {
    testDb.close();
  }
  const paused = watches.applyAssistantAction(pause, pauseClaim);
  assert.equal(watches.list()[0].status, 'paused');
  assert.equal(connection.signal.aborted, true);
  assert.notEqual(watchRevision(watches.list()[0]), originalRevision, 'Reaching the previous state must keep a new revision.');
  assert.deepEqual(watches.applyAssistantAction(pause, pauseClaim), paused);
  assert.throws(() => watches.applyAssistantAction(
    { ...pause, kind: 'remove' },
    { key: 'key-stale', proposalId: 'proposal-stale', jobId: 'job-1' },
  ), { status: 409 });

  const remove = { kind: 'remove', watchId: created.watchId, expectedRevision: watchRevision(watches.list()[0]) };
  const removeClaim = { key: 'key-remove', proposalId: 'proposal-remove', jobId: 'job-1' };
  const removed = watches.applyAssistantAction(remove, removeClaim);
  assert.equal(watches.list().length, 0);
  assert.equal(watches.events().events.length, 1, 'Removing a template must preserve its event journal.');
  watches.close();
  watches = new WatchService(databasePath, provider);
  assert.deepEqual(watches.applyAssistantAction(create, createClaim), created);
  assert.deepEqual(watches.applyAssistantAction(remove, removeClaim), removed);
  assert.equal(watches.list().length, 0, 'Replaying after restart must never recreate a deleted template.');
  assert.equal(watches.events().events.length, 1);
  console.log('Assistant watch previews, atomic apply, stale revisions and durable replay passed.');
} finally {
  watches?.close();
  await api?.close();
  await rm(folder, { recursive: true, force: true });
}
