// Горячие клавиши: ввод сочетаний в окне потока и в настройках, проверки, сохранение, подсветка занятых.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');
const M = path.join(__dirname, 'media');
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hk-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (c, l, x) => { console.log((c ? 'PASS ' : 'FAIL ') + l + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 200) : '')); if (!c) fails++; };
fs.writeFileSync(path.join(D, 'config.json'), JSON.stringify({ version: 1, port: 7900, solo: true, streams: [
  { id: 'a', name: 'ВХОД', folder: path.join(M, 'Piano'), color: '#E9B44C', volume: 60 },
  { id: 'b', name: 'ПЕРЕРЫВ', folder: path.join(M, 'Lo-Fi'), color: '#2BB3A3', volume: 60, hotkey: 'Ctrl+Alt+2' }], schedules: [] }));
(async () => {
  const app = createApp({ dataDir: D, port: 7900 });
  const pauses = []; app.on('hotkeysPause', (on) => pauses.push(on));
  await app.start();
  check(app.snapshot().config.hotkeys && app.snapshot().config.hotkeys.stopAll === '', 'old config gets empty global hotkeys');
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1120, height: 820 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('ppHelpSeen', '1'); } catch (e) {} });
  const p = await ctx.newPage(); await p.goto('http://127.0.0.1:7900/?engine=1'); await sleep(1000);
  check(await p.evaluate(() => [...document.querySelectorAll('.tag.hk')].map((t) => t.textContent).join('|')) === 'Ctrl + Alt + 2', 'card shows hotkey tag');
  // окно потока
  await p.evaluate(() => openEditor('a')); await sleep(300);
  await p.click('#fHotkey'); await sleep(100);
  check(pauses[pauses.length - 1] === true, 'focus pauses hotkeys in the app');
  await p.keyboard.press('Control+Digit1'); await sleep(100);
  check(/двух клавиш-модификаторов/.test(await p.textContent('#fHotkeyHint')), 'Ctrl+1 rejected (needs 2 modifiers)');
  await p.keyboard.press('KeyK'); await sleep(100);
  check(/двух клавиш-модификаторов/.test(await p.textContent('#fHotkeyHint')), 'single letter rejected');
  await p.keyboard.press('Control+Alt+Digit2'); await sleep(100);
  check(/уже назначено потоку «ПЕРЕРЫВ»/.test(await p.textContent('#fHotkeyHint')), 'duplicate rejected', await p.textContent('#fHotkeyHint'));
  await p.keyboard.press('Control+Alt+Digit1'); await sleep(200);
  check(await p.inputValue('#fHotkey') === 'Ctrl + Alt + 1' && await p.evaluate(() => document.activeElement.id) !== 'fHotkey', 'Ctrl+Alt+1 accepted, field left');
  check(pauses[pauses.length - 1] === false, 'blur resumes hotkeys');
  await p.click('#saveBtn'); await sleep(800);
  check(app.snapshot().config.streams.find((x) => x.id === 'a').hotkey === 'Ctrl+Alt+1', 'saved with stream');
  // F13 без модификаторов — можно; Backspace — убрать
  await p.evaluate(() => openEditor('b')); await sleep(300);
  await p.click('#fHotkey'); await p.evaluate(() => document.querySelector('#fHotkey').dispatchEvent(new KeyboardEvent('keydown', { key: 'F13', code: 'F13', bubbles: true, cancelable: true }))); await sleep(200);
  check(await p.inputValue('#fHotkey') === 'F13', 'F13 alone accepted');
  await p.click('#fHotkey'); await p.keyboard.press('Backspace'); await sleep(200);
  check(await p.inputValue('#fHotkey') === '', 'Backspace clears');
  await p.click('#fHotkey'); await p.keyboard.press('Control+Shift+Numpad5'); await sleep(200);
  check(await p.inputValue('#fHotkey') === 'Ctrl + Shift + Num 5', 'numpad key', await p.inputValue('#fHotkey'));
  await p.click('#fHotkey'); await p.keyboard.press('Escape'); await sleep(200);
  check(await p.inputValue('#fHotkey') === 'Ctrl + Shift + Num 5', 'Esc keeps previous value');
  await p.click('#saveBtn'); await sleep(800);
  check(app.snapshot().config.streams.find((x) => x.id === 'b').hotkey === 'Ctrl+Shift+num5', 'saved numpad as Electron accelerator');
  // настройки
  await p.click('#tabs button[data-tab=settings]'); await sleep(200);
  await p.click('#hkStopAll'); await p.keyboard.press('Control+Alt+Digit1'); await sleep(200);
  check(/уже назначено потоку «ВХОД»/.test(await p.textContent('#hkSetHint')), 'settings: duplicate with stream rejected');
  await p.keyboard.press('Control+Alt+Digit0'); await sleep(600);
  await p.click('#hkNext'); await p.keyboard.press('Control+Alt+KeyN'); await sleep(600);
  const hk = app.snapshot().config.hotkeys;
  check(hk.stopAll === 'Ctrl+Alt+0' && hk.next === 'Ctrl+Alt+N', 'settings hotkeys saved', hk);
  // сочетание занято другой программой
  app.setHotkeyStatus({ failed: ['Ctrl+Alt+N', 'Ctrl+Alt+1'] }); await sleep(300);
  check(/Ctrl \+ Alt \+ N уже занято другой программой/.test(await p.textContent('#hkSetHint')) && await p.evaluate(() => document.querySelector('#hkNext').classList.contains('bad')), 'settings: busy hotkey highlighted');
  await p.click('#tabs button[data-tab=streams]'); await sleep(200);
  check(await p.evaluate(() => !!document.querySelector('.tag.hk.bad')), 'card: busy hotkey highlighted');
  // серверная проверка мусора
  await p.evaluate((F) => send({ t: 'saveStream', stream: { id: 'a', name: 'ВХОД', folder: F, hotkey: 'rm -rf' } }), path.join(M, 'Piano')); await sleep(300);
  check(app.snapshot().config.streams.find((x) => x.id === 'a').hotkey === '', 'server rejects invalid hotkey string');
  await p.screenshot({ path: path.join(__dirname, 'out', 'hk_cards.png'), clip: { x: 0, y: 150, width: 1120, height: 420 } });
  await p.click('#tabs button[data-tab=settings]'); await sleep(200);
  await p.screenshot({ path: path.join(__dirname, 'out', 'hk_settings.png') });
  await p.evaluate(() => openEditor('b')); await sleep(300);
  await p.screenshot({ path: path.join(__dirname, 'out', 'hk_editor.png') });
  await b.close(); await app.stop();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
