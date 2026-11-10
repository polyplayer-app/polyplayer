// Резервная копия настроек и продолжение музыки после сбоя окна-проигрывателя.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const MEDIA = path.join(__dirname, 'media');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 200) : '')); if (!c) fails++; };
const cfg = (port) => ({ version: 1, port, solo: true, streams: [
  { id: 'a', name: 'ПЕРЕРЫВ', folder: path.join(MEDIA, 'Piano'), color: '#6A994E', shuffle: false, loop: true, volume: 50, fadeIn: 0.2, fadeOut: 0.2, crossfade: 0 },
  { id: 'b', name: 'ФОН', folder: path.join(MEDIA, 'Lo-Fi'), color: '#E85D2E', shuffle: false, loop: true, volume: 50, fadeIn: 0.2, fadeOut: 0.2, crossfade: 0 }], schedules: [] });
(async () => {
  // --- 1. резервная копия ---
  const D = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-rb-'));
  fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify(cfg(7806)));
  let app = createApp({ dataDir: D, port: 7806 }); await app.start(); await app.stop();
  check(fs.existsSync(path.join(D, 'config.backup.json')), 'backup created on start');
  fs.writeFileSync(path.join(D, 'config.json'), '{"version":1,"streams":[{"id":"a"'); // «обрезанный» файл
  app = createApp({ dataDir: D, port: 7806 }); await app.start();
  check(app.snapshot().config.streams.length === 2, 'damaged config → restored from backup', app.snapshot().config.streams.map((s) => s.name));
  check(fs.readdirSync(D).some((f) => /^config\.broken-/.test(f)), 'damaged file kept');
  check(/restored from config.backup.json/.test(fs.readFileSync(path.join(D, 'log.txt'), 'utf8')), 'restore logged');
  await app.stop();
  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-rb-'));
  fs.writeFileSync(path.join(D2, 'config.json'), 'garbage');
  app = createApp({ dataDir: D2, port: 7806 }); await app.start();
  check(app.snapshot().config.streams.length === 0 && fs.readdirSync(D2).some((f) => /^config\.broken-/.test(f)), 'no backup → empty start, damaged file kept');
  await app.stop();

  // --- 2. сбой окна: что играло — снова играет ---
  const D3 = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-rb-'));
  fs.writeFileSync(path.join(D3, 'config.json'), JSON.stringify(cfg(7807)));
  let relaunch = 0;
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext();
  let page = null;
  const open = async () => { page = await ctx.newPage(); await page.goto('http://127.0.0.1:7807/?engine=1'); };
  app = createApp({ dataDir: D3, port: 7807, launchHook: () => { relaunch++; setTimeout(open, 300); } });
  await app.start();
  await open(); await sleep(800);
  const st = (id) => page.evaluate((i) => { const c = Engine.debug().ch[i]; return c ? c.state : 'none'; }, id);
  app.command({ cmd: 'play', id: 'a' }); await sleep(1500);
  check(await st('a') === 'playing', 'stream playing before crash');
  await page.close(); // «сбой» окна
  await sleep(2500);
  check(relaunch === 1, 'player relaunched', relaunch);
  check(await st('a') === 'playing' && await st('b') !== 'playing', 'playing stream resumed after crash', [await st('a'), await st('b')]);
  // остановленный поток после сбоя не включается
  app.command({ cmd: 'stop', id: 'a', fade: 0 }); await sleep(800);
  const r0 = relaunch;
  await page.close(); await sleep(1000);
  check(relaunch === r0, 'nothing to resume → no relaunch request');
  await open(); await sleep(1500); // в программе окно перезагружает main.js
  check(await st('a') !== 'playing', 'stopped stream stays stopped after crash', await st('a'));
  // выход из программы — ничего не возобновляется
  app.command({ cmd: 'play', id: 'b' }); await sleep(1500);
  const rl = relaunch;
  await app.stop(); await sleep(1000);
  check(relaunch === rl, 'no relaunch when app quits');
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
