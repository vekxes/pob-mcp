import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!process.argv.includes('--real')) {
  console.log('Use --real with POE_ASSISTANT_PLAYWRIGHT to run two Codex requests against synthetic test data in Edge.');
  process.exit(0);
}

async function codexExecutable() {
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const configured = process.env.POE_ASSISTANT_CODEX;
  const candidates = configured ? [configured] : (process.env.PATH ?? '').split(delimiter)
    .filter(folder => isAbsolute(folder)).map(folder => join(folder, executable));
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error('Set POE_ASSISTANT_CODEX to the absolute path of the authenticated Codex executable.');
}

async function reservePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

const playwrightModule = process.env.POE_ASSISTANT_PLAYWRIGHT;
assert.ok(playwrightModule && isAbsolute(playwrightModule), 'Set POE_ASSISTANT_PLAYWRIGHT to an absolute Playwright module path.');
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const edge = process.env.POE_ASSISTANT_EDGE;
assert.ok(!edge || isAbsolute(edge), 'POE_ASSISTANT_EDGE must be an absolute executable path when set.');
const root = fileURLToPath(new URL('../../', import.meta.url));
const scope = { game: 'poe1', realm: 'pc', league: 'Hardcore Settlers' };
const settings = {
  scope, slots: ['Ring 2', 'Ring 1'], mode: 'upgrade',
  budget: { currency: 'chaos', min: 10, max: 45 },
  budgets: { 'Ring 2': { currency: 'divine', min: 1, max: 3 } },
};
const label = 'Assistant flow rings fixture';
const initialPrompt = `Открой сохранённый комплект «${label}» через подтверждение в приложении.`;
const upgradePrompt = 'Подбери апгрейды для выбранного слота Ring 2 с учётом его бюджета в открытом комплекте.';
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const executable = await codexExecutable();
const temporaryRoot = resolve(tmpdir());
const folder = await mkdtemp(join(temporaryRoot, 'pob-set-watch-flow-'));
const logPath = join(folder, 'service.log');
const env = {
  ...process.env, POE_ASSISTANT_CODEX: executable, POE_TRADE_HOME: folder,
  POE_TRADE_PORT: String(port), POB_DIRECTORY: join(root, 'tests', 'fixtures'),
  POE_TRADE_ENABLED: 'false', POE_TRADE_LIVE_ENABLED: 'false', POE_SESSION_ID: '',
};
delete env.CODEX_API_KEY;
delete env.OPENAI_API_KEY;

let browser, daemon, exited, headers;
const pageErrors = [];
try {
  const log = await open(logPath, 'wx', 0o600);
  try {
    daemon = spawn(process.execPath, [join(root, 'build', 'trade', 'daemon.js')], {
      cwd: root, env, stdio: ['ignore', 'ignore', log.fd], windowsHide: true,
    });
    exited = once(daemon, 'exit');
  } finally {
    await log.close();
  }

  let token;
  for (let attempt = 0; attempt < 60 && daemon.exitCode === null && !token; attempt++) {
    try { ({ token } = JSON.parse(await readFile(join(folder, 'connection.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!token) await delay(100);
  }
  assert.match(token ?? '', /^[a-f0-9]{64}$/, 'The isolated daemon did not create an authenticated connection.');
  headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };

  async function request(path, body, windowId) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(windowId && { 'X-PoE-Trade-Window': windowId }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const payload = await response.json();
    assert.ok(response.ok, `${path} returned ${response.status}: ${payload.error ?? 'unexpected status'}`);
    return payload.data;
  }
  const trade = (name, args) => request('/api', { name, args });

  const seed = await fetch(origin + '/events', { headers, signal: AbortSignal.timeout(45_000) });
  try {
    const seedWindow = seed.headers.get('X-PoE-Trade-Window');
    assert.ok(seed.ok && seedWindow);
    const build = await trade('trade_import_build', { kind: 'file', value: 'occ-vortex', name: 'Synthetic Vortex fixture' });
    const { set } = await request('/pob-sets', {
      kind: 'save_pob_set', label, draft: { buildId: build.buildId, revision: build.revision, ...settings },
    }, seedWindow);
    assert.deepEqual(set.slots, settings.slots);
    assert.deepEqual(set.budgets, settings.budgets);
  } finally {
    await seed.body?.cancel();
  }
  assert.deepEqual((await trade('trade_watch_list', {})).watches, []);

  browser = await chromium.launch(edge ? { executablePath: edge } : { channel: 'msedge' });
  const context = await browser.newContext();
  await context.addInitScript(({ origin, token }) => {
    if (location.origin !== origin) return;
    sessionStorage.setItem('poe-trade-token', token);
    localStorage.setItem('poe-trade-league:poe1:pc:catalog', JSON.stringify([{ id: 'Standard', label: 'Standard' }]));
  }, { origin, token });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.name));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#league option[value="Standard"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#league').inputValue(), 'Standard');

  async function ask(prompt) {
    if (!(await page.locator('#assistant').isVisible())) await page.locator('#assistant-toggle').click();
    await page.locator('#assistant-form textarea').fill(prompt);
    const finished = page.waitForResponse(async response => {
      if (!response.ok() || response.request().method() !== 'GET'
          || !/^\/assistant\/jobs\/[a-f0-9-]{36}$/.test(new URL(response.url()).pathname)) return false;
      const { data } = await response.json();
      return ['completed', 'cancelled', 'failed'].includes(data?.status);
    }, { timeout: 140_000 });
    const [response] = await Promise.all([finished, page.locator('#assistant-send').click()]);
    const { data } = await response.json();
    assert.equal(data.status, 'completed', `Assistant job ended with ${data.errorCode ?? data.status}`);
    return data;
  }

  const opening = await ask(initialPrompt);
  assert.ok(opening.tools.some(tool => tool.namespace === 'pob' && tool.name === 'list_sets'));
  assert.equal(opening.proposals.filter(proposal => proposal.kind === 'open_pob_set' && proposal.label === label).length, 1);
  assert.equal(await page.locator('#league').inputValue(), 'Standard', 'A proposal must not open the set.');
  await page.locator('#assistant-proposals').getByRole('button', { name: 'Открыть комплект', exact: true }).click();
  await page.locator('#build-form').waitFor();
  assert.equal(await page.locator('#league').inputValue(), scope.league);
  const buildForm = page.locator('#build-form');
  const override = buildForm.locator('#slot-budget-fields fieldset').filter({ has: page.locator('legend', { hasText: /^Кольцо 2$/ }) });
  assert.equal(await buildForm.locator('#slot-picker').inputValue(), 'Ring 2');
  assert.equal(await buildForm.locator('select[name=mode]').inputValue(), settings.mode);
  for (const [name, value] of Object.entries(settings.budget)) {
    assert.equal(await buildForm.locator(`[name="${name}"]`).inputValue(), String(value));
  }
  for (const [name, value] of Object.entries(settings.budgets['Ring 2'])) {
    assert.equal(await override.locator(`[name="slot-${name}"]`).inputValue(), String(value));
  }

  const manualSearch = page.waitForResponse(response => response.ok()
    && new URL(response.url()).pathname === '/api'
    && response.request().method() === 'POST'
    && response.request().postDataJSON().name === 'trade_for_build');
  await buildForm.getByRole('button', { name: 'Создать поиск по выбранному слоту' }).click();
  const manualResult = await manualSearch;
  assert.deepEqual(manualResult.request().postDataJSON().args.slots, ['Ring 2']);
  assert.deepEqual((await manualResult.json()).data.rows.map(row => row.slot), ['Ring 2']);

  const upgrades = await ask(upgradePrompt);
  assert.ok(upgrades.tools.some(tool => tool.namespace === 'pob' && tool.name === 'prepare_slots'));
  const prepared = upgrades.results.find(result => result.data?.rows?.some(row => row.slot === 'Ring 2'));
  assert.ok(prepared, 'The assistant must show the query for the selected ring.');
  assert.deepEqual(prepared.data.rows.map(row => row.slot), ['Ring 2']);
  for (const row of prepared.data.rows) {
    const budget = settings.budgets[row.slot] ?? settings.budget;
    assert.deepEqual(row.scope, scope);
    assert.match(row.link, /^https:\/\/www\.pathofexile\.com\/trade\/search\/Hardcore%20Settlers\//);
    assert.ok(row.body.query.stats.some(group => group.type === 'weight' && group.filters.length));
    assert.deepEqual(row.body.query.filters.trade_filters.filters.price, { option: budget.currency, min: budget.min, max: budget.max });
  }

  const selected = prepared.data.rows.find(row => row.slot === 'Ring 2');
  const card = page.locator('#assistant-results article').filter({ has: page.getByRole('heading', { name: /^Ring 2(?: ·|$)/ }) });
  await card.getByRole('button', { name: 'Сохранить как шаблон Live Search', exact: true }).click();
  const confirmation = page.locator('.assistant-proposal').filter({ hasText: 'Ring 2' });
  await confirmation.getByRole('button', { name: 'Сохранить шаблон', exact: true }).waitFor();
  assert.deepEqual((await trade('trade_watch_list', {})).watches, [], 'Selecting a search must not create a watch.');
  await confirmation.getByRole('button', { name: 'Сохранить шаблон', exact: true }).click();
  await confirmation.getByText('Шаблон сохранён.', { exact: true }).waitFor();
  await page.locator('button[data-page="watches"]').click();
  await page.locator('#watch-list article').filter({ hasText: 'Ring 2' }).getByText(/На паузе/).waitFor();

  const { watches } = await trade('trade_watch_list', {});
  assert.equal(watches.length, 1);
  assert.equal(watches[0].status, 'paused');
  assert.equal(watches[0].searchUrl, selected.link);
  assert.deepEqual(watches[0].scope, scope);
  assert.deepEqual(watches[0].body, selected.body);
  const database = new DatabaseSync(join(folder, 'watches.sqlite'), { readOnly: true });
  try {
    const rows = database.prepare('SELECT saved FROM watches').all();
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].saved), watches[0]);
    const receipt = database.prepare('SELECT job_id, result FROM assistant_watch_actions').get();
    assert.equal(receipt.job_id, upgrades.id);
    assert.equal(JSON.parse(receipt.result).watchId, watches[0].id);
  } finally {
    database.close();
  }
  const logs = await readFile(logPath, 'utf8');
  assert.ok(![token, initialPrompt, upgradePrompt, selected.link].some(privateValue => logs.includes(privateValue)), 'The log contains private test data.');
  assert.deepEqual(pageErrors, []);
  console.log('Edge, Codex and PoB full flow passed: confirmed set opening, exact slot budgets, selected query and confirmed paused SQLite watch.');
} finally {
  await browser?.close().catch(() => {});
  if (headers && daemon.exitCode === null) {
    await fetch(origin + '/stop', { method: 'POST', headers, signal: AbortSignal.timeout(4_000) }).catch(() => {});
  }
  if (daemon) {
    const fallback = setTimeout(() => daemon.kill(), headers ? 6_000 : 0);
    try { await exited; } finally { clearTimeout(fallback); }
  }
  const child = relative(temporaryRoot, resolve(folder));
  assert.match(child, /^pob-set-watch-flow-[a-zA-Z0-9]+$/);
  await rm(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
