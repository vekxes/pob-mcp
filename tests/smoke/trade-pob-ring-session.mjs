import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { descriptor, localOrigin } from '../../build/trade/localConnection.js';

const { values } = parseArgs({ options: {
  'anonymous-baseline': { type: 'boolean' },
  league: { type: 'string', default: 'Covens' },
  'save-query': { type: 'string' },
  'replay-query': { type: 'string' },
} });
assert.ok(!values['save-query'] || !values['replay-query'], 'Choose either --save-query or --replay-query.');
const scope = { game: 'poe1', realm: 'pc', league: values.league };
const slot = 'Ring 1';
const sessionExpected = !values['anonymous-baseline'];

// Attach to the already running desktop service so the probe cannot start a
// headless service or create a new profile in place of the signed-in browser.
const { token } = JSON.parse(await readFile(descriptor, 'utf8'));
assert.ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'Expected a local Trade service connection.');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function request(path, input) {
  const response = await fetch(localOrigin + path, {
    headers, redirect: 'error', signal: AbortSignal.timeout(120_000),
    ...(input && { method: 'POST', body: JSON.stringify(input) }),
  });
  assert.ok(response.ok, `${path} returned HTTP ${response.status}.`);
  return response.json();
}

async function trade(name, args) {
  const { data } = await request('/api', { name, args });
  assert.ok(data, `No response from ${name}.`);
  return data;
}

assert.equal((await request('/health')).service, 'poe-local-trade');
const { data: session } = await request('/trade-session');
assert.equal(session.connected, sessionExpected, `Unexpected browser session state: ${session.status ?? 'unknown'}`);
if (sessionExpected) assert.equal(session.browserAvailable, true, 'The desktop browser must own the session.');

const xml = await readFile(new URL('../fixtures/occ-vortex.xml', import.meta.url), 'utf8');
const { buildId, revision } = await trade('trade_import_build', { kind: 'xml', value: xml });
const { rows } = await trade('trade_for_build', { buildId, revision, scope, mode: 'upgrade', slots: [slot] });
assert.equal(rows.length, 1);
const [row] = rows;
assert.equal(row.slot, slot);
assert.equal(row.item, 'Hate Band, Paua Ring');
const countWeights = body => body?.query?.stats?.find(group => group.type === 'weight')?.filters?.length;
assert.ok(countWeights(row.body), 'PoB must produce its native weighted query for the ring.');

// PoB can recalculate weights when Lua restarts. The saved payload contains only
// the fixture's search settings, so the next run can replay the exact request.
let body = row.body;
if (values['replay-query']) {
  const saved = JSON.parse(await readFile(values['replay-query'], 'utf8'));
  assert.deepEqual(saved.scope, scope);
  assert.equal(saved.slot, slot);
  assert.equal(saved.revision, revision);
  assert.ok(countWeights(saved.body), 'The replay file must contain a PoB weighted query.');
  body = saved.body;
} else if (values['save-query']) {
  await writeFile(values['save-query'], JSON.stringify({ scope, revision, slot, body }), { flag: 'wx', mode: 0o600 });
}
const querySha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
const result = await trade('trade_search', { scope, body, limit: 5 });
console.log(JSON.stringify({
  league: scope.league, slot, item: row.item, weights: countWeights(body), querySha256,
  connected: session.connected, status: result.status, warningCode: result.warningCode,
  total: result.total, listings: result.listings.length, searchId: result.searchId,
}));

if (sessionExpected) {
  assert.equal(result.status, 'ok', result.warning);
  assert.ok(result.searchId, 'Expected an official Trade query ID.');
  if (result.total > 0) assert.ok(result.listings.length, 'Expected fetched listings for a nonempty search.');
} else {
  assert.equal(result.status, 'unavailable');
  assert.equal(result.warningCode, 'complex_query', result.warning);
}
