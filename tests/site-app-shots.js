// Снимки для страницы скачивания: главное окно, расписание, кнопки пульта.
const path = require('path');
const PKG = require('../package.json'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const M = path.join(__dirname, 'media', 'showcase');
const OUT = process.env.OUT || path.join(__dirname, '..', 'docs', 'img');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ls-'));
fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify({ version: 1, port: 7895, solo: true, autoOpen: true, streams: [
  { id: 'a', name: 'ВХОД', folder: path.join(M, 'Вход'), color: '#E9B44C', volume: 70, fadeIn: 3, fadeOut: 3, crossfade: 6, shuffle: true, loop: true },
  { id: 'b', name: 'ПЕРЕРЫВ', folder: path.join(M, 'Перерыв'), color: '#2BB3A3', volume: 60, fadeIn: 3, fadeOut: 3, crossfade: 6, shuffle: true, loop: true },
  { id: 'c', name: 'ФИНАЛ', folder: path.join(M, 'Финал'), color: '#4F86C6', volume: 65, fadeIn: 3, fadeOut: 4, crossfade: 6, shuffle: false, loop: true }],
  schedules: [
    { id: 'r1', streamId: 'a', days: [1, 2, 3, 4, 5], start: '09:40', end: '09:58', enabled: true },
    { id: 'r2', streamId: 'b', days: [1, 2, 3, 4, 5], start: '12:30', end: '13:00', enabled: true },
    { id: 'r3', streamId: '*', days: [1, 2, 3, 4, 5], start: '', end: '18:00', enabled: true }] }));
(async () => {
  const app = createApp({ dataDir: D, port: 7895, about: { version: PKG.version, date: PKG.releaseDate, plugin: true } }); await app.start();
  app.setUpdate({ current: PKG.version, status: 'latest', checkedAt: new Date().toISOString(), url: '' });
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'], env: Object.assign({}, process.env, { LANG: 'ru_RU.UTF-8' }) });
  const ctx = await b.newContext({ viewport: { width: 1180, height: 640 }, deviceScaleFactor: 2, locale: 'ru-RU' });
  await ctx.addInitScript(() => { try { localStorage.setItem('ppHelpSeen', '1'); } catch (e) {} });
  const p = await ctx.newPage(); await p.goto('http://127.0.0.1:7895/?engine=1'); await p.waitForTimeout(1500);
  app.command({ cmd: 'play', id: 'a' }); await p.waitForTimeout(1800);
  app.command({ cmd: 'seek', id: 'a', value: 74 }); await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(OUT, 'app-main.png'), clip: { x: 0, y: 0, width: 1180, height: 356 } });
  await p.click('#tabs button[data-tab=sched]'); await p.waitForTimeout(300);
  const nb = await p.locator('#nextRun').boundingBox(), lb = await p.locator('#sched').boundingBox();
  await p.screenshot({ path: path.join(OUT, 'app-schedule.png'), clip: { x: lb.x - 12, y: nb.y - 6, width: Math.min(1160, lb.width + 24), height: lb.y + lb.height - nb.y + 18 } });
  await b.close(); await app.stop();
})().catch((e) => { console.error(e); process.exit(1); });
