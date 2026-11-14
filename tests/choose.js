// Плагин: поток назначается в панели настроек кнопки (список из PolyPlayer); пустая кнопка — подсказка; нажатие и удержание.
const net = require('net'); const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const SDP = path.join(__dirname, '..', 'plugin', 'com.polyplayer.deck.sdPlugin');
const PLUGIN = path.join(SDP, 'bin', 'plugin.js');
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
  // манифест: у действия «Поток» есть панель настроек, файл на месте
  const man = JSON.parse(fs.readFileSync(path.join(SDP, 'manifest.json'), 'utf8'));
  const act = man.Actions.find((a) => a.UUID === 'com.polyplayer.deck.stream');
  check(act && act.PropertyInspectorPath === 'pi/stream.html' && fs.existsSync(path.join(SDP, act.PropertyInspectorPath)), 'manifest: «Поток» → PropertyInspectorPath pi/stream.html (файл есть)');
  check(!/выбрать|сменить/.test(act.Tooltip) || /настройк/.test(act.Tooltip), 'manifest: подсказка действия не про выбор на кнопке', act.Tooltip);

  const launched = [];
  const app = createApp({ dataDir: D, port: 7870, launchHook: (hidden) => launched.push(hidden) }); await app.start();
  await new Promise((r) => srv.listen(0, r));
  const pl = spawn(process.execPath, [PLUGIN, '-port', String(srv.address().port), '-pluginUUID', 'U', '-registerEvent', 'registerPlugin', '-info', '{}'], { env: Object.assign({}, process.env, { POLYPLAYER_DATA_DIR: D }) });
  await sleep(1200);
  const ACT = 'com.polyplayer.deck.stream';
  sd({ event: 'willAppear', action: ACT, context: 'K', payload: { controller: 'Keypad', settings: {} } });
  await sleep(600);
  let img = lastImg();
  check(/ВЫБЕРИТЕ/.test(img) && /ПОТОК/.test(img) && /В НАСТРОЙКАХ/.test(img) && /КНОПКИ/.test(img), 'новая кнопка: подсказка «выберите поток в настройках кнопки»');
  check(!/НАЖАТЬ|ДАЛЬШЕ|1\/2/.test(img), 'новая кнопка: старого режима выбора на ней нет');

  // панель настроек: плагин отдаёт список потоков
  let n = rx.length;
  sd({ event: 'propertyInspectorDidAppear', action: ACT, context: 'K', payload: {} });
  await sleep(300);
  const pi = rx.slice(n).find((x) => x.event === 'sendToPropertyInspector' && x.context === 'K');
  check(pi && pi.payload.streams.length === 2 && pi.payload.streams[0].id === 'a' && pi.payload.streams[1].name === 'ПЛЕЙЛИСТ 2', 'панель настроек получает список потоков', pi && pi.payload.streams);
  check(pi && pi.payload.connected === true, 'панель настроек знает, что программа на связи');
  n = rx.length;
  sd({ event: 'sendToPlugin', action: ACT, context: 'K', payload: { t: 'getStreams' } });
  await sleep(300);
  check(rx.slice(n).some((x) => x.event === 'sendToPropertyInspector'), 'getStreams → список потоков');

  // пользователь выбрал поток в панели → Stream Deck присылает настройки
  n = rx.length;
  sd({ event: 'didReceiveSettings', action: ACT, context: 'K', payload: { settings: { streamId: 'b' } } });
  await sleep(300);
  img = lastImg();
  check(/ПЛЕЙЛИСТ/.test(img) && /2/.test(img) && !/ВЫБЕРИТЕ/.test(img), 'выбран поток в панели → кнопка показывает ПЛЕЙЛИСТ 2');

  // нажать — пуск/пауза (проигрыватель закрыт → программа запускается в трей, команда ждёт в очереди)
  await hold(100); await sleep(500);
  check(launched.length === 1 && launched[0] === true, 'нажатие на кнопку потока → команда дошла до программы (она запустилась в трей)', launched);

  // держать: подсказки стоп; 3 с больше ничего не значат
  n = rx.length;
  await hold(1500);
  const f2 = imgsSince(n);
  check(f2.some((f) => />СТОП</.test(f) && /ДЕРЖИТЕ/.test(f)) && f2.some((f) => /ОТПУСТИТЕ —/.test(f) && />СТОП</.test(f)), 'держать 1,5 с: «СТОП · ДЕРЖИТЕ», затем «ОТПУСТИТЕ — СТОП»');
  n = rx.length;
  await hold(3400);
  const f3 = imgsSince(n);
  check(!f3.some((f) => /ВЫБОР|ВЫБРАТЬ/.test(f)), 'держать 3 с: режима выбора потока нет');
  check(!rx.some((x) => x.event === 'setSettings') && /ПЛЕЙЛИСТ/.test(lastImg()) && !/ВЫБЕРИТЕ/.test(lastImg()), 'после долгого удержания кнопка осталась на своём потоке, настройки не менялись');

  // сменили поток в панели → кнопка перерисована
  sd({ event: 'didReceiveSettings', action: ACT, context: 'K', payload: { settings: { streamId: 'a' } } });
  await sleep(300);
  check(/ПЛЕЙЛИСТ/.test(lastImg()) && /1/.test(lastImg()), 'смена потока в панели → кнопка показывает ПЛЕЙЛИСТ 1');

  // удалённый поток: снова подсказка
  sd({ event: 'didReceiveSettings', action: ACT, context: 'K', payload: { settings: { streamId: 'zzz' } } });
  await sleep(300);
  check(/ВЫБЕРИТЕ/.test(lastImg()), 'поток удалён → на кнопке снова подсказка');

  // нажатие и удержание на кнопке без потока ничего не назначают
  await hold(100); await hold(1300); await hold(3300);
  check(!rx.some((x) => x.event === 'setSettings'), 'на кнопке без потока нажатие и удержание не назначают поток');
  check(/ВЫБЕРИТЕ/.test(lastImg()), 'кнопка без потока осталась с подсказкой');

  // регулятор Stream Deck +
  sd({ event: 'willAppear', action: ACT, context: 'E', payload: { controller: 'Encoder', settings: { streamId: 'a' } } });
  await sleep(300);
  n = rx.length;
  sd({ event: 'dialRotate', action: ACT, context: 'E', payload: { ticks: 3 } });
  await sleep(400);
  const e1 = JSON.parse(await (await fetch('http://127.0.0.1:7870/api/state')).text());
  check(e1.config.streams.find((s) => s.id === 'a').volume === 66, 'регулятор: поворот меняет громкость (+2 за щелчок)', e1.config.streams.find((s) => s.id === 'a').volume);
  sd({ event: 'willAppear', action: ACT, context: 'E2', payload: { controller: 'Encoder', settings: {} } });
  await sleep(300);
  const fb = [...rx].reverse().find((x) => x.event === 'setFeedback' && x.context === 'E2');
  check(fb && /настройках/.test(fb.payload.value), 'регулятор без потока: подсказка про настройки', fb && fb.payload.value);

  // сама панель настроек в Chromium, с поддельным сокетом Stream Deck
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 400, height: 300 } });
  await pg.addInitScript(() => {
    window.__sent = [];
    window.WebSocket = class { constructor(u) { window.__ws = this; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(d) { window.__sent.push(JSON.parse(d)); } };
  });
  await pg.goto('file://' + path.join(SDP, 'pi', 'stream.html'));
  await pg.evaluate(() => connectElgatoStreamDeckSocket(28196, 'PIUUID', 'registerPropertyInspector', '{}', JSON.stringify({ action: 'com.polyplayer.deck.stream', context: 'K', payload: { settings: {} } })));
  await pg.waitForTimeout(100);
  const sent0 = await pg.evaluate(() => window.__sent);
  check(sent0.some((m) => m.event === 'registerPropertyInspector' && m.uuid === 'PIUUID') && sent0.some((m) => m.event === 'sendToPlugin' && m.payload.t === 'getStreams'), 'панель: регистрируется и запрашивает список потоков');
  await pg.evaluate(() => window.__ws.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: { streams: [{ id: 'a', name: 'ПЛЕЙЛИСТ 1', color: '#6A994E' }, { id: 'b', name: 'ПЛЕЙЛИСТ 2', color: '#4F86C6' }], connected: true } }) }));
  const opts = await pg.$$eval('#stream option', (o) => o.map((x) => x.textContent));
  check(JSON.stringify(opts) === JSON.stringify(['Не выбран', 'ПЛЕЙЛИСТ 1', 'ПЛЕЙЛИСТ 2']), 'панель: выпадающий список потоков', opts);
  await pg.selectOption('#stream', 'b');
  const sent1 = await pg.evaluate(() => window.__sent);
  check(sent1.some((m) => m.event === 'setSettings' && m.context === 'PIUUID' && m.payload.streamId === 'b'), 'панель: выбор потока сохраняется в настройках кнопки (setSettings)');
  await pg.evaluate(() => window.__ws.onmessage({ data: JSON.stringify({ event: 'didReceiveSettings', payload: { settings: { streamId: 'zzz' } } }) }));
  const opts2 = await pg.$$eval('#stream option', (o) => o.map((x) => x.textContent));
  check(opts2[opts2.length - 1] === 'Поток не найден' && await pg.$eval('#stream', (s) => s.value) === 'zzz', 'панель: сохранённый поток удалён — виден как «Поток не найден», настройки не затираются', opts2);
  await pg.evaluate(() => window.__ws.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: { streams: [], connected: true } }) }));
  check(await pg.$eval('#open', (x) => !x.hidden) && /Потоков пока нет/.test(await pg.$eval('#note', (x) => x.textContent)), 'панель: потоков нет — подсказка и кнопка «Открыть PolyPlayer»');
  await pg.evaluate(() => window.__ws.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: { streams: [], connected: false } }) }));
  check(/не запущена/.test(await pg.$eval('#note', (x) => x.textContent)) && await pg.$eval('#open', (x) => x.hidden), 'панель: программа не запущена — подсказка');
  await b.close();

  pl.kill(); srv.close(); await app.stop();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
