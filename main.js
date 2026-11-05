// PolyPlayer — настольное приложение (Electron): несколько музыкальных потоков, расписание, пульт Stream Deck.
// Внутри: сервер (потоки, расписание, связь с пультом Stream Deck) и окно-проигрыватель.
// Окно и значок в трее принадлежат самой программе: крестик прячет окно в трей, музыка продолжает играть.
'use strict';

const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, shell, powerMonitor, net, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { createApp } = require('./app/server.js');

const START_HIDDEN = process.argv.includes('--hidden');
const ICON = path.join(__dirname, 'app', 'icons', 'polyplayer.ico');
const TRAY_ICON = path.join(__dirname, 'app', 'icons', 'tray.ico');
const ICON_PNG = path.join(__dirname, 'app', 'public', 'icon-v3-256.png');

// ---------- один экземпляр программы ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// служебные файлы Electron (кэш и т.п.) — в отдельной подпапке, рядом с настройками PolyPlayer
app.setPath('userData', path.join(app.getPath('appData'), 'PolyPlayer', 'electron'));
app.setAppUserModelId('com.polyplayer.app'); // свой значок и группа на панели задач Windows
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let win = null;
let tray = null;
let core = null;
let quitting = false;
let trayHintShown = false;

// ---------- «трей» для сервера: показать/спрятать окно, выбрать папку ----------
const trayProvider = new EventEmitter();
trayProvider.available = true;
trayProvider.status = 'none';
function setStatus() {
  const st = !win || win.isDestroyed() ? 'none' : (win.isVisible() && !win.isMinimized() ? 'visible' : 'hidden');
  if (st !== trayProvider.status) {
    trayProvider.status = st;
    trayProvider.emit('status', st);
    trayProvider.emit('change');
    updateTrayMenu();
  }
}
trayProvider.show = () => { showWindow(); return true; };
trayProvider.hide = () => { hideWindow(); return true; };
trayProvider.kick = () => { if (win && !win.isDestroyed()) win.webContents.invalidate(); return true; };
trayProvider.closeWindow = () => { hideWindow(); return true; };
trayProvider.stop = () => true;
trayProvider.pickFolder = async (initial) => {
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
  const r = await dialog.showOpenDialog(parent, {
    title: 'Выберите папку с музыкой для потока',
    defaultPath: initial && fs.existsSync(initial) ? initial : app.getPath('music'),
    properties: ['openDirectory']
  });
  return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
};

// ---------- окно ----------
function createWindow(show) {
  win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'PolyPlayer',
    icon: ICON,
    backgroundColor: '#0C0D10',
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false, // звук и таймеры работают и в свёрнутом окне
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadURL('http://127.0.0.1:' + core.snapshot().port + '/?engine=1');
  win.once('ready-to-show', () => { if (show) { win.show(); win.focus(); } setStatus(); });
  win.on('show', setStatus);
  win.on('hide', setStatus);
  win.on('minimize', setStatus);
  win.on('restore', setStatus);
  win.on('page-title-updated', (e) => e.preventDefault());
  // крестик — не выход, а «спрятать в трей»: музыка продолжает играть
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideWindow();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      try {
        tray.displayBalloon({ iconType: 'info', title: 'PolyPlayer работает', content: 'Программа спрятана в значок возле часов, музыка продолжает играть. Выйти — правый клик по значку → «Выйти».' });
      } catch (err) { /* не во всех версиях Windows */ }
    }
  });
  // если проигрыватель «упал» — перезагружаем его
  win.webContents.on('render-process-gone', (e, details) => {
    core.log('Renderer gone: ' + (details && details.reason));
    setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 1000);
  });
  win.webContents.on('unresponsive', () => core.log('Renderer unresponsive'));
  // ссылки наружу — в обычный браузер
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(true); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  setStatus();
}

function hideWindow() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  setStatus();
}

// ---------- значок в трее ----------
let trayPlaying = false;
function isPlaying() { return !!core && Object.values(core.snapshot().runtime || {}).some((r) => r && r.state === 'playing'); }
function updateTrayMenu() {
  if (!tray) return;
  const visible = trayProvider.status === 'visible';
  trayPlaying = isPlaying();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Спрятать окно' : 'Открыть PolyPlayer', click: () => (visible ? hideWindow() : showWindow()) },
    { label: 'Стоп всё (плавно)', enabled: trayPlaying, click: () => core.command({ cmd: 'stopAll' }) },
    { type: 'separator' },
    { label: 'Выйти', click: quitApp }
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip('PolyPlayer');
  tray.on('click', () => (trayProvider.status === 'visible' ? hideWindow() : showWindow()));
  updateTrayMenu();
}

function quitApp() {
  if (quitting) return;
  quitting = true;
  try { core.command({ cmd: 'stopAll', fade: 0.6 }); } catch (e) { /* ignore */ }
  setTimeout(async () => {
    try { await core.stop(); } catch (e) { /* ignore */ }
    app.quit();
  }, 900);
}

// ---------- автозапуск вместе с Windows ----------
function applyAutostart() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  const want = core.snapshot().config.autoOpen !== false;
  try {
    app.setLoginItemSettings({ openAtLogin: want, path: process.execPath, args: ['--hidden'] });
  } catch (e) { core.log('Autostart error: ' + e.message); }
}

// ---------- обновления через GitHub Releases ----------
// При запуске программа проверяет, вышла ли новая версия (ничего не скачивая), и сообщает об этом в окне.
// Пользователь соглашается — установщик скачивается (видно, сколько скачано), потом окно «нужно перезапустить».
// Установка — только когда музыка не играет. Проверить вручную можно в «Настройках».
const UPDATE_REPO = process.env.POLYPLAYER_UPDATE_REPO || (() => { try { return require('./package.json').updateRepo || ''; } catch (e) { return ''; } })();
const UPDATE_API = process.env.POLYPLAYER_UPDATE_API || 'https://api.github.com'; // для тестов
const RELEASES_URL = UPDATE_REPO ? 'https://github.com/' + UPDATE_REPO + '/releases' : '';
// status: off | idle | checking | latest | available | downloading | ready | error
const upd = { current: app.getVersion(), status: UPDATE_REPO ? 'idle' : 'off', version: '', progress: 0, got: 0, total: 0, error: '', file: '', checkedAt: '', notes: '', url: '', dismissed: '', asset: null };
let updChecking = false, updDownloading = false;
const updPublic = () => ({ current: upd.current, status: upd.status, version: upd.version, progress: upd.progress, got: upd.got, total: upd.total, error: upd.error, checkedAt: upd.checkedAt, notes: upd.notes, url: upd.url, dismissed: upd.dismissed });
function updSet(patch) { Object.assign(upd, patch); if (core) core.setUpdate(updPublic()); }
function newer(a, b) { // a > b ?
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
const updDir = () => path.join(app.getPath('userData'), 'updates');

async function checkForUpdate(manual) {
  if (!UPDATE_REPO || updChecking || updDownloading || upd.status === 'ready') { if (manual) updSet({}); return; }
  updChecking = true;
  const before = upd.status;
  if (manual) updSet({ status: 'checking', error: '' });
  try {
    const r = await net.fetch(UPDATE_API + '/repos/' + UPDATE_REPO + '/releases/latest', { headers: { 'User-Agent': 'PolyPlayer', Accept: 'application/vnd.github+json' } });
    const now = new Date().toISOString();
    if (r.status === 404) { updSet({ status: 'latest', error: '', checkedAt: now, url: RELEASES_URL }); return; } // выпусков ещё нет
    if (!r.ok) throw new Error('GitHub ответил ' + r.status);
    const rel = await r.json();
    const ver = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => /^PolyPlayer-Setup-.*\.exe$/i.test(a.name));
    if (!ver || !asset || !newer(ver, upd.current)) {
      updSet({ status: 'latest', version: '', error: '', checkedAt: now, url: RELEASES_URL + '/tag/v' + upd.current }); // «Что нового» — про установленную версию
      return;
    }
    const file = path.join(updDir(), asset.name);
    const already = fs.existsSync(file) && fs.statSync(file).size === asset.size;
    if (ver !== upd.version) upd.dismissed = '';
    core.log('Update available: ' + ver + (already ? ' (already downloaded)' : ''));
    updSet({ status: already ? 'ready' : 'available', version: ver, asset, file, total: asset.size, got: already ? asset.size : 0, progress: already ? 100 : 0, error: '', checkedAt: now, notes: String(rel.body || ''), url: rel.html_url || (RELEASES_URL + '/tag/v' + ver) });
  } catch (e) {
    core.log('Update check failed: ' + e.message);
    updSet({ status: manual ? 'error' : (before === 'checking' ? 'idle' : before), error: manual ? e.message : '', checkedAt: new Date().toISOString() });
  } finally { updChecking = false; }
}

async function downloadUpdate() {
  if (updDownloading || upd.status !== 'available' || !upd.asset) return;
  updDownloading = true;
  const asset = upd.asset, file = upd.file;
  updSet({ status: 'downloading', got: 0, total: asset.size, progress: 0, error: '' });
  core.log('Downloading update ' + upd.version);
  try {
    fs.mkdirSync(updDir(), { recursive: true });
    const d = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'PolyPlayer' } });
    if (!d.ok || !d.body) throw new Error('загрузка не удалась (' + d.status + ')');
    const tmp = file + '.part';
    const out = fs.createWriteStream(tmp);
    const reader = d.body.getReader();
    let got = 0, lastSent = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
      if (Date.now() - lastSent > 400) { lastSent = Date.now(); updSet({ got, progress: Math.floor(got * 100 / (asset.size || 1)) }); }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    if (asset.size && fs.statSync(tmp).size !== asset.size) throw new Error('файл скачался не полностью');
    fs.renameSync(tmp, file);
    for (const f of fs.readdirSync(updDir())) if (f !== asset.name) { try { fs.unlinkSync(path.join(updDir(), f)); } catch (e) { /* ignore */ } }
    core.log('Update ' + upd.version + ' downloaded');
    updSet({ status: 'ready', got: asset.size, progress: 100 });
  } catch (e) {
    core.log('Update download failed: ' + e.message);
    updSet({ status: 'available', error: 'не удалось скачать: ' + e.message, got: 0, progress: 0 });
  } finally { updDownloading = false; }
}

function installUpdate() {
  if (upd.status !== 'ready' || !upd.file || !fs.existsSync(upd.file)) return;
  if (isPlaying()) { core.log('Update install refused: music is playing'); return; }
  core.log('Installing update ' + upd.version);
  try {
    // тихая установка: установщик закроет программу, обновит файлы и сам запустит её снова
    const child = spawn(upd.file, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) { updSet({ status: 'error', error: e.message }); return; }
  quitting = true;
  setTimeout(async () => { try { await core.stop(); } catch (e) { /* ignore */ } app.quit(); }, 300);
}

// ---------- плагин Stream Deck: ставим или обновляем вместе с программой ----------
// Плагин лежит внутри программы. Если на компьютере есть Stream Deck, а плагин не стоит или он старее программы,
// программа один раз (для каждой версии) открывает файл плагина — Stream Deck ставит его поверх старого.
const BUNDLED_PLUGIN = path.join(process.resourcesPath || __dirname, 'PolyPlayer.streamDeckPlugin');
function openBundledPlugin() {
  if (!fs.existsSync(BUNDLED_PLUGIN)) return;
  core.log('Opening bundled Stream Deck plugin');
  shell.openPath(BUNDLED_PLUGIN).then((err) => { if (err) core.log('Plugin open error: ' + err); });
}
function offerStreamDeckPlugin() {
  try {
    if (!app.isPackaged || process.platform !== 'win32') return;
    const bundled = BUNDLED_PLUGIN;
    const sdRoot = path.join(app.getPath('appData'), 'Elgato', 'StreamDeck');
    if (!fs.existsSync(bundled) || !fs.existsSync(sdRoot)) return; // Stream Deck не установлен
    let installed = '';
    try { installed = JSON.parse(fs.readFileSync(path.join(sdRoot, 'Plugins', 'com.polyplayer.deck.sdPlugin', 'manifest.json'), 'utf8')).Version || ''; } catch (e) { /* не стоит */ }
    if (installed && !newer(app.getVersion(), installed)) return; // уже свежий
    const mark = path.join(core.dataDir, 'plugin-offered.txt');
    let offered = ''; try { offered = fs.readFileSync(mark, 'utf8').trim(); } catch (e) { /* ignore */ }
    if (offered === app.getVersion()) return; // уже предлагали для этой версии
    fs.writeFileSync(mark, app.getVersion());
    core.log('Stream Deck plugin ' + (installed || 'not installed') + ' → opening bundled ' + app.getVersion());
    shell.openPath(bundled).then((err) => { if (err) core.log('Plugin open error: ' + err); });
  } catch (e) { core.log('Plugin offer error: ' + e.message); }
}

// ---------- горячие клавиши ----------
// Работают во всей системе, даже когда окно спрятано. Назначает их пользователь (по умолчанию — никаких).
// Если сочетание уже занято другой программой, Windows его не отдаст — окно покажет предупреждение.
let hotkeysPaused = false;
let hotkeysKey = '';
function hotkeyMap() {
  const cfg = core.snapshot().config;
  const map = [];
  for (const st of cfg.streams || []) if (st.hotkey) map.push({ acc: st.hotkey, run: () => core.command({ cmd: 'toggle', id: st.id }) });
  const hk = cfg.hotkeys || {};
  if (hk.stopAll) map.push({ acc: hk.stopAll, run: () => { if (isPlaying()) core.command({ cmd: 'stopAll' }); } });
  if (hk.next) map.push({
    acc: hk.next,
    run: () => {
      const rt = core.snapshot().runtime || {};
      const playing = Object.keys(rt).filter((id) => rt[id] && rt[id].state === 'playing');
      if (playing.length === 1) core.command({ cmd: 'next', id: playing[0] }); // как на пульте: только когда играет один поток
    }
  });
  return map;
}
function applyHotkeys(force) {
  if (!core) return;
  const map = hotkeysPaused ? [] : hotkeyMap();
  const key = JSON.stringify(map.map((m) => m.acc)) + (hotkeysPaused ? 'p' : '');
  if (key === hotkeysKey && !force) return;
  hotkeysKey = key;
  try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  const failed = [];
  const seen = new Set();
  for (const m of map) {
    if (seen.has(m.acc)) continue; // одно сочетание — одно действие (повторы окно не даст сохранить)
    seen.add(m.acc);
    let ok = false;
    try { ok = globalShortcut.register(m.acc, m.run); } catch (e) { ok = false; }
    if (!ok) failed.push(m.acc);
  }
  if (failed.length) core.log('Hotkeys not available (used by another program): ' + failed.join(', '));
  if (!hotkeysPaused) core.setHotkeyStatus({ failed });
}

// ---------- перенос настроек из старой версии (SWP Player) ----------
// потоки и расписание лежали в %APPDATA%\SWP Player — при первом запуске копируем их в %APPDATA%\PolyPlayer
function migrateOldSettings() {
  if (process.env.POLYPLAYER_DATA_DIR) return '';
  const appData = app.getPath('appData');
  const oldDir = path.join(appData, 'SWP Player');
  const newDir = path.join(appData, 'PolyPlayer');
  try {
    if (fs.existsSync(path.join(newDir, 'config.json')) || !fs.existsSync(path.join(oldDir, 'config.json'))) return '';
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ['config.json', 'config.backup.json', 'schedule-state.json']) {
      if (fs.existsSync(path.join(oldDir, f))) fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f));
    }
    return 'Settings copied from ' + oldDir;
  } catch (e) { return 'Settings migration error: ' + e.message; }
}

// ---------- запуск ----------
app.whenReady().then(async () => {
  const migrated = migrateOldSettings();
  core = createApp({
    isApp: true,
    dataDir: process.env.POLYPLAYER_DATA_DIR || undefined, // для тестов
    port: process.env.POLYPLAYER_PORT ? parseInt(process.env.POLYPLAYER_PORT, 10) : undefined,
    trayProvider,
    about: { version: app.getVersion(), date: (() => { try { return require('./package.json').releaseDate || ''; } catch (e) { return ''; } })(), plugin: fs.existsSync(BUNDLED_PLUGIN) },
    autoOpen: false, // окно создаём сами
    launchHook: (hidden) => {
      if (!win || win.isDestroyed()) createWindow(!hidden);
      else if (!hidden) showWindow();
    }
  });
  try {
    await core.start();
  } catch (e) {
    dialog.showErrorBox('PolyPlayer', 'Не удалось запустить PolyPlayer: ' + e.message);
    app.quit();
    return;
  }
  // плагин Stream Deck находит программу по этому файлу (и может сам её запустить)
  try {
    fs.writeFileSync(path.join(core.dataDir, 'app.json'), JSON.stringify({ exe: process.execPath, port: core.snapshot().port, pid: process.pid, version: app.getVersion() }, null, 2));
  } catch (e) { core.log('app.json error: ' + e.message); }
  core.log('PolyPlayer app ' + app.getVersion() + ' started' + (START_HIDDEN ? ' (hidden)' : ''));
  if (migrated) core.log(migrated);

  createTray();
  createWindow(!START_HIDDEN);
  applyAutostart();
  core.on('change', (kind) => {
    if (kind === 'config') { applyAutostart(); applyHotkeys(); }
    if (kind === 'runtime' && isPlaying() !== trayPlaying) updateTrayMenu(); // «Стоп всё» в меню — только когда что-то играет
  });
  core.on('installPlugin', openBundledPlugin);
  core.on('hotkeysPause', (on) => { hotkeysPaused = !!on; applyHotkeys(); });
  applyHotkeys(true);
  core.on('updateCmd', (cmd) => {
    if (cmd === 'install') installUpdate();
    else if (cmd === 'download') downloadUpdate();
    else if (cmd === 'later') updSet({ dismissed: upd.version }); // окно «вышла версия» больше не показываем до следующего запуска
    else checkForUpdate(true);
  });
  core.setUpdate(updPublic());
  setTimeout(() => checkForUpdate(false), process.env.POLYPLAYER_UPDATE_API ? 1500 : 3000);
  setTimeout(offerStreamDeckPlugin, 4000);
  powerMonitor.on('resume', () => {
    core.log('System resumed');
    setTimeout(() => { if (win && !win.isDestroyed() && win.webContents.isCrashed()) win.reload(); }, 2000);
  });
});

// второй запуск (ярлык, кнопка пульта) — показываем уже открытую программу
app.on('second-instance', (e, argv) => {
  if (!argv.includes('--hidden')) showWindow();
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ } });
app.on('window-all-closed', (e) => { /* остаёмся в трее */ });
