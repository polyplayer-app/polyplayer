# PolyPlayer — стек и архитектура

Документ для разработчика (и для Claude в новом чате): как устроена программа, где что лежит, как собирается и выпускается.
Что программа умеет, как она дошла до текущего состояния и что в планах — в [STATUS.md](STATUS.md).

## Стек

| Часть | Технология |
|---|---|
| Программа | Electron 45 (`main.js`), Windows 10/11 x64 |
| Ядро | Node.js без внешних зависимостей (`app/server.js`): HTTP + собственный WebSocket на 127.0.0.1 |
| Окно и проигрыватель | Один HTML-файл без фреймворков и сборки (`app/public/index.html`), звук — `<audio>` + Web Audio (GainNode) |
| Плагин Stream Deck | Node.js 20 (встроенный в Stream Deck), SDK v2, без зависимостей (`plugin/com.polyplayer.deck.sdPlugin`) |
| Установщик | NSIS 3 (`installer.nsi`), MUI2, плагин WinShell (AUMID ярлыков) |
| Сборка | electron-builder 26 (`--dir`, только распаковка), resedit (значок и версия в exe), makensis |
| CI / выпуски | GitHub Actions на `windows-latest` (`.github/workflows/release.yml`) |
| Сайт | Статическая страница `docs/index.html` на GitHub Pages (`.github/workflows/pages.yml`) |
| Тесты | Node + Playwright (Chromium), Electron под Xvfb, тестовая музыка из ffmpeg (`tests/`) |
| Лицензия | GPL-3.0 |

Репозиторий: https://github.com/polyplayer-app/polyplayer (организация `polyplayer-app`, публичный).
Сайт: https://polyplayer-app.github.io/polyplayer/
Постоянная ссылка на установщик: https://github.com/polyplayer-app/polyplayer/releases/latest/download/PolyPlayer-Setup.exe

## Карта репозитория

```
main.js                      Electron: окно, трей, автозапуск, один экземпляр, горячие клавиши, обновления, плагин
app/server.js                ядро: настройки, потоки, расписание, команды, HTTP/WebSocket (createApp)
app/public/index.html        окно программы (вкладки «Потоки», «Расписание», «Настройки», справка) + движок звука
app/public/keyname.js        раскладка названия потока на кнопке Stream Deck (общий файл для окна и плагина)
app/public/help/*.png        скриншоты и картинки кнопок для справки (генерируются скриптами из tests/)
app/public/fonts/            Unbounded и Playfair Display (справка); Inter — шрифт основного окна
app/icons/                   polyplayer.ico (окно), tray.ico (трей)
plugin/com.polyplayer.deck.sdPlugin/
  manifest.json              действия плагина; Version перезаписывается при сборке = версия программы + ".0"
  bin/plugin.js              логика кнопок, рисование кнопок (SVG), удержания, выбор потока
  bin/client.js              WebSocket-клиент к программе (role=plugin), запуск программы, если она закрыта
  bin/keyname.js             копия app/public/keyname.js (копируется при сборке; в git тоже лежит копия)
  imgs/                      значки действий и картинки кнопки «PolyPlayer» (off/tray/on)
installer.nsi                установщик (UTF-8 с BOM!), per-user, без прав администратора
build/                       icon.ico, NSIS-плагин WinShell.dll
builder.json                 настройки electron-builder
patch-exe.js                 вписывает значок и версию в PolyPlayer.exe (resedit)
build.sh                     локальная сборка установщика на Linux (без wine)
.github/workflows/release.yml  выпуск: сборка + GitHub Release при новой версии в package.json
.github/workflows/pages.yml    публикация docs/ на GitHub Pages
docs/                        сайт (index.html, img/, fonts/)
tests/                       автотесты и скрипты скриншотов (см. tests/README раздел ниже)
RELEASE_NOTES.md             текст выпуска: идёт в GitHub Release и в окно обновления программы
```

## Как программа устроена во время работы

```
┌──────────────── PolyPlayer.exe (Electron main, main.js) ────────────────┐
│  трей, автозапуск, globalShortcut, обновления, один экземпляр           │
│                                                                         │
│  core = createApp()  ← app/server.js, в том же процессе                 │
│   • config.json / расписание / команды / журнал                         │
│   • HTTP + WebSocket 127.0.0.1:7777                                     │
│        ▲ role=engine          ▲ role=panel             ▲ role=plugin    │
└────────┼──────────────────────┼────────────────────────┼────────────────┘
         │                      │                        │
  BrowserWindow                 браузер (необязательно)   плагин Stream Deck
  /?engine=1                    http://127.0.0.1:7777     (отдельный процесс node
  окно + движок звука                                     внутри Stream Deck)
```

- **Ядро (`createApp` в `app/server.js`)** хранит настройки, считает расписание (тик раз в секунду), принимает команды и рассылает состояние. Само ничего не играет.
- **Движок звука** — окно Electron, открытое как `/?engine=1`. Оно же — интерфейс. Подключается по WebSocket с `role=engine` (принимается только от Electron, user-agent проверяется). Движок только один; второй такой же клиент становится панелью.
- **Панель** — тот же `index.html` в обычном браузере (`role=panel`): только интерфейс, без звука. Используется в тестах и для отладки.
- **Плагин** — пульт (`role=plugin`): получает конфиг и состояние, шлёт команды. Если программа закрыта, по нажатию кнопки запускает её из пути в `app.json` (с `--hidden`).
- Окно при закрытии крестиком прячется в трей (музыка продолжает играть). Выход — пункт трея «Выйти».

### Данные на диске

Папка данных: `%APPDATA%\PolyPlayer` (переопределяется `POLYPLAYER_DATA_DIR`).

| Файл | Что это |
|---|---|
| `config.json` | настройки: потоки, правила расписания, горячие клавиши, автозапуск. Запись атомарная (через временный файл) |
| `config.backup.json` | резервная копия; если `config.json` повреждён, берётся она, а повреждённый файл сохраняется рядом |
| `schedule-state.json` | какие запуски расписания уже сработали (чтобы не сработать дважды после перезапуска) |
| `app.json` | путь к exe и порт — для плагина |
| `log.txt`, `plugin-log.txt` | журналы программы и плагина |
| `plugin-offered.txt` | для какой версии программа уже предлагала поставить плагин |
| `%APPDATA%\PolyPlayer\electron\updates\` | скачанный установщик обновления (путь userData Electron) |

При первом запуске программа переносит настройки старой версии из `%APPDATA%\SWP Player` (если там есть `config.json`, а в новой папке ещё нет).

### Модель данных (`config.json`)

```js
{
  version: 1, port: 7777, autoOpen: true,           // autoOpen = «Запускать вместе с Windows»
  hotkeys: { stopAll: 'Ctrl+Alt+0', next: '' },      // '' = не назначена
  streams: [{
    id, name,                     // name ≤ 60 символов, пишется заглавными на кнопке пульта
    keyLayout: { name, size, lines },  // готовая раскладка названия на кнопке (считает окно по настоящему шрифту)
    folder,                       // папка с музыкой (подпапки учитываются)
    color: '#RRGGBB', volume: 0–100,
    shuffle: true, loop: true, randomStart: false,
    fadeIn: 0–30 с (3), fadeOut: 0–30 с (3), crossfade: 0–12 с (5),
    hotkey: 'Ctrl+Alt+1' | '',
    solo                          // осталось от старых версий, не используется
  }],
  schedules: [{
    id, streamId,                 // streamId '*' = «Все потоки» (только время «до»: выключить всё)
    days: [0..6],                 // 0 = воскресенье
    start: 'HH:MM' | '',          // без «с» — правило только выключает
    end:   'HH:MM' | '',          // без «до» — только включает; «до» < «с» — правило через полночь
    enabled: true
  }]
}
```

Форматы музыки: mp3, m4a, aac, wav, flac, ogg/oga, opus, webm. Папка сканируется с подпапками (до 5 уровней, до 5000 файлов).

### Протокол WebSocket

Свой минимальный WebSocket (RFC 6455) в `server.js`, сообщения — JSON с полем `t`.

- Сервер → клиенты: `hello` (роль, config, runtime, next, about, update, hotkeyStatus), `config`, `runtime`, `cmd` (только движку), `update`, `hotkeys`, `saved`, `saveError`, `folderPicked`, `ping`.
- Клиенты → сервер: `cmd` (play / pause / toggle / stop / next / seek / stopAll / volume / volumeDelta; громкость ядро сохраняет в настройках потока и рассылает новый config), `saveStream`, `deleteStream`, `moveStream`, `saveSchedules`, `saveSettings`, `keyLayouts`, `pickFolder`, `installPlugin`, `updateCmd`, `hotkeysPause`, `showWindow`/`hideWindow`/`panelPress`/`openEngine`; движок — `state` (своё состояние), `ack`, `pong`.
- Команды движку идут с `seq` и ждут `ack`. Если движок пропал (heartbeat `ping` каждые 2 с), неподтверждённые команды переотправляются после переподключения, а игравшие потоки восстанавливаются.

HTTP: `/api/state`, `/api/browse?path=`, `/api/scan?path=`, `/api/tracks/<streamId>` (`{tracks, missing}`), `/api/cmd?cmd=…&id=…` (для отладки и сторонних кнопок), `/api/open`, `/media/<streamId>/…` (файлы музыки), статика из `app/public`.

### Ключевые механизмы

- **Звук.** У каждого потока свой `<audio>` + GainNode. Плавный старт/остановка — линейные рампы громкости; переход треков — второй `<audio>` и перекрёстное затухание. Одновременно играет только один поток: при включении другого тот, что играл, ставится на паузу с затуханием (настройки «смешивать потоки» больше нет).
- **Расписание** (`tick()` в server.js, раз в секунду). Окно запуска — 60 с: если компьютер включили позже времени «с», поток не запускается (сознательно, без «догоняния»). Метка срабатывания: `id@дата_начала@streamId start-end` — если поменять время правила, оно сработает снова. Правило через полночь начинается в свой день, а заканчивается на следующий (проверяется и вчерашний день). Остановка начинается за `fadeOut` секунд до «до», чтобы к этому времени музыка затихла.
- **Горячие клавиши** (`main.js`, `globalShortcut`). Каждому потоку — переключение пуск/пауза; глобальные «Стоп всё» (только когда что-то играет) и «Следующий трек» (когда играет ровно один поток). Допустимые сочетания: минимум два модификатора, среди них Ctrl или Alt (или F13–F24 без модификаторов); проверка и в окне, и в ядре (`cleanHotkey`). Пока поле ввода сочетания в фокусе, клавиши снимаются (`hotkeysPause`). Если Windows не отдала сочетание, окно подсвечивает его красным.
- **Обновления** (`main.js`). При запуске — запрос `GET /repos/polyplayer-app/polyplayer/releases/latest`; если версия новее, окно предлагает «Скачать и обновить» (без согласия ничего не качается). Установщик скачивается в `updates/`, затем «Перезапустить» → тихая установка `/S` → программа запускается сама (`.onInstSuccess`, `--updated`). Статусы: checking / latest / available / downloading / ready / error.
- **Плагин Stream Deck.** Лежит внутри установщика (`resources/PolyPlayer.streamDeckPlugin`). Если Stream Deck установлен, а плагин не стоит или старее программы, программа один раз на версию открывает файл плагина (Stream Deck ставит его сам). Кнопка «Установить плагин» в настройках открывает его без условий.
- **Название на кнопке пульта** (`keyname.js`). Заглавными, до 2 строк, поля по 10 px; размер 21 → 13 с шагом 0,5. Окно считает раскладку по настоящему шрифту и сохраняет в `keyLayout`; плагин рисует её, а если её нет — считает приблизительно по таблице ширин. Название, которое не помещается даже при 13 px, ввести нельзя.
- **Кнопка «Поток» на пульте.** Новая кнопка сама предлагает потоки: нажать — следующий, держать 1 с — выбрать. Назначенная: нажать — пуск/пауза, держать 1 с — стоп, держать 3 с — выбрать другой поток; пока держите, кнопка показывает, что будет, если отпустить. На Stream Deck + — регулятор: поворот — громкость, нажатие — пуск/пауза, касание экрана — следующий трек.
- **Один экземпляр** (`requestSingleInstanceLock`): второй запуск просто показывает окно. Автозапуск — `setLoginItemSettings` с `--hidden`.

## Сборка и выпуск

**Выпуск делается одним коммитом:** поднять `version` (и `releaseDate`) в `package.json`, обновить `RELEASE_NOTES.md`, запушить в `main`. Workflow `Release`:

1. `npm ci` → `electron-builder --dir` → `patch-exe.js` (значок и версия в exe).
2. Копирует `keyname.js` в плагин, ставит `Version` в manifest = версия + `.0`, пакует плагин 7z в `PolyPlayer.streamDeckPlugin`, кладёт копию в `resources`.
3. `makensis /V2 /INPUTCHARSET UTF8 /DVERSION=… installer.nsi`.
4. `gh release create vX.Y.Z --target <sha>` с файлами `PolyPlayer-Setup-X.Y.Z.exe`, `PolyPlayer-Setup.exe` (постоянное имя для ссылки), `PolyPlayer.streamDeckPlugin`; текст — из `RELEASE_NOTES.md`.

Если выпуск с такой версией уже есть, workflow ничего не делает (обычные коммиты выпусков не создают). Сайт (`docs/`) публикуется отдельным workflow `Pages` при каждом пуше в `main`.

**Важно про установщик:** `installer.nsi` хранится в UTF-8 **с BOM**, makensis вызывается с `/INPUTCHARSET UTF8`. Без этого makensis на Windows читает русский текст в cp1252 и в окнах установщика кракозябры (issue #1, исправлено в 1.0.1).

**Локально (Linux, без Windows):** `./build.sh` — та же сборка, makensis для Linux из кэша electron-builder (`~/.cache/electron-builder/nsis-3.0.4.1/`). Подписи кода нет — Windows показывает SmartScreen.

## Тесты

`tests/run.sh` — все автотесты (нужны `npm ci`, Playwright с Chromium, ffmpeg, xvfb-run). Тестовая музыка создаётся `tests/make-media.sh` (тоны, в `tests/media/`, не в git). Журналы и скриншоты — в `tests/out/`.

| Тест | Что проверяет |
|---|---|
| `ui.js` | окно обновления, строка версии, названия на кнопках |
| `hotkeys.js` | ввод сочетаний, запреты, дубликаты, занятые сочетания, сохранение |
| `midnight.js` | правило через полночь |
| `missing.js` | «Папка не найдена» / «В папке нет треков», нет лишних меток на карточках |
| `sched-edit.js` | правка правил расписания, повторное срабатывание после смены времени |
| `choose.js` | плагин: выбор потока на новой кнопке, удержания |
| `robust.js` | повреждённый конфиг, резервная копия, переподключения |
| `app.js` | движок в браузере: старт/пауза/затухание, один поток, переходы, расписание |
| `freeze.js` | потеря и восстановление движка, повтор команд |
| `e2e-electron.js` | настоящее приложение Electron + плагин + мок Stream Deck + фальшивый сервер обновлений |

Скрипты картинок: `helpshots.js` (скриншоты справки → `app/public/help`), `keyshots.js` (кнопки для справки), `site-app-shots.js` (окно программы для сайта → `docs/img`), `landing-keys.js` (кнопки для сайта).

Переменные окружения для тестов: `POLYPLAYER_DATA_DIR`, `POLYPLAYER_PORT`, `POLYPLAYER_UPDATE_API`, `POLYPLAYER_UPDATE_REPO`. Electron в контейнере: `env -u NODE_OPTIONS xvfb-run -a electron . --no-sandbox --disable-gpu`.

Не покрыто автотестами (проверять руками на Windows): `globalShortcut`, настоящий Stream Deck, установщик с окнами, SmartScreen, автозапуск.

## Сайт

`docs/index.html` — одна страница, без сборки. Шрифты свои (`docs/fonts`): Unbounded — весь текст, Playfair Display bold italic — акцент только в главном заголовке («многопоточный аудиоплеер») и в «Попробуйте *PolyPlayer*». Цвета: графит + коралл (`--acc`, градиент `--grad`). Версия и дата под кнопкой подгружаются из GitHub API. Картинки в `docs/img` (окно программы, кнопки, фото Stream Deck Mini с нашими кнопками, og.png 1200×630).

Неразрывные пробелы ставятся скриптом (после коротких предлогов и союзов, перед тире), не вручную.
