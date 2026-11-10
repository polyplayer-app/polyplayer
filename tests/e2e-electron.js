// Сквозной тест: настоящее приложение Electron (под Xvfb) + плагин 2.0 + мок Stream Deck.
const net = require('net'); const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn, execSync } = require('child_process');
const EL = path.join(__dirname, '..');
const ELBIN = path.join(EL, 'node_modules', 'electron', 'dist', 'electron');
const PLUGIN = path.join(__dirname, '..', 'plugin', 'com.polyplayer.deck.sdPlugin', 'bin', 'plugin.js');
const IMGS = path.join(__dirname, '..', 'plugin', 'com.polyplayer.deck.sdPlugin', 'imgs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-'));
const PORT = 7841;
const UPORT = 7842;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 220) : '')); if (!c) fails++; };
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ version: 1, port: PORT, autoOpen: false, solo: true, streams: [
  { id: 'a', name: 'ПЕРЕРЫВ', folder: path.join(__dirname, 'media', 'Piano'), color: '#6A994E', shuffle: true, loop: true, volume: 60, fadeIn: 0.3, fadeOut: 0.3, crossfade: 0 }], schedules: [] }));
// обёртка, которой плагин запускает программу (на Windows это сам SWP Player.exe)
const wrapper = path.join(DATA, 'swp-player.sh');
fs.writeFileSync(wrapper, '#!/bin/sh\nexport POLYPLAYER_DATA_DIR="' + DATA + '" POLYPLAYER_PORT=' + PORT + ' POLYPLAYER_UPDATE_API=http://127.0.0.1:' + UPORT + ' POLYPLAYER_UPDATE_REPO=test/pp\nunset NODE_OPTIONS http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY\nexec xvfb-run -a "' + ELBIN + '" "' + EL + '" --no-sandbox --disable-gpu "$@" >> "' + DATA + '/electron.out" 2>&1\n');
fs.chmodSync(wrapper, 0o755);

const http = require('http');
const FAKE = '#!/bin/sh\necho "installed $@" > "' + DATA + '/installed.txt"\n';
let api404 = false;
const usrv = http.createServer((req, res) => {
  if (req.url === '/repos/test/pp/releases/latest') {
    if (api404) { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ tag_name: 'v99.0.0', assets: [{ name: 'PolyPlayer-Setup-99.0.0.exe', size: Buffer.byteLength(FAKE), browser_download_url: 'http://127.0.0.1:' + UPORT + '/dl' }] }));
  } else if (req.url === '/dl') { res.end(FAKE); } else { res.writeHead(404); res.end(); }
}).listen(UPORT);
const state = async () => { try { return await (await fetch('http://127.0.0.1:' + PORT + '/api/state')).json(); } catch (e) { return null; } };
function frame(t) { const d = Buffer.from(t); let h; if (d.length < 126) h = Buffer.from([0x81, d.length]); else if (d.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(d.length, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(d.length), 2); } return Buffer.concat([h, d]); }
const received = []; let sock = null;
const srv = net.createServer((s) => {
  sock = s; let shook = false, acc = Buffer.alloc(0);
  s.on('data', (c) => {
    acc = Buffer.concat([acc, c]);
    if (!shook) { const i = acc.indexOf('\r\n\r\n'); if (i < 0) return; const key = /Sec-WebSocket-Key: (.*)\r\n/.exec(acc.toString())[1];
      s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n'); shook = true; acc = acc.slice(i + 4); }
    while (acc.length >= 2) { let len = acc[1] & 0x7f, off = 2; if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4; } else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10; }
      if (acc.length < off + 4 + len) return; const m = acc.slice(off, off + 4); off += 4; const p = Buffer.alloc(len); for (let i = 0; i < len; i++) p[i] = acc[off + i] ^ m[i % 4]; acc = acc.slice(off + len);
      try { received.push(JSON.parse(p.toString())); } catch (e) { /* ignore */ } }
  });
});
const sd = (o) => sock.write(frame(JSON.stringify(o)));
const last = (ev, ctx) => [...received].reverse().find((m) => m.event === ev && (!ctx || m.context === ctx));
const img = (k) => 'data:image/png;base64,' + fs.readFileSync(path.join(IMGS, 'panel_' + k + '@2x.png')).toString('base64');

(async () => {
  // 1. запускаем программу
  spawn(wrapper, [], { detached: true, stdio: 'ignore' }).unref();
  let st = null;
  for (let i = 0; i < 40 && !(st && st.engineOnline); i++) { await sleep(500); st = await state(); }
  check(st && st.engineOnline && st.window === 'visible', 'app started, player window visible', st && { e: st.engineOnline, w: st.window });
  const appJson = JSON.parse(fs.readFileSync(path.join(DATA, 'app.json'), 'utf8'));
  check(appJson.port === PORT, 'app.json written');
  fs.writeFileSync(path.join(DATA, 'app.json'), JSON.stringify(Object.assign(appJson, { exe: wrapper }))); // плагин будет запускать обёртку

  // 2. плагин + мок Stream Deck
  await new Promise((r) => srv.listen(0, r));
  const plugin = spawn(process.execPath, [PLUGIN, '-port', String(srv.address().port), '-pluginUUID', 'U', '-registerEvent', 'registerPlugin', '-info', '{}'], { env: Object.assign({}, process.env, { POLYPLAYER_DATA_DIR: DATA }) });
  await sleep(1500);
  sd({ event: 'willAppear', action: 'com.polyplayer.deck.stream', context: 'K1', payload: { controller: 'Keypad', settings: { streamId: 'a' } } });
  sd({ event: 'willAppear', action: 'com.polyplayer.deck.panel', context: 'K4', payload: { controller: 'Keypad', settings: {} } });
  await sleep(1500);
  check(last('setImage', 'K1') && last('setImage', 'K1').payload.image.includes('ПЕРЕРЫВ'), 'plugin got streams from app');
  check(last('setImage', 'K4').payload.image === img('on'), 'panel key: window open (bright)');
  sd({ event: 'keyUp', action: 'com.polyplayer.deck.panel', context: 'K4', payload: {} });
  await sleep(1200);
  st = await state();
  check(st.window === 'hidden' && last('setImage', 'K4').payload.image === img('tray'), 'panel key → window hidden to tray', st.window);
  sd({ event: 'keyDown', action: 'com.polyplayer.deck.stream', context: 'K1', payload: {} }); await sleep(60);
  sd({ event: 'keyUp', action: 'com.polyplayer.deck.stream', context: 'K1', payload: {} });
  await sleep(2000);
  st = await state();
  check(st.runtime.a.state === 'playing' && st.window === 'hidden', 'stream key plays while window stays hidden', { r: st.runtime.a.state, w: st.window });
  await sleep(4000); // окно спрятано — музыка должна продолжать играть (таймеры не тормозятся)
  st = await state();
  check(st.runtime.a.state === 'playing', 'still playing after 4 s hidden');
  sd({ event: 'keyUp', action: 'com.polyplayer.deck.panel', context: 'K4', payload: {} });
  await sleep(1200);
  check((await state()).window === 'visible', 'panel key → window shown again');
  // второй запуск программы — просто показывает окно, второй экземпляр не появляется
  sd({ event: 'keyUp', action: 'com.polyplayer.deck.panel', context: 'K4', payload: {} }); await sleep(1000);
  spawn(wrapper, [], { detached: true, stdio: 'ignore' }).unref();
  await sleep(6000);
  st = await state();
  check(st.window === 'visible', 'second launch shows existing window', st.window);
  const count = execSync('pgrep -f "' + EL + '" | wc -l').toString().trim();
  console.log('electron processes:', count);

  // 3. программа закрыта → кнопка пульта сама запускает её (в трее) и включает поток
  sd({ event: 'keyUp', action: 'com.polyplayer.deck.stream', context: 'K1', payload: {} }); await sleep(800); // пауза
  try { execSync('pkill -f "' + ELBIN + '"'); } catch (e) { /* ignore */ }
  await sleep(3000);
  check(last('setImage', 'K4').payload.image === img('off'), 'panel key grey when app closed');
  sd({ event: 'keyDown', action: 'com.polyplayer.deck.stream', context: 'K1', payload: {} }); await sleep(60);
  sd({ event: 'keyUp', action: 'com.polyplayer.deck.stream', context: 'K1', payload: {} });
  st = null;
  for (let i = 0; i < 40 && !(st && st.runtime && st.runtime.a && st.runtime.a.state === 'playing'); i++) { await sleep(500); st = await state(); }
  check(st && st.runtime.a.state === 'playing', 'key press launched the app and started the stream', st && st.runtime && st.runtime.a);
  check(st && st.window === 'hidden', 'app launched from key stays in tray', st && st.window);
  // 4. обновление: скачалось в фоне, не ставится, пока играет музыка, ставится после остановки
  const { chromium } = require('playwright');
  const br = await chromium.launch(); const pg = await br.newPage();
  await pg.goto('http://127.0.0.1:' + PORT + '/');
  const ut = async () => pg.evaluate(() => { document.querySelector('#tabs button[data-tab=settings]').click(); return [document.querySelector('#updText').textContent, document.querySelector('#updBtn').textContent, document.querySelector('#updBtn').disabled]; });
  let u = [];
  for (let i = 0; i < 30 && !/Доступна новая версия 99.0.0/.test(u[0] || ''); i++) { await sleep(500); u = await ut(); }
  check(/Доступна новая версия 99.0.0/.test(u[0]) && u[1] === 'Скачать и обновить', 'startup check: new version announced (nothing downloaded yet)', u);
  check(!fs.existsSync('/root/.config/PolyPlayer/electron/updates/PolyPlayer-Setup-99.0.0.exe'), 'not downloaded without consent');
  await pg.evaluate(() => send({ t: 'updateCmd', cmd: 'download' }));
  for (let i = 0; i < 30 && !/скачана/.test(u[0] || ''); i++) { await sleep(500); u = await ut(); }
  check(/Версия 99.0.0 скачана/.test(u[0]) && u[1] === 'Перезапустить и обновить', 'downloaded after consent → restart offered', u);
  check(u[2] === true, 'restart button disabled while music plays');
  check(await pg.evaluate(() => !document.querySelector('.updot').hidden), 'dot on settings tab');
  await pg.evaluate(() => send({ t: 'updateCmd', cmd: 'install' })); await sleep(1000);
  check(/Update install refused/.test(fs.readFileSync(path.join(DATA, 'log.txt'), 'utf8')), 'install refused while playing');
  check(!(await pg.evaluate(() => document.querySelector('#stopAll').disabled)), '«Стоп всё» enabled while playing');
  await fetch('http://127.0.0.1:' + PORT + '/api/cmd?cmd=stopAll'); await sleep(2500);
  u = await ut();
  check(u[2] === false, 'restart button enabled when silent');
  check(await pg.evaluate(() => document.querySelector('#stopAll').disabled), '«Стоп всё» disabled when silent');
  const upFile = execSync('ls /root/.config/PolyPlayer/electron/updates/PolyPlayer-Setup-99.0.0.exe').toString().trim();
  fs.chmodSync(upFile, 0o755);
  await pg.evaluate(() => send({ t: 'updateCmd', cmd: 'install' }));
  await sleep(3000);
  check(fs.existsSync(path.join(DATA, 'installed.txt')) && /\/S/.test(fs.readFileSync(path.join(DATA, 'installed.txt'), 'utf8')), 'installer started silently (/S)');
  check((await state()) === null, 'app closed itself for the update');
  await br.close(); usrv.close();
  try { fs.unlinkSync(upFile); } catch (e) { /* ignore */ }
  console.log('--- plugin log ---\n' + fs.readFileSync(path.join(DATA, 'plugin-log.txt'), 'utf8').trim());
  console.log('--- app log tail ---\n' + fs.readFileSync(path.join(DATA, 'log.txt'), 'utf8').trim().split('\n').slice(-6).join('\n'));
  try { execSync('pkill -f "' + ELBIN + '"'); } catch (e) { /* ignore */ }
  plugin.kill();
  srv.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); try { execSync('pkill -f "' + ELBIN + '"'); } catch (x) { /* ignore */ } process.exit(2); });
