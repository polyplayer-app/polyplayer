// Окно о новой версии, версия в справке/настройках, ввод названия с раскладкой для кнопки.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const M = path.join(__dirname, 'media');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 200) : '')); if (!c) fails++; };
fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify({ version: 1, port: 7860, solo: true, streams: [
  { id: 'a', name: 'ПЛЕЙЛИСТ 1', folder: path.join(M, 'Piano'), color: '#6A994E', volume: 60, fadeIn: 0.3, fadeOut: 0.3, crossfade: 0, shuffle: false, loop: true }], schedules: [] }));
(async () => {
  const app = createApp({ dataDir: D, port: 7860, about: { version: '3.0.3', date: '2026-11-05' } });
  const cmds = []; app.on('updateCmd', (c) => cmds.push(c));
  await app.start();
  app.setUpdate({ current: '3.0.3', status: 'latest', checkedAt: new Date().toISOString(), url: 'https://github.com/x/y/releases/tag/v3.0.3' });
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1120, height: 800 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('ppHelpSeen', '1'); } catch (e) {} });
  const p = await ctx.newPage(); await p.goto('http://127.0.0.1:7860/?engine=1'); await sleep(1200);
  // раскладка для существующего потока досчитана окном программы
  const k = app.snapshot().config.streams[0].keyLayout;
  check(k && k.name === 'ПЛЕЙЛИСТ 1' && k.lines.length >= 1 && k.size <= 21, 'key layout filled for existing stream', k);
  // версия
  check(await p.evaluate(() => document.querySelector('#helpVer').textContent) === 'PolyPlayer 3.0.3 · от 5 ноября 2026', 'version line in help header', await p.evaluate(() => document.querySelector('#helpVer').textContent));
  await p.click('#tabs button[data-tab=settings]'); await sleep(200);
  const st = await p.evaluate(() => [document.querySelector('#updHead').textContent, document.querySelector('#updText').textContent, !document.querySelector('#updNews').hidden]);
  check(st[0] === 'Версия 3.0.3 · от 5 ноября 2026' && /Последняя проверка обновлений: сегодня в \d\d:\d\d — у вас последняя версия/.test(st[1]) && st[2], 'settings: version + last check + «Что нового»', st);
  // «Стоп всё» неактивна, пока ничего не играет
  check(await p.evaluate(() => document.querySelector('#stopAll').disabled), '«Стоп всё» disabled when silent');
  // вышла новая версия → окно с описанием
  const U = (x) => Object.assign({ current: '3.0.3', version: '3.0.3', notes: '**Что нового**\n- Первое\n- `Второе`', url: 'https://github.com/x/y/releases/tag/v3.0.3', checkedAt: new Date().toISOString(), dismissed: '', got: 0, total: 117000000, progress: 0 }, x);
  app.setUpdate(U({ status: 'available' })); await sleep(500);
  const dlg = () => p.evaluate(() => { const vis = (s) => getComputedStyle(document.querySelector(s)).display !== 'none'; return { open: document.querySelector('#updDlg').open, title: document.querySelector('#updDlgTitle').textContent, later: vis('#updDlgLater'), now: !vis('#updDlgNow') ? null : document.querySelector('#updDlgNow').textContent, notes: vis('#updDlgNotes'), prog: vis('#updDlgProg'), progText: document.querySelector('#updDlgProgText').textContent }; });
  let d = await dlg();
  check(d.open && d.title === 'Вышла версия 3.0.3' && d.later && d.now === 'Скачать и обновить' && d.notes, 'available: dialog with notes, «Скачать и обновить» / «Позже»', d);
  check(await p.evaluate(() => document.querySelectorAll('#updDlgNotes li').length) === 2, 'release notes rendered');
  await p.click('#updDlgLater'); await sleep(300);
  check(cmds.includes('later') && !(await dlg()).open, '«Позже» closes and tells the app');
  app.setUpdate(U({ status: 'available', dismissed: '3.0.3' })); await sleep(300);
  check(!(await dlg()).open, 'not shown again after «Позже»');
  await p.click('#tabs button[data-tab=settings]'); await sleep(200);
  check(await p.evaluate(() => document.querySelector('#updBtn').textContent) === 'Скачать и обновить' && /Доступна новая версия 3.0.3/.test(await p.evaluate(() => document.querySelector('#updText').textContent)), 'settings: «Доступна новая версия» + «Скачать и обновить»');
  check(await p.evaluate(() => !document.querySelector('.updot').hidden), 'dot on settings tab');
  // скачивание из «Настроек» → прогресс → окно о перезапуске
  await p.click('#updBtn'); await sleep(200);
  check(cmds.includes('download'), 'settings button starts download');
  app.setUpdate(U({ status: 'downloading', dismissed: '3.0.3', got: 50000000, progress: 42 })); await sleep(300);
  const st2 = await p.evaluate(() => [document.querySelector('#updText').textContent, !document.querySelector('#updBar').hidden, document.querySelector('#updBarFill').style.width]);
  check(/скачано 47,7 МБ из 111,6 МБ \(42%\)/.test(st2[0]) && st2[1] && st2[2] === '42%', 'settings: download progress in MB', st2);
  app.command({ cmd: 'play', id: 'a' }); await sleep(1500);
  app.setUpdate(U({ status: 'ready', dismissed: '3.0.3', got: 117000000, total: 117000000, progress: 100 })); await sleep(400);
  check(!(await dlg()).open, 'ready while music plays: restart dialog waits');
  check(await p.evaluate(() => document.querySelector('#updBtn').disabled), 'settings restart button disabled while playing');
  app.command({ cmd: 'stopAll', fade: 0 }); await sleep(1200);
  d = await dlg();
  check(d.open && d.title === 'Обновление готово' && !d.later && d.now === 'Перезапустить', 'music stopped → «Обновление готово» with one button', d);
  await p.keyboard.press('Escape'); await sleep(200);
  check((await dlg()).open, 'Esc does not close the restart dialog');
  await p.click('#updDlgNow'); await sleep(200);
  check(cmds.includes('install'), '«Перезапустить» sends install');
  // путь через окно: «Скачать и обновить» → прогресс в окне
  app.setUpdate(U({ status: 'available', version: '3.0.4' })); await sleep(400);
  await p.click('#updDlgNow'); await sleep(200);
  app.setUpdate(U({ status: 'downloading', version: '3.0.4', got: 10485760, progress: 9 })); await sleep(300);
  d = await dlg();
  check(d.open && d.title === 'Скачиваю версию 3.0.4' && d.prog && /Скачано 10 МБ из 111,6 МБ/.test(d.progText) && d.now === null, 'dialog shows download progress', d);
  await p.click('#updDlgLater'); await sleep(200);
  app.setUpdate(U({ status: 'downloading', version: '3.0.4', got: 20971520, progress: 18 })); await sleep(300);
  check(!(await dlg()).open, '«Скрыть» hides progress window (download continues)');
  app.setUpdate(U({ status: 'ready', version: '3.0.4', progress: 100 })); await sleep(300);
  check((await dlg()).title === 'Обновление готово', 'restart dialog after hidden download');
  await p.click('#updDlgNow'); await sleep(200);
  // окно не показывается в браузерной вкладке (панель)
  const panel = await ctx.newPage(); await panel.goto('http://127.0.0.1:7860/'); await sleep(600);
  app.setUpdate(U({ status: 'available', version: '3.0.5' })); await sleep(400);
  check(!(await panel.evaluate(() => document.querySelector('#updDlg').open)), 'panel tab: no update dialog');
  app.setUpdate({ current: '3.0.3', status: 'latest', checkedAt: new Date().toISOString() }); await sleep(300);
  await p.evaluate(() => { const d = document.querySelector('#updDlg'); if (d.open) d.close(); });
  // ввод названия
  await p.click('#tabs button[data-tab=streams]'); await sleep(200);
  await p.evaluate(() => openEditor(null)); await sleep(300);
  const nm = p.locator('#fName');
  await nm.fill(''); await nm.pressSequentially('ПЕРЕРЫВ НА ЗАВТРА', { delay: 5 });
  check(await nm.inputValue() === 'ПЕРЕРЫВ НА ЗАВТРА', 'normal name typed');
  const lines1 = await p.evaluate(() => [...document.querySelectorAll('#keyPrev text')].map((t) => [t.textContent, +t.getAttribute('font-size')]));
  check(lines1.length === 2 && lines1[0][1] === lines1[1][1], 'preview: 2 lines, same size', lines1);
  await nm.pressSequentially(' И ЕЩЁ ОЧЕНЬ ДЛИННОЕ ПРОДОЛЖЕНИЕ', { delay: 5 });
  const v = await nm.inputValue();
  check(v.length < 'ПЕРЕРЫВ НА ЗАВТРА И ЕЩЁ ОЧЕНЬ ДЛИННОЕ ПРОДОЛЖЕНИЕ'.length && v.startsWith('ПЕРЕРЫВ НА ЗАВТРА'), 'typing stops when it no longer fits', v);
  check(await p.evaluate(() => document.querySelector('#nameHint').classList.contains('bad')), 'hint: does not fit');
  const fit = await p.evaluate(() => { const l = keyLayoutFor(document.querySelector('#fName').value); return l && l.lines.length <= 2 && l.size >= KeyName.FONT_MIN; });
  check(fit, 'what was accepted fits at ≥ min size in ≤ 2 lines');
  // вставка длинного текста — обрезается
  await nm.fill(''); await p.evaluate(() => { const el = document.querySelector('#fName'); el.value = 'ОДИН ДВА ТРИ ЧЕТЫРЕ ПЯТЬ ШЕСТЬ СЕМЬ ВОСЕМЬ ДЕВЯТЬ'; el.dispatchEvent(new Event('input')); });
  const pv = await nm.inputValue();
  check(pv.length > 0 && pv.length < 45 && 'ОДИН ДВА ТРИ ЧЕТЫРЕ ПЯТЬ ШЕСТЬ СЕМЬ ВОСЕМЬ ДЕВЯТЬ'.startsWith(pv), 'pasted text trimmed to what fits', pv);
  // сохранение — раскладка уходит в настройки
  await nm.fill('ПЛЕЙЛИСТ 2'); await p.evaluate(() => document.querySelector('#fName').dispatchEvent(new Event('input')));
  await p.fill('#fFolder', path.join(M, 'Lo-Fi')); await p.click('#saveBtn'); await sleep(800);
  const s2 = app.snapshot().config.streams.find((x) => x.name === 'ПЛЕЙЛИСТ 2');
  check(s2 && s2.keyLayout && s2.keyLayout.name === 'ПЛЕЙЛИСТ 2' && s2.keyLayout.lines.join(' ') === 'ПЛЕЙЛИСТ 2', 'saved stream has key layout', s2 && s2.keyLayout);
  // переименовали поток без раскладки (например, через старую версию) — раскладка пересчитывается
  await p.evaluate(() => send({ t: 'saveStream', stream: { id: 'a', name: 'ФОН ДЛЯ ЗАЛА', folder: '' } }));
  await sleep(300);
  const sa = app.snapshot().config.streams.find((x) => x.id === 'a');
  check(sa.name === 'ПЛЕЙЛИСТ 1' || (sa.keyLayout && sa.keyLayout.name === sa.name), 'layout stays consistent with name', sa);
  await b.close(); await app.stop();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
