// PolyPlayer — плагин Stream Deck (Windows и macOS).
// Подключается к программе PolyPlayer (как пульт) и связывает с ней кнопки и крутилки:
//   «Поток»        — кнопка: нажал = пуск/пауза, держишь 0,6 с = стоп;
//                    крутилка: поворот = громкость, нажатие = пуск/пауза, касание экрана = следующий трек
//   «Стоп всё»     — плавно гасит все потоки
//   «След. трек»   — следующий трек выбранного потока
//   «Панель»       — открывает окно PolyPlayer

'use strict';

const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createClient } = require('./client.js');
const KeyName = require('./keyname.js'); // раскладка названия на кнопке: до 2 строк, поля от краёв

// картинки кнопки «PolyPlayer»: закрыт / в трее / открыт
const PANEL_IMG = {};
for (const k of ['off', 'tray', 'on']) {
  try { PANEL_IMG[k] = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', 'imgs', 'panel_' + k + '@2x.png')).toString('base64'); } catch (e) { PANEL_IMG[k] = ''; }
}

const A = {
  stream: 'com.polyplayer.deck.stream',
  stopall: 'com.polyplayer.deck.stopall',
  next: 'com.polyplayer.deck.next',
  panel: 'com.polyplayer.deck.panel'
};
const HOLD_MS = 600;          // держать дольше — стоп
const CHOOSE_HOLD_MS = 3000;  // держать 3 с — сменить поток на кнопке
const DOUBLE_MS = 400;        // два нажатия быстрее — «сохранить»
const VOL_STEP = 2;

// ---------- аргументы ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) if (argv[i].startsWith('-')) { out[argv[i].slice(1)] = argv[i + 1]; i++; }
  return out;
}
const args = parseArgs(process.argv);
const port = parseInt(args.port, 10);

// ---------- приложение ----------
// сама программа PolyPlayer — отдельное приложение; плагин подключается к ней как пульт
const app = createClient({ dataDir: process.env.POLYPLAYER_DATA_DIR || undefined });
const log = app.log;

// ---------- WebSocket-клиент к Stream Deck ----------
let socket = null;
let ready = false;
let buffer = Buffer.alloc(0);
let fragments = [];

function sendFrame(opcode, payload) {
  if (!socket || !ready) return;
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (data.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | data.length; }
  else if (data.length < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  socket.write(Buffer.concat([header, mask, masked]));
}
const send = (obj) => sendFrame(0x1, JSON.stringify(obj));

function processFrames() {
  while (buffer.length >= 2) {
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const isMasked = (buffer[1] & 0x80) !== 0;
    let len = buffer[1] & 0x7f;
    let offset = 2;
    if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    let maskKey = null;
    if (isMasked) { if (buffer.length < offset + 4) return; maskKey = buffer.slice(offset, offset + 4); offset += 4; }
    if (buffer.length < offset + len) return;
    let payload = Buffer.from(buffer.slice(offset, offset + len));
    if (maskKey) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i % 4];
    buffer = buffer.slice(offset + len);
    if (opcode === 0x8) { shutdown(); return; }
    if (opcode === 0x9) { sendFrame(0xA, payload); continue; }
    if (opcode === 0x1 || opcode === 0x0) {
      fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        try { onMessage(JSON.parse(text)); } catch (e) { log('Bad message: ' + e.message); }
      }
    }
  }
}

function connect() {
  const key = crypto.randomBytes(16).toString('base64');
  socket = net.connect(port, '127.0.0.1', () => {
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!ready) {
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buffer.slice(0, idx).toString('utf8');
      buffer = buffer.slice(idx + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) { log('Handshake failed: ' + head.split('\r\n')[0]); shutdown(); return; }
      ready = true;
      send({ event: args.registerEvent, uuid: args.pluginUUID });
      log('Stream Deck connected');
    }
    processFrames();
  });
  socket.on('error', (e) => { log('Socket error: ' + e.message); shutdown(); });
  socket.on('close', () => shutdown());
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Stream Deck disconnected, exiting');
  app.stop().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

// ---------- кнопки ----------
const ctxs = new Map(); // context -> {action, controller, settings, last:{}, downAt}
const piOpen = new Map(); // context -> action

function xml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

function splitName(name) {
  const words = String(name || '').toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  if (words.length === 1) return [words[0]];
  // делим на две строки как можно ровнее
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const score = Math.max(a.length, b.length);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best.lines;
}

function textBlock(lines, cx, top, bottom, maxW, maxSize, color) {
  const longest = Math.max(1, ...lines.map((l) => l.length));
  let size = Math.min(maxSize, Math.floor(maxW / (longest * 0.66)));
  size = Math.max(13, Math.min(size, Math.floor((bottom - top) / (lines.length * 1.05))));
  const lh = size * 1.02;
  const total = lh * lines.length;
  const y0 = top + (bottom - top - total) / 2 + size * 0.82;
  return lines.map((l, i) =>
    '<text x="' + cx + '" y="' + (y0 + i * lh).toFixed(1) + '" text-anchor="middle" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900" font-size="' + size + '" fill="' + color + '">' + xml(l) + '</text>'
  ).join('');
}

function glyph(state, x, y, s, color) {
  if (state === 'playing') return '<path d="M' + x + ' ' + y + 'l' + s + ' ' + s / 2 + 'l-' + s + ' ' + s / 2 + 'z" fill="' + color + '"/>';
  if (state === 'paused') return '<rect x="' + x + '" y="' + y + '" width="' + s * 0.36 + '" height="' + s + '" rx="2" fill="' + color + '"/><rect x="' + (x + s * 0.62) + '" y="' + y + '" width="' + s * 0.36 + '" height="' + s + '" rx="2" fill="' + color + '"/>';
  return '<rect x="' + x + '" y="' + y + '" width="' + s + '" height="' + s + '" rx="2" fill="none" stroke="' + color + '" stroke-width="3"/>';
}

const svgUri = (svg) => 'data:image/svg+xml;charset=utf8,' + svg;

function streamKeySvg(s, rt) {
  const W = 144;
  if (!s) {
    return svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#2B2B2B"/>' +
      textBlock(['ВЫБЕРИ', 'ПОТОК'], 72, 30, 114, 124, 26, '#F2E6CC') + '</svg>');
  }
  const st = (rt && rt.state) || 'stopped';
  const on = st === 'playing';
  // пауза выглядит так же серо, как стоп (отличается только значком)
  const bg = on ? '#1E2A44' : '#262626';
  const ink = on ? '#F2E6CC' : '#8E8E8E';
  const accent = on ? s.color : '#5A5A5A';
  const vol = Math.max(0, Math.min(100, s.volume));
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + W + '" viewBox="0 0 144 144">';
  svg += '<rect width="144" height="144" fill="' + bg + '"/>';
  svg += '<rect width="144" height="10" fill="' + accent + '"/>';
  svg += glyph(st, 12, 20, 18, accent);
  if (on) svg += '<circle cx="124" cy="29" r="8" fill="' + s.color + '"/><circle cx="124" cy="29" r="12" fill="none" stroke="' + s.color + '" stroke-opacity="0.45" stroke-width="3"/>';
  else svg += '<circle cx="124" cy="29" r="7" fill="none" stroke="' + ink + '" stroke-opacity="0.5" stroke-width="2"/>';
  svg += KeyName.textSvg(KeyName.forStream(s), 72, 44, 114, ink);
  svg += '<rect x="12" y="122" width="120" height="10" rx="5" fill="#000" fill-opacity="0.45"/>';
  if (vol > 0) svg += '<rect x="12" y="122" width="' + Math.max(10, 1.2 * vol).toFixed(1) + '" height="10" rx="5" fill="' + accent + '"/>';
  svg += '</svg>';
  return svgUri(svg);
}

function simpleKeySvg(lines, sub, color, active) {
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">';
  svg += '<rect width="144" height="144" fill="' + (active ? '#1E2A44' : '#262626') + '"/>';
  svg += '<rect width="144" height="10" fill="' + color + '"/>';
  svg += textBlock(lines, 72, sub ? 22 : 24, sub ? 100 : 120, 128, 34, '#F2E6CC');
  if (sub) svg += textBlock([sub], 72, 104, 132, 128, 18, color);
  svg += '</svg>';
  return svgUri(svg);
}

// кнопка в режиме выбора потока: 1 нажатие — следующий, 2 быстрых — сохранить
function chooseKeySvg(p, i, n) {
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">';
  svg += '<rect width="144" height="144" fill="#262626"/>';
  svg += '<rect x="5" y="5" width="134" height="134" rx="14" fill="none" stroke="' + p.color + '" stroke-width="5" stroke-dasharray="14 9"/>';
  svg += textBlock([(i + 1) + '/' + n], 72, 16, 44, 120, 24, p.color);
  svg += KeyName.textSvg(KeyName.forStream(p), 72, 48, 122, '#F2E6CC');
  svg += '</svg>';
  return svgUri(svg);
}

// подсказка, которая чередуется с названием потока в режиме выбора
function chooseHintSvg(p, i, n) {
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">';
  svg += '<rect width="144" height="144" fill="#262626"/>';
  svg += '<rect x="5" y="5" width="134" height="134" rx="14" fill="none" stroke="' + p.color + '" stroke-width="5" stroke-dasharray="14 9"/>';
  svg += textBlock(['1 НАЖАТИЕ'], 72, 16, 44, 122, 20, p.color);
  svg += textBlock(['ДАЛЬШЕ'], 72, 42, 68, 120, 20, '#F2E6CC');
  svg += textBlock(['2 НАЖАТИЯ'], 72, 76, 104, 122, 20, p.color);
  svg += textBlock(['ОК'], 72, 102, 128, 120, 22, '#F2E6CC');
  svg += '</svg>';
  return svgUri(svg);
}

// в режиме выбора кнопка каждые 1,6 с переключается: название потока ↔ подсказка
let hintPhase = false;
setInterval(() => {
  let any = false;
  for (const c of ctxs.values()) if (c.action === A.stream && c.controller !== 'Encoder' && isChoosing(c)) { any = true; break; }
  if (!any) { hintPhase = false; return; }
  hintPhase = !hintPhase;
  for (const [k, c] of ctxs) if (c.action === A.stream && c.controller !== 'Encoder' && isChoosing(c)) render(k);
}, 1600);

function isChoosing(c) {
  if (c.choosing) return true;
  const snap = app.snapshot();
  return !snap.config.streams.some((x) => x.id === c.settings.streamId);
}

function startChoosing(c, context) {
  const list = app.snapshot().config.streams;
  c.choosing = true;
  c.previewIdx = Math.max(0, list.findIndex((x) => x.id === c.settings.streamId));
  clearTimeout(c.chooseTimeout);
  // если кнопка уже была настроена и выбор бросили — через 30 с вернётся как было
  c.chooseTimeout = setTimeout(() => { if (c.choosing) { c.choosing = false; render(context); } }, 30000);
  render(context);
}

function commitChoice(c, context) {
  const list = app.snapshot().config.streams;
  if (!list.length) { app.showWindow(); return; }
  const p = list[((c.previewIdx || 0) % list.length + list.length) % list.length];
  c.settings = Object.assign({}, c.settings, { streamId: p.id });
  c.choosing = false;
  clearTimeout(c.chooseTimeout);
  send({ event: 'setSettings', context, payload: c.settings });
  send({ event: 'showOk', context });
  c.last = {};
  render(context);
}

function choosePress(c, context) {
  c.lastPressAt = Date.now(); // пока листают — подсказку не показываем, только названия
  const list = app.snapshot().config.streams;
  if (!list.length) { app.showWindow(); send({ event: 'showAlert', context }); return; }
  if (c.pressTimer) { // второе быстрое нажатие — сохраняем показанный поток
    clearTimeout(c.pressTimer);
    c.pressTimer = null;
    commitChoice(c, context);
    return;
  }
  c.pressTimer = setTimeout(() => {
    c.pressTimer = null;
    c.previewIdx = ((c.previewIdx || 0) + 1) % list.length;
    clearTimeout(c.chooseTimeout);
    if (c.choosing) c.chooseTimeout = setTimeout(() => { if (c.choosing) { c.choosing = false; render(context); } }, 30000);
    render(context);
  }, DOUBLE_MS);
}

// «Следующий трек» работает, только когда играет ровно один поток
function singlePlaying(snap) {
  const playing = snap.config.streams.filter((s) => snap.runtime[s.id] && snap.runtime[s.id].state === 'playing');
  return playing.length === 1 ? playing[0] : null;
}

function nextKeySvg(stream) {
  const on = !!stream;
  const bg = on ? '#1E2A44' : '#262626';
  const col = on ? stream.color : '#5A5A5A';
  const ink = on ? '#F2E6CC' : '#8E8E8E';
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">';
  svg += '<rect width="144" height="144" fill="' + bg + '"/>';
  svg += '<rect width="144" height="10" fill="' + col + '"/>';
  // ▶▶| крупно
  svg += '<path d="M26 28 L60 52 L26 76 Z" fill="' + col + '"/>';
  svg += '<path d="M62 28 L96 52 L62 76 Z" fill="' + col + '"/>';
  svg += '<rect x="100" y="28" width="12" height="48" rx="2" fill="' + col + '"/>';
  svg += textBlock(['СЛЕД.', 'ТРЕК'], 72, 86, 136, 128, 24, ink);
  svg += '</svg>';
  return svgUri(svg);
}

function iconSvg(state, color) {
  return svgUri('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' + glyph(state, 10, 10, 28, color) + '</svg>');
}

function findStream(id) {
  const snap = app.snapshot();
  const s = snap.config.streams.find((x) => x.id === id) || null;
  return { s, rt: s ? snap.runtime[s.id] : null, snap };
}

function setOnce(c, key, msg) {
  const k = JSON.stringify(msg.payload);
  if (c.last[key] === k) return;
  c.last[key] = k;
  send(msg);
}

function render(context) {
  const c = ctxs.get(context);
  if (!c) return;
  const snap = app.snapshot();
  if (c.action === A.stream) {
    const { s, rt } = findStream(c.settings.streamId);
    if (isChoosing(c)) {
      const list = snap.config.streams;
      if (!list.length) {
        if (c.controller === 'Encoder') setOnce(c, 'fb', { event: 'setFeedback', context, payload: { title: 'POLYPLAYER', value: 'создай поток', icon: iconSvg('stopped', '#8E8E8E'), indicator: { value: 0 } } });
        else setOnce(c, 'img', { event: 'setImage', context, payload: { image: simpleKeySvg(['СОЗДАЙ', 'ПОТОК'], 'в PolyPlayer', '#8E8E8E', false), target: 0 } });
        return;
      }
      const i = ((c.previewIdx || 0) % list.length + list.length) % list.length;
      const p = list[i];
      if (c.controller === 'Encoder') {
        setOnce(c, 'fb', { event: 'setFeedback', context, payload: { title: (i + 1) + '/' + list.length, value: p.name.toUpperCase(), icon: iconSvg('stopped', p.color), indicator: { value: Math.round((i + 1) / list.length * 100), bar_fill_c: p.color } } });
      } else {
        setOnce(c, 'img', { event: 'setImage', context, payload: { image: (hintPhase && Date.now() - (c.lastPressAt || 0) > 3000) ? chooseHintSvg(p, i, list.length) : chooseKeySvg(p, i, list.length), target: 0 } });
      }
      return;
    }
    if (c.controller === 'Encoder') {
      const st = (rt && rt.state) || 'stopped';
      const label = !s ? 'Выбери поток' : (st === 'playing' ? s.volume + '%' : st === 'paused' ? 'пауза · ' + s.volume + '%' : 'стоп · ' + s.volume + '%');
      setOnce(c, 'fb', {
        event: 'setFeedback', context,
        payload: {
          title: s ? s.name.toUpperCase() : 'POLYPLAYER',
          value: label,
          icon: iconSvg(st, s ? (st === 'stopped' ? '#8E8E8E' : s.color) : '#8E8E8E'),
          indicator: { value: s ? s.volume : 0, bar_fill_c: s ? s.color : '#8E8E8E' }
        }
      });
    } else {
      setOnce(c, 'img', { event: 'setImage', context, payload: { image: streamKeySvg(s, rt), target: 0 } });
      setOnce(c, 'title', { event: 'setTitle', context, payload: { title: '', target: 0 } });
    }
  } else if (c.action === A.stopall) {
    const anyOn = Object.values(snap.runtime).some((r) => r && r.state === 'playing');
    setOnce(c, 'img', { event: 'setImage', context, payload: { image: simpleKeySvg(['СТОП', 'ВСЁ'], '', '#E85D2E', anyOn), target: 0 } });
  } else if (c.action === A.next) {
    const one = singlePlaying(snap);
    setOnce(c, 'img', { event: 'setImage', context, payload: { image: nextKeySvg(one), target: 0 } });
  } else if (c.action === A.panel) {
    const w = snap.window;
    const img = w === 'visible' ? PANEL_IMG.on : (w === 'hidden' || w === 'starting') ? PANEL_IMG.tray : PANEL_IMG.off;
    setOnce(c, 'img', { event: 'setImage', context, payload: { image: img || simpleKeySvg(['POLY', 'PLAYER'], '', '#FF6A4D', w !== 'off'), target: 0 } });
  }
}

function renderAll() { for (const k of ctxs.keys()) render(k); }

function streamsForPI() {
  const snap = app.snapshot();
  return { streams: snap.config.streams.map((s) => ({ id: s.id, name: s.name, color: s.color })), port: snap.port };
}
function pushPI() {
  for (const [context, action] of piOpen) send({ event: 'sendToPropertyInspector', action, context, payload: streamsForPI() });
}

app.on('change', (kind) => { renderAll(); if (kind === 'config') pushPI(); });
app.on('alert', () => { for (const [k, c] of ctxs) if (c.action === A.stream || c.action === A.panel) send({ event: 'showAlert', context: k }); });

function toggleStream(c, context) {
  const { s } = findStream(c.settings.streamId);
  if (!s) { app.showWindow(); send({ event: 'showAlert', context }); return; }
  app.command({ cmd: 'toggle', id: s.id });
}

function onMessage(msg) {
  const { event, action, context, payload } = msg;
  switch (event) {
    case 'willAppear': {
      const prev = ctxs.get(context);
      ctxs.set(context, {
        action, controller: (payload && payload.controller) || 'Keypad',
        settings: (payload && payload.settings) || {}, last: {}, downAt: prev ? prev.downAt : 0
      });
      render(context);
      break;
    }
    case 'willDisappear':
      ctxs.delete(context);
      piOpen.delete(context);
      break;
    case 'didReceiveSettings': {
      const c = ctxs.get(context);
      if (c) { c.settings = (payload && payload.settings) || {}; c.choosing = false; c.last = {}; render(context); }
      break;
    }
    case 'keyDown': {
      const c = ctxs.get(context);
      if (c) c.downAt = Date.now();
      break;
    }
    case 'keyUp': {
      const c = ctxs.get(context);
      if (!c) break;
      const held = c.downAt ? Date.now() - c.downAt : 0;
      c.downAt = 0;
      c.last = {}; // Stream Deck иногда перерисовывает кнопку сам — вернём наш рисунок
      if (c.action === A.stream && isChoosing(c)) {
        choosePress(c, context);
      } else if (c.action === A.stream) {
        const { s } = findStream(c.settings.streamId);
        if (held >= CHOOSE_HOLD_MS) startChoosing(c, context);
        else if (s && held >= HOLD_MS) app.command({ cmd: 'stop', id: s.id });
        else toggleStream(c, context);
      } else if (c.action === A.stopall) {
        app.command({ cmd: 'stopAll' });
      } else if (c.action === A.next) {
        const one = singlePlaying(app.snapshot());
        if (one) app.command({ cmd: 'next', id: one.id }); else send({ event: 'showAlert', context });
      } else if (c.action === A.panel) {
        app.panelPress();
      }
      render(context);
      break;
    }
    case 'dialRotate': {
      const c = ctxs.get(context);
      if (!c || c.action !== A.stream) break;
      if (isChoosing(c)) { // в режиме выбора поворот листает потоки
        c.previewIdx = (c.previewIdx || 0) + Math.sign((payload && payload.ticks) || 0);
        render(context);
        break;
      }
      const { s } = findStream(c.settings.streamId);
      if (!s) break;
      const ticks = (payload && payload.ticks) || 0;
      app.command({ cmd: 'volumeDelta', id: s.id, value: ticks * (payload && payload.pressed ? 5 : VOL_STEP) });
      break;
    }
    case 'dialDown': {
      const c = ctxs.get(context);
      if (c) c.downAt = Date.now();
      break;
    }
    case 'dialUp': {
      const c = ctxs.get(context);
      if (!c || c.action !== A.stream) break;
      const held = c.downAt ? Date.now() - c.downAt : 0;
      c.downAt = 0;
      if (isChoosing(c)) { commitChoice(c, context); break; } // крутилка: нажатие — сохранить
      const { s } = findStream(c.settings.streamId);
      if (held >= CHOOSE_HOLD_MS) startChoosing(c, context);
      else if (s && held >= HOLD_MS) app.command({ cmd: 'stop', id: s.id });
      else toggleStream(c, context);
      break;
    }
    case 'dialPress': { // старые версии Stream Deck (6.0)
      const c = ctxs.get(context);
      if (c && c.action === A.stream && payload && payload.pressed) toggleStream(c, context);
      break;
    }
    case 'touchTap': {
      const c = ctxs.get(context);
      if (!c || c.action !== A.stream) break;
      const { s } = findStream(c.settings.streamId);
      if (!s) { app.showWindow(); break; }
      if (payload && payload.hold) app.command({ cmd: 'stop', id: s.id });
      else app.command({ cmd: 'next', id: s.id });
      break;
    }
    case 'propertyInspectorDidAppear':
      piOpen.set(context, action);
      send({ event: 'sendToPropertyInspector', action, context, payload: streamsForPI() });
      break;
    case 'propertyInspectorDidDisappear':
      piOpen.delete(context);
      break;
    case 'sendToPlugin':
      if (payload && payload.t === 'getStreams') send({ event: 'sendToPropertyInspector', action, context, payload: streamsForPI() });
      if (payload && payload.t === 'openPanel') app.showWindow();
      break;
    case 'systemDidWakeUp':
      renderAll();
      break;
    default:
      break;
  }
}

process.on('uncaughtException', (e) => { log('Uncaught: ' + (e && e.stack || e)); });

app.start().then((p) => {
  log('Plugin started, panel port ' + p + ', Stream Deck port ' + port + ', data ' + app.dataDir);
  connect();
}).catch((e) => {
  log('App start failed: ' + e.message);
  connect();
});

