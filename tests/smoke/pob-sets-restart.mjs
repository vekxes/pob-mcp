import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const realBuild = await readFile(new URL('../fixtures/occ-vortex.xml', import.meta.url), 'utf8');
const tempRoot = resolve(tmpdir());
const home = await mkdtemp(join(tempRoot, 'pob-sets-restart-'));
const builds = join(home, 'builds');
const buildFile = join(builds, 'restart-fixture.xml');
const codexPath = join(home, process.platform === 'win32' ? 'codex.exe' : 'codex');
const codexSettingsPath = '/settings/codex';
const scope = { game: 'poe1', realm: 'pc', league: 'Hardcore Settlers' };
const settings = {
  scope, mode: 'upgrade', slots: ['Ring 2', 'Ring 1'],
  budget: { currency: 'chaos', min: 10, max: 45 },
  budgets: { 'Ring 2': { currency: 'divine', min: 1, max: 3 } },
};

async function withDaemon(callback) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()));
  const origin = `http://127.0.0.1:${port}`;
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../../build/trade/daemon.js', import.meta.url))], {
    env: {
      ...process.env, POE_TRADE_HOME: home, POE_TRADE_PORT: String(port), POB_DIRECTORY: builds,
      POE_ASSISTANT_CODEX: '', POE_TRADE_ENABLED: 'false', POE_TRADE_LIVE_ENABLED: 'false', POE_SESSION_ID: '',
    },
    stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  });
  const exited = once(daemon, 'exit');
  let headers, window, passed;

  try {
    for (let attempt = 0; attempt < 70 && !headers && daemon.exitCode === null; attempt++) {
      try {
        const { token } = JSON.parse(await readFile(join(home, 'connection.json'), 'utf8'));
        assert.match(token, /^[a-f0-9]{64}$/);
        const candidate = { Authorization: `Bearer ${token}`, Origin: origin };
        const response = await fetch(`${origin}/health`, { headers: candidate, signal: AbortSignal.timeout(400) });
        if (response.ok && (await response.json()).service === 'poe-local-trade') headers = candidate;
      } catch {
        // After a restart the previous connection file can exist until the replacement is published.
      }
      if (!headers) await delay(100);
    }
    assert.ok(headers, 'The isolated daemon must publish an authenticated connection.');
    window = await fetch(`${origin}/events`, { headers, signal: AbortSignal.timeout(60_000) });
    assert.equal(window.status, 200);
    const windowId = window.headers.get('X-PoE-Trade-Window');
    assert.ok(windowId, 'The daemon must register the smoke test as a live application window.');
    const request = async (path, body, { useWindow = true, useOrigin = true, useAuth = true, expectedStatus = 200 } = {}) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(useAuth && { Authorization: headers.Authorization }), ...(useOrigin && { Origin: origin }),
          ...(useWindow && { 'X-PoE-Trade-Window': windowId }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(35_000),
      });
      const payload = await response.json();
      assert.equal(response.status, expectedStatus, `${path}: ${payload.error ?? 'unexpected status'}`);
      return payload.data;
    };
    const result = await callback(request, (name, args) => request('/api', { name, args }));
    passed = true;
    return result;
  } finally {
    await window?.body?.cancel().catch(() => {});
    if (headers && daemon.exitCode === null) {
      await fetch(`${origin}/stop`, { method: 'POST', headers, signal: AbortSignal.timeout(4_000) }).catch(() => {});
    }
    const fallback = setTimeout(() => daemon.kill(), headers ? 6_000 : 0);
    try {
      const [code] = await exited;
      if (passed) assert.equal(code, 0, 'The app daemon must exit cleanly before reopening the database.');
    } finally {
      clearTimeout(fallback);
    }
  }
}

function assertSettings(set) {
  assert.deepEqual({ scope: set.scope, slots: set.slots, mode: set.mode, budget: set.budget, budgets: set.budgets }, settings);
}

function buildNotesPath({ buildId, revision }) {
  return '/build-notes?' + new URLSearchParams({ buildId, revision });
}

try {
  await mkdir(builds);
  await writeFile(buildFile, realBuild);
  await writeFile(codexPath, 'CLI path fixture', { mode: 0o700 });
  const { original, saved, watchList, notes } = await withDaemon(async (request, trade) => {
    await request(codexSettingsPath, undefined, { useAuth: false, expectedStatus: 401 });
    assert.equal((await request(codexSettingsPath)).path, '');
    const codeSetting = { action: 'save', path: codexPath };
    await request(codexSettingsPath, codeSetting, { useOrigin: false, expectedStatus: 403 });
    await request(codexSettingsPath, codeSetting, { useWindow: false, expectedStatus: 409 });
    await request(codexSettingsPath, { action: 'save', path: process.execPath }, { expectedStatus: 400 });
    const configured = await request(codexSettingsPath, codeSetting);
    assert.equal(configured.path, codexPath);
    assert.equal(configured.source, 'saved');
    assert.deepEqual(await request('/assistant/status'), { configured: true, ready: false, state: 'unavailable' });
    await request('/assistant/jobs', { requestId: 'not-ready', text: 'Do not send', context: { scope } }, { expectedStatus: 503 });
    assert.deepEqual(await request('/pob-sets', undefined, { useWindow: false, useOrigin: false }), []);
    await request('/pob-build-files', undefined, { useAuth: false, expectedStatus: 401 });
    const listBuildFiles = () => request('/pob-build-files', undefined, { useWindow: false, useOrigin: false });
    assert.deepEqual(await listBuildFiles(), ['restart-fixture.xml']);
    const subfolder = join(builds, 'Ведьма');
    await mkdir(subfolder);
    await writeFile(join(subfolder, 'Вихрь 2.XML'), realBuild);
    await writeFile(join(subfolder, '.backup.xml'), realBuild);
    await writeFile(join(builds, '~~temp~~save.xml'), realBuild);
    await writeFile(join(builds, 'README.txt'), 'not a build');
    assert.deepEqual(new Set(await listBuildFiles()), new Set(['restart-fixture.xml', join('Ведьма', 'Вихрь 2.XML')]));
    const original = await trade('trade_import_build', { kind: 'file', value: 'restart-fixture.xml', name: 'Vortex snapshot' });
    const noteDraft = { buildId: original.buildId, revision: original.revision, expectedVersion: null,
      text: 'Keep Vortex as the main skill.' };
    await request(buildNotesPath(original), undefined, { useAuth: false, expectedStatus: 401 });
    assert.deepEqual(await request(buildNotesPath(original)), { text: '', version: null });
    await request('/build-notes', noteDraft, { useWindow: false, expectedStatus: 409 });
    await request('/build-notes', noteDraft, { useOrigin: false, expectedStatus: 403 });
    await request('/build-notes', { ...noteDraft, buildId: '0'.repeat(24) }, { expectedStatus: 404 });
    const notes = await request('/build-notes', noteDraft);
    assert.equal(notes.text, noteDraft.text);
    await request('/build-notes', { ...noteDraft, text: 'Stale overwrite' }, { expectedStatus: 409 });
    await trade('trade_watch_save', { scope, name: 'Tabula Rasa', label: 'Unrelated watch' });
    const watchList = await trade('trade_watch_list', {});
    const save = {
      kind: 'save_pob_set', label: 'Rings for hardcore',
      draft: { buildId: original.buildId, revision: original.revision, ...settings },
    };
    await request('/pob-sets', save, { useWindow: false, expectedStatus: 409 });
    await request('/pob-sets', save, { useOrigin: false, expectedStatus: 403 });
    await request('/pob-sets', save, { useAuth: false, expectedStatus: 401 });
    assert.deepEqual(await request('/pob-sets'), []);
    const result = await request('/pob-sets', save);
    assert.equal(result.kind, 'save_pob_set');
    const [saved] = await request('/pob-sets');
    assert.equal(saved.id, result.setId);
    assert.equal(saved.sourceRevision, original.revision);
    assert.equal(Object.hasOwn(saved, 'source'), false, 'The source snapshot must stay in the local store.');
    assertSettings(saved);
    assert.equal(await readFile(buildFile, 'utf8'), realBuild, 'Saving a set must not rewrite the imported file.');
    return { original, saved, watchList, notes };
  });

  const changedBuild = realBuild.replaceAll('<Slot name="Ring 1" itemId="5"/>', '<Slot name="Ring 1" itemId="6"/>');
  assert.notEqual(changedBuild, realBuild, 'The source-file mutation must affect the actual fixture.');
  await writeFile(buildFile, changedBuild);

  await withDaemon(async (request, trade) => {
    assert.equal((await request(codexSettingsPath)).path, codexPath);
    assert.deepEqual(await request('/assistant/status'), { configured: true, ready: false, state: 'unavailable' });
    assert.equal((await request(codexSettingsPath, { action: 'reset' })).source, 'none');
    assert.deepEqual(await request('/assistant/status'), { configured: false, ready: false, state: 'setup_required' });
    assert.deepEqual(await request('/pob-sets'), [saved]);
    const opened = await request('/pob-sets', {
      kind: 'open_pob_set', setId: saved.id, expectedVersion: saved.version,
    });
    assert.equal(opened.kind, 'open_pob_set');
    assert.deepEqual(opened.set, saved);
    assertSettings(opened.set);
    assert.equal(opened.build.revision, original.revision);
    assert.deepEqual(opened.build.slots, original.slots);
    assert.deepEqual(await request(buildNotesPath(opened.build)), notes);

    const { scope, mode, slots, budget, budgets } = opened.set;
    const result = await trade('trade_for_build', {
      buildId: opened.build.buildId, revision: opened.build.revision, scope, mode, slots, budget, budgets,
    });
    assert.deepEqual(result.rows.map(row => row.slot), settings.slots);
    for (const row of result.rows) {
      const expected = settings.budgets[row.slot] ?? settings.budget;
      assert.deepEqual(row.scope, settings.scope);
      assert.ok(row.link.startsWith(`https://www.pathofexile.com/trade/search/${encodeURIComponent(scope.league)}/`));
      assert.ok(row.body.query.stats.some(group => group.type === 'weight' && group.filters.length));
      assert.deepEqual(row.body.query.filters.trade_filters.filters.price, {
        option: expected.currency, min: expected.min, max: expected.max,
      });
    }

    const changed = await trade('trade_import_build', { kind: 'file', value: 'restart-fixture.xml', name: 'Vortex snapshot' });
    assert.notEqual(changed.revision, opened.build.revision);
    assert.notEqual(changed.slots.find(item => item.slot === 'Ring 1').item, opened.build.slots.find(item => item.slot === 'Ring 1').item);
    assert.deepEqual(await request(buildNotesPath(changed)), { text: '', version: null });
    assert.deepEqual(await request(buildNotesPath(opened.build)), notes);

    // Simulate a saved selection from before empty tree sockets were hidden.
    const emptyJewel = 'Jewel 16218';
    const database = new DatabaseSync(join(home, 'watches.sqlite'));
    try {
      const updateSummary = database.prepare('UPDATE pob_sets SET summary = ? WHERE id = ?');
      const legacy = { ...saved, slots: [...saved.slots, emptyJewel] };
      updateSummary.run(JSON.stringify(legacy), saved.id);
      try {
        const result = await request('/pob-sets', { kind: 'open_pob_set', setId: saved.id, expectedVersion: saved.version });
        assert.deepEqual(result.skippedEmptyJewelSlots, [emptyJewel]);
        assert.ok(result.build.slots.every(({ slot }) => slot !== emptyJewel));
        assert.deepEqual(await request('/pob-sets'), [legacy]);
      } finally {
        updateSummary.run(JSON.stringify(saved), saved.id);
      }
    } finally {
      database.close();
    }

    await request('/pob-sets', { kind: 'rename_pob_set', setId: saved.id, expectedVersion: saved.version, label: 'Renamed rings' });
    const [renamed] = await request('/pob-sets');
    assert.equal(renamed.label, 'Renamed rings');
    assert.notEqual(renamed.version, saved.version);
    assertSettings(renamed);
    await request('/pob-sets', { kind: 'rename_pob_set', setId: saved.id, expectedVersion: saved.version, label: 'Stale rename' }, { expectedStatus: 409 });
    await request('/pob-sets', { kind: 'remove_pob_set', setId: saved.id, expectedVersion: saved.version }, { expectedStatus: 409 });
    assert.deepEqual(await request('/pob-sets'), [renamed]);
    await request('/pob-sets', { kind: 'remove_pob_set', setId: renamed.id, expectedVersion: renamed.version });
    assert.deepEqual(await request('/pob-sets'), []);
    assert.equal(await readFile(buildFile, 'utf8'), changedBuild);
    assert.deepEqual(await trade('trade_watch_list', {}), watchList);
  });

  console.log('PoB set restart, immutable source snapshot, league, slot order, budgets, version checks, and build notes passed.');
} finally {
  const child = relative(tempRoot, resolve(home));
  assert.match(child, /^pob-sets-restart-[a-zA-Z0-9]+$/);
  await rm(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
