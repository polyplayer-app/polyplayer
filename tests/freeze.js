// «Замороженная» страница-проигрыватель: сервер должен заметить, разбудить окно и выполнить команду один раз.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const MEDIA = path.join(__dirname, 'media');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-fz-'));
const TRAYLOG = path.join(DATA, 'tray.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!c) fails++; };
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ version: 1, port: 7801, autoOpen: false, streams: [
  { id: 'a', name: 'A', folder: path.join(MEDIA, 'Piano'), color: '#E85D2E', shuffle: false, loop: true, solo: true, volume: 50, fadeIn: 0.5, fadeOut: 0.5, crossfade: 0 } ], schedules: [] }));
(async () => {
  const app = createApp({ dataDir: DATA, trayProvider: require('./fake_tray_provider.js')(TRAYLOG) });
  await app.start();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:7801/?engine=1');
  await sleep(1500);
  const cdp = await ctx.newCDPSession(page);
  const st = () => page.evaluate(() => { const c = Engine.debug().ch.a; return c ? c.state : 'none'; });
  // нормальная работа: команда подтверждается
  app.command({ cmd: 'toggle', id: 'a' }); await sleep(1200);
  check(await st() === 'playing', 'normal toggle works');
  app.command({ cmd: 'toggle', id: 'a' }); await sleep(1000);
  check(await st() === 'paused', 'normal toggle back');
  // замораживаем страницу (как это делает браузер со скрытыми окнами)
  await page.evaluate(() => { window.__q = []; window.__orig = ws.onmessage; ws.onmessage = (e) => window.__q.push(e); window.__send = send; send = () => {}; });
  await sleep(500);
  app.command({ cmd: 'toggle', id: 'a' }); // уходит в замороженную страницу
  // ждём, пока сервер заметит и попросит помощника «разбудить» окно
  let kicked = false;
  for (let i = 0; i < 40 && !kicked; i++) { await sleep(250); kicked = fs.existsSync(TRAYLOG) && fs.readFileSync(TRAYLOG, 'utf8').includes('CMD kick'); }
  check(kicked, 'server detected frozen page and sent kick');
  await page.evaluate(() => { send = window.__send; ws.onmessage = window.__orig; for (const e of window.__q) window.__orig(e); window.__q = []; }); // «проснулась»
  await sleep(3000);
  check(await st() === 'playing', 'command executed after wake-up — exactly once (toggle not doubled)', await st());
  // долгая заморозка: команда старше 30 с не выполняется, но и не ломает ничего
  check(fs.readFileSync(path.join(DATA, 'log.txt'), 'utf8').includes('Engine not responding'), 'logged');
  // замороженная страница + расписание/команда, пока «спит»: команда ставится в очередь и выполняется после пробуждения
  await page.evaluate(() => { window.__q = []; window.__orig = ws.onmessage; ws.onmessage = (e) => window.__q.push(e); window.__send = send; send = () => {}; });
  await sleep(10000); // сердцебиение пропало
  app.command({ cmd: 'stop', id: 'a' });
  await sleep(1000);
  await page.evaluate(() => { send = window.__send; ws.onmessage = window.__orig; for (const e of window.__q) window.__orig(e); window.__q = []; });
  await sleep(3500);
  check(await st() === 'stopped', 'command issued while known-frozen runs after wake', await st());
  // долгое «зависание»: тихое пробуждение не помогло — окно показывается на миг и снова прячется
  const FREEZE = "window.__q = []; window.__orig = ws.onmessage; ws.onmessage = (e) => window.__q.push(e); window.__send = send; send = () => {};";
  const THAW = "send = window.__send; ws.onmessage = window.__orig; for (const e of window.__q) window.__orig(e); window.__q = [];";
  fs.writeFileSync(TRAYLOG, '');
  await page.evaluate(FREEZE);
  app.command({ cmd: 'toggle', id: 'a' });
  await sleep(17000);
  check(fs.readFileSync(TRAYLOG, 'utf8').includes('CMD show'), 'escalation: window shown after ~12 s of no answer');
  await page.evaluate(THAW);
  await sleep(3000);
  const tl = fs.readFileSync(TRAYLOG, 'utf8');
  check(tl.lastIndexOf('CMD hide') > tl.lastIndexOf('CMD show'), 'window hidden again once player answered', tl.trim().split('\n'));

  // окно «заснуло» вместе с компьютером, пришла команда, потом окно отвалилось — команда не должна потеряться
  await page.evaluate(() => { window.__q = []; window.__orig = ws.onmessage; ws.onmessage = (e) => window.__q.push(e); window.__send = send; send = () => {}; });
  app.command({ cmd: 'toggle', id: 'a' });
  await sleep(500);
  await page.close();
  await sleep(800);
  check(app.windowState() === 'starting', 'player re-launch requested after disconnect with pending command', app.windowState());
  const page2 = await ctx.newPage();
  await page2.goto('http://127.0.0.1:7801/?engine=1');
  await sleep(2500);
  const st2 = await page2.evaluate(() => { const c = Engine.debug().ch.a; return c ? c.state : 'none'; });
  check(st2 === 'playing', 'lost command executed in reopened player', st2);
  check(fs.readFileSync(path.join(DATA, 'log.txt'), 'utf8').includes('Re-opening player'), 'logged re-open');
  await b.close(); await app.stop();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
