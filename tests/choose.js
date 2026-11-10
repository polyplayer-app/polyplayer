// Плагин: выбор потока на кнопке (нажать — следующий, держать 1 с — выбрать) и подсказки при удержании.
const net = require('net'); const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { createApp } = require('../app/server.js');
const PLUGIN = path.join(__dirname, '..', 'plugin', 'com.polyplayer.deck.sdPlugin', 'bin', 'plugin.js');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ch-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 160) : '')); if (!c) fails++; };
const M = path.join(__dirname, 'media');
fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify({ version: 1, port: 7870, solo: true, streams: [
  { id: 'a', name: 'ПЛЕЙЛИСТ 1', folder: path.join(M, 'Piano'), color: '#6A994E', volume: 60 },
  { id: 'b', name: 'ПЛЕЙЛИСТ 2', folder: path.join(M, 'Lo-Fi'), color: '#4F86C6', volume: 60 }], schedules: [] }));
fs.writeFileSync(path.join(D, 'app.json'), JSON.stringify({ port: 7870, exe: '' }));
function frame(t) { const d = Buffer.from(t); let h; if (d.length < 126) h = Buffer.from([0x81, d.length]); else if (d.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(d.length, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(d.length), 2); } return Buffer.concat([h, d]); }
const rx = []; let sock = null;
const srv = net.createServer((s) => { sock = s; let shook = false, acc = Buffer.alloc(0);
  s.on('data', (c) => { acc = Buffer.concat([acc, c]);
    if (!shook) { const i = acc.indexOf('\r\n\r\n'); if (i < 0) return; const key = /Sec-WebSocket-Key: (.*)\r\n/.exec(acc.toString())[1];
      s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n'); shook = true; acc = acc.slice(i + 4); }
    while (acc.length >= 2) { let len = acc[1] & 0x7f, off = 2; if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4; } else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10; }
      if (acc.length < off + 4 + len) return; const m = acc.slice(off, off + 4); off += 4; const p = Buffer.alloc(len); for (let i = 0; i < len; i++) p[i] = acc[off + i] ^ m[i % 4]; acc = acc.slice(off + len);
      try { rx.push(JSON.parse(p.toString())); } catch (e) { /* ignore */ } } }); });
const sd = (o) => sock.write(frame(JSON.stringify(o)));
const lastImg = () => { const m = [...rx].reverse().find((x) => x.event === 'setImage' && x.context === 'K'); return m ? decodeURIComponent(m.payload.image) : ''; };
const imgsSince = (n) => rx.slice(n).filter((x) => x.event === 'setImage' && x.context === 'K').map((x) => decodeURIComponent(x.payload.image));
const hold = async (ms) => { sd({ event: 'keyDown', action: 'com.polyplayer.deck.stream', context: 'K', payload: {} }); await sleep(ms); sd({ event: 'keyUp', action: 'com.polyplayer.deck.stream', context: 'K', payload: {} }); await sleep(300); };
(async () => {
  const app = createApp({ dataDir: D, port: 7870 }); await app.start();
  await new Promise((r) => srv.listen(0, r));
  const pl = spawn(process.execPath, [PLUGIN, '-port', String(srv.address().port), '-pluginUUID', 'U', '-registerEvent', 'registerPlugin', '-info', '{}'], { env: Object.assign({}, process.env, { POLYPLAYER_DATA_DIR: D }) });
  await sleep(1200);
  sd({ event: 'willAppear', action: 'com.polyplayer.deck.stream', context: 'K', payload: { controller: 'Keypad', settings: {} } });
  await sleep(2600);
  check(rx.some((x) => x.event === 'setImage' && /1\/2/.test(decodeURIComponent(x.payload.image))) && rx.some((x) => x.event === 'setImage' && /НАЖАТЬ/.test(decodeURIComponent(x.payload.image)) && /ВЫБРАТЬ/.test(decodeURIComponent(x.payload.image))), 'new key: choose mode 1/2 + hint «нажать — дальше / держать — выбрать»');
  await hold(100);
  check(/2\/2/.test(lastImg()), 'short press → next stream immediately (2/2)');
  let n = rx.length;
  await hold(1300);
  const frames = imgsSince(n);
  check(frames.some((f) => /ВЫБРАТЬ…/.test(f)), 'holding shows «ВЫБРАТЬ…» progress');
  const set = [...rx].reverse().find((x) => x.event === 'setSettings' && x.context === 'K');
  check(set && set.payload.streamId === 'b', 'hold 1 s → selects shown stream (ПЛЕЙЛИСТ 2)', set && set.payload);
  check(rx.slice(n).some((x) => x.event === 'showOk'), 'showOk after select');
  check(!/2\/2|1\/2/.test(lastImg()) && /ПЛЕЙЛИСТ/.test(lastImg()), 'key now shows the stream (normal mode)');
  n = rx.length;
  await hold(1500);
  const f2 = imgsSince(n);
  check(f2.some((f) => />СТОП</.test(f) && /ДЕРЖИТЕ/.test(f)) && f2.some((f) => /ОТПУСТИТЕ —/.test(f) && />СТОП</.test(f)), 'hold 1.5 s: «СТОП · ДЕРЖИТЕ» then «ОТПУСТИТЕ — СТОП»');
  check(!/1\/2|2\/2/.test(lastImg()), 'released at 1.5 s → still normal mode (stop)');
  n = rx.length;
  await hold(3300);
  check(imgsSince(n).some((f) => /ВЫБОР/.test(f) && /ПОТОКА/.test(f)), 'hold 3 s: «ОТПУСТИТЕ — ВЫБОР ПОТОКА»');
  check(/2\/2/.test(lastImg()), 'released after 3 s → choose mode starting at current stream (2/2)', lastImg().slice(0, 0));
  await hold(100);
  check(/1\/2/.test(lastImg()), 'press → 1/2');
  await hold(1200);
  const set2 = [...rx].reverse().find((x) => x.event === 'setSettings' && x.context === 'K');
  check(set2 && set2.payload.streamId === 'a', 'hold → ПЛЕЙЛИСТ 1 selected');
  pl.kill(); srv.close(); await app.stop();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
