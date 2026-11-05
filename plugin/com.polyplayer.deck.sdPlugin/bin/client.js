// Связь плагина Stream Deck с программой PolyPlayer (Electron).
// Программа сама хранит потоки, расписание и играет музыку; плагин — только пульт.
// Если программа закрыта, нажатие кнопки её запускает (путь берётся из app.json, который пишет программа).
'use strict';

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

function defaultDataDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PolyPlayer');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'PolyPlayer');
  return path.join(os.homedir(), '.polyplayer');
}

function createClient(opts) {
  opts = opts || {};
  const app = new EventEmitter();
  const dataDir = opts.dataDir || defaultDataDir();
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* ignore */ }
  const logFile = path.join(dataDir, 'plugin-log.txt');
  app.dataDir = dataDir;

  function log(msg) {
    try {
      const st = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
      if (st && st.size > 512 * 1024) fs.renameSync(logFile, logFile + '.old');
      fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) { /* ignore */ }
  }
  app.log = log;

  let snap = { config: { streams: [], schedules: [] }, runtime: {}, engineOnline: false, window: 'off', port: 7777, next: null };
  let connected = false;
  let sock = null;
  let buf = Buffer.alloc(0);
  let shook = false;
  let frags = [];
  let stopped = false;
  let queue = [];
  let lastLaunch = 0;
  let retryTimer = null;

  function appInfo() {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8')); } catch (e) { return {}; }
  }

  app.snapshot = () => Object.assign({}, snap, { window: connected ? snap.window : 'off', engineOnline: connected && snap.engineOnline, connected });

  // ---------- WebSocket-клиент ----------
  function sendRaw(obj) {
    if (!sock || !shook) return false;
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | data.length; }
    else if (data.length < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    header[0] = 0x81;
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    try { sock.write(Buffer.concat([header, mask, masked])); return true; } catch (e) { return false; }
  }

  function onMessage(m) {
    if (m.t === 'hello') {
      snap.config = m.config || snap.config;
      snap.runtime = m.runtime || {};
      snap.engineOnline = !!m.engineOnline;
      snap.next = m.next || null;
      if (m.window) snap.window = m.window;
      connected = true;
      log('Connected to PolyPlayer');
      const q = queue; queue = [];
      for (const c of q) if (Date.now() - c.at < 30000) sendRaw(c.msg);
      app.emit('change', 'config');
    } else if (m.t === 'config') {
      snap.config = m.config || snap.config;
      snap.next = m.next || null;
      app.emit('change', 'config');
    } else if (m.t === 'runtime') {
      snap.runtime = m.runtime || {};
      snap.engineOnline = !!m.engineOnline;
      if (m.window) snap.window = m.window;
      app.emit('change', 'runtime');
    } else if (m.t === 'ping') {
      sendRaw({ t: 'pong' });
    }
  }

  function parse() {
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 0x8) { try { sock.destroy(); } catch (e) { /* ignore */ } return; }
      if (op === 0x9) continue;
      if (op === 0x1 || op === 0x0) {
        frags.push(payload);
        if (fin) {
          const text = Buffer.concat(frags).toString('utf8');
          frags = [];
          try { onMessage(JSON.parse(text)); } catch (e) { /* ignore */ }
        }
      }
    }
  }

  function scheduleRetry() {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 2000);
  }

  function connect() {
    if (stopped) return;
    const port = appInfo().port || opts.port || 7777;
    snap.port = port;
    const key = crypto.randomBytes(16).toString('base64');
    shook = false; buf = Buffer.alloc(0); frags = [];
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /ws?role=plugin HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock = s;
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!shook) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString();
        buf = buf.slice(i + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) { s.destroy(); return; }
        shook = true;
      }
      parse();
    });
    s.on('error', () => { /* закрытие обработает 'close' */ });
    s.on('close', () => {
      if (sock !== s) return;
      const was = connected;
      connected = false; shook = false; sock = null;
      for (const id of Object.keys(snap.runtime)) snap.runtime[id] = Object.assign({}, snap.runtime[id], { state: 'stopped' });
      if (was) { log('PolyPlayer disconnected'); app.emit('change', 'runtime'); }
      scheduleRetry();
    });
  }

  // ---------- запуск программы, если она закрыта ----------
  function launchApp(hidden) {
    if (Date.now() - lastLaunch < 15000) return;
    lastLaunch = Date.now();
    const exe = appInfo().exe;
    if (!exe || !fs.existsSync(exe)) {
      log('PolyPlayer app not found (app.json missing) — install and start the program once');
      app.emit('alert', 'Программа PolyPlayer не найдена');
      return;
    }
    try {
      const child = spawn(exe, hidden ? ['--hidden'] : [], { detached: true, stdio: 'ignore' });
      child.on('error', (e) => log('Launch error: ' + e.message));
      child.unref();
      log('Launching PolyPlayer' + (hidden ? ' (hidden)' : ''));
    } catch (e) { log('Launch error: ' + e.message); }
    setTimeout(connect, 1500);
  }

  function sendOrQueue(msg, launchHidden) {
    if (connected && sendRaw(msg)) return;
    queue.push({ at: Date.now(), msg });
    launchApp(launchHidden);
  }

  app.command = (c) => {
    if (!c || !c.cmd) return;
    const msg = Object.assign({ t: 'cmd' }, c);
    if (!connected && (c.cmd === 'stop' || c.cmd === 'stopAll' || c.cmd === 'pause' || c.cmd === 'volumeDelta' || c.cmd === 'volume')) return; // нечего останавливать
    sendOrQueue(msg, true);
  };
  app.panelPress = () => { if (connected) sendRaw({ t: 'panelPress' }); else launchApp(false); };
  app.showWindow = () => { if (connected) sendRaw({ t: 'showWindow' }); else launchApp(false); };
  app.start = () => { connect(); return Promise.resolve(snap.port); };
  app.stop = () => { stopped = true; clearTimeout(retryTimer); try { if (sock) sock.destroy(); } catch (e) { /* ignore */ } return Promise.resolve(); };
  return app;
}

module.exports = { createClient };
