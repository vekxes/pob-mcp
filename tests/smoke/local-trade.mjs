import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchService } from '../../build/trade/watchService.js';
import { buildTradeQuery } from '../../build/trade/query.js';

const folder = await mkdtemp(join(tmpdir(), 'pob-local-trade-'));
const scope = { game: 'poe1', realm: 'pc', league: 'Standard' };
const body = buildTradeQuery({ scope, name: 'Tabula Rasa' });
let handlers;
const provider = {
  directLive: true,
  async subscribe(_scope, _body, events) {
    handlers = events;
    return { ready: Promise.resolve(), close() {} };
  },
  async fetch(_scope, _queryId, ids) {
    return ids.map(id => ({ id, name: 'Tabula Rasa', price: { amount: 7, currency: 'chaos' } }));
  },
};

let watches;
try {
  watches = new WatchService(join(folder, 'watches.sqlite'), provider);
  const watch = watches.start(scope, body, 'Tabula');
  while (!handlers) await new Promise(resolve => setImmediate(resolve));
  const update = once(watches, 'event');
  await handlers.matches(['new-listing'], 'query');
  await update;
  await handlers.matches(['new-listing'], 'query');
  const first = watches.events();
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].price.amount, 7);
  assert.equal(first.events[0].watchId, watch.id);
  assert.equal(watches.events(first.nextCursor).events.length, 0);
  watches.stop(watch.id);
  await handlers.matches(['after-stop'], 'query');
  assert.equal(watches.events().events.length, 1);
  const template = watches.saveSearch(scope, body, 'Tabula template');
  watches.close();
  watches = undefined;
  watches = new WatchService(join(folder, 'watches.sqlite'), provider);
  assert.deepEqual(watches.list()[0], template);
  assert.equal(watches.list()[1].status, 'paused');
  assert.equal(watches.events().events[0].listingId, 'new-listing');
  watches.resume(watch.id);
  const batch = Array.from({ length: 45 }, (_, index) => `burst-${index}`);
  const pending = handlers.matches(batch, 'query');
  handlers.disconnected();
  await pending;
  assert.equal(watches.events().events.length, 46, 'A disconnect must preserve the whole already received burst.');
  assert.equal(watches.list()[1].status, 'disconnected');
  console.log('Trade watch deduplication, cursors, stop and SQLite persistence passed.');
} finally {
  watches?.close();
  await rm(folder, { recursive: true, force: true });
}
