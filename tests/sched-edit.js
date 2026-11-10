// Правило уже сработало сегодня, потом ему поменяли время — должно сработать снова (ошибка из 2.0.1).
const path = require('path'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const MEDIA = path.join(__dirname, 'media');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-se-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fakeNow = null, fails = 0;
const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!c) fails++; };
const hm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ version: 1, port: 7805, solo: true, streams: [
  { id: 'a', name: 'ПЕРЕРЫВ', folder: path.join(MEDIA, 'Piano'), color: '#6A994E', shuffle: false, loop: true, volume: 50, fadeIn: 0.2, fadeOut: 0.2, crossfade: 0 }], schedules: [] }));
(async () => {
  const app = createApp({ dataDir: DATA, port: 7805, now: () => (fakeNow ? new Date(fakeNow) : new Date()) });
  await app.start();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext();
  const engine = await ctx.newPage(); await engine.goto('http://127.0.0.1:7805/?engine=1');
  const panel = await ctx.newPage(); await panel.goto('http://127.0.0.1:7805/');
  await sleep(800);
  const st = () => engine.evaluate(() => { const c = Engine.debug().ch.a; return c ? c.state : 'none'; });
  const day = new Date(); day.setHours(10, 0, 0, 0);
  const at = (h, m) => { const d = new Date(day); d.setHours(h, m, 0, 0); return d; };
  const save = (start, end) => panel.evaluate((s) => send({ t: 'saveSchedules', schedules: [s] }), { id: 'r1', streamId: 'a', days: [day.getDay()], start, end, enabled: true });
  // 1) 10:00–10:05 срабатывает
  await save('10:00', '10:05'); await sleep(300);
  fakeNow = at(10, 0).getTime() + 1000; app.tick(); await sleep(1200);
  check(await st() === 'playing', 'first rule time fired');
  fakeNow = at(10, 5).getTime() - 100; app.tick(); await sleep(1200);
  check(await st() === 'stopped', 'first rule end fired');
  // 2) то же правило, новое время в тот же день — снова срабатывает
  await save('12:30', '12:31'); await sleep(300);
  check(app.snapshot().config.schedules[0].id === 'r1', 'same rule id kept');
  fakeNow = at(12, 30).getTime() + 1000; app.tick(); await sleep(1200);
  check(await st() === 'playing', 'edited rule fires again same day', await st());
  fakeNow = at(12, 31).getTime() - 100; app.tick(); await sleep(1200);
  check(await st() === 'stopped', 'edited rule stops');
  // 3) ручная остановка внутри окна всё ещё уважается
  await save('13:35', '13:40'); await sleep(300);
  fakeNow = at(13, 35).getTime() + 1000; app.tick(); await sleep(1200);
  app.command({ cmd: 'stop', id: 'a' }); await sleep(800);
  fakeNow = at(13, 36).getTime(); app.tick(); await sleep(800);
  check(await st() === 'stopped', 'manual stop inside window respected');
  // 4) «Следующее» обновляется, когда время прошло
  const panelNext = () => panel.evaluate(() => (typeof S !== 'undefined' && S.next) ? S.next.start : (window.__next || null)).catch(() => null);
  const n1 = app.snapshot().next;
  check(!n1 || n1.at > fakeNow, 'server next is in the future', n1);
  const log = fs.readFileSync(path.join(DATA, 'log.txt'), 'utf8');
  check((log.match(/Schedule start/g) || []).length === 3, 'three starts logged', log.split('\n').filter((l) => /Schedule/.test(l)));
  await b.close(); await app.stop();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
