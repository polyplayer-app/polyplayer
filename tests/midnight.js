// Правило через полночь: с 23:50 до 00:10 — включается в свой день, выключается на следующий.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const MEDIA = path.join(__dirname, 'media');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mn-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fakeNow = null, fails = 0;
const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!c) fails++; };
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ version: 1, port: 7808, solo: true, streams: [
  { id: 'a', name: 'НОЧЬ', folder: path.join(MEDIA, 'Piano'), color: '#6A994E', shuffle: false, loop: true, volume: 50, fadeIn: 0.2, fadeOut: 0.2, crossfade: 0 }], schedules: [] }));
(async () => {
  const app = createApp({ dataDir: DATA, port: 7808, now: () => (fakeNow ? new Date(fakeNow) : new Date()) });
  await app.start();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext();
  const engine = await ctx.newPage(); await engine.goto('http://127.0.0.1:7808/?engine=1');
  const panel = await ctx.newPage(); await panel.goto('http://127.0.0.1:7808/');
  await sleep(800);
  const st = () => engine.evaluate(() => { const c = Engine.debug().ch.a; return c ? c.state : 'none'; });
  const D = new Date(); D.setDate(D.getDate() + 3); D.setHours(12, 0, 0, 0); // какой-то будущий день
  const at = (plus, h, m, s = 0) => { const d = new Date(D); d.setDate(d.getDate() + plus); d.setHours(h, m, s, 0); return d.getTime(); };
  const save = (sc) => panel.evaluate((x) => send({ t: 'saveSchedules', schedules: x }), sc);
  await save([{ id: 'r1', streamId: 'a', days: [D.getDay()], start: '23:50', end: '00:10', enabled: true }]); await sleep(300);
  fakeNow = at(0, 22, 0); app.tick(); await sleep(300);
  const nx = app.snapshot().next || null;
  const warn = await panel.evaluate(() => [...document.querySelectorAll('.srow')].map((r) => r.textContent).join(' '));
  check(!/не сработает|совпадают/.test(warn), 'no warning in schedule row for overnight rule');
  fakeNow = at(0, 23, 50, 1); app.tick(); await sleep(1200);
  check(await st() === 'playing', 'starts at 23:50 on its day', await st());
  fakeNow = at(1, 0, 5); app.tick(); await sleep(800);
  check(await st() === 'playing', 'still playing after midnight', await st());
  fakeNow = at(1, 0, 10) - 100; app.tick(); await sleep(1200);
  check(await st() === 'stopped', 'stops at 00:10 next day', await st());
  // на следующий день (он не отмечен) в 23:50 не включается
  fakeNow = at(1, 23, 50, 1); app.tick(); await sleep(1000);
  check(await st() === 'stopped', 'not started on unchecked day');
  // правило «все потоки» до 00:05 и обычное через полночь не мешают друг другу; «с» = «до» — предупреждение
  await save([{ id: 'r2', streamId: 'a', days: [D.getDay()], start: '10:00', end: '10:00', enabled: true }]); await sleep(500);
  const warn2 = await panel.evaluate(() => [...document.querySelectorAll('.srow')].map((r) => r.textContent).join(' '));
  check(/совпадают/.test(warn2), 'equal start/end is flagged', warn2.slice(0, 120));
  await b.close(); await app.stop();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
