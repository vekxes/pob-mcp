# Установка PoE Trade Companion и MCP

В репозитории находятся настольное приложение для Windows и два MCP-сервера. **Path of Building MCP** читает XML-билды и выполняет расчёты через движок PoB. **PoE Trade MCP** работает с теми же торговыми запросами, комплектами и шаблонами Live Search, что и приложение. Можно установить компоненты по отдельности.

## 1. Получить исходники и собрать проект

Установите Git и Node.js 24 LTS с npm. На Windows откройте новый PowerShell после установки, чтобы команды появились в `PATH`. [Git](https://git-scm.com/install) · [Node.js](https://nodejs.org/en/download)

```powershell
git clone --branch feat/local-trade-companion https://github.com/vekxes/pob-mcp.git
Set-Location pob-mcp
node --version
npm ci
npm run build
```

Сборка создаёт `build/index.js` для PoB MCP и `build/trade/mcp.js` для Trade MCP. Храните репозиторий в постоянной папке. Ярлык и конфигурация клиента используют абсолютные пути.

## 2. Запустить настольное приложение

Из корня репозитория выполните следующую команду. Она создаёт ярлык **PoE Trade** на рабочем столе текущего пользователя.

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\apps\trade-desktop\Install-TradeShortcut.ps1
```

1. Запустите **PoE Trade** двойным щелчком. Первый запуск загружает закреплённую версию Electron. Можно также запустить приложение командой `npm run trade:open`.
2. Откройте **Настройки → Сессия PoE Trade → Войти в Path of Exile**. Войдите во встроенном браузере на официальном сайте. Приложение использует эту сессию и после перезапуска, пока она действует.
3. В **Настройки → Лига с торгового сайта** выберите игру, платформу и лигу. Кнопка **Обновить лиги** перечитывает актуальный список у PoE Trade.
4. Во вкладке **Live Search** вставьте URL выполненного поиска с официального сайта и импортируйте шаблон. Нажмите **Активировать**, чтобы получать события, и **Пауза**, чтобы остановить подписку. Сохранённый шаблон после перезапуска можно активировать снова.

Закрытие окна оставляет значок в трее. Для полного завершения выберите **Остановить сервис и выйти** в меню трея или запустите `npm run trade:stop` из корня репозитория. [Руководство по приложению](../apps/trade-desktop/README.md)

## 3. Подготовить движок Path of Building

Для чтения сохранённых XML через PoB MCP достаточно указать папку билдов через `POB_DIRECTORY`. Для расчётов, сравнения предметов и взвешенного поиска для слота потребуется движок PoB для PoE 1. Используйте версию исходников, совместимую с проверяемым билдом.

Склонируйте исходники PoB рядом с `pob-mcp`:

```powershell
git clone https://github.com/PathOfBuildingCommunity/PathOfBuilding.git ..\PathOfBuilding
```

Для Windows x64 установите MSYS2 и откройте терминал **MSYS2 UCRT64**. После первого обновления повторите его в новом терминале, если установщик попросил закрыть текущий.

```sh
pacman -Syu
pacman -S --needed mingw-w64-ucrt-x86_64-luajit
```

[Установка MSYS2](https://www.msys2.org/) · [Пакет LuaJIT для UCRT64](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-luajit) · [PoB 2.68.0, использованный при проверке](https://github.com/PathOfBuildingCommunity/PathOfBuilding/commit/07fa089)

В PowerShell из корня `pob-mcp` проверьте пути и совместимость интерпретатора:

```powershell
$env:POB_PATH = (Resolve-Path ..\PathOfBuilding\src).Path
$env:POB_CMD = 'C:\msys64\ucrt64\bin\luajit.exe'
Test-Path (Join-Path $env:POB_PATH 'HeadlessWrapper.lua')
& $env:POB_CMD -bl (Join-Path $env:POB_PATH 'Modules/Main.lua') | Out-Null
```

Первый результат должен быть `True`, а LuaJIT должен завершиться с кодом 0. При установке MSYS2 в другую папку укажите её путь. Чтобы запуск из ярлыка также находил LuaJIT, сохраните путь как пользовательскую переменную Windows:

```powershell
[Environment]::SetEnvironmentVariable('POB_CMD', $env:POB_CMD, 'User')
```

Перезапустите приложение через ярлык. Если старый процесс ещё работает, завершите его из трея. В **Настройки → Path of Building** укажите папку с XML-билдами и папку движка. Во вкладке **Комплект PoB** выберите билд, слот и бюджет. Кнопка **Создать поиск по выбранному слоту** сформирует запрос PoE Trade. [Настройка Lua для macOS и Linux](../README.md#setting-up-the-lua-bridge)

## 4. Подключить MCP к Codex

В приложении откройте **Настройки → Локальные MCP в Codex**, выберите `config.toml`, отметьте **Path of Building** и **PoE Trade**. Проверьте предпросмотр и нажмите **Записать в config.toml**. Приложение создаст резервную копию рядом с существующим файлом. После записи откройте новый сеанс Codex.

Для ручной установки добавьте следующие секции в пользовательский `~/.codex/config.toml` или в `config.toml` вашего `CODEX_HOME`, если он задан. Замените пути на свои. Одинарные кавычки TOML позволяют записывать обратные косые черты Windows без экранирования.

```toml
[mcp_servers.pob]
command = 'node'
args = ['C:\Projects\pob-mcp\build\index.js']

[mcp_servers.pob.env]
POB_DIRECTORY = 'C:\Users\you\Documents\Path of Building\Builds'
POB_LUA_ENABLED = 'true'
POB_PATH = 'C:\Projects\PathOfBuilding\src'
POB_CMD = 'C:\msys64\ucrt64\bin\luajit.exe'

[mcp_servers.trade]
command = 'node'
args = ['C:\Projects\pob-mcp\build\trade\mcp.js']
```

Для PoB MCP в режиме XML оставьте только `POB_DIRECTORY` в секции окружения. Если клиент не находит `node`, задайте абсолютный путь к `node.exe`. Для Trade MCP запустите настольное приложение, чтобы сервер использовал его авторизованную сессию. При запуске MCP без приложения локальный сервис поднимается по запросу. Если задаёте `POE_TRADE_HOME` или `POE_TRADE_PORT`, используйте одинаковые значения для приложения и Trade MCP. [Документация Codex по MCP](https://developers.openai.com/codex/mcp)

Проверьте регистрацию командой `codex mcp list`. В новом сеансе попросите вызвать `list_builds` через `pob` и `trade_watch_list` через `trade`. Второй вызов вернёт пустой список, пока в текущем профиле нет шаблонов. Для сквозной проверки попросите импортировать тестовый PoB-билд через `trade_import_build`, выбрать один экипированный слот и создать для него запрос через `trade_for_build`. Имена лиг можно получить через `trade_list_leagues`.

Боковому **Чату Codex** нужен установленный и авторизованный CLI. Выполните `codex login`, затем укажите исполняемый файл в **Настройки → Codex CLI**. После успешной проверки `codex login status` в шапке приложения появится кнопка чата. [Как использовать помощника](../apps/trade-desktop/README.md#помощник-codex) · [Примеры запросов и исследование билдов](assistant-poe-research.md)

## 5. Подключить MCP к Claude Desktop или другому stdio-клиенту

Добавьте оба сервера в конфигурацию клиента. У Claude Desktop на Windows это `%APPDATA%\Claude\claude_desktop_config.json`. Сохраните уже существующие записи. Обратную косую черту в JSON записывайте как `\\` или используйте прямую косую черту, как в примере.

```json
{
  "mcpServers": {
    "pob": {
      "command": "node",
      "args": ["C:/Projects/pob-mcp/build/index.js"],
      "env": {
        "POB_DIRECTORY": "C:/Users/you/Documents/Path of Building/Builds",
        "POB_LUA_ENABLED": "true",
        "POB_PATH": "C:/Projects/PathOfBuilding/src",
        "POB_CMD": "C:/msys64/ucrt64/bin/luajit.exe"
      }
    },
    "trade": {
      "command": "node",
      "args": ["C:/Projects/pob-mcp/build/trade/mcp.js"]
    }
  }
}
```

После изменения конфигурации перезапустите клиент. Оба процесса подключаются по stdio. HTTP-порт `127.0.0.1:48217` используется внутри Trade Companion. Перечень инструментов доступен через стандартный запрос MCP `tools/list`. [Инструменты PoB MCP](../README.md#available-tools)

## Обновление и диагностика

- Для обновления выполните `git pull --ff-only`, `npm ci` и `npm run build`. Перезапустите приложение и клиент MCP. При переносе папки переустановите ярлык и обновите абсолютные пути в конфигурации MCP.
- Настройки, сохранённые комплекты, шаблоны и логи приложения находятся в `%LOCALAPPDATA%\PoELocalTrade` по умолчанию. Для диагностики запуска и торговых запросов откройте `service.log` в этой папке. Храните браузерный профиль и файл `connection.json` локально.
- Если PoB MCP видит список билдов, но не выполняет расчёты, проверьте `POB_LUA_ENABLED`, версию движка и `POB_CMD`. Для GUI проверьте выбранную папку движка в настройках и доступность LuaJIT из процесса приложения.
- Если торговый сайт вернул ошибку входа или ограничения запросов, проверьте авторизацию и выбранную лигу. Откройте поиск по сгенерированной ссылке, если встроенная загрузка лотов временно недоступна.

Из чистой копии командой `npm run test:ci` можно проверить Jest-тесты. После сборки `node tests/smoke/local-trade.mjs` проверяет сохранение подписок и событий на тестовых данных. Для проверки Trade MCP, приложения и Live Search запустите `npm run test:smoke:local-trade` с настроенным `POB_PATH` и `POB_CMD`. Для проверки PoB MCP запустите `npm run test:smoke` с теми же путями.
