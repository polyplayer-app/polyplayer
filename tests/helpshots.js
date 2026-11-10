// Скриншоты для справки: настоящие окна программы с примером «Плейлист 1 / 2».
const path = require('path');
const PKG = require('../package.json'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const M = path.join(__dirname, 'media');
const OUT = path.join(__dirname, '..', 'app', 'public', 'help');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hs-'));
fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify({ version: 1, port: 7880, solo: true, autoOpen: true, streams: [
  { id: 'a', name: 'ПЛЕЙЛИСТ 1', folder: path.join(M, 'Плейлист 1'), color: '#6A994E', volume: 70, fadeIn: 3, fadeOut: 3, crossfade: 5, shuffle: true, loop: true },
  { id: 'b', name: 'ПЛЕЙЛИСТ 2', folder: path.join(M, 'Lo-Fi'), color: '#4F86C6', volume: 55, fadeIn: 3, fadeOut: 3, crossfade: 5, shuffle: true, loop: true }],
  schedules: [{ id: 'r1', streamId: 'a', days: [0], start: '09:40', end: '09:55', enabled: true }, { id: 'r2', streamId: '*', days: [0], start: '', end: '10:00', enabled: true }] }));
(async () => {
  const app = createApp({ dataDir: D, port: 7880, about: { version: PKG.version, date: PKG.releaseDate, plugin: true } }); await app.start();
  app.setUpdate({ current: PKG.version, status: 'latest', checkedAt: new Date().toISOString(), url: 'https://github.com/' });
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'], env: Object.assign({}, process.env, { LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' }) });
  const ctx = await b.newContext({ viewport: { width: 1120, height: 760 }, deviceScaleFactor: 2, locale: 'ru-RU' });
  await ctx.addInitScript(() => { try { localStorage.setItem('ppHelpSeen', '1'); } catch (e) {} });
  const p = await ctx.newPage(); await p.goto('http://127.0.0.1:7880/?engine=1'); await p.waitForTimeout(1200);
  const shot = async (name, sel, pad = 10, extra) => {
    const box = await p.locator(sel).first().boundingBox();
    const clip = Object.assign({ x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 }, extra || {});
    await p.screenshot({ path: path.join(OUT, name), clip });
  };
  // 1. новая карточка
  await shot('new-card.png', '.add-card', 12);
  // 2–4. окно потока
  await p.evaluate(() => openEditor(null)); await p.waitForTimeout(300);
  await p.fill('#fName', 'ПЛЕЙЛИСТ 1'); await p.evaluate(() => document.querySelector('#fName').dispatchEvent(new Event('input')));
  await p.fill('#fFolder', path.join(M, 'Плейлист 1')); await p.evaluate(() => { document.querySelector('#fFolder').dispatchEvent(new Event('change')); });
  await p.waitForTimeout(500);
  await p.evaluate(() => { const f = document.querySelector('#fFolder'); f.value = 'C:\\Users\\Музыка\\Плейлист 1'; const i = document.querySelector('#folderInfo'); i.className = 'folder-info ok'; i.textContent = 'Найдено треков: 24'; });
  const fields = p.locator('#editView .field');
  const b0 = await fields.nth(0).boundingBox(), b1 = await fields.nth(1).boundingBox();
  await p.screenshot({ path: path.join(OUT, 'name.png'), clip: { x: b0.x - 10, y: b0.y - 10, width: b0.width + 20, height: b0.height + 20 } });
  await p.screenshot({ path: path.join(OUT, 'folder.png'), clip: { x: b1.x - 10, y: b1.y - 10, width: b1.width + 20, height: b1.height + 20 } });
  const dlgBox = await p.locator('#editView').boundingBox();
  await p.screenshot({ path: path.join(OUT, 'stream-settings.png'), clip: { x: dlgBox.x, y: b1.y + b1.height + 4, width: dlgBox.width, height: dlgBox.y + dlgBox.height - (b1.y + b1.height + 4) } });
  await p.evaluate(() => document.querySelector('#editDlg').close());
  // 5. играющая карточка, «Стоп всё»
  app.command({ cmd: 'play', id: 'a' }); await p.waitForTimeout(2500);
  await shot('card.png', '.card', 10);
  const hb = await p.locator('#stopAll').boundingBox();
  await p.screenshot({ path: path.join(OUT, 'stop-all.png'), clip: { x: hb.x - 14, y: hb.y - 14, width: hb.width + 28, height: hb.height + 28 } });
  app.command({ cmd: 'stopAll', fade: 0 }); await p.waitForTimeout(800);
  // 6. расписание
  await p.click('#tabs button[data-tab=sched]'); await p.waitForTimeout(300);
  const nb = await p.locator('#nextRun').boundingBox(), lb = await p.locator('#sched').boundingBox(), ab = await p.locator('#addSched').boundingBox();
  await p.screenshot({ path: path.join(OUT, 'schedule.png'), clip: { x: lb.x - 10, y: nb.y - 10, width: lb.width + 20, height: ab.y + ab.height - nb.y + 20 } });
  // 7. настройки
  await p.click('#tabs button[data-tab=settings]'); await p.waitForTimeout(300);
  const sb = await p.locator('section[data-pane=settings]').boundingBox();
  await p.screenshot({ path: path.join(OUT, 'settings.png'), clip: { x: sb.x - 10, y: sb.y - 10, width: sb.width + 20, height: sb.height + 20 } });
  await b.close(); await app.stop();
})().catch((e) => { console.error(e); process.exit(1); });
