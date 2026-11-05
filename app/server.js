// PolyPlayer — сервер: настройки, потоки, расписание, раздача медиа, связь с окном-проигрывателем и пультом.
// Без внешних зависимостей (только Node.js). Работает внутри программы PolyPlayer (Electron, main.js),
// которая передаёт сюда своё окно и трей (opts.trayProvider, opts.launchHook).
// Для проверки можно запустить отдельно:  node server.js [--port 7777] [--data <папка>]

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.webm']);
const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.webm': 'audio/webm', '.html': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const COLORS = ['#E85D2E', '#2A9D8F', '#E9B44C', '#4F86C6', '#8E5572', '#6A994E'];
const DEFAULT_PORT = 7777;
const IS_WIN = process.platform === 'win32';

function defaultDataDir() {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PolyPlayer');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'PolyPlayer');
  return path.join(os.homedir(), '.polyplayer');
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const newId = () => crypto.randomBytes(4).toString('hex');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

function atTime(base, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  const d = new Date(base);
  d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  return d.getTime();
}

// ---------- WebSocket (серверная сторона) ----------
function wsAccept(req, socket, head, onMessage, onClose) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let frags = [];
  let closed = false;

  const conn = {
    send(obj) {
      if (closed) return;
      const data = Buffer.from(JSON.stringify(obj), 'utf8');
      let header;
      if (data.length < 126) header = Buffer.from([0x81, data.length]);
      else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
      try { socket.write(Buffer.concat([header, data])); } catch (e) { /* сокет закрыт */ }
    },
    close() {
      if (closed) return;
      closed = true;
      try { socket.end(Buffer.from([0x88, 0])); } catch (e) { /* ignore */ }
    }
  };

  function parse() {
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      const p = Buffer.from(buf.slice(off, off + len));
      if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      buf = buf.slice(off + len);
      if (op === 0x8) { conn.close(); socket.destroy(); return; }
      if (op === 0x9) { if (p.length < 126) socket.write(Buffer.concat([Buffer.from([0x8A, p.length]), p])); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x0) {
        frags.push(p);
        if (fin) {
          const text = Buffer.concat(frags).toString('utf8');
          frags = [];
          let msg = null;
          try { msg = JSON.parse(text); } catch (e) { continue; }
          onMessage(msg, conn);
        }
      }
    }
  }

  socket.on('data', (d) => { buf = Buffer.concat([buf, d]); parse(); });
  socket.on('close', () => { closed = true; onClose(conn); });
  socket.on('error', () => { /* закрытие обработает 'close' */ });
  setImmediate(() => { if (buf.length) parse(); });
  return conn;
}

// ---------- Файлы ----------
function scanFolder(dir) {
  const out = [];
  if (!dir) return out;
  function walk(d, depth) {
    if (depth > 5 || out.length > 5000) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  }
  walk(dir, 0);
  out.sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  return out;
}

function browse(p) {
  const shortcuts = [];
  const home = os.homedir();
  for (const [name, sub] of [['Музыка', 'Music'], ['Рабочий стол', 'Desktop'], ['Документы', 'Documents'], ['Загрузки', 'Downloads']]) {
    const full = path.join(home, sub);
    if (fs.existsSync(full)) shortcuts.push({ name, path: full });
  }
  if (IS_WIN && fs.existsSync('C:\\')) shortcuts.push({ name: 'Диск C:', path: 'C:\\' });

  if (!p) p = fs.existsSync(path.join(home, 'Music')) ? path.join(home, 'Music') : home;
  p = path.resolve(p);
  let ents = [];
  let error = '';
  try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { error = 'Не удалось открыть папку'; }
  const dirs = [];
  let audio = 0;
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    if (e.isDirectory()) dirs.push({ name: e.name, path: path.join(p, e.name) });
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) audio++;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  const parent = path.dirname(p);
  return { path: p, parent: parent === p ? null : parent, dirs, audio, shortcuts, error };
}

function serveFile(req, res, file, mime) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end(); return; }
    const headers = { 'Content-Type': mime || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = 0;
      let end = st.size - 1;
      if (m && m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), st.size - 1); }
      else if (m && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); }
      if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); res.end(); return; }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
  });
}

function noTray() {
  const t = new EventEmitter();
  t.available = false;
  t.status = 'none';
  t.show = t.hide = t.kick = t.stop = () => false;
  t.pickFolder = () => Promise.resolve('');
  return t;
}

// ---------- Приложение ----------
function createApp(opts) {
  opts = opts || {};
  const app = new EventEmitter();
  const dataDir = opts.dataDir || defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const configFile = path.join(dataDir, 'config.json');
  const firedFile = path.join(dataDir, 'schedule-state.json');
  const logFile = path.join(dataDir, 'log.txt');
  const publicDir = path.join(__dirname, 'public');
  app.now = opts.now || (() => new Date());

  function log(msg) {
    const line = new Date().toISOString() + ' ' + msg + '\n';
    try {
      const st = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
      if (st && st.size > 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
      fs.appendFileSync(logFile, line);
    } catch (e) { /* ignore */ }
    if (opts.log) opts.log(msg);
  }
  app.log = log;

  // --- настройки ---
  // solo — общая настройка: играет только один поток, остальные плавно затихают (по умолчанию включено)
  // hotkeys — горячие клавиши для «Стоп всё» и «Следующий трек» (у потоков — свои, в stream.hotkey)
  let config = { version: 1, port: DEFAULT_PORT, autoOpen: true, solo: true, hotkeys: { stopAll: '', next: '' }, streams: [], schedules: [] };
  // настройки + резервная копия: если config.json повреждён, берём копию, а повреждённый файл сохраняем рядом
  const backupFile = path.join(dataDir, 'config.backup.json');
  const readJson = (f) => { const o = JSON.parse(fs.readFileSync(f, 'utf8')); if (!o || typeof o !== 'object' || !Array.isArray(o.streams)) throw new Error('bad config'); return o; };
  if (fs.existsSync(configFile)) {
    try {
      config = Object.assign(config, readJson(configFile));
      try { fs.copyFileSync(configFile, backupFile); } catch (e) { /* ignore */ }
    } catch (e) {
      const broken = path.join(dataDir, 'config.broken-' + Date.now() + '.json');
      try { fs.renameSync(configFile, broken); } catch (x) { /* ignore */ }
      try {
        config = Object.assign(config, readJson(backupFile));
        log('config.json damaged (' + e.message + ') — restored from config.backup.json, damaged file kept as ' + path.basename(broken));
        app.configRestored = true;
      } catch (x) {
        log('config.json damaged (' + e.message + ') and no usable backup — starting empty, damaged file kept as ' + path.basename(broken));
      }
    }
  }
  if (opts.port) config.port = opts.port;
  config.streams = (config.streams || []).map((x) => (x.crossfade == null ? Object.assign({}, x, { crossfade: 5 }) : x));

  let saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.writeFileSync(configFile + '.tmp', JSON.stringify(config, null, 2));
      fs.renameSync(configFile + '.tmp', configFile);
      if (config.streams.length) fs.copyFileSync(configFile, backupFile); // последняя рабочая копия
    } catch (e) { log('Save error: ' + e.message); }
  }
  function saveSoon() { if (!saveTimer) saveTimer = setTimeout(saveNow, 800); }

  let fired = {};
  try { fired = JSON.parse(fs.readFileSync(firedFile, 'utf8')); } catch (e) { /* пусто */ }
  function saveFired() { try { fs.writeFileSync(firedFile, JSON.stringify(fired)); } catch (e) { /* ignore */ } }

  const stream = (id) => config.streams.find((s) => s.id === id);

  // горячая клавиша в формате Electron: «Ctrl+Alt+1», «Ctrl+Shift+K», «F13», «Alt+num5»
  function cleanHotkey(v) {
    const k = String(v || '').trim();
    return /^(?:(?:Ctrl|Alt|Shift)\+){0,3}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|num[0-9])$/.test(k) ? k : '';
  }

  // раскладка названия на кнопке Stream Deck (её считает окно программы по настоящему шрифту)
  function cleanLayout(k, name) {
    if (!k || typeof k !== 'object' || !Array.isArray(k.lines) || !k.lines.length || k.lines.length > 2) return undefined;
    const size = Number(k.size);
    if (!(size >= 10 && size <= 30)) return undefined;
    return { name: String(k.name != null ? k.name : name), size: Math.round(size * 10) / 10, lines: k.lines.map((l) => String(l).slice(0, 60)) };
  }

  function normalizeStream(s, old) {
    const base = old || { id: newId(), color: COLORS[config.streams.length % COLORS.length], volume: 60 };
    const name = String(s.name || base.name || 'Поток').trim().slice(0, 60) || 'Поток';
    const keyLayout = cleanLayout(s.keyLayout !== undefined ? s.keyLayout : base.keyLayout, name);
    return {
      id: base.id,
      name,
      keyLayout: keyLayout && keyLayout.name === name ? keyLayout : undefined,
      folder: String(s.folder != null ? s.folder : (base.folder || '')).trim(),
      color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : base.color,
      shuffle: s.shuffle != null ? !!s.shuffle : (base.shuffle != null ? base.shuffle : true),
      loop: s.loop != null ? !!s.loop : (base.loop != null ? base.loop : true),
      solo: s.solo != null ? !!s.solo : (base.solo != null ? !!base.solo : true),
      hotkey: cleanHotkey(s.hotkey !== undefined ? s.hotkey : base.hotkey),
      randomStart: s.randomStart != null ? !!s.randomStart : !!base.randomStart,
      volume: clamp(Math.round(Number(s.volume != null ? s.volume : base.volume) || 0), 0, 100),
      fadeIn: clamp(Number(s.fadeIn != null ? s.fadeIn : (base.fadeIn != null ? base.fadeIn : 3)) || 0, 0, 30),
      fadeOut: clamp(Number(s.fadeOut != null ? s.fadeOut : (base.fadeOut != null ? base.fadeOut : 3)) || 0, 0, 30),
      crossfade: clamp(Math.round(Number(s.crossfade != null ? s.crossfade : (base.crossfade != null ? base.crossfade : 5))) || 0, 0, 12)
    };
  }

  // streamId '*' — правило «все потоки»: только время остановки
  function normalizeSchedule(s) {
    const ok = (t) => /^\d{1,2}:\d{2}$/.test(t || '');
    const all = s.streamId === '*';
    return {
      id: s.id || newId(),
      streamId: String(s.streamId || ''),
      days: Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [0],
      start: !all && ok(s.start) ? s.start : '',
      end: ok(s.end) ? s.end : '',
      enabled: s.enabled !== false
    };
  }

  // --- состояние воспроизведения (сообщает окно-движок) ---
  let runtime = {};
  let engine = null;
  const clients = new Set();
  let pending = [];
  let lastLaunch = 0;
  let hideUntil = 0;
  let actualPort = config.port;
  // окно и трей принадлежат программе (main.js) — она передаёт свою реализацию.
  // Без неё (отдельный запуск для проверки) — «пустой» трей: спрятать окно нельзя.
  const tray = opts.trayProvider || noTray();
  app.tray = tray;

  function nextSchedule() {
    const now = app.now();
    let best = null;
    for (const s of config.schedules) {
      if (!s.enabled || !(s.streamId === '*' || stream(s.streamId))) continue;
      if (s.start && s.end && s.end <= s.start) continue; // правило через полночь не срабатывает
      for (let add = 0; add < 8; add++) {
        const day = new Date(now);
        day.setDate(day.getDate() + add);
        if (!s.days.includes(day.getDay())) continue;
        // правило со стартом — показываем старт; правило «только стоп» — время остановки
        const t = s.start ? atTime(day, s.start) : atTime(day, s.end);
        if (t == null || t <= now.getTime()) continue;
        if (!best || t < best.at) best = { at: t, scheduleId: s.id, streamId: s.streamId, name: s.streamId === '*' ? 'все потоки' : stream(s.streamId).name, start: s.start, end: s.end, kind: s.start ? 'start' : 'stop' };
        break;
      }
    }
    return best;
  }

  // состояние окна-проигрывателя: off | starting | visible | hidden
  function windowState() {
    if (!engine) return Date.now() - lastLaunch < 20000 ? 'starting' : 'off';
    if (tray.available && tray.status === 'hidden') return 'hidden';
    return 'visible';
  }
  app.windowState = windowState;

  function snapshot() {
    return { config, runtime, engineOnline: !!engine, next: nextSchedule(), port: actualPort, window: windowState(), tray: !!tray.available };
  }
  app.snapshot = snapshot;

  function broadcast(obj) { for (const c of clients) c.send(obj); }
  function changed(kind) {
    const snap = snapshot();
    if (kind === 'config') broadcast({ t: 'config', config: snap.config, next: snap.next });
    broadcast({ t: 'runtime', runtime: snap.runtime, engineOnline: snap.engineOnline, tray: snap.tray, window: snap.window });
    app.emit('change', kind);
  }

  // открыть окно-проигрыватель (если ещё не открыто). hidden — сразу убрать в трей
  function launchEngine(hidden) {
    if (engine) return;
    if (Date.now() - lastLaunch < 20000) { if (!hidden) hideUntil = 0; return; } // уже запускается
    lastLaunch = Date.now();
    hideUntil = hidden && tray.available ? Date.now() + 40000 : 0;
    if (opts.launchHook) opts.launchHook(!!hidden);
    changed('window');
  }
  app.launchEngine = launchEngine;

  // кнопка «PolyPlayer»: закрыт → открыть; в трее → показать; открыт → свернуть в трей
  app.panelPress = function () {
    const st = windowState();
    if (st === 'off') launchEngine(false);
    else if (st === 'starting') hideUntil = 0;
    else if (st === 'hidden') tray.show();
    else if (tray.available) tray.hide();
    else app.emit('alert', 'Сворачивание в трей недоступно');
  };
  app.showWindow = function () {
    if (engine && tray.available) tray.show(); else launchEngine(false);
  };
  app.openPanel = app.showWindow;

  tray.on('status', (v) => {
    if (v === 'visible' && hideUntil > Date.now()) { hideUntil = 0; tray.hide(); }
  });
  tray.on('change', () => changed('window'));

  // --- команды ---
  // {cmd: play|pause|toggle|stop|next|volume|volumeDelta|stopAll, id, value, fade}
  function command(c) {
    if (!c || !c.cmd) return;
    if (c.cmd === 'volume' || c.cmd === 'volumeDelta') {
      const s = stream(c.id);
      if (!s) return;
      const v = c.cmd === 'volume' ? Number(c.value) : s.volume + Number(c.value);
      const nv = clamp(Math.round(v) || 0, 0, 100);
      if (nv === s.volume) return;
      s.volume = nv;
      saveSoon();
      changed('config');
      return;
    }
    if (c.cmd !== 'stopAll' && !stream(c.id)) return;
    const msg = { t: 'cmd', cmd: c.cmd, id: c.id };
    if (c.fade != null) msg.fade = Number(c.fade);
    if (c.cmd === 'seek') { msg.value = Number(c.value) || 0; if (!engine) return; }
    if (engine && engineResponsive()) { sendCmd(msg); return; }
    if (engine) { // окно есть, но не отвечает (браузер «усыпил» страницу) — будим и ставим в очередь
      pending.push(Object.assign({ queuedAt: Date.now() }, msg));
      wakeEngine('command');
      return;
    }
    if (c.cmd === 'stopAll' || c.cmd === 'pause' || c.cmd === 'stop') return; // нечего останавливать
    pending.push(Object.assign({ queuedAt: Date.now() }, msg));
    // команды кнопок и расписания открывают проигрыватель сразу в трее — окно показывается только вручную
    launchEngine(true);
  }
  app.command = command;

  // --- проверка, что окно-проигрыватель живо (браузер может «заморозить» скрытую страницу) ---
  const instance = crypto.randomBytes(3).toString('hex');
  let cmdSeq = 0;
  const unacked = new Map(); // seq -> msg
  let lastPong = 0;
  let lastWake = 0;
  let stopping = false;
  let reparkAfterWake = false;
  let stuckSince = 0;   // когда окно перестало отвечать
  let escalated = false;
  function engineResponsive() { return Date.now() - lastPong < 8000; }
  function sendCmd(msg) {
    // повторная отправка идёт с тем же номером — окно выполнит команду только один раз
    const m = { t: 'cmd', cmd: msg.cmd, id: msg.id, seq: msg.seqOrig || (instance + '-' + (++cmdSeq)), at: Date.now() };
    if (msg.fade != null) m.fade = msg.fade;
    if (msg.value != null) m.value = msg.value;
    unacked.set(m.seq, { msg: m, sentAt: Date.now() });
    engine.send(m);
  }
  function flushPending() {
    if (!engine || !engineResponsive() || !pending.length) return;
    const queued = pending;
    pending = [];
    for (const p of queued) sendCmd(p);
  }
  function wakeEngine(reason) {
    if (Date.now() - lastWake < 5000) return;
    lastWake = Date.now();
    log('Engine not responding (' + reason + ') — waking window');
    tray.kick();
  }
  let lastBeat = Date.now();
  function heartbeat() {
    const gap = Date.now() - lastBeat;
    lastBeat = Date.now();
    if (gap > 20000) log('Computer was asleep or paused for ~' + Math.round(gap / 1000) + ' s');
    if (!engine) return;
    engine.send({ t: 'ping' });
    let stuck = false;
    for (const [, u] of unacked) if (Date.now() - u.sentAt > 3000) { stuck = true; break; }
    if (stuck || !engineResponsive()) {
      if (stuck) { // неподтверждённые команды — снова в очередь, отправим после пробуждения
        const back = [...unacked.values()].map((u) => ({ queuedAt: u.sentAt, cmd: u.msg.cmd, id: u.msg.id, fade: u.msg.fade, seqOrig: u.msg.seq }));
        unacked.clear();
        pending = back.concat(pending);
        lastPong = Math.min(lastPong, Date.now() - 9000);
      }
      if (!stuckSince) stuckSince = Date.now();
      wakeEngine(stuck ? 'command not confirmed' : 'no heartbeat');
      // если «тихое» пробуждение не помогло, а команда ждёт — показываем окно (это точно будит страницу)
      if (pending.length && !escalated && Date.now() - stuckSince > 12000) {
        escalated = true;
        log('Engine still not responding — showing window briefly');
        tray.show();
        reparkAfterWake = true; // как только окно ответит — снова спрячем его в трей
      }
    }
  }
  function onEngineAlive() {
    lastPong = Date.now();
    if (reparkAfterWake) { reparkAfterWake = false; log('Engine woke up — hiding window again'); tray.hide(); }
    stuckSince = 0;
    escalated = false;
    flushPending();
  }

  // --- расписание ---
  let lastNextKey = null;
  function tick() {
    const now = app.now();
    const nowMs = now.getTime();
    const today = ymd(now);
    let dirty = false;
    for (const s of config.schedules) {
      if (!s.enabled || !s.days.includes(now.getDay())) continue;
      const all = s.streamId === '*';
      const st = all ? null : stream(s.streamId);
      if (!all && !st) continue;
      const start = !all && s.start ? atTime(now, s.start) : null;
      const end = s.end ? atTime(now, s.end) : null;
      if (start == null && end == null) continue;
      if (start != null && end != null && end <= start) continue;
      // отметка «уже сработало сегодня» привязана к времени правила: изменили время — правило снова сработает
      const key = s.id + '@' + today + '@' + s.streamId + ' ' + (s.start || '') + '-' + (s.end || '');
      // затухание начинается заранее, чтобы ко времени «до» была тишина
      const fadeOut = all ? Math.max(1, ...config.streams.map((x) => x.fadeOut || 0)) : st.fadeOut;
      const stopAt = end != null ? Math.max(start != null ? start : -Infinity, end - fadeOut * 1000) : null;
      // старт: если этот же поток уже играет — ничего не меняется;
      // если играет другой — запускается запланированный (с «Соло» другой плавно затихнет)
      if (start != null) {
        // музыка включается только в само время «с» (минута на случай задержки);
        // если программу запустили позже — пропущенный старт не «догоняем»
        const inWindow = nowMs >= start && nowMs < Math.min(start + 60 * 1000, stopAt != null ? stopAt : Infinity);
        if (inWindow && !fired[key + ':start']) {
          fired[key + ':start'] = 1; dirty = true;
          log('Schedule start: ' + st.name + ' ' + s.start);
          command({ cmd: 'play', id: st.id, background: true });
        }
      }
      // стоп: срабатывает всегда, кто бы ни включил поток; если он не играет — ничего не происходит
      if (stopAt != null && !fired[key + ':end'] && nowMs >= stopAt && nowMs < end + 60 * 1000) {
        fired[key + ':end'] = 1; dirty = true;
        const fade = Math.max(0.5, (end - nowMs) / 1000);
        log('Schedule end: ' + (all ? 'ALL' : st.name) + ' ' + s.end + ' (fade ' + fade.toFixed(1) + 's)');
        if (all) command({ cmd: 'stopAll', fade }); else command({ cmd: 'stop', id: st.id, fade });
      }
    }
    // чистим старые отметки
    for (const k of Object.keys(fired)) {
      const d = k.split('@')[1] ? k.split('@')[1].slice(0, 10) : '';
      if (d && d < ymd(new Date(nowMs - 3 * 86400000))) { delete fired[k]; dirty = true; }
    }
    if (dirty) saveFired();
    // «Следующее: …» на экране — обновляем, когда время правила прошло
    const nx = nextSchedule();
    const nxKey = nx ? nx.scheduleId + '@' + nx.at : '';
    if (nxKey !== lastNextKey) {
      const first = lastNextKey === null;
      lastNextKey = nxKey;
      if (!first) broadcast({ t: 'config', config, next: nx });
    }
    // команды, которые ждали запуска движка, живут 30 секунд
    if (pending.length) pending = pending.filter((p) => Date.now() - p.queuedAt < 30000);
  }
  app.tick = tick;

  // --- сообщения от окон ---
  function onMessage(msg, conn) {
    switch (msg.t) {
      case 'state':
        if (conn === engine && msg.streams && typeof msg.streams === 'object') { runtime = msg.streams; onEngineAlive(); changed('runtime'); }
        break;
      case 'pong':
        if (conn === engine) onEngineAlive();
        break;
      case 'ack':
        if (conn === engine) {
          unacked.delete(msg.seq);
          pending = pending.filter((p) => p.seqOrig !== msg.seq); // оригинал всё-таки дошёл — повтор не нужен
          onEngineAlive();
        }
        break;
      case 'cmd':
        command(msg);
        break;
      case 'saveStream': {
        const old = msg.stream && msg.stream.id ? stream(msg.stream.id) : null;
        const s = normalizeStream(msg.stream || {}, old);
        if (!s.folder) { conn.send({ t: 'saveError', msg: 'Укажи папку с музыкой' }); break; }
        if (!scanFolder(s.folder).length) { conn.send({ t: 'saveError', msg: 'В папке нет аудиофайлов (mp3, m4a, wav, flac, ogg, opus)' }); break; }
        if (old) config.streams[config.streams.indexOf(old)] = s; else config.streams.push(s);
        saveNow();
        changed('config');
        conn.send({ t: 'saved', id: s.id });
        break;
      }
      case 'deleteStream': {
        const s = stream(msg.id);
        if (!s) break;
        if (engine) engine.send({ t: 'cmd', cmd: 'stop', id: s.id, fade: 0.5 });
        config.streams = config.streams.filter((x) => x.id !== s.id);
        config.schedules = config.schedules.filter((x) => x.streamId !== s.id);
        delete runtime[s.id];
        saveNow();
        changed('config');
        break;
      }
      case 'moveStream': {
        const i = config.streams.findIndex((x) => x.id === msg.id);
        const j = i + (msg.dir > 0 ? 1 : -1);
        if (i < 0 || j < 0 || j >= config.streams.length) break;
        const tmp = config.streams[i]; config.streams[i] = config.streams[j]; config.streams[j] = tmp;
        saveNow();
        changed('config');
        break;
      }
      case 'saveSchedules':
        config.schedules = (Array.isArray(msg.schedules) ? msg.schedules : []).map(normalizeSchedule);
        saveNow();
        changed('config');
        break;
      case 'openEngine':
        launchEngine(false);
        break;
      case 'keyLayouts': { // окно программы досчитало раскладку названий для кнопок пульта
        let dirty = false;
        for (const st of config.streams) {
          const k = cleanLayout(msg.layouts && msg.layouts[st.id], st.name);
          if (k && k.name === st.name && JSON.stringify(k) !== JSON.stringify(st.keyLayout)) { st.keyLayout = k; dirty = true; }
        }
        if (dirty) { saveNow(); changed('config'); }
        break;
      }
      case 'saveSettings':
        if (msg.autoOpen != null) config.autoOpen = !!msg.autoOpen;
        if (msg.solo != null) config.solo = !!msg.solo;
        if (msg.hotkeys && typeof msg.hotkeys === 'object') {
          config.hotkeys = { stopAll: cleanHotkey(msg.hotkeys.stopAll), next: cleanHotkey(msg.hotkeys.next) };
        }
        saveNow();
        changed('config');
        break;
      case 'hideWindow':
        if (tray.available) tray.hide();
        break;
      case 'panelPress': // кнопка «PolyPlayer» на пульте
        app.panelPress();
        break;
      case 'showWindow':
        app.showWindow();
        break;
      case 'hotkeysPause': // пока в окне вводят сочетание клавиш, горячие клавиши не срабатывают
        app.emit('hotkeysPause', !!msg.on);
        break;
      case 'installPlugin': // «Установить плагин Stream Deck» — обрабатывает main.js
        app.emit('installPlugin');
        break;
      case 'updateCmd': // «Проверить обновления» / «Установить» — обрабатывает main.js
        app.emit('updateCmd', String(msg.cmd || ''));
        break;
      case 'pickFolder':
        if (!tray.available) { conn.send({ t: 'folderPicked', fallback: true }); break; }
        tray.pickFolder(String(msg.initial || '')).then((p) => {
          conn.send(p == null ? { t: 'folderPicked', fallback: true } : { t: 'folderPicked', path: p });
        });
        break;
      default:
        break;
    }
  }

  function onConnect(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    let role = url.searchParams.get('role') === 'engine' ? 'engine' : 'panel';
    // проигрывателем может быть только окно самой программы (не вкладка обычного браузера)
    if (role === 'engine' && opts.isApp && !/Electron/i.test(req.headers['user-agent'] || '')) role = 'panel';
    const conn = wsAccept(req, socket, head, onMessage, (c) => {
      clients.delete(c);
      if (c === engine) {
        engine = null;
        // что играло — включим снова, когда проигрыватель перезапустится (например, после сбоя окна)
        const wasPlaying = stopping ? [] : Object.keys(runtime).filter((id) => runtime[id] && runtime[id].state === 'playing' && stream(id));
        // окно закрыто или сервер перезапускается — помечаем всё как остановленное
        for (const id of Object.keys(runtime)) runtime[id] = Object.assign({}, runtime[id], { state: 'stopped' });
        log('Engine disconnected');
        // команды, которые окно не успело подтвердить (например, после сна компьютера), не теряем:
        // открываем проигрыватель заново (в трее) и выполняем их
        const lost = [...unacked.values()].map((u) => ({ queuedAt: Date.now(), cmd: u.msg.cmd, id: u.msg.id, fade: u.msg.fade }));
        unacked.clear();
        pending = lost.concat(pending);
        const resume = wasPlaying.filter((id) => !pending.some((p) => p.id === id));
        if (resume.length) {
          log('Player closed while playing — will resume: ' + resume.map((id) => stream(id).name).join(', '));
          pending = resume.map((id) => ({ queuedAt: Date.now(), cmd: 'play', id })).concat(pending);
        }
        if (pending.length && !stopping) {
          log('Re-opening player to run ' + pending.length + ' pending command(s)');
          launchEngine(true);
        }
        changed('runtime');
      }
    });
    if (!conn) return;
    let duplicate = false;
    if (role === 'engine') {
      if (engine) { role = 'panel'; duplicate = true; } else { engine = conn; lastLaunch = 0; log('Engine connected'); }
    }
    clients.add(conn);
    const snap = snapshot();
    conn.send({ t: 'hello', role, duplicate, config: snap.config, runtime: snap.runtime, engineOnline: snap.engineOnline, next: snap.next, tray: snap.tray, window: snap.window, platform: process.platform, app: !!opts.isApp, update: updateInfo, about: opts.about || null, hotkeyStatus });
    if (role === 'engine') {
      lastPong = Date.now();
      unacked.clear();
      flushPending();
      changed('runtime');
    }
  }

  // --- HTTP ---
  function sendJson(res, obj, code) {
    res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function onRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p === '/api/state') return sendJson(res, snapshot());
    if (p === '/api/browse') return sendJson(res, browse(url.searchParams.get('path') || ''));
    if (p === '/api/scan') {
      const tracks = scanFolder(url.searchParams.get('path') || '');
      return sendJson(res, { count: tracks.length, sample: tracks.slice(0, 5) });
    }
    if (p.startsWith('/api/tracks/')) {
      const s = stream(p.slice('/api/tracks/'.length));
      if (!s) return sendJson(res, { tracks: [] }, 404);
      return sendJson(res, { tracks: scanFolder(s.folder) });
    }
    if (p === '/api/open') { // ярлык на рабочем столе: показать окно (или открыть проигрыватель)
      app.showWindow();
      return sendJson(res, { ok: true });
    }
    if (p.startsWith('/api/cmd')) { // GET /api/cmd?cmd=toggle&id=... — для отладки и сторонних кнопок
      command({ cmd: url.searchParams.get('cmd'), id: url.searchParams.get('id'), value: url.searchParams.get('value') });
      return sendJson(res, { ok: true });
    }
    if (p.startsWith('/media/')) {
      const s = stream(p.slice('/media/'.length));
      const rel = url.searchParams.get('f') || '';
      if (!s || !s.folder || !rel) { res.writeHead(404); res.end(); return; }
      const root = path.resolve(s.folder);
      const full = path.resolve(root, rel.split('/').join(path.sep));
      if (!full.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      return serveFile(req, res, full, MIME[path.extname(full).toLowerCase()]);
    }
    // статика
    let file = p === '/' ? 'index.html' : p.slice(1);
    if (file.includes('..')) { res.writeHead(403); res.end(); return; }
    file = path.join(publicDir, file);
    return serveFile(req, res, file, MIME[path.extname(file).toLowerCase()]);
  }

  let server = null;
  let timer = null;
  let hbTimer = null;
  app.start = function () {
    return new Promise((resolve, reject) => {
      let port = config.port || DEFAULT_PORT;
      const tryListen = (attempt) => {
        server = http.createServer(onRequest);
        server.on('upgrade', onConnect);
        server.once('error', (e) => {
          if (e.code === 'EADDRINUSE' && attempt < 10) { port++; tryListen(attempt + 1); }
          else { log('Server error: ' + e.message); reject(e); }
        });
        server.listen(port, '127.0.0.1', () => {
          actualPort = port;
          log('PolyPlayer listening on http://127.0.0.1:' + port + ' (data: ' + dataDir + ')');
          timer = setInterval(tick, 1000);
          hbTimer = setInterval(heartbeat, 2000);
          tick();
          resolve(port);
        });
      };
      tryListen(0);
    });
  };
  app.stop = function () {
    stopping = true;
    clearInterval(timer);
    clearInterval(hbTimer);
    tray.stop();
    if (saveTimer) saveNow();
    for (const c of clients) c.close();
    return new Promise((r) => (server ? server.close(() => r()) : r()));
  };
  // сведения об обновлении (их заполняет main.js) — показываются во вкладке «Настройки»
  let updateInfo = null;
  // какие горячие клавиши не удалось занять (их уже использует другая программа) — заполняет main.js
  let hotkeyStatus = { failed: [] };
  app.setHotkeyStatus = (st) => { hotkeyStatus = st || { failed: [] }; broadcast({ t: 'hotkeys', status: hotkeyStatus }); };
  app.setUpdate = (info) => { updateInfo = info; broadcast({ t: 'update', update: info }); };
  app.dataDir = dataDir;
  return app;
}

module.exports = { createApp, scanFolder, browse };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const app = createApp({
    port: get('--port') ? parseInt(get('--port'), 10) : undefined,
    dataDir: get('--data'),
    log: (m) => console.log(m)
  });
  app.start().then((port) => {
    console.log('Панель: http://127.0.0.1:' + port + '/   проигрыватель: http://127.0.0.1:' + port + '/?engine=1');
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
