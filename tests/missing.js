// Папку потока удалили — на карточке «Папка не найдена»; пустая папка — «В папке нет треков».
const path = require('path'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-miss-'));
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-empty-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x) : '')); if (!c) fails++; };
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ version: 1, port: 7809, solo: true, streams: [
  { id: 'a', name: 'НЕТ', folder: path.join(EMPTY, 'gone'), color: '#6A994E', volume: 50, fadeIn: 0.2, fadeOut: 0.2, crossfade: 0 },
  { id: 'b', name: 'ПУСТО', folder: EMPTY, color: '#4F86C6', volume: 50, fadeIn: 0.2, fadeOut: 0.2, crossfade: 0 }], schedules: [] }));
(async () => {
  const app = createApp({ dataDir: DATA, port: 7809 }); await app.start();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext();
  const engine = await ctx.newPage(); await engine.goto('http://127.0.0.1:7809/?engine=1');
  const panel = await ctx.newPage(); await panel.goto('http://127.0.0.1:7809/'); await sleep(800);
  app.command({ cmd: 'play', id: 'a' }); await sleep(1200); app.command({ cmd: 'play', id: 'b' }); await sleep(1500);
  const t = await panel.evaluate(() => [...document.querySelectorAll('.track')].map((e) => e.textContent));
  check(t.includes('Папка не найдена'), 'missing folder shown', t);
  check(t.includes('В папке нет треков'), 'empty folder shown', t);
  const tags = await panel.evaluate(() => document.querySelector('#streams').textContent);
  check(!/плавно|переход \d/.test(tags), 'no fade tags on cards');
  await b.close(); await app.stop(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
