import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PobAdapter } from '../../build/trade/pobAdapter.js';
import { TradeProvider } from '../../build/trade/provider.js';
import { buildTradeQuery } from '../../build/trade/query.js';

process.env.POE_TRADE_ENABLED = 'false';
process.env.POB_DIRECTORY = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixture = await readFile(new URL('../fixtures/occ-vortex.xml', import.meta.url), 'utf8');
const scope = { game: 'poe1', realm: 'pc', league: 'Standard' };
const provider = new TradeProvider();

test('exposes only the selected build research profile', async t => {
  const adapter = new PobAdapter((scope, mods) => provider.resolveMods(scope, mods));
  t.after(() => adapter.close());
  const imported = await adapter.importBuild({ kind: 'file', value: 'occ-vortex', name: 'private-test-label' });
  const profile = await adapter.researchProfile({ buildId: imported.buildId, revision: imported.revision });
  assert.equal(profile.className, 'Witch');
  assert.equal(profile.ascendancy, 'Occultist');
  assert.equal(profile.level, 99);
  assert.equal(profile.mainSkill, 'Vortex');
  assert.ok(profile.skills.includes('Vortex'));
  assert.ok(profile.supportGems.length > 0);
  assert.ok(profile.gear.some(item => item.slot === 'Helmet' && item.name === "Heretic's Veil"));
  assert.ok(profile.stats.EnergyShield > 0);
  assert.ok(Number.isFinite(profile.stats.ColdResist));
  assert.doesNotMatch(JSON.stringify(profile), /private-test-label|<PathOfBuilding|Metadata\/Items|occ-vortex/i);
  await assert.rejects(adapter.researchProfile({ buildId: imported.buildId, revision: '0'.repeat(64) }), /revision/i);
});

test('PoB searches preserve build context and report which slots and modifiers can be matched', async t => {
  const adapter = new PobAdapter((scope, mods) => provider.resolveMods(scope, mods));
  t.after(() => adapter.close());
  const build = await adapter.importBuild({ kind: 'file', value: 'occ-vortex', name: 'Vortex' });
  const matching = { buildId: build.buildId, revision: build.revision, scope, mode: 'match' };

  await t.test('uses one revision for the same XML across a file and pasted text', async () => {
    for (const eol of ['\n', '\r\n']) {
      const pasted = await adapter.importBuild({ kind: 'xml', value: fixture.trim().replace(/\r?\n/g, eol), name: 'Vortex' });
      assert.equal(pasted.buildId, build.buildId);
      assert.equal(pasted.revision, build.revision);
    }
  });

  await t.test('hides empty passive-tree sockets from the slot list', async () => {
    const emptyRing = fixture.replaceAll('<Slot name="Ring 2" itemId="6"/>', '<Slot name="Ring 2" itemId="0"/>');
    const { slots } = await adapter.importBuild({ kind: 'xml', value: emptyRing });
    assert.deepEqual(slots.find(entry => entry.slot === 'Ring 2'), { slot: 'Ring 2', item: null });
    assert.equal(slots.find(entry => entry.slot === 'Jewel 36634')?.item, 'Cataclysm Stone, Cobalt Jewel');
    assert.equal(slots.some(entry => entry.slot === 'Weapon 2 Swap'), false);
    assert.equal(slots.some(entry => /^Jewel \d+$/.test(entry.slot) && entry.item === null), false);
  });

  await t.test('exposes item level and equipped modifiers to the slot picker', () => {
    const ring = build.slots.find(entry => entry.slot === 'Ring 1');
    assert.equal(ring.item, 'Hate Band, Paua Ring');
    assert.equal(ring.details.itemLevel, 72);
    assert.equal(ring.details.rarity, 'RARE');
    assert.ok(ring.details.mods.some(mod => mod.type === 'implicit' && mod.line === '+29 to maximum Mana'));
    assert.ok(ring.details.mods.some(mod => mod.type === 'crafted' && mod.line === '+13% to Fire and Chaos Resistances'));
  });

  await t.test('matches a unique by its trade name and keeps rings and their budgets separate', async () => {
    const result = await adapter.prepare({ ...matching, slots: ['Helmet', 'Ring 1', 'Ring 2'],
      budget: { currency: 'chaos', max: 12 }, budgets: { 'Ring 2': { currency: 'divine', max: 3 } } });
    const [helmet, first, second] = result.rows;
    assert.equal(helmet.body.query.name, "Heretic's Veil");
    assert.equal(first.body.query.type, 'Paua Ring');
    assert.equal(second.body.query.type, 'Coral Ring');
    assert.equal(first.body.query.filters.trade_filters.filters.price.max, 12);
    assert.equal(second.body.query.filters.trade_filters.filters.price.max, 3);
    assert.ok(first.body.query.stats.some(group => group.filters.some(filter => filter.value?.min === 78)));
    assert.ok(first.warnings.some(warning => warning.includes('resolved modifiers')));
  });

  await t.test('preserves an equipped inactive weapon slot without calculating an inactive replacement', async () => {
    const swapXml = fixture.replaceAll('<Slot name="Weapon 1 Swap" itemId="0"/>', '<Slot name="Weapon 1 Swap" itemId="3"/>');
    const swapped = await adapter.importBuild({ kind: 'xml', value: swapXml });
    const input = { ...matching, buildId: swapped.buildId, revision: swapped.revision, slots: ['Weapon 1 Swap'] };
    assert.match(swapped.slots.find(item => item.slot === 'Weapon 1 Swap')?.item, /^Maelstrom Cry/);
    const match = (await adapter.prepare(input)).rows[0];
    assert.match(match.item, /^Maelstrom Cry/);
    assert.ok(match.link, JSON.stringify(match));
    const upgrade = (await adapter.prepare({ ...input, mode: 'upgrade' })).rows[0];
    assert.equal(upgrade.link, undefined);
    assert.match(upgrade.warnings.join(' '), /inactive|enable/i);
    await assert.rejects(adapter.simulate({ ...input, slot: 'Weapon 1 Swap', itemText: 'Rarity: Normal\nImbued Wand' }), /inactive|active/i);
  });

  await t.test('keeps concurrent imports associated with their own ring and revision', async () => {
    const changed = fixture.replaceAll('<Slot name="Ring 1" itemId="5"/>', '<Slot name="Ring 1" itemId="6"/>');
    const importAndMatch = async (kind, value) => {
      const imported = await adapter.importBuild({ kind, value });
      return adapter.prepare({ ...matching, buildId: imported.buildId, revision: imported.revision, slots: ['Ring 1'] });
    };
    const [original, other] = await Promise.all([importAndMatch('file', 'occ-vortex'), importAndMatch('xml', changed)]);
    assert.notEqual(original.revision, other.revision);
    assert.equal(original.rows[0].body.query.type, 'Paua Ring');
    assert.equal(other.rows[0].body.query.type, 'Coral Ring');
  });

  await t.test('withholds a bare base when all modifiers are unresolved', async () => {
    const noFilters = new PobAdapter(async (_scope, mods) => ({ filters: [], warnings: mods.map(mod => mod.line) }));
    try {
      const imported = await noFilters.importBuild({ kind: 'xml', value: fixture });
      const result = await noFilters.prepare({ ...matching, buildId: imported.buildId, revision: imported.revision,
        slots: ['Ring 1', 'Missing slot'] });
      assert.equal(result.rows[0].body, undefined);
      assert.equal(result.rows[0].link, undefined);
      assert.ok(result.rows[0].warnings.some(warning => warning.includes('+78 to maximum Life')));
      assert.match(result.rows[1].warnings[0], /unknown/i);
    } finally {
      await noFilters.close();
    }
  });

  await t.test('rejects malformed slot selection and shows an invalid budget on its row only', async () => {
    await assert.rejects(adapter.prepare({ ...matching, slots: 'Ring 1' }), /slots/i);
    const { rows } = await adapter.prepare({ ...matching, slots: ['Ring 1', 'Ring 2'], budgets: { 'Ring 1': null } });
    assert.equal(rows[0].link, undefined);
    assert.match(rows[0].warnings.join(' '), /budget/i);
    assert.ok(rows[1].link);
  });

  await t.test('recovers the requested build when Lua reports a restart inside a live MCP session', async () => {
    await adapter.prepare({ ...matching, slots: ['Ring 1'] });
    const client = adapter.client;
    const callTool = client.callTool.bind(client);
    client.callTool = async request => {
      if (request.name !== 'get_equipped_items') return callTool(request);
      client.callTool = callTool;
      await callTool({ name: 'lua_stop' });
      return { isError: true, content: [{ type: 'text', text: 'The PoB Lua bridge crashed and was restarted. The previously loaded build was lost.' }] };
    };
    const { rows } = await adapter.prepare({ ...matching, slots: ['Ring 1'] });
    assert.equal(rows[0].body.query.type, 'Paua Ring');
  });

  await t.test('keeps native ring and unique-slot replacement weights and leaves gear intact', async () => {
    const { rows } = await adapter.prepare({ ...matching, mode: 'upgrade', slots: ['Ring 1', 'Ring 2', 'Helmet'],
      budget: { currency: 'divine', max: 2 } });
    for (const row of rows) {
      assert.ok(row.body, JSON.stringify(row));
      assert.ok(row.body.query.stats.some(group => group.type === 'weight' && group.filters.length));
      assert.equal(row.body.sort['statgroup.0'], 'desc');
      assert.equal(row.body.query.filters.trade_filters.filters.price.max, 2);
    }
    assert.equal(rows[0].body.query.filters.type_filters.filters.category.option, 'accessory.ring');
    assert.equal(rows[2].body.query.filters.type_filters.filters.rarity.option, 'nonunique');
    const simulation = await adapter.simulate({ ...matching, slot: 'Ring 1', itemText: 'Rarity: Rare\nTest Ring\nPaua Ring\nImplicits: 0\n+90 to maximum Life' });
    assert.match(simulation.report, /Combined DPS/);
    assert.match(simulation.report, /Effective HP/);
    const { rows: after } = await adapter.prepare({ ...matching, slots: rows.map(row => row.slot) });
    assert.deepEqual(after.map(row => row.item), rows.map(row => row.item));
  });

  await t.test('rejects a recognised item that cannot occupy the chosen slot', async () => {
    await assert.rejects(adapter.simulate({ ...matching, slot: 'Helmet', itemText: 'Rarity: Normal\nPaua Ring' }),
      /cannot be equipped in Helmet/);
  });

  await t.test('compares the canonical text of a loaded offer in PoB', async () => {
    const itemText = [
      'Item Class: Rings', 'Rarity: Rare', 'Ash Turn', 'Paua Ring', '--------', 'Item Level: 84', '--------',
      '+30 to maximum Mana (implicit)', '--------', '+110 to maximum Life', '+12% to Lightning Resistance (crafted)',
      '--------', 'Note: ~price 3 chaos',
    ].join('\r\n');
    const previousFetch = globalThis.fetch;
    const previousDirectSearch = process.env.POE_TRADE_ENABLED;
    globalThis.fetch = async (_url, options) => options.method === 'POST'
      ? Response.json({ id: 'listing-search', result: ['one'], total: 1 })
      : Response.json({ result: [{ id: 'one', listing: {}, item: {
        name: 'Ash Turn', typeLine: 'Paua Ring', identified: true,
        extended: { text: Buffer.from(itemText).toString('base64') },
      } }] });
    process.env.POE_TRADE_ENABLED = 'true';
    try {
      const trade = new TradeProvider();
      const { listings } = await trade.search(scope, buildTradeQuery({ scope, base: 'Paua Ring' }));
      assert.ok(listings[0]?.itemText);
      const result = await adapter.simulate({ ...matching, slot: 'Ring 1', itemText: listings[0].itemText });
      assert.match(result.report, /^  Life: [^\n]+ → [^\n]+ {2}\+/m);
      assert.match(result.report, /^  Lightning Resistance: 75 → 57\b/m);
      assert.doesNotMatch(result.report, /did not recognise these item lines/i);
    } finally {
      globalThis.fetch = previousFetch;
      process.env.POE_TRADE_ENABLED = previousDirectSearch;
    }
  });
});
