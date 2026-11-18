const get = id => document.getElementById(id);
const buttons = [...document.querySelectorAll('[data-page]')];
const hash = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(hash)) {
  sessionStorage.setItem('poe-trade-token', hash);
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('poe-trade-token');
const authorization = { Authorization: `Bearer ${token ?? ''}` };
const labels = new Map();
let build;
let buildNotes;
let page = 'build';
let cursor = 0;
let unseen = 0;
let updates = Promise.resolve();
let watchWindow;
let assistantJob;
let assistantSending = false;
let assistantReady = false;
let assistantReadinessRequest = 0;
const slotBudgetControls = new Map();
let slotSearchVersion = 0;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function status(text, error = false) {
  const element = get('status');
  element.textContent = text;
  element.hidden = !text;
  element.toggleAttribute('data-error', error);
}

async function api(name, args = {}, headers = {}) {
  const response = await fetch('/api', {
    method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ name, args }),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result.data;
}

function action(text, callback, className = 'secondary') {
  const button = node('button', text, className);
  button.type = 'button';
  button.addEventListener('click', () => void run(button, callback));
  return button;
}

async function run(button, callback) {
  button.disabled = true;
  status('');
  try { await callback(); }
  catch (error) { status(error.message, true); }
  finally { button.disabled = false; }
}

function handleForm(id, callback) {
  const form = get(id);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void run(event.submitter || form.querySelector('button'), () => callback(new FormData(form)));
  });
}

function tradeLink(url) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://www.pathofexile.com') return node('span', 'Ссылка недоступна', 'warning');
  const link = node('a', 'На торговый сайт ↗', 'link-button');
  link.href = parsed.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function openPage(target) {
  page = target;
  for (const button of buttons) {
    const active = button.dataset.page === target;
    get(button.dataset.page).hidden = !active;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (page === 'watches') {
    unseen = 0;
    get('new-count').hidden = true;
  }
  if (page === 'build') void refreshPobSets();
  if (page === 'settings') {
    void refreshCodexSettings();
    void refreshIntegrationSettings();
    void refreshTradeSession();
    void refreshAssistantReadiness();
  }
}
for (const button of buttons) button.addEventListener('click', () => openPage(button.dataset.page));

function openSettings(target) {
  openPage('settings');
  get(target).focus();
}
get('scope-settings').addEventListener('click', () => openSettings(get('league').disabled ? 'game' : 'league'));

function realm() {
  return {
    game: get('game').value, realm: get('game').value === 'poe2' ? 'poe2' : get('realm').value,
  };
}
function leagueKey(current) {
  return `poe-trade-league:${current.game}:${current.realm}`;
}
function savedLeague(current = realm()) {
  const stored = localStorage.getItem(leagueKey(current));
  try { return JSON.parse(stored) || {}; }
  catch { return { id: stored }; }
}
function rememberLeague(league, current = realm(), source) {
  if (league) localStorage.setItem(leagueKey(current), JSON.stringify({ id: league, source }));
}
function scope() {
  const current = realm();
  const league = get('league').value;
  if (!league) throw new Error('Выбери лигу для поиска.');
  return { ...current, league };
}

function showScope() {
  const league = get('league').value || 'Выбрать лигу';
  get('scope-settings').textContent = scopeSummary({ ...realm(), league });
  showAssistantContext();
}

function renderLeagues(current, leagues, placeholder) {
  const select = get('league');
  const { id, source, fromLink } = savedLeague(current);
  const options = leagues.map(league => new Option(league.label, league.id));
  const pinned = source === 'set' ? 'из комплекта' : source === 'link' || fromLink ? 'из ссылки' : '';
  if (pinned && id && !options.some(option => option.value === id)) options.unshift(new Option(`${id} · ${pinned}`, id));
  select.replaceChildren(...(options.length ? options : [new Option(placeholder, '')]));
  if (options.some(option => option.value === id)) select.value = id;
  select.disabled = !options.length;
  showScope();
}

let leagueRequest = 0;
async function updateLeagues({ refresh = false, selected, source = 'link' } = {}) {
  const current = realm();
  localStorage.setItem('poe-trade-game', current.game);
  localStorage.setItem('poe-trade-platform', get('realm').value);
  const request = ++leagueRequest;
  const message = get('league-status');
  const cacheKey = leagueKey(current) + ':catalog';
  let cached;
  try {
    const stored = JSON.parse(localStorage.getItem(cacheKey));
    if (Array.isArray(stored) && stored.every(league => typeof league?.id === 'string' && typeof league.label === 'string')) {
      cached = stored;
    }
  } catch {
    localStorage.removeItem(cacheKey);
  }
  if (selected) rememberLeague(selected, current, source);
  renderLeagues(current, cached ?? [], cached ? 'Нет доступных лиг' : token ? 'Загрузка…' : 'Список недоступен');
  if (!token) {
    message.textContent = 'Открой приложение через ярлык PoE Trade.';
    return;
  }
  if (selected && source === 'set') {
    message.textContent = 'Лига восстановлена из комплекта.';
    return;
  }
  if (cached && !refresh) {
    message.textContent = cached.length ? 'Сохранённый список лиг PoE Trade.' : 'В сохранённом списке нет лиг для выбранной платформы.';
    return;
  }
  message.textContent = cached ? 'Обновляем список лиг с сайта PoE Trade…' : 'Загружаем список с сайта PoE Trade…';
  try {
    const result = await api('trade_list_leagues', { ...current, refresh });
    if (request !== leagueRequest) return;
    if (result.stale && !result.leagues.length) {
      throw new Error('No cached league list for this platform.');
    }
    localStorage.setItem(cacheKey, JSON.stringify(result.leagues));
    renderLeagues(current, result.leagues, 'Нет доступных лиг');
    if (result.stale) message.textContent = 'Показан последний полученный список. Сайт PoE Trade сейчас недоступен.';
    else message.textContent = result.leagues.length ? 'Лиги загружены с сайта PoE Trade.' : 'На сайте PoE Trade нет лиг для выбранной платформы.';
  } catch (error) {
    if (request !== leagueRequest) return;
    if (!cached?.length) renderLeagues(current, [], 'Список недоступен');
    if (error.status === 401) message.textContent = 'Открой приложение через ярлык PoE Trade, чтобы восстановить соединение.';
    else if (cached?.length) message.textContent = 'Показан последний полученный список. Сейчас обновить лиги не удалось.';
    else message.textContent = 'Список лиг с сайта PoE Trade недоступен. Нажми «Обновить лиги», чтобы повторить.';
  }
}

const inheritCurrency = '@inherit';
const currenciesByGame = new Map();
const currencyRequests = new Map();

function equivalentLabel(game) {
  return game === 'poe2' ? 'Exalted Orb Equivalent' : 'Chaos Orb Equivalent';
}

function currencyName(currency, game) {
  const option = currenciesByGame.get(game)?.find(entry => entry.id === (currency ?? null));
  return option?.label ?? currency ?? equivalentLabel(game);
}

function fillCurrencies(select, game, value = select.value) {
  const catalog = currenciesByGame.get(game) ?? [{ id: null, label: equivalentLabel(game) }];
  const options = catalog.map(({ id, label }) => new Option(label, id ?? ''));
  for (const option of options) option.lang = 'en';
  if (select.name === 'slot-currency') options.unshift(new Option('Общая валюта', inheritCurrency));
  if (value && !options.some(option => option.value === value)) options.push(new Option(value, value));
  select.replaceChildren(...options);
  select.value = value;
}

function syncCurrencyOnly() {
  const { currency, 'currency-only': currencyOnly } = get('build-form').elements;
  currencyOnly.disabled = !currency.value;
  if (currencyOnly.disabled) currencyOnly.checked = false;
}

async function loadCurrencies(game) {
  if (!token || currenciesByGame.has(game)) return;
  if (!currencyRequests.has(game)) {
    const url = '/trade-currencies?' + new URLSearchParams({ game });
    const request = localRequest(url, undefined, undefined, 'Список валют недоступен.')
      .then(({ options }) => currenciesByGame.set(game, options))
      .finally(() => currencyRequests.delete(game));
    currencyRequests.set(game, request);
  }
  await currencyRequests.get(game);
}

async function refreshCurrencies(game, reset = false) {
  const general = get('build-form').elements.currency;
  fillCurrencies(general, game, reset ? '' : general.value);
  for (const { currency } of slotBudgetControls.values()) fillCurrencies(currency, game);
  syncCurrencyOnly();
  try {
    await loadCurrencies(game);
    if (get('game').value !== game) return;
    fillCurrencies(general, game);
    for (const { currency } of slotBudgetControls.values()) fillCurrencies(currency, game);
  } catch (error) {
    if (get('game').value === game) status(error.message, true);
  }
}

function applyGame() {
  const isPoe2 = get('game').value === 'poe2';
  get('realm').disabled = isPoe2;
  get('realm').closest('label').hidden = isPoe2;
  void refreshCurrencies(get('game').value, true);
}
get('build-form').elements.currency.addEventListener('change', syncCurrencyOnly);
get('game').addEventListener('change', () => {
  applyGame();
  void updateLeagues();
});
get('realm').addEventListener('change', () => void updateLeagues());
get('league').addEventListener('change', () => {
  const league = get('league').value;
  const { id, source, fromLink } = savedLeague();
  rememberLeague(league, realm(), league === id ? source ?? (fromLink ? 'link' : undefined) : undefined);
  showScope();
});
get('refresh-leagues').addEventListener('click', () => void updateLeagues({ refresh: true }));
handleForm('league-link-form', async form => {
  const { scope: selected } = await api('trade_scope_from_url', { url: form.get('url') });
  const gameChanged = get('game').value !== selected.game;
  get('game').value = selected.game;
  if (selected.realm !== 'poe2') get('realm').value = selected.realm;
  if (gameChanged) applyGame();
  await updateLeagues({ selected: selected.league });
  status(`Выбрана лига ${selected.league} из ссылки PoE Trade.`);
});
for (const [id, key] of [['game', 'poe-trade-game'], ['realm', 'poe-trade-platform']]) {
  const select = get(id);
  const value = localStorage.getItem(key);
  if ([...select.options].some(option => option.value === value)) select.value = value;
}
applyGame();
void updateLeagues();

function field(title, name, value = '', type = 'text') {
  const label = node('label', title);
  const input = node('input');
  input.name = name;
  input.value = value;
  input.type = type;
  if (type === 'number') input.step = 'any';
  label.append(input);
  return label;
}

function tradeBudget(minimum, maximum, currency, { slot, currencyOnly = false } = {}) {
  if (minimum === '' && maximum === '' && (!currencyOnly || !currency)) return undefined;
  const min = minimum === '' ? undefined : Number(minimum);
  const max = maximum === '' ? undefined : Number(maximum);
  if ((currency && !/^[a-z0-9_-]{1,40}$/.test(currency)) || (min !== undefined && (!Number.isFinite(min) || min < 0))
      || (max !== undefined && (!Number.isFinite(max) || max < 0))
      || (min !== undefined && max !== undefined && min > max)) {
    const target = slot ? ` для слота ${slot}` : '';
    throw new Error(`Проверь сумму и валюту бюджета${target}.`);
  }
  return { ...(currency && { currency }), min, max };
}

function buildOptions(form, slot) {
  const budget = tradeBudget(form.get('min'), form.get('max'), form.get('currency'), { currencyOnly: form.has('currency-only') });
  const controls = slotBudgetControls.get(slot);
  let override;
  if (controls) {
    const currency = controls.currency.value;
    const inherited = currency === inheritCurrency;
    override = tradeBudget(controls.min.value, controls.max.value, inherited ? form.get('currency') : currency,
      { slot, currencyOnly: !inherited });
  }
  return { mode: form.get('mode'), budget, budgets: override ? { [slot]: override } : undefined };
}

function buildDraft(form) {
  if (!build) throw new Error('Загрузи билд в PoB.');
  const slot = get('slot-picker').value;
  if (!slot) throw new Error('Выбери слот в списке.');
  return { buildId: build.buildId, revision: build.revision, scope: scope(), slots: [slot], ...buildOptions(form, slot) };
}

function scopeSummary(target) {
  const platform = { pc: 'PC', xbox: 'Xbox', sony: 'PlayStation' }[target.realm];
  return [target.game === 'poe2' ? 'PoE 2' : 'PoE 1', platform, target.league].filter(Boolean).join(' · ');
}

function budgetSummary(value, game = get('game').value) {
  if (!value) return 'без лимита';
  const currency = currencyName(value.currency, game);
  if (value.min === undefined && value.max === undefined) return `в валюте ${currency}`;
  return [value.min === undefined ? '' : `от ${value.min}`, value.max === undefined ? '' : `до ${value.max}`, currency]
    .filter(Boolean).join(' ');
}

function appendSetDetails(card, set) {
  if (set.buildLabel) card.append(node('p', set.buildLabel, 'muted'));
  if (set.mode) {
    const mode = set.mode === 'upgrade' ? 'Найти апгрейды' : 'Подобрать похожие';
    card.append(node('p', `${mode} · ${set.slots.join(', ')}`));
    card.append(node('p', `Общий бюджет ${budgetSummary(set.budget, set.scope?.game)} на слот`, 'muted'));
    if (set.budgets) {
      const overrides = Object.entries(set.budgets).map(([slot, value]) => `${slot} · ${budgetSummary(value, set.scope?.game)}`);
      if (overrides.length) card.append(node('p', overrides.join(' / '), 'muted'));
    }
  }
}

const listingNumbers = new Intl.NumberFormat('ru', { maximumFractionDigits: 20 });
const sellerStatusLabels = { online: 'В сети', afk: 'AFK', offline: 'Не в сети' };
const listingFlags = {
  corrupted: 'Осквернён', unidentified: 'Не опознан', mirrored: 'Отражён', split: 'Разделён',
  fractured: 'Расколот', synthesised: 'Синтезирован', replica: 'Реплика',
  sanctified: 'Освящён', mutated: 'Мутировавший', veiled: 'Завуалирован', unmodifiable: 'Неизменяемый',
  doublecorrupted: 'Двойное осквернение', desecrated: 'Осквернённое свойство',
};
const listingRarities = { normal: 'Обычный', magic: 'Магический', rare: 'Редкий', unique: 'Уникальный' };
const listingModLabels = {
  implicit: 'Собственные свойства', explicit: 'Явные свойства', crafted: 'Свойства с верстака',
  fractured: 'Расколотые свойства', enchant: 'Зачарования', rune: 'Руны', desecrated: 'Осквернённые свойства',
  mutated: 'Мутировавшие свойства', vestigial: 'Рудиментарные свойства', crucible: 'Горнило',
  scourge: 'Нашествие', cosmetic: 'Косметика', veiled: 'Завуалированные свойства',
  foulborn: 'Свойства порождённых скверной', utility: 'Дополнительные свойства',
};

function appendModGroups(target, groups) {
  for (const { type, lines } of groups) {
    if (type) target.append(node('h5', listingModLabels[type] ?? 'Прочие свойства'));
    const list = node('ul');
    for (const line of lines) list.append(node('li', line));
    target.append(list);
  }
}

function compareListing(itemText, context) {
  const area = node('div', undefined, 'trade-comparison');
  const feedback = node('p', undefined, 'muted');
  feedback.setAttribute('role', 'status');
  feedback.hidden = true;
  const report = node('pre');
  report.hidden = true;
  const currentBuild = () => build?.buildId === context.buildId && build?.revision === context.revision;

  function message(text, error = false) {
    feedback.textContent = text;
    feedback.hidden = !text;
    feedback.toggleAttribute('data-error', error);
  }

  const button = action('Сравнить в PoB', async () => {
    report.hidden = true;
    if (!currentBuild()) {
      message('Открой билд, для которого был подготовлен этот поиск.', true);
      return;
    }
    const version = buildRequest;
    message('PoB рассчитывает замену…');
    try {
      const result = await api('trade_simulate_item', { ...context, itemText });
      if (!area.isConnected) return;
      if (!currentBuild() || version !== buildRequest) {
        message('Открытый билд изменился. Запусти сравнение для актуального билда.', true);
        return;
      }
      report.textContent = result.report;
      report.hidden = false;
      message('Сравнение готово.');
    } catch (error) {
      if (area.isConnected) message(error.message, true);
    }
  });
  area.append(button, feedback, report);
  return area;
}

function listingCard(item, game, detailed = false, comparison) {
  const card = node('article', undefined, 'card trade-listing');
  const heading = node('div', undefined, 'trade-listing-head');
  heading.append(node(detailed ? 'h4' : 'h3', item.name || item.typeLine || 'Новый лот'));
  const price = item.price && `${listingNumbers.format(item.price.amount)} ${currencyName(item.price.currency, game)}`;
  if (price || detailed) heading.append(node('strong', price || 'Цена не указана', price ? 'price' : 'muted'));
  card.append(heading);

  const bases = [...new Set([item.typeLine, item.base])].filter(value => value && value !== item.name);
  if (bases.length) card.append(node('p', bases.join(' · '), 'muted'));
  const facts = [
    listingRarities[item.rarity],
    item.itemLevel !== undefined && `Ур. предмета ${item.itemLevel}`,
    item.quality && `Качество ${item.quality}`,
    ...(item.flags ?? []).map(flag => listingFlags[flag]).filter(Boolean),
  ].filter(Boolean);
  if (facts.length) card.append(node('p', facts.join(' · '), 'muted'));
  if (item.seller?.name) {
    const seller = [item.seller.name, sellerStatusLabels[item.seller.status]].filter(Boolean).join(' · ');
    card.append(node('p', seller, 'trade-listing-seller'));
  }
  if (item.indexed) {
    const date = new Date(item.indexed);
    if (Number.isFinite(date.getTime())) {
      const time = node('time', `Выставлен ${date.toLocaleString('ru', { dateStyle: 'short', timeStyle: 'short' })}`, 'muted');
      time.dateTime = date.toISOString();
      card.append(time);
    }
  }

  const groups = item.modGroups?.length ? item.modGroups : item.mods?.length ? [{ type: '', lines: item.mods }] : [];
  const properties = item.properties ?? [];
  if (groups.length || properties.length) {
    const details = node('details', undefined, 'trade-listing-details');
    details.append(node('summary', 'Характеристики и модификаторы'));
    details.open = !detailed;
    if (properties.length) {
      const list = node('ul', undefined, 'trade-listing-properties');
      for (const property of properties) {
        list.append(node('li', [property.name, ...property.values].join(' · ')));
      }
      details.append(list);
    }
    appendModGroups(details, groups);
    card.append(details);
  }
  if (comparison && item.itemText) card.append(compareListing(item.itemText, comparison));
  return card;
}

function showListings(result, panel, game, comparison) {
  const notices = {
    browser: 'Прямой поиск выключен. Открой результаты на PoE Trade.',
    partial: 'Поиск выполнен, но PoE Trade не вернул карточки лотов.',
    unavailable: 'PoE Trade не вернул результаты запроса.',
  };
  const warnings = {
    rate_limited: 'Достигнут лимит запросов. Попробуй позже.',
    complex_query: 'Сайт отклонил сложный запрос. Подключи сессию PoE Trade или сократи число фильтров.',
    session_required: 'Сайт ограничил доступ. Проверь сессию PoE Trade.',
    session_changed: 'Сессия PoE Trade изменилась. Повтори поиск.',
    expired: 'Срок действия поиска истёк. Обнови лоты.',
  };
  const total = result.total;
  const shown = result.listings.length;
  let summary = warnings[result.warningCode] ?? notices[result.status] ?? result.warning;
  if (result.status === 'ok') {
    if (total === 0) summary = 'По этим фильтрам лотов нет.';
    else if (shown === 0) summary = 'PoE Trade пока не вернул карточки лотов.';
    else if (total === null) summary = `Загружено лотов ${shown}`;
    else summary = `Показано ${shown} из ${result.inexact ? 'примерно ' : ''}${listingNumbers.format(total)}`;
  }
  const headline = node('p', summary, result.status === 'ok' ? 'muted' : 'warning');
  headline.setAttribute('role', 'status');
  const bar = node('div', undefined, 'actions trade-listing-toolbar');
  const link = tradeLink(result.searchUrl);
  if (link.tagName === 'A') link.textContent = 'Все результаты на PoE Trade ↗';
  bar.append(headline, link);
  if (['complex_query', 'session_required'].includes(result.warningCode)) {
    bar.append(action('Настроить сессию', openTradeSession));
  }
  const list = node('div', undefined, 'cards');
  list.append(...result.listings.map(item => listingCard(item, game, true, comparison)));
  panel.replaceChildren(bar, list);
  if (comparison && result.listings.some(item => !item.itemText)) {
    panel.append(node('p', 'Для лотов без кнопки сравнения нужен полный текст предмета из PoE Trade.', 'muted'));
  }
}

function listingPanel(searchArgs, comparison) {
  const panel = node('section', undefined, 'trade-listings');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Лоты PoE Trade');
  let request = 0;
  const button = action('Показать лоты', async () => {
    const args = searchArgs();
    const current = ++request;
    panel.hidden = false;
    panel.setAttribute('aria-busy', 'true');
    const loading = node('p', 'Загружаем лоты…', 'muted');
    loading.setAttribute('role', 'status');
    panel.replaceChildren(loading);
    try {
      const result = await api('trade_search', args);
      if (current !== request || !panel.isConnected) return;
      showListings(result, panel, args.scope.game, args.scope.game === 'poe1' ? comparison : undefined);
      button.textContent = 'Обновить лоты';
    } catch (error) {
      if (current !== request || !panel.isConnected) return;
      const failure = node('p', error.message, 'warning');
      failure.setAttribute('role', 'status');
      panel.replaceChildren(failure);
    } finally {
      if (current === request) panel.removeAttribute('aria-busy');
    }
  }, '');
  return {
    panel, button,
    reset() {
      request++;
      panel.hidden = true;
      panel.removeAttribute('aria-busy');
      panel.replaceChildren();
      button.textContent = 'Показать лоты';
    },
  };
}

async function showSavedTemplate(watch) {
  openPage('watches');
  await refreshWatches();
  status(watch.body ? 'Шаблон Live Search сохранён.' : 'Ссылка сохранена. PoE Trade пока не вернул фильтры.');
}

function assistantStatus(text, error = false) {
  const element = get('assistant-status');
  element.textContent = text;
  element.toggleAttribute('data-error', error);
}

async function localRequest(path, owner, body, fallback) {
  const headers = { ...authorization };
  if (owner) headers['X-PoE-Trade-Window'] = owner;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || fallback), { status: response.status, code: result.code });
  return result.data;
}

let tradeSessionRequest = 0;
let tradeSessionBusy = false;

function openTradeSession() {
  const login = get('trade-session-connect');
  openSettings(login.hidden || login.disabled ? 'trade-session-heading' : 'trade-session-connect');
  get('trade-session-panel').scrollIntoView({ block: 'nearest' });
}

function tradeSessionMessage(text, error = false) {
  const message = get('trade-session-status');
  message.textContent = text;
  message.hidden = !text;
  message.toggleAttribute('data-error', error);
}

function showTradeSession({ connected, browserAvailable, status: sessionStatus }) {
  get('trade-session-state').textContent = connected ? 'Вход выполнен'
    : sessionStatus === 'disconnected' ? 'Вход не выполнен' : 'Сессия недоступна';
  get('trade-session-connect').hidden = connected || !browserAvailable;
  get('trade-session-connect').disabled = !browserAvailable;
  get('trade-session-disconnect').hidden = !connected || !browserAvailable;
  get('trade-session-help').textContent = browserAvailable
    ? connected ? 'Сессия доступна для поиска и Live Search.' : 'Войди на официальном сайте в окне PoE Trade.'
    : 'Для встроенного входа запусти PoE Trade через ярлык.';
  if (connected) tradeSessionMessage('');
}

function tradeSessionRequestData(body) {
  return localRequest('/trade-session', body ? watchWindow : undefined, body, 'Сессия PoE Trade недоступна.');
}

async function refreshTradeSession() {
  if (!token || tradeSessionBusy) return;
  const version = ++tradeSessionRequest;
  try {
    const session = await tradeSessionRequestData();
    if (version === tradeSessionRequest) showTradeSession(session);
  } catch {
    if (version === tradeSessionRequest) get('trade-session-state').textContent = 'Недоступна';
  }
}

async function changeTradeSession(body) {
  if (tradeSessionBusy) return;
  if (!watchWindow) {
    tradeSessionMessage('Дождись подключения к локальному сервису.', true);
    return;
  }
  tradeSessionBusy = true;
  tradeSessionRequest++;
  const controls = ['trade-session-connect', 'trade-session-disconnect'].map(get);
  for (const control of controls) control.disabled = true;
  tradeSessionMessage('');
  try {
    showTradeSession(await tradeSessionRequestData(body));
    tradeSessionMessage(body.action === 'login' ? 'Заверши вход в открывшемся окне Path of Exile.' : 'Сессия очищена.');
    void refreshWatches().catch(error => status(error.message, true));
  } catch (error) {
    tradeSessionMessage(error.message, true);
  } finally {
    tradeSessionBusy = false;
    for (const control of controls) control.disabled = false;
    void refreshTradeSession();
  }
}

get('trade-session-connect').addEventListener('click', () => void changeTradeSession({ action: 'login' }));
get('trade-session-disconnect').addEventListener('click', () => void changeTradeSession({ action: 'logout' }));
window.addEventListener('focus', () => void refreshTradeSession());
void refreshTradeSession();

let codexSettingsView;
let codexSettingsBusy = false;
let codexSettingsRequest = 0;

function codexPathMessage(text, error = false) {
  const message = get('codex-path-status');
  message.textContent = text;
  message.toggleAttribute('data-error', error);
}

function showCodexSettings(data, preserveDraft = false) {
  const input = get('codex-path');
  if (!preserveDraft || input.value === (codexSettingsView?.path ?? '')) input.value = data.path;
  codexSettingsView = data;
  get('codex-path-browse').hidden = !data.browseAvailable;
  get('codex-path-reset').hidden = data.source !== 'saved';
  if (!data.path) codexPathMessage('Укажи путь к установленному Codex CLI.');
  else if (!data.configured) codexPathMessage('Файл Codex CLI недоступен по указанному пути.', true);
  else if (data.source === 'environment') codexPathMessage('Путь задан переменной POE_ASSISTANT_CODEX.');
  else codexPathMessage('Путь к Codex CLI сохранён.');
}

function codexSettingsApi(body) {
  return localRequest('/settings/codex', body ? watchWindow : undefined, body, 'Настройки Codex CLI недоступны.');
}

async function refreshCodexSettings() {
  if (codexSettingsBusy) return;
  const version = ++codexSettingsRequest;
  try {
    const data = await codexSettingsApi();
    if (version !== codexSettingsRequest) return;
    showCodexSettings(data, true);
    get('codex-path-controls').disabled = false;
  } catch (error) {
    if (version === codexSettingsRequest) codexPathMessage(error.message, true);
  }
}

async function changeCodexSettings(action) {
  if (codexSettingsBusy) return;
  if (!watchWindow) return codexPathMessage('Дождись подключения к локальному сервису.', true);
  codexSettingsBusy = true;
  codexSettingsRequest++;
  const controls = get('codex-path-controls');
  const input = get('codex-path');
  controls.disabled = true;
  let focusPath = false;
  try {
    const data = await codexSettingsApi(action === 'save' ? { action, path: input.value } : { action });
    if (action === 'browse') {
      if (data.selected) {
        input.value = data.selected;
        codexPathMessage('Нажми «Сохранить путь», чтобы применить выбор.');
        focusPath = true;
      }
    } else {
      showCodexSettings(data);
      setAssistantReadiness('checking');
      void refreshAssistantReadiness(true);
    }
  } catch (error) {
    codexPathMessage(error.message, true);
  } finally {
    codexSettingsBusy = false;
    controls.disabled = false;
    if (focusPath && page === 'settings') input.focus();
  }
}

get('codex-path-form').addEventListener('submit', event => {
  event.preventDefault();
  void changeCodexSettings('save');
});
get('codex-path-browse').addEventListener('click', () => void changeCodexSettings('browse'));
get('codex-path-reset').addEventListener('click', () => void changeCodexSettings('reset'));

const integrationForms = {
  pob: { controls: 'pob-settings-controls', status: 'pob-settings-status' },
  mcp: { controls: 'mcp-config-controls', status: 'mcp-config-status' },
};
const integrationRequests = new Set();
let mcpConfigDraft;

function integrationMessage(kind, message, error = false) {
  const target = get(integrationForms[kind].status);
  target.textContent = message;
  target.toggleAttribute('data-error', error);
}

function integrationRequest(kind, body) {
  return localRequest('/settings/' + kind, body ? watchWindow : undefined, body, 'Настройки недоступны.');
}

function clearMcpConfigDraft() {
  mcpConfigDraft = undefined;
  get('mcp-config-draft').hidden = true;
  get('mcp-config-preview').textContent = '';
}

function showIntegrationSettings(kind, data) {
  if (kind === 'pob') {
    get('pob-builds-directory').value = data.buildsDirectory;
    get('pob-source-directory').value = data.sourceDirectory;
    get('pob-browse-builds').hidden = get('pob-browse-source').hidden = !data.browseAvailable;
  } else {
    get('mcp-config-path').value = data.path;
    get('mcp-config-browse').hidden = !data.browseAvailable;
  }
}

async function refreshIntegrationSettings() {
  await Promise.all(Object.keys(integrationForms).map(async kind => {
    const controls = get(integrationForms[kind].controls);
    if (!controls.disabled || integrationRequests.has(kind)) return;
    integrationRequests.add(kind);
    try {
      showIntegrationSettings(kind, await integrationRequest(kind));
      controls.disabled = false;
      integrationMessage(kind, '');
    } catch (error) {
      integrationMessage(kind, error.message, true);
    } finally {
      integrationRequests.delete(kind);
    }
  }));
}

async function updateIntegrationSettings(kind, body, display) {
  if (integrationRequests.has(kind)) return;
  if (!watchWindow) return integrationMessage(kind, 'Дождись подключения к локальному сервису.', true);
  const controls = get(integrationForms[kind].controls);
  integrationRequests.add(kind);
  controls.disabled = true;
  let focusTarget;
  try {
    focusTarget = display(await integrationRequest(kind, body));
  } catch (error) {
    if (body.action === 'apply' && error.status === 409) clearMcpConfigDraft();
    integrationMessage(kind, error.message, true);
  } finally {
    controls.disabled = false;
    integrationRequests.delete(kind);
    if (focusTarget && page === 'settings') focusTarget.focus();
  }
}

function savePobSettings(buildsDirectory, sourceDirectory) {
  void updateIntegrationSettings('pob', { action: 'save', buildsDirectory, sourceDirectory }, data => {
    showIntegrationSettings('pob', data);
    clearMcpConfigDraft();
    integrationMessage('pob', 'Папки Path of Building сохранены.');
    if (get('import-kind').value === 'file') void refreshBuildFiles();
  });
}

function browseIntegrationPath(kind, field, inputId) {
  void updateIntegrationSettings(kind, { action: 'browse', field }, data => {
    if (!data.selected) return;
    if (kind === 'mcp') clearMcpConfigDraft();
    const input = get(inputId);
    input.value = data.selected;
    integrationMessage(kind, '');
    return input;
  });
}

get('pob-settings-form').addEventListener('submit', event => {
  event.preventDefault();
  savePobSettings(get('pob-builds-directory').value, get('pob-source-directory').value);
});
get('pob-settings-reset').addEventListener('click', () => savePobSettings(null, null));
get('pob-browse-builds').addEventListener('click', () => browseIntegrationPath('pob', 'buildsDirectory', 'pob-builds-directory'));
get('pob-browse-source').addEventListener('click', () => browseIntegrationPath('pob', 'sourceDirectory', 'pob-source-directory'));

get('mcp-config-form').addEventListener('input', clearMcpConfigDraft);
get('mcp-config-form').addEventListener('submit', event => {
  event.preventDefault();
  clearMcpConfigDraft();
  const form = new FormData(event.currentTarget);
  const servers = form.getAll('server');
  void updateIntegrationSettings('mcp', { action: 'preview', path: form.get('path'), servers }, data => {
    get('mcp-config-path').value = data.path;
    get('mcp-config-preview').textContent = data.snippet;
    get('mcp-config-draft').hidden = false;
    mcpConfigDraft = { path: data.path, version: data.version, servers };
    integrationMessage('mcp', '');
  });
});
get('mcp-config-browse').addEventListener('click', () => browseIntegrationPath('mcp', undefined, 'mcp-config-path'));
get('mcp-config-save').addEventListener('click', () => {
  void updateIntegrationSettings('mcp', { action: 'save', path: get('mcp-config-path').value }, data => {
    showIntegrationSettings('mcp', data);
    clearMcpConfigDraft();
    integrationMessage('mcp', 'Путь к config.toml сохранён.');
  });
});
get('mcp-config-apply').addEventListener('click', () => {
  if (!mcpConfigDraft) return;
  void updateIntegrationSettings('mcp', { action: 'apply', ...mcpConfigDraft }, data => {
    clearMcpConfigDraft();
    const backup = data.backup ? ` Копия предыдущего файла · ${data.backup}.` : '';
    const pathStatus = data.remembered ? '' : ' Не удалось запомнить путь в настройках приложения.';
    integrationMessage('mcp', 'Настройки MCP записаны. Открой новый сеанс Codex, чтобы загрузить их.' + backup + pathStatus, !data.remembered);
    return get('mcp-config-submit');
  });
});

function assistantRequest(path, owner, body) {
  return localRequest('/assistant/' + path, owner, body, 'Помощник недоступен.');
}

function pobSetRequest(body) {
  if (body && !watchWindow) throw new Error('Дождись подключения к локальному сервису.');
  return localRequest('/pob-sets', body ? watchWindow : undefined, body, 'Сохранённые комплекты недоступны.');
}

function buildNotesStatus(text, error = false) {
  const element = get('build-notes-status');
  element.textContent = text;
  element.toggleAttribute('data-error', error);
}

function buildNotesDirty(notes) {
  return Boolean(notes.saved && get('build-notes-text').value !== notes.saved.text);
}

function updateBuildNotesControls() {
  const notes = buildNotes;
  if (!notes) return;
  get('build-notes-text').readOnly = !notes.saved || notes.pending;
  get('build-notes-save').disabled = notes.pending || notes.needsRefresh || !buildNotesDirty(notes);
  get('build-notes-refresh').disabled = notes.pending;
}

function openBuildNotes({ buildId, revision }) {
  const target = { buildId, revision };
  if (buildNotes?.target.revision === revision) {
    buildNotes.target = target;
    if (!buildNotes.pending && !buildNotesDirty(buildNotes)) void requestBuildNotes(buildNotes);
    return;
  }
  buildNotes = { target, saved: null, pending: false, needsRefresh: false, refreshQueued: false };
  get('build-notes-text').value = '';
  get('build-notes-form').hidden = false;
  void requestBuildNotes(buildNotes);
}

async function requestBuildNotes(notes, change) {
  const saving = change !== undefined;
  const path = saving ? '/build-notes' : '/build-notes?' + new URLSearchParams(notes.target);
  notes.pending = true;
  updateBuildNotesControls();
  buildNotesStatus(saving ? 'Сохраняем заметки…' : 'Загружаем заметки…');
  try {
    const view = await localRequest(path, saving ? watchWindow : undefined, change, 'Заметки недоступны.');
    if (notes !== buildNotes) return;
    const text = get('build-notes-text');
    text.value = view.text;
    notes.saved = { version: view.version, text: text.value };
    notes.needsRefresh = false;
    buildNotesStatus(saving ? 'Заметки сохранены.' : '');
  } catch (error) {
    if (notes !== buildNotes) return;
    if (saving && error.status === 409 && error.code !== 'window_disconnected') {
      notes.needsRefresh = true;
      buildNotesStatus('Обнови заметки перед сохранением. Черновик остался в редакторе.', true);
    } else {
      buildNotesStatus(error.message, true);
    }
  } finally {
    if (notes === buildNotes) {
      notes.pending = false;
      updateBuildNotesControls();
      if (notes.refreshQueued) {
        notes.refreshQueued = false;
        syncAssistantNotes(notes);
      }
    }
  }
}

function syncAssistantNotes(notes) {
  if (notes.pending) {
    notes.refreshQueued = true;
  } else if (buildNotesDirty(notes)) {
    notes.needsRefresh = true;
    updateBuildNotesControls();
    buildNotesStatus('Помощник обновил заметки. Черновик остался в редакторе. Обнови заметки перед сохранением.', true);
  } else {
    void requestBuildNotes(notes);
  }
}

get('build-notes-text').addEventListener('input', () => {
  updateBuildNotesControls();
  if (buildNotes?.saved && !buildNotes.needsRefresh) {
    buildNotesStatus(buildNotesDirty(buildNotes) ? 'Есть несохранённые правки.' : '');
  }
});
get('build-notes-form').addEventListener('submit', event => {
  event.preventDefault();
  const notes = buildNotes;
  if (!notes || notes.pending || notes.needsRefresh || !buildNotesDirty(notes)) return;
  if (!watchWindow) {
    buildNotesStatus('Дождись подключения к локальному сервису.', true);
    return;
  }
  void requestBuildNotes(notes, {
    ...notes.target, expectedVersion: notes.saved.version, text: get('build-notes-text').value,
  });
});
get('build-notes-refresh').addEventListener('click', () => {
  const notes = buildNotes;
  if (!notes || notes.pending) return;
  if (buildNotesDirty(notes) && !window.confirm('Обновить заметки и сбросить несохранённые правки?')) return;
  void requestBuildNotes(notes);
});

let setListRequest = 0;
async function refreshPobSets() {
  if (!token) return;
  const request = ++setListRequest;
  const list = get('pob-set-list');
  try {
    const sets = await pobSetRequest();
    await Promise.allSettled([...new Set(sets.map(set => set.scope.game))].map(loadCurrencies));
    if (request !== setListRequest) return;
    list.replaceChildren(...sets.map(pobSetCard));
    if (!sets.length) list.append(node('p', 'Сохранённых комплектов пока нет.', 'muted'));
  } catch (error) {
    if (request === setListRequest) list.replaceChildren(node('p', error.message, 'warning'));
  }
}

let buildRequest = 0;

function restorePobSet(result) {
  const selected = result.set.scope;
  const gameChanged = get('game').value !== selected.game;
  get('game').value = selected.game;
  if (selected.realm !== 'poe2') get('realm').value = selected.realm;
  if (gameChanged) applyGame();
  void updateLeagues({ selected: selected.league, source: 'set' });
  renderBuild(result.build, result.set);
  openPage('build');
  get('build-title').focus();
  const skipped = result.skippedEmptyJewelSlots?.length;
  status(`Открыт комплект «${result.set.label}».${skipped ? ` Пустых гнёзд самоцветов скрыто ${skipped}.` : ''}`);
}

function pobSetCard(set) {
  const card = node('article', undefined, 'card');
  card.append(node('h4', set.label), node('p', scopeSummary(set.scope), 'muted'));
  appendSetDetails(card, set);
  const buttons = node('div', undefined, 'actions');
  const target = { setId: set.id, expectedVersion: set.version };
  const open = action('Открыть', async () => {
    const request = ++buildRequest;
    const result = await pobSetRequest({ kind: 'open_pob_set', ...target });
    if (request === buildRequest) restorePobSet(result);
  });
  const renameForm = node('form', undefined, 'filter-bar');
  renameForm.hidden = true;
  const newName = field('Новое имя', 'label', set.label);
  const nameInput = newName.querySelector('input');
  nameInput.maxLength = 120;
  nameInput.required = true;
  const renameSave = node('button', 'Сохранить имя');
  const rename = action('Переименовать', () => {
    renameForm.hidden = false;
    removal.hidden = true;
    nameInput.focus();
    nameInput.select();
  });
  renameForm.append(newName, renameSave, action('Отмена', () => {
    renameForm.hidden = true;
    rename.focus();
  }, 'quiet'));
  renameForm.addEventListener('submit', event => {
    event.preventDefault();
    if (renameSave.disabled) return;
    void run(renameSave, async () => {
      if (!nameInput.value.trim()) throw new Error('Введи имя комплекта.');
      await pobSetRequest({ kind: 'rename_pob_set', ...target, label: nameInput.value.trim() });
      await refreshPobSets();
      status('Комплект переименован.');
    });
  });
  const removal = node('div', undefined, 'assistant-delete-confirm');
  removal.hidden = true;
  const remove = action('Удалить', () => {
    removal.hidden = false;
    renameForm.hidden = true;
    cancelRemoval.focus();
  }, 'quiet');
  const cancelRemoval = action('Отмена', () => {
    removal.hidden = true;
    remove.focus();
  });
  const removeButtons = node('div', undefined, 'actions');
  removeButtons.append(action('Подтвердить удаление', async () => {
    await pobSetRequest({ kind: 'remove_pob_set', ...target });
    await refreshPobSets();
    status('Комплект удалён.');
  }), cancelRemoval);
  removal.append(node('p', `Удалить комплект «${set.label}»?`), removeButtons);
  buttons.append(open, rename, remove);
  card.append(buttons, renameForm, removal);
  return card;
}

get('pob-set-save').addEventListener('click', event => void run(event.currentTarget, async () => {
  const form = new FormData(get('build-form'));
  const draft = buildDraft(form);
  const label = form.get('set-name').trim() || build.label.trim().slice(0, 120) || 'Комплект PoB';
  await pobSetRequest({ kind: 'save_pob_set', label, draft });
  await refreshPobSets();
  status('Комплект сохранён.');
}));
get('pob-set-name').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    get('pob-set-save').click();
  }
});
void refreshPobSets();

function showAssistantContext() {
  const league = get('league').value;
  get('assistant-context').textContent = [league || 'Лига не выбрана', build?.label || 'Билд PoB не выбран'].join(' · ');
}

function setAssistantOpen(open) {
  const panel = get('assistant');
  const toggle = get('assistant-toggle');
  const hadFocus = panel.contains(document.activeElement);
  panel.hidden = !open;
  document.body.classList.toggle('assistant-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (open) {
    showAssistantContext();
    get('assistant-form').elements.text.focus();
    scrollAssistantToLatest();
  } else if (hadFocus) {
    (toggle.disabled ? get('scope-settings') : toggle).focus();
  }
}

const readinessLabels = {
  checking: 'Проверяем Codex CLI…',
  ready: 'Codex CLI готов к работе.',
  setup_required: 'Укажи путь к доступному Codex CLI.',
  login_required: 'Выполни вход через codex login, затем проверь готовность.',
  unavailable: 'Не удалось проверить готовность Codex CLI.',
};

function updateAssistantControls() {
  get('assistant-send').disabled = !assistantReady || !watchWindow || assistantSending;
}

function setAssistantReadiness(state) {
  assistantReady = state === 'ready';
  const toggle = get('assistant-toggle');
  toggle.disabled = !assistantReady;
  toggle.title = readinessLabels[state];
  const feedback = get('codex-readiness');
  feedback.textContent = readinessLabels[state];
  feedback.toggleAttribute('data-error', state === 'login_required' || state === 'unavailable');
  if (!assistantReady && !get('assistant').hidden) setAssistantOpen(false);
  updateAssistantControls();
}

async function refreshAssistantReadiness(force = false) {
  if (!token) {
    setAssistantReadiness('unavailable');
    return false;
  }
  const request = ++assistantReadinessRequest;
  try {
    const { state } = await assistantRequest(force ? 'status?refresh=1' : 'status');
    if (request === assistantReadinessRequest) {
      setAssistantReadiness(Object.hasOwn(readinessLabels, state) ? state : 'unavailable');
    }
  } catch {
    if (request === assistantReadinessRequest) setAssistantReadiness('unavailable');
  }
  return assistantReady;
}

get('assistant-toggle').addEventListener('click', async () => {
  if (!get('assistant').hidden) return setAssistantOpen(false);
  if (await refreshAssistantReadiness()) setAssistantOpen(true);
});
get('assistant-close').addEventListener('click', () => setAssistantOpen(false));
get('codex-check').addEventListener('click', event => void run(event.currentTarget, () => refreshAssistantReadiness(true)));
window.addEventListener('focus', () => void refreshAssistantReadiness());
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || get('assistant').hidden) return;
  if (get('assistant').contains(document.activeElement)) setAssistantOpen(false);
});

function assistantContext() {
  const context = { scope: scope() };
  const slot = get('slot-picker').value;
  if (build && slot) {
    Object.assign(context, { buildId: build.buildId, revision: build.revision, slots: [slot] });
    if (context.scope.game === 'poe1') context.buildOptions = buildOptions(new FormData(get('build-form')), slot);
  }
  return context;
}

const assistantProposalActions = {
  save_watch_from_result: { button: 'Сохранить шаблон', done: 'Шаблон сохранён.' },
  import_watch_link: { button: 'Импортировать шаблон', done: 'Шаблон импортирован.' },
  pause_watch: { button: 'Поставить на паузу', done: 'Шаблон поставлен на паузу.' },
  remove_watch: { button: 'Удалить шаблон', done: 'Шаблон удалён.' },
  save_pob_set: { button: 'Сохранить комплект', done: 'Комплект сохранён.' },
  open_pob_set: { button: 'Открыть комплект', done: 'Комплект открыт.' },
  rename_pob_set: { button: 'Переименовать комплект', done: 'Комплект переименован.' },
  remove_pob_set: { button: 'Удалить комплект', done: 'Комплект удалён.' },
};

function assistantProposalCard(proposal, jobId, owner) {
  const { id, kind, label, scope: targetScope, slot, status: watchStatus, filtersAvailable, searchUrl } = proposal;
  const copy = assistantProposalActions[kind];
  const isSet = kind.endsWith('_pob_set');
  const destructive = kind === 'remove_watch' || kind === 'remove_pob_set';
  const key = crypto.randomUUID();
  const card = node('article', undefined, 'card assistant-proposal');
  const title = node('h4', label);
  title.id = 'assistant-proposal-' + id;
  title.tabIndex = -1;
  card.setAttribute('aria-labelledby', title.id);
  const details = [scopeSummary(targetScope), slot, stateNames[watchStatus]].filter(Boolean).join(' · ');
  card.append(title, node('p', details));
  if (kind === 'rename_pob_set' && proposal.setLabel) card.append(node('p', `Текущее имя «${proposal.setLabel}»`, 'muted'));
  if (isSet) appendSetDetails(card, proposal);
  if (kind === 'save_watch_from_result') card.append(node('p', `Бюджет ${budgetSummary(proposal.budget)}`, 'muted'));
  if (kind === 'import_watch_link' && filtersAvailable === false) {
    card.append(node('p', 'Фильтры будут запрошены при запуске Live Search.', 'muted'));
  }
  if (kind === 'import_watch_link' && typeof searchUrl === 'string'
      && searchUrl.startsWith('https://www.pathofexile.com/') && URL.canParse(searchUrl)) {
    const link = tradeLink(searchUrl);
    link.textContent = 'Проверить поиск на PoE Trade ↗';
    const inspect = node('div', undefined, 'actions');
    inspect.append(link);
    card.append(inspect);
  }

  const actions = node('div', undefined, 'actions');
  const applyButton = node('button', copy.button, destructive ? 'quiet' : undefined);
  applyButton.type = 'button';
  actions.append(applyButton);
  const feedback = node('p');
  feedback.setAttribute('role', 'status');
  feedback.tabIndex = -1;
  card.append(actions, feedback);

  let submitting = false;
  let applied = false;
  async function apply(confirmationButton) {
    if (submitting || applied) return;
    if (watchWindow !== owner) {
      feedback.textContent = 'Окно переподключилось. Подготовь новое предложение.';
      feedback.toggleAttribute('data-error', true);
      return;
    }
    submitting = true;
    confirmationButton.disabled = true;
    feedback.textContent = 'Применяется…';
    feedback.removeAttribute('data-error');
    const selection = kind === 'open_pob_set' ? ++buildRequest : undefined;
    try {
      const result = await assistantRequest('jobs/' + jobId + '/apply', owner, { proposalId: id, idempotencyKey: key, context: assistantContext() });
      applied = true;
      actions.hidden = true;
      if (destructive) confirmationButton.closest('.assistant-delete-confirm').hidden = true;
      feedback.textContent = copy.done;
      if (card.isConnected && !get('assistant').hidden && document.activeElement === document.body) feedback.focus();
      if (isSet) {
        if (kind === 'open_pob_set' && buildRequest === selection) restorePobSet(result);
        if (kind !== 'open_pob_set') await refreshPobSets();
      } else {
        const refresh = updates.then(refreshWatches);
        updates = refresh.catch(() => {});
        await refresh;
      }
    } catch (error) {
      const list = isSet ? 'комплектов' : 'Live Search';
      feedback.textContent = applied ? copy.done + ` Не удалось обновить список ${list}.` : error.message;
      feedback.toggleAttribute('data-error', true);
    } finally {
      submitting = false;
      confirmationButton.disabled = applied;
    }
  }

  if (destructive) {
    const confirmation = node('div', undefined, 'assistant-delete-confirm');
    confirmation.hidden = true;
    const description = node('p', isSet ? `Удалить комплект «${label}»?` : `Удалить «${label}» из Live Search в лиге ${targetScope.league}?`);
    description.id = title.id + '-confirmation';
    confirmation.setAttribute('role', 'group');
    confirmation.setAttribute('aria-labelledby', description.id);
    const confirmActions = node('div', undefined, 'actions');
    const confirm = node('button', 'Подтвердить удаление');
    const cancel = node('button', 'Отмена', 'secondary');
    confirm.type = cancel.type = 'button';
    confirmActions.append(confirm, cancel);
    confirmation.append(description, confirmActions);
    card.insertBefore(confirmation, feedback);
    applyButton.addEventListener('click', () => {
      actions.hidden = true;
      confirmation.hidden = false;
      cancel.focus();
    });
    const dismiss = () => {
      if (submitting) return;
      confirmation.hidden = true;
      actions.hidden = false;
      feedback.textContent = '';
      feedback.removeAttribute('data-error');
      applyButton.focus();
    };
    cancel.addEventListener('click', dismiss);
    confirmation.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      }
    });
    confirm.addEventListener('click', () => void apply(confirm));
  } else {
    applyButton.addEventListener('click', () => void apply(applyButton));
  }
  return card;
}

function revealAssistantProposal(proposal, jobId, owner) {
  const titleId = 'assistant-proposal-' + proposal.id;
  if (!get(titleId)) get('assistant-proposal-list').append(assistantProposalCard(proposal, jobId, owner));
  get('assistant-proposals').hidden = false;
  assistantStatus('Подтверди сохранение выбранного шаблона.');
  get(titleId).focus();
}

function assistantResultCard(row, resultRef, jobId, owner, buildVersion, data) {
  const card = node('article', undefined, 'card');
  card.append(node('h3', row.slot + (row.item ? ' · ' + row.item : '')));
  for (const warning of row.warnings) card.append(node('p', warning, 'warning'));
  if (!row.link) return card;
  card.append(node('p', scopeSummary(row.scope), 'trade-result-scope muted'));
  const link = tradeLink(row.link);
  const actions = node('div', undefined, 'actions');
  const comparison = { buildId: data.buildId, revision: data.revision, slot: row.slot };
  const offers = row.body?.query && listingPanel(() => ({ scope: row.scope, body: row.body }), comparison);
  if (offers) actions.append(offers.button);
  actions.append(link);
  if (link.tagName === 'A' && typeof resultRef === 'string' && row.body?.query) {
    const price = row.body.query.filters?.trade_filters?.filters?.price;
    const budget = price && (price.min !== undefined || price.max !== undefined || price.option)
      ? { currency: price.option, min: price.min, max: price.max }
      : undefined;
    card.append(node('p', `Бюджет ${budgetSummary(budget, row.scope.game)}`, 'muted'));
    let prepared;
    actions.append(action('Сохранить как шаблон Live Search', async () => {
      if (watchWindow !== owner) throw new Error('Окно переподключилось. Подготовь поиск заново.');
      if (buildVersion !== buildRequest) throw new Error('Билд изменился. Подготовь поиск заново.');
      const proposal = prepared ?? await assistantRequest('jobs/' + jobId + '/proposals/slot', owner, {
        resultRef, slot: row.slot, context: assistantContext(),
      });
      if (!card.isConnected || buildVersion !== buildRequest || watchWindow !== owner) return;
      prepared = proposal;
      revealAssistantProposal(proposal, jobId, owner);
    }));
  }
  card.append(actions);
  if (offers) card.append(offers.panel);
  return card;
}

function showAssistantResults(job, owner, buildVersion, researchContext) {
  const context = get('assistant-answer-context');
  context.textContent = researchContext;
  context.hidden = !researchContext;
  get('assistant-answer').textContent = job.response.message;
  get('assistant-answer').hidden = false;
  showAssistantResearch(job.report);
  const cards = (job.results ?? []).flatMap(({ data, resultRef }) => (Array.isArray(data?.rows) ? data.rows : [])
    .map(row => assistantResultCard(row, resultRef, job.id, owner, buildVersion, data)));
  get('assistant-results').replaceChildren(...cards);
  const proposals = (job.proposals ?? []).filter(proposal => Object.hasOwn(assistantProposalActions, proposal.kind));
  get('assistant-proposal-list').replaceChildren(...proposals.map(proposal => assistantProposalCard(proposal, job.id, owner)));
  get('assistant-proposals').hidden = proposals.length === 0;
  assistantStatus(proposals.length ? 'Подтверди изменения, которые нужно применить.' : '');
  scrollAssistantToLatest();
}

function showAssistantNotes(result, context) {
  if (!result) return;
  const currentRevision = Boolean(context.revision && buildNotes?.target.revision === context.revision);
  const skipMessage = {
    stale: 'Заметки изменились во время запроса. Добавление новых записей пропущено.',
    full: 'Достигнут лимит заметок для этой ревизии билда.',
    unavailable: 'Не удалось сохранить новые заметки помощника.',
  }[result.skipped];
  const savedMessage = result.added > 0
    ? `Помощник сохранил заметки для ${currentRevision ? 'текущей ревизии' : 'ревизии из запроса'} (${result.added}).`
    : '';
  get('assistant-notes-status').textContent = [savedMessage, skipMessage].filter(Boolean).join(' ');
  if (result.added > 0 && currentRevision) syncAssistantNotes(buildNotes);
}

function showAssistantResearch(report) {
  const section = get('assistant-research');
  const cards = get('assistant-recommendations');
  const sources = get('assistant-sources');
  cards.replaceChildren();
  sources.replaceChildren();
  section.hidden = !report;
  if (!report) return;
  const indexed = new Map(report.sources.map((source, index) => [source.url, index + 1]));
  for (const entry of report.recommendations) {
    const card = node('article', undefined, 'card');
    card.append(node('h4', entry.title), node('p', entry.slot, 'muted'), node('p', entry.reason),
      node('p', 'Как проверить · ' + entry.verification, 'muted'));
    const references = entry.sourceUrls.flatMap(url => indexed.has(url) ? [indexed.get(url)] : []);
    card.append(node('p', references.length ? 'Источники · ' + references.join(', ') : 'Для этой рекомендации нужен источник.', 'muted'));
    cards.append(card);
  }
  if (!report.recommendations.length) cards.append(node('p', 'В этом запросе рекомендации не сформированы.', 'muted'));
  if (report.sources.length) {
    const list = node('ol');
    const kinds = { guide: 'Веб', economy: 'Рынок poe.ninja', official: 'GGG' };
    for (const source of report.sources) {
      const link = node('a', source.title);
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const row = node('li', (kinds[source.kind] || 'Источник') + ' · ');
      row.append(link);
      list.append(row);
    }
    sources.append(node('h3', 'Проверенные ссылки'), list);
  }
}

function scrollAssistantToLatest() {
  if (get('assistant').hidden) return;
  const answer = get('assistant-answer');
  (answer.hidden ? get('assistant-question') : answer).scrollIntoView({ block: 'nearest' });
}

function archiveAssistantTurn() {
  const question = get('assistant-question');
  if (question.hidden) return;
  const answer = get('assistant-answer');
  const history = get('assistant-history');
  const turn = node('div');
  turn.append(node('p', question.textContent, question.className));
  const reply = answer.hidden ? get('assistant-status').textContent : answer.textContent;
  if (reply) turn.append(node('p', reply, answer.className));
  history.append(turn);
  if (history.children.length > 12) history.firstElementChild.remove();
}

get('assistant-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!assistantReady || assistantSending) return;
  void sendAssistant(new FormData(event.currentTarget)).catch(error => assistantStatus(error.message, true));
});

async function sendAssistant(form) {
  const owner = watchWindow;
  if (!owner) throw new Error('Дождись подключения к локальному сервису.');
  const text = form.get('text').trim();
  if (!text) throw new Error('Введи сообщение для Codex.');
  const context = assistantContext();
  const buildVersion = buildRequest;
  const research = form.has('research');
  const selection = [scopeSummary(context.scope), build?.label || 'Без билда PoB'];
  if (research && context.slots?.length) {
    const defaultBudget = context.buildOptions?.budget;
    selection.push(...context.slots.map(slot => `${slot} ${budgetSummary(context.buildOptions?.budgets?.[slot] ?? defaultBudget)}`));
  }
  const researchContext = research ? 'Контекст ответа · ' + selection.join(' · ') : '';
  archiveAssistantTurn();
  get('assistant-question').textContent = text;
  get('assistant-question').hidden = false;
  get('assistant-answer-context').hidden = true;
  get('assistant-answer').hidden = true;
  showAssistantResearch();
  get('assistant-results').replaceChildren();
  get('assistant-proposal-list').replaceChildren();
  get('assistant-proposals').hidden = true;
  get('assistant-notes-status').textContent = '';
  assistantStatus('Запускаем Codex…');
  assistantSending = true;
  updateAssistantControls();
  scrollAssistantToLatest();
  try {
    let job = await assistantRequest('jobs', owner, { text, context, research, requestId: crypto.randomUUID() });
    const input = get('assistant-form').elements.text;
    if (input.value.trim() === text) input.value = '';
    assistantJob = { id: job.id, owner };
    get('assistant-cancel').hidden = false;
    while (job.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 500));
      job = await assistantRequest('jobs/' + job.id, owner);
      if (job.status === 'running' && (job.tools.length || job.webSearches)) {
        const sources = [...new Set(job.tools.map(tool => tool.namespace === 'pob' ? 'PoB' : 'Trade'))];
        if (job.webSearches) sources.push('веб-поиска');
        assistantStatus('Данные получены из ' + sources.join(' и '));
      }
    }
    if (job.status === 'completed') {
      showAssistantNotes(job.buildNotes, context);
      showAssistantResults(job, owner, buildVersion, researchContext);
    } else if (job.status === 'cancelled') {
      assistantStatus('Запрос отменён.');
    } else {
      assistantStatus(job.error || 'Запрос Codex завершился с ошибкой.', true);
    }
  } catch (error) {
    assistantStatus(error.message, true);
    if (error.status === 503) void refreshAssistantReadiness(true);
  } finally {
    assistantJob = undefined;
    assistantSending = false;
    get('assistant-cancel').hidden = true;
    updateAssistantControls();
  }
}

get('assistant-cancel').addEventListener('click', event => void run(event.currentTarget, async () => {
  if (assistantJob) await assistantRequest('jobs/' + assistantJob.id + '/cancel', assistantJob.owner, {});
}));

handleForm('watch-import-form', async form => {
  const watch = await api('trade_watch_import', Object.fromEntries(form));
  get('watch-import-form').reset();
  await showSavedTemplate(watch);
});

const slotLabels = {
  'Weapon 1': 'Основная рука', 'Weapon 2': 'Вторая рука',
  'Weapon 1 Swap': 'Основная рука (второй набор)', 'Weapon 2 Swap': 'Вторая рука (второй набор)',
  Helmet: 'Шлем', 'Body Armour': 'Доспех', Gloves: 'Перчатки', Boots: 'Сапоги',
  Amulet: 'Амулет', Belt: 'Пояс', 'Ring 1': 'Кольцо 1', 'Ring 2': 'Кольцо 2', 'Ring 3': 'Кольцо 3',
};

function slotLabel(slot) {
  if (Object.hasOwn(slotLabels, slot)) return slotLabels[slot];
  const flask = /^Flask (\d+)$/.exec(slot);
  if (flask) return `Флакон ${flask[1]}`;
  const jewel = /^Jewel (\d+)$/.exec(slot);
  if (jewel) return `Самоцвет (гнездо ${jewel[1]})`;
  const abyss = /^(.+) Abyssal Socket (\d+)$/.exec(slot);
  if (abyss) return `${slotLabel(abyss[1])} (гнездо Бездны ${abyss[2]})`;
  return slot;
}

function slotChoiceLabel({ slot, item }) {
  return `${slotLabel(slot)} · ${item || 'Пусто'}`;
}

function showFocusedSlot() {
  const picker = get('slot-picker');
  const entry = build?.slots.find(item => item.slot === picker.value);
  for (const [slot, { row }] of slotBudgetControls) row.hidden = row.disabled = slot !== entry?.slot;
  get('slot-budgets').hidden = !entry;

  const preview = get('slot-details');
  preview.replaceChildren();
  preview.hidden = !entry;
  if (!entry) return;
  if (!entry.item) {
    preview.append(node('p', 'Слот пуст', 'muted'));
    return;
  }
  preview.append(node('h4', entry.item));
  const { rarity, itemLevel, quality, mods = [] } = entry.details ?? {};
  const facts = [listingRarities[rarity?.toLowerCase()], itemLevel !== undefined && `Уровень предмета ${itemLevel}`,
    quality !== undefined && `Качество ${quality}%`].filter(Boolean);
  if (facts.length) preview.append(node('p', facts.join(' · '), 'muted'));
  const groups = new Map();
  for (const { type, line } of mods) {
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(line);
  }
  appendModGroups(preview, [...groups].map(([type, lines]) => ({ type, lines })));
}

function renderBuild(loaded, set) {
  build = loaded;
  showAssistantContext();
  openBuildNotes(loaded);
  get('build-title').textContent = build.label;
  const picker = get('slot-picker');
  picker.replaceChildren();
  slotBudgetControls.clear();
  const budgetFields = get('slot-budget-fields');
  budgetFields.replaceChildren();
  const slotBudgets = get('slot-budgets');
  slotBudgets.open = Boolean(set?.budgets && Object.keys(set.budgets).length);
  get('simulate-slot').replaceChildren();
  const entries = new Map(build.slots.map(entry => [entry.slot, entry]));
  const order = new Set([...(set?.slots ?? []), ...entries.keys()]);
  for (const slot of order) {
    const entry = entries.get(slot);
    if (!entry) continue;
    const label = slotChoiceLabel(entry);
    picker.add(new Option(label, slot));
    get('simulate-slot').add(new Option(label, slot));

    const override = set?.budgets && Object.hasOwn(set.budgets, entry.slot) ? set.budgets[entry.slot] : undefined;
    const row = node('fieldset');
    const fields = node('div', undefined, 'fields');
    const minimum = field('Минимум', 'slot-min', override?.min ?? '', 'number');
    const maximum = field('Максимум', 'slot-max', override?.max ?? '', 'number');
    const unit = node('label', 'Валюта цены');
    const min = minimum.querySelector('input');
    const max = maximum.querySelector('input');
    const currency = node('select');
    currency.name = 'slot-currency';
    fillCurrencies(currency, get('game').value, override ? override.currency ?? '' : inheritCurrency);
    unit.append(currency);
    min.min = max.min = '0';
    fields.append(minimum, maximum, unit);
    row.append(node('legend', slotLabel(slot)), fields);
    budgetFields.append(row);
    slotBudgetControls.set(entry.slot, { row, min, max, currency });
  }
  if (set) {
    const elements = get('build-form').elements;
    elements.mode.value = set.mode;
    elements.min.value = set.budget?.min ?? '';
    elements.max.value = set.budget?.max ?? '';
    fillCurrencies(elements.currency, set.scope.game, set.budget?.currency ?? '');
    elements['currency-only'].checked = Boolean(set.budget && set.budget.min === undefined && set.budget.max === undefined);
  }
  syncCurrencyOnly();
  get('pob-set-name').value = set?.label ?? '';
  const initialSlot = set?.slots.find(slot => entries.has(slot)) ?? build.slots.find(entry => entry.item)?.slot;
  if (initialSlot) picker.value = initialSlot;
  picker.disabled = !picker.options.length;
  showFocusedSlot();
  get('build-results').replaceChildren();
  get('simulation').hidden = true;
  get('build-form').hidden = false;
  get('simulate-form').hidden = false;
}

get('slot-picker').addEventListener('change', () => {
  slotSearchVersion++;
  showFocusedSlot();
  get('build-results').replaceChildren();
  status('');
});

let buildFileListRequest = 0;

async function refreshBuildFiles() {
  const request = ++buildFileListRequest;
  const select = get('import-file');
  const refresh = get('refresh-build-files');
  const result = get('import-file-status');
  const previous = select.value;
  refresh.disabled = true;
  select.replaceChildren(new Option('Загрузка…', ''));
  result.hidden = true;
  try {
    const files = await localRequest('/pob-build-files', undefined, undefined, 'Не удалось загрузить список билдов PoB.');
    if (request !== buildFileListRequest) return;
    const options = document.createDocumentFragment();
    options.append(new Option(files.length ? 'Выбери билд' : 'Файлы билдов не найдены', ''));
    for (const file of files) options.append(new Option(file, file));
    select.replaceChildren(options);
    if (files.includes(previous)) select.value = previous;
  } catch (error) {
    if (request !== buildFileListRequest) return;
    select.replaceChildren(new Option('Список недоступен', ''));
    result.textContent = error.message;
    result.hidden = false;
  } finally {
    if (request === buildFileListRequest) refresh.disabled = false;
  }
}

function updateBuildImportSource() {
  const fileMode = get('import-kind').value === 'file';
  get('import-text-label').hidden = fileMode;
  get('import-text').disabled = fileMode;
  get('import-file-fields').hidden = !fileMode;
  get('import-file').disabled = !fileMode;
  if (fileMode) void refreshBuildFiles();
  else buildFileListRequest++;
}

get('import-kind').addEventListener('change', updateBuildImportSource);
get('refresh-build-files').addEventListener('click', () => void refreshBuildFiles());
updateBuildImportSource();

handleForm('import-form', async form => {
  const request = ++buildRequest;
  status('Загрузка билда в PoB…');
  const loaded = await api('trade_import_build', Object.fromEntries(form));
  if (request !== buildRequest) return;
  renderBuild(loaded);
  status('');
});

handleForm('build-form', async form => {
  status('PoB формирует запрос…');
  const snapshot = build;
  const version = slotSearchVersion;
  const result = await api('trade_for_build', buildDraft(form));
  if (snapshot !== build || version !== slotSearchVersion) return;
  const target = get('build-results');
  target.className = 'cards';
  target.replaceChildren(...result.rows.map(row => {
    const card = node('article', undefined, 'card');
    card.append(node('h3', `${row.slot} · ${row.item ?? 'Пусто'}`));
    for (const warning of row.warnings) card.append(node('p', warning, 'warning'));
    if (row.link) {
      card.append(node('p', scopeSummary(row.scope), 'trade-result-scope muted'));
      const link = tradeLink(row.link);
      const inputs = [];
      if (result.mode === 'match') {
        const edits = node('div', undefined, 'fields');
        for (const group of row.body.query.stats || []) {
          for (const filter of group.filters) {
            const control = field(filter.id, filter.id, filter.value?.min ?? '', 'number');
            edits.append(control);
            inputs.push(control.querySelector('input'));
          }
        }
        if (inputs.length) card.append(edits);
      }
      const args = () => {
        const body = structuredClone(row.body);
        const filters = body.query.stats?.flatMap(group => group.filters) ?? [];
        inputs.forEach((control, index) => {
          filters[index].value ??= {};
          if (control.value === '') delete filters[index].value.min;
          else filters[index].value.min = Number(control.value);
        });
        return { scope: row.scope, body };
      };
      const offers = listingPanel(args, { buildId: result.buildId, revision: result.revision, slot: row.slot });
      const bar = node('div', undefined, 'actions');
      bar.append(offers.button, link);
      if (inputs.length) {
        let filterRevision = 0;
        const apply = action('Обновить ссылку', async () => {
          const revision = filterRevision;
          const updated = await api('trade_search', { ...args(), linkOnly: true });
          if (revision !== filterRevision) return;
          link.href = tradeLink(updated.searchUrl).href;
          link.hidden = false;
          apply.hidden = true;
        });
        apply.hidden = true;
        for (const control of inputs) control.addEventListener('input', () => {
          filterRevision++;
          offers.reset();
          link.hidden = true;
          apply.hidden = false;
        });
        bar.append(apply);
      }
      bar.append(action('Сохранить шаблон Live Search', async () => {
        await showSavedTemplate(await api('trade_watch_save', { ...args(), label: `${row.slot} · ${row.item}` }));
      }));
      card.append(bar, offers.panel);
    }
    return card;
  }));
  status('');
});

handleForm('simulate-form', async form => {
  const result = await api('trade_simulate_item', {
    buildId: build.buildId, revision: build.revision, ...Object.fromEntries(form),
  });
  get('simulation').textContent = result.report;
  get('simulation').hidden = false;
});

const stateNames = {
  active: 'Активен', connecting: 'Подключение', disconnected: 'Соединение прервано',
  paused: 'На паузе', unavailable: 'Источник недоступен',
};
async function refreshWatches() {
  const { watches, directLive } = await api('trade_watch_list');
  get('connection').textContent = directLive ? 'Live Search настроен' : 'Прямой Live Search выключен';
  get('watch-list').replaceChildren(...watches.map(watch => {
    labels.set(watch.id, watch.label);
    const card = node('article', undefined, 'card');
    card.append(node('h3', watch.label), node('p', `${watch.scope.league} · ${stateNames[watch.status] || watch.status}`));
    if (watch.reason) card.append(node('p', watch.reason, 'warning'));
    else if (!watch.body) card.append(node('p', 'Сохранена ссылка. Фильтры пока недоступны.', 'muted'));
    const running = ['active', 'connecting'].includes(watch.status);
    const bar = node('div', undefined, 'actions');
    const link = tradeLink(watch.searchUrl);
    if (!directLive && link.tagName === 'A') link.textContent = 'Открыть на PoE Trade для Live Search ↗';
    bar.append(link);
    if (running) {
      bar.append(action('Пауза', async () => {
        await api('trade_watch_stop', { watchId: watch.id });
        await refreshWatches();
      }));
    } else if (directLive) {
      bar.append(action('Активировать', async () => {
        if (!watchWindow) throw new Error('Дождись подключения к локальному сервису.');
        await api('trade_watch_resume', { watchId: watch.id }, { 'X-PoE-Trade-Window': watchWindow });
        await refreshWatches();
      }));
    }
    bar.append(action('Удалить', async () => {
      await api('trade_watch_remove', { watchId: watch.id });
      await refreshWatches();
    }, 'quiet'));
    card.append(bar);
    return card;
  }));
  if (!watches.length) get('watch-list').append(node('p', 'Сохранённых шаблонов пока нет.', 'muted'));
}

async function refreshEvents(notifyAfter) {
  let result;
  do {
    result = await api('trade_watch_events', { after: cursor, limit: 100 });
    for (const event of result.events) {
      const notify = event.eventId > notifyAfter;
      const title = labels.get(event.watchId) || 'Сохранённый поиск';
      const card = listingCard({ ...event, name: event.name || 'Новое совпадение' }, get('game').value);
      card.append(node('p', `${title} · ${new Date(event.observedAt).toLocaleString()}`), tradeLink(event.searchUrl));
      const list = get('event-list');
      list.prepend(card);
      if (list.children.length > 100) list.lastElementChild.remove();
      if (notify && page !== 'watches') {
        get('new-count').textContent = String(++unseen);
        get('new-count').hidden = false;
      }
      cursor = event.eventId;
    }
  } while (result.events.length === 100);
}

async function stream() {
  if (!token) { status('Открой приложение через Windows-лаунчер.', true); return; }
  let notifyAfter;
  while (true) {
    try {
      if (notifyAfter === undefined) {
        const initial = await api('trade_watch_events', { limit: 1 });
        notifyAfter = initial.latestCursor;
        cursor = Math.max(0, notifyAfter - 100);
      }
      const response = await fetch('/events', { headers: authorization });
      if (response.status === 401) { status('Перезапусти приложение, чтобы открыть новую сессию.', true); return; }
      if (!response.ok || !response.body) throw new Error('Не удалось получить события.');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        watchWindow = response.headers.get('X-PoE-Trade-Window');
        updateAssistantControls();
        void refreshAssistantReadiness();
        await Promise.all([refreshWatches(), refreshTradeSession()]);
        await refreshEvents(notifyAfter);
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += chunk.value;
          const messages = buffer.split('\n\n');
          buffer = messages.pop();
          for (const message of messages) {
            const payload = JSON.parse(message.slice(6));
            updates = updates.then(async () => {
              if (payload.kind === 'event') await refreshEvents(notifyAfter);
              if (payload.kind === 'state') await Promise.all([refreshWatches(), refreshTradeSession()]);
              if (payload.kind === 'heartbeat' && !get('assistant').hidden) void refreshAssistantReadiness();
            }).catch(error => status(error.message, true));
          }
        }
      } finally {
        watchWindow = undefined;
        updateAssistantControls();
        await reader.cancel().catch(() => {});
        await updates;
      }
    } catch (error) {
      if (error.status === 401) {
        status('Перезапусти приложение, чтобы открыть новую сессию.', true);
        return;
      }
      get('connection').textContent = 'Нет соединения с локальным сервисом';
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
void stream();
