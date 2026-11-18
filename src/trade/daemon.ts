import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TradeApi } from './api.js';
import { AssistantJobs, AssistantRequestError } from './assistant/jobs.js';
import { CodexReadiness, codexReadinessMessages } from './assistant/readiness.js';
import { PobSetError } from './assistant/pobSets.js';
import { BuildNoteError } from './assistant/buildNotes.js';
import { AssistantToolError } from './assistant/tools.js';
import { CodexSettings, CodexSettingsError } from './codexSettings.js';
import { configPath, IntegrationSettings, IntegrationSettingsError } from './integrationSettings.js';
import { applyMcpConfig, previewMcpConfig } from './mcpConfig.js';
import { tradeCurrencyOptions } from './currencies.js';
import { dataHome, descriptor, localOrigin, port } from './localConnection.js';
import { tradeLog } from './log.js';
import type { BrowserTradeSession } from './browserSession.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.ico', ['poe-trade.ico', 'image/x-icon']],
]);
const expectedHost = `127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
let api: TradeApi;
let assistant: AssistantJobs;
let codexSettings: CodexSettings;
let integrationSettings: IntegrationSettings;
const assistantReadiness = new CodexReadiness();
let browseCodex: ((currentPath: string) => Promise<string | undefined>) | undefined;
type IntegrationPicker = 'buildsDirectory' | 'sourceDirectory' | 'mcpConfig';
let browseIntegration: ((field: IntegrationPicker, currentPath: string) => Promise<string | undefined>) | undefined;
const subscribers = new Map<string, { response: ServerResponse; lifetime: AbortController }>();
const queuedBroadcasts = new Set<'event' | 'state'>();
let closing = false;
let browserSession: BrowserTradeSession | undefined;
let sessionRevision = 0;
let browserIdentityChanged = false;

function tradeSessionStatus() {
  const { sessionConnected: connected, directLive, browserStatus } = api.provider;
  return { connected, directLive, browserAvailable: Boolean(browserSession),
    status: browserSession ? browserStatus : connected ? 'connected' : 'unavailable' };
}

async function refreshBrowserSession(identityChanged = false): Promise<void> {
  if (!browserSession || closing) return;
  browserIdentityChanged ||= identityChanged;
  const revision = ++sessionRevision;
  const status = await browserSession.getStatus().catch(() => 'unavailable' as const);
  if (closing || revision !== sessionRevision) return;
  if (!browserIdentityChanged && api.provider.browserStatus === status) return;
  browserIdentityChanged = false;
  api.updateBrowserSession(status);
  tradeLog('trade-session', 'browser_state_changed', { status, directLive: api.provider.directLive });
  queueBroadcast('state');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

async function readRequest(req: IncomingMessage, maxBytes = 2_200_000): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Use JSON.');
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const item of req) {
    const chunk = Buffer.from(item);
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request too large.');
    buffers.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(buffers).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use a JSON object.');
  return value as Record<string, unknown>;
}

function authorized(req: IncomingMessage): boolean {
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function assistantStatus(force = false) {
  let executable = codexSettings.executable;
  while (executable) {
    const state = await assistantReadiness.check(executable, force);
    const current = codexSettings.executable;
    if (current === executable) return { configured: true, ready: state === 'ready', state };
    executable = current;
  }
  return { configured: false, ready: false, state: 'setup_required' as const };
}

async function routeAssistant(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  try {
    if (path === '/assistant/gateway' && req.method === 'POST') {
      if (req.headers.origin || !assistant.hasCapability(req.headers.authorization)) {
        throw new AssistantRequestError(401, 'Assistant request is not authorized.');
      }
      const input = await readRequest(req, 32_768);
      return json(res, 200, { data: await assistant.callTool(req.headers.authorization, input) });
    }
    if (!authorized(req)) throw new AssistantRequestError(401, 'Open the application through its launcher.');
    if (path === '/assistant/status' && req.method === 'GET') {
      return json(res, 200, { data: await assistantStatus(url.searchParams.get('refresh') === '1') });
    }
    const owner = req.headers['x-poe-trade-window'];
    const window = typeof owner === 'string' ? subscribers.get(owner) : undefined;
    if (!window || typeof owner !== 'string') {
      throw new AssistantRequestError(409, 'Окно потеряло соединение с локальным сервисом.');
    }
    if (path === '/assistant/jobs' && req.method === 'POST') {
      const input = await readRequest(req, 65_536);
      const readiness = await assistantStatus(true);
      if (!readiness.ready) throw new AssistantRequestError(503, codexReadinessMessages[readiness.state]);
      return json(res, 202, { data: assistant.start(owner, window.lifetime.signal, input) });
    }
    const job = /^\/assistant\/jobs\/([a-f0-9-]{36})(\/cancel|\/apply|\/proposals\/slot)?$/.exec(path);
    if (job && !job[2] && req.method === 'GET') return json(res, 200, { data: assistant.get(owner, job[1]) });
    if (job?.[2] === '/cancel' && req.method === 'POST') return json(res, 200, { data: assistant.cancel(owner, job[1]) });
    if (job && (job[2] === '/apply' || job[2] === '/proposals/slot') && req.method === 'POST') {
      if (req.headers.origin !== localOrigin) throw new AssistantRequestError(403, 'Подтверди изменение в окне приложения.');
      const input = await readRequest(req, 32_768);
      const data = job[2] === '/apply'
        ? await assistant.apply(owner, window.lifetime.signal, job[1], input)
        : assistant.proposeSlot(owner, window.lifetime.signal, job[1], input);
      return json(res, 200, { data });
    }
    json(res, 404, { error: 'Unknown assistant route.' });
  } catch (error) {
    if (error instanceof AssistantRequestError) return json(res, error.status, { error: error.message });
    if (error instanceof AssistantToolError) return json(res, 400, { error: error.message, code: error.code });
    tradeLog('assistant', 'request_rejected', { code: 'invalid_request' });
    json(res, 400, { error: 'Не удалось обработать запрос помощника.' });
  }
}

async function routePobSets(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET') return json(res, 200, { data: api.pobSets.list() });
  if (req.method !== 'POST') return json(res, 405, { error: 'Неподдерживаемая операция с комплектом.' });
  if (req.headers.origin !== localOrigin) return json(res, 403, { error: 'Открой комплект в приложении.' });
  const owner = req.headers['x-poe-trade-window'];
  const lifetime = typeof owner === 'string' ? subscribers.get(owner)?.lifetime.signal : undefined;
  if (!lifetime) return json(res, 409, { error: 'Окно потеряло соединение с локальным сервисом.' });
  try {
    const input = await readRequest(req, 32_768);
    json(res, 200, { data: await api.pobSets.apply(input, undefined, lifetime) });
  } catch (error) {
    if (lifetime.aborted) return json(res, 409, { error: 'Окно потеряло соединение с локальным сервисом.' });
    if (error instanceof PobSetError) return json(res, error.status, { error: error.message });
    tradeLog('pob-sets', 'request_rejected', { code: 'invalid_request' });
    json(res, 400, { error: 'Не удалось обработать запрос к комплектам PoB.' });
  }
}

async function routeBuildNotes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    if (req.method === 'GET') {
      const buildId = url.searchParams.get('buildId');
      const revision = url.searchParams.get('revision');
      return json(res, 200, { data: api.readBuildNotes(buildId, revision) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Неподдерживаемая операция с заметками.' });
    if (req.headers.origin !== localOrigin) return json(res, 403, { error: 'Открой редактор заметок в приложении.' });
    const owner = req.headers['x-poe-trade-window'];
    const lifetime = typeof owner === 'string' ? subscribers.get(owner)?.lifetime.signal : undefined;
    if (!lifetime) return json(res, 409, { error: 'Окно потеряло соединение с локальным сервисом.', code: 'window_disconnected' });
    const input = await readRequest(req, 80_000);
    if (lifetime.aborted) return json(res, 409, { error: 'Окно потеряло соединение с локальным сервисом.', code: 'window_disconnected' });
    const notes = api.replaceBuildNotes(input);
    tradeLog('build-notes', 'editor_saved', { cleared: !notes.text.trim() });
    return json(res, 200, { data: notes });
  } catch (error) {
    if (error instanceof BuildNoteError) return json(res, error.status, { error: error.message });
    tradeLog('build-notes', 'request_failed', { code: 'read_or_save_failed' });
    return json(res, 400, { error: 'Не удалось загрузить или сохранить заметки билда.' });
  }
}

async function routeTradeSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET') {
    await refreshBrowserSession();
    return json(res, 200, { data: tradeSessionStatus() });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Неподдерживаемая операция с сессией PoE Trade.' });
  if (req.headers.origin !== localOrigin) return json(res, 403, { error: 'Открой настройки сессии в приложении.' });
  const owner = req.headers['x-poe-trade-window'];
  const lifetime = typeof owner === 'string' ? subscribers.get(owner)?.lifetime.signal : undefined;
  const closedWindow = { error: 'Окно потеряло соединение с локальным сервисом.', code: 'window_disconnected' };
  if (!lifetime) return json(res, 409, closedWindow);

  const maxBytes = 1024;
  if (Number(req.headers['content-length']) > maxBytes) return json(res, 413, { error: 'Запрос слишком большой.' });
  let input: Record<string, unknown>;
  try {
    input = await readRequest(req, maxBytes);
  } catch {
    return json(res, 400, { error: 'Не удалось прочитать запрос к сессии PoE Trade.' });
  }
  if (lifetime.aborted) return json(res, 409, closedWindow);
  if (Object.keys(input).length !== 1 || (input.action !== 'login' && input.action !== 'logout')) {
    return json(res, 400, { error: 'Выбери действие с сессией PoE Trade.' });
  }
  if (!browserSession) return json(res, 503, { error: 'Открой PoE Trade через ярлык для входа.' });
  try {
    if (input.action === 'login') {
      browserSession.openLogin();
    } else {
      await browserSession.clear();
      await refreshBrowserSession();
    }
    return json(res, 200, { data: tradeSessionStatus() });
  } catch {
    return json(res, 500, { error: 'Не удалось обновить сессию PoE Trade.' });
  }
}

async function routeCodexSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const view = () => ({ ...codexSettings.status(), browseAvailable: Boolean(browseCodex) });
  if (req.method === 'GET') return json(res, 200, { data: view() });
  if (req.method !== 'POST') return json(res, 405, { error: 'Неподдерживаемая операция с настройками Codex CLI.' });
  if (req.headers.origin !== localOrigin) return json(res, 403, { error: 'Открой настройки Codex в приложении.' });
  const owner = req.headers['x-poe-trade-window'];
  const lifetime = typeof owner === 'string' ? subscribers.get(owner)?.lifetime.signal : undefined;
  const closedWindow = { error: 'Окно потеряло соединение с локальным сервисом.', code: 'window_disconnected' };
  if (!lifetime) return json(res, 409, closedWindow);

  let input: Record<string, unknown>;
  try {
    input = await readRequest(req, 16_384);
  } catch {
    return json(res, 400, { error: 'Не удалось прочитать настройки Codex CLI.' });
  }
  if (lifetime.aborted) return json(res, 409, closedWindow);
  try {
    const { action, path } = input;
    if (action === 'browse' && Object.keys(input).length === 1) {
      if (!browseCodex) return json(res, 503, { error: 'Открой PoE Trade через ярлык для выбора файла.' });
      const selected = await browseCodex(codexSettings.status().path);
      if (lifetime.aborted) return json(res, 409, closedWindow);
      return json(res, 200, { data: { selected: selected ?? null } });
    }
    if (action === 'save' && typeof path === 'string' && Object.keys(input).length === 2) {
      codexSettings.save(path);
    } else if (action === 'reset' && Object.keys(input).length === 1) {
      codexSettings.save(null);
    } else {
      return json(res, 400, { error: 'Выбери действие с настройками Codex CLI.' });
    }
    const data = view();
    tradeLog('settings', 'codex_changed', { source: data.source, configured: data.configured });
    return json(res, 200, { data });
  } catch (error) {
    if (error instanceof CodexSettingsError) return json(res, 400, { error: error.message });
    tradeLog('settings', 'codex_request_failed');
    return json(res, 500, { error: 'Не удалось изменить настройки Codex CLI.' });
  }
}

async function routeIntegrationSettings(req: IncomingMessage, res: ServerResponse, kind: 'pob' | 'mcp'): Promise<void> {
  const pob = () => ({ ...integrationSettings.pob, browseAvailable: Boolean(browseIntegration) });
  const mcp = () => ({ path: integrationSettings.mcpConfigPath, browseAvailable: Boolean(browseIntegration) });
  if (req.method === 'GET') return json(res, 200, { data: kind === 'pob' ? pob() : mcp() });
  if (req.method !== 'POST') return json(res, 405, { error: 'Неподдерживаемая операция с настройками.' });
  if (req.headers.origin !== localOrigin) return json(res, 403, { error: 'Открой настройки в приложении.' });
  const owner = req.headers['x-poe-trade-window'];
  const lifetime = typeof owner === 'string' ? subscribers.get(owner)?.lifetime.signal : undefined;
  const closedWindow = { error: 'Окно потеряло соединение с локальным сервисом.', code: 'window_disconnected' };
  if (!lifetime) return json(res, 409, closedWindow);
  let input: Record<string, unknown>;
  try { input = await readRequest(req, 32_768); }
  catch { return json(res, 400, { error: 'Не удалось прочитать настройки.' }); }
  if (lifetime.aborted) return json(res, 409, closedWindow);
  try {
    const { action, field, path, servers, version } = input;
    if (action === 'browse') {
      if (!browseIntegration) return json(res, 503, { error: 'Открой PoE Trade через ярлык для выбора пути.' });
      if (kind === 'pob' && field !== 'buildsDirectory' && field !== 'sourceDirectory') {
        return json(res, 400, { error: 'Выбери поле для папки PoB.' });
      }
      const selected = kind === 'pob' && (field === 'buildsDirectory' || field === 'sourceDirectory')
        ? await browseIntegration(field, integrationSettings.pob[field])
        : await browseIntegration('mcpConfig', integrationSettings.mcpConfigPath);
      if (lifetime.aborted) return json(res, 409, closedWindow);
      return json(res, 200, { data: { selected: selected ?? null } });
    }
    if (action === 'save' && kind === 'pob') {
      integrationSettings.savePob(input.buildsDirectory, input.sourceDirectory);
      tradeLog('settings', 'pob_changed');
      return json(res, 200, { data: pob() });
    }
    if (action === 'save' && kind === 'mcp') {
      integrationSettings.saveConfigPath(configPath(path));
      return json(res, 200, { data: mcp() });
    }
    if (action === 'preview' && kind === 'mcp') {
      return json(res, 200, { data: previewMcpConfig(path, servers, integrationSettings.pob) });
    }
    if (action === 'apply' && kind === 'mcp') {
      const result = await applyMcpConfig(path, servers, () => integrationSettings.pob, version, codexSettings.executable, lifetime);
      let remembered = true;
      try { integrationSettings.saveConfigPath(result.path); }
      catch { remembered = false; }
      tradeLog('settings', 'mcp_config_applied', { backup: Boolean(result.backup), remembered });
      return json(res, 200, { data: { ...result, remembered } });
    }
    return json(res, 400, { error: 'Выбери действие с настройками.' });
  } catch (error) {
    if (lifetime.aborted) return json(res, 409, closedWindow);
    if (error instanceof IntegrationSettingsError) return json(res, error.status, { error: error.message });
    tradeLog('settings', 'integration_request_failed', { kind });
    return json(res, 500, { error: 'Не удалось прочитать или обновить настройки. Проверь путь и права доступа.' });
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
  if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== localOrigin)) {
    json(res, 403, { error: 'The local Trade service only accepts requests from its own origin.' });
    return;
  }
  const url = new URL(req.url ?? '/', localOrigin);
  const path = url.pathname;
  if (path.startsWith('/assistant/')) return routeAssistant(req, res, url);
  const asset = assets.get(path);
  if (asset && req.method === 'GET') {
    const [file, mime] = asset;
    const body = readFileSync(new URL(`../../apps/trade-desktop/${file}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': mime }).end(body);
    return;
  }
  if (!authorized(req)) {
    json(res, 401, { error: 'Open the application through its launcher.' });
    return;
  }
  if (closing) return json(res, 503, { error: 'The local Trade service is stopping.' });
  if (path === '/pob-sets') return routePobSets(req, res);
  if (path === '/build-notes') return routeBuildNotes(req, res, url);
  if (path === '/trade-session') return routeTradeSession(req, res);
  if (path === '/settings/codex') return routeCodexSettings(req, res);
  if (path === '/settings/pob') return routeIntegrationSettings(req, res, 'pob');
  if (path === '/settings/mcp') return routeIntegrationSettings(req, res, 'mcp');
  if (path === '/trade-currencies' && req.method === 'GET') {
    const game = url.searchParams.get('game');
    if (game !== 'poe1' && game !== 'poe2') return json(res, 400, { error: 'Выбери игру PoE или PoE 2.' });
    return json(res, 200, { data: { options: tradeCurrencyOptions[game] } });
  }
  if (path === '/pob-build-files' && req.method === 'GET') {
    try {
      const files = await api.listBuildFiles();
      tradeLog('pob', 'build_files_listed', { count: files.length });
      return json(res, 200, { data: files });
    } catch {
      tradeLog('pob', 'build_files_unavailable');
      return json(res, 503, { error: 'Не удалось прочитать папку билдов PoB. Проверь её в настройках.' });
    }
  }
  if (path === '/health' && req.method === 'GET') {
    json(res, 200, { service: 'poe-local-trade', browserAvailable: Boolean(browserSession) });
    return;
  }
  if (path === '/events' && req.method === 'GET') {
    if (subscribers.size >= 12) {
      json(res, 503, { error: 'Too many open event streams.' });
      return;
    }
    const windowId = randomUUID();
    const lifetime = new AbortController();
    subscribers.set(windowId, { response: res, lifetime });
    tradeLog('service', 'window_connected', { windows: subscribers.size });
    res.on('close', () => {
      subscribers.delete(windowId);
      lifetime.abort();
      if (!closing) tradeLog('service', 'window_disconnected', { windows: subscribers.size });
    });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-PoE-Trade-Window': windowId,
    });
    res.write('data: {"kind":"ready"}\n\n');
    return;
  }
  if (path === '/stop' && req.method === 'POST') {
    await shutdown('request', res);
    return;
  }
  if (path === '/api' && req.method === 'POST') {
    const input = await readRequest(req);
    if (typeof input.name !== 'string' || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
      throw new Error('Provide a tool name and argument object.');
    }
    const windowId = req.headers['x-poe-trade-window'];
    let windowLifetime: AbortSignal | undefined;
    if (input.name === 'trade_watch_resume' && windowId !== undefined) {
      windowLifetime = typeof windowId === 'string' ? subscribers.get(windowId)?.lifetime.signal : undefined;
      if (!windowLifetime) {
        json(res, 409, { error: 'Окно потеряло соединение. Повтори после переподключения.' });
        return;
      }
    }
    json(res, 200, { data: await api.call(input.name, input.args as Record<string, unknown>, windowLifetime) });
    return;
  }
  json(res, 404, { error: 'Unknown route.' });
}

const server = createServer((req, res) => {
  void route(req, res).catch(error => {
    tradeLog('service', 'request_failed', { responseStarted: res.headersSent });
    if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : 'Local request failed.' });
    else res.end();
  });
});

function broadcast(kind: 'event' | 'state' | 'heartbeat'): void {
  for (const { response } of subscribers.values()) {
    if (!response.write(`data: ${JSON.stringify({ kind })}\n\n`)) response.end();
  }
}

function queueBroadcast(kind: 'event' | 'state'): void {
  if (queuedBroadcasts.has(kind)) return;
  queuedBroadcasts.add(kind);
  setImmediate(() => {
    queuedBroadcasts.delete(kind);
    if (!closing) broadcast(kind);
  });
}

let heartbeat: NodeJS.Timeout;
let unsubscribeSession: (() => void) | undefined;
let shutdownPromise: Promise<void> | undefined;
let onStopped: (() => void) | undefined;

function shutdown(reason: 'request' | 'SIGINT' | 'SIGTERM', response?: ServerResponse): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  tradeLog('service', 'stopping', { reason, windows: subscribers.size });
  clearInterval(heartbeat);
  unsubscribeSession?.();
  for (const { response, lifetime } of subscribers.values()) {
    lifetime.abort();
    response.end();
  }
  server.close();
  shutdownPromise = new Promise(resolve => {
    const finish = (outcome: 'clean' | 'cleanup_failed' | 'timeout') => {
      clearTimeout(timeout);
      tradeLog('service', 'stopped', { outcome });
      const closeConnections = () => {
        response?.off('close', closeConnections);
        response?.off('finish', closeConnections);
        server.closeAllConnections();
        resolve();
      };
      if (!response || response.destroyed) return closeConnections();
      response.once('close', closeConnections);
      response.once('finish', closeConnections);
      json(response, 200, { stopped: true });
    };
    const timeout = setTimeout(finish, 3_000, 'timeout');
    void Promise.all([assistant?.close(), api?.close()]).then(() => finish('clean'), () => finish('cleanup_failed'));
  });
  void shutdownPromise.then(() => onStopped?.());
  return shutdownPromise;
}

export async function startTradeDaemon(options: {
  browserSession?: BrowserTradeSession;
  browseCodex?: (currentPath: string) => Promise<string | undefined>;
  browseIntegration?: (field: IntegrationPicker, currentPath: string) => Promise<string | undefined>;
  onStopped?: () => void;
} = {}) {
  browserSession = options.browserSession;
  browseCodex = options.browseCodex;
  browseIntegration = options.browseIntegration;
  onStopped = options.onStopped;
  tradeLog('service', 'starting', { port, browser: Boolean(browserSession) });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  }).catch(error => {
    const reason = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'port_in_use' : 'listen_failed';
    tradeLog('service', 'start_failed', { port, reason });
    throw error;
  });
  try {
    mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    integrationSettings = new IntegrationSettings(join(dataHome, 'integration-settings.json'));
    api = new TradeApi(join(dataHome, 'watches.sqlite'), browserSession, () => integrationSettings.pob);
    codexSettings = new CodexSettings(join(dataHome, 'codex-settings.json'), process.env.POE_ASSISTANT_CODEX);
    assistant = new AssistantJobs(api, {
      get codexExecutable() { return codexSettings.executable; },
      workspaceRoot: join(dataHome, 'assistant'),
      schemaPath: fileURLToPath(new URL('../../src/trade/assistant/proposal.schema.json', import.meta.url)),
      researchSchemaPath: fileURLToPath(new URL('../../src/trade/assistant/research.schema.json', import.meta.url)),
      mcpPath: fileURLToPath(new URL('./assistant/mcp.js', import.meta.url)),
      origin: localOrigin,
    });
    api.watches.on('event', () => queueBroadcast('event'));
    api.watches.on('state', () => queueBroadcast('state'));
    unsubscribeSession = browserSession?.onChange(() => void refreshBrowserSession(true));
    await refreshBrowserSession();
    const pending = descriptor + `.${process.pid}`;
    writeFileSync(pending, JSON.stringify({ token }), { mode: 0o600 });
    renameSync(pending, descriptor);
    heartbeat = setInterval(() => broadcast('heartbeat'), 20_000);
    heartbeat.unref();
    tradeLog('service', 'ready', { port, browser: Boolean(browserSession) });
    return { url: `${localOrigin}/#${token}`, close: () => shutdown('request') };
  } catch (error) {
    tradeLog('service', 'start_failed', { port, reason: 'initialize_failed' });
    await shutdown('request');
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await startTradeDaemon();
    const handleSignal = (signal: 'SIGINT' | 'SIGTERM') => void shutdown(signal).then(() => process.exit(0));
    onStopped = () => process.exit(0);
    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
  } catch {
    process.exitCode = 1;
  }
}
