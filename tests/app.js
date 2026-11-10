// Интеграционный тест: сервер SWP Player + окно-движок в Chromium.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../app/server.js');

const MEDIA = path.join(__dirname, 'media');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'swp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fakeNow = null;
let fails = 0;
function check(cond, label, extra) { console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails++; }

(async () => {
  const app = createApp({ dataDir: DATA, port: 7790, noLaunch: true, now: () => (fakeNow ? new Date(fakeNow) : new Date()) });
  const port = await app.start();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1120, height: 900 } });
  const errors = [];
  let engine = await ctx.newPage();
  engine.on('pageerror', (e) => errors.push('engine: ' + e.message));
  engine.on('console', (m) => { if (m.type() === 'error') errors.push('engine console: ' + m.text()); });
  await engine.goto('http://127.0.0.1:' + port + '/?engine=1');
  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
  await panel.goto('http://127.0.0.1:' + port + '/');
  await sleep(500);

  check(app.snapshot().engineOnline, 'engine connected');
  check(await panel.evaluate(() => role) === 'panel', 'panel role');

  // create streams through panel websocket
  await panel.evaluate((m) => {
    send({ t: 'saveStream', stream: { name: 'Piano', folder: m + '/Piano', fadeIn: 2, fadeOut: 2 } });
    send({ t: 'saveStream', stream: { name: 'Lo-Fi объявления', folder: m + '/Lo-Fi', solo: true, fadeIn: 1, fadeOut: 1 } });
    send({ t: 'saveStream', stream: { name: 'Outro', folder: m + '/Outro', shuffle: false, loop: false, fadeIn: 0, fadeOut: 0 } });
  }, MEDIA);
  await sleep(400);
  const streams = app.snapshot().config.streams;
  check(streams.length === 3, '3 streams saved', streams.map((s) => s.name));
  const [P, L, O] = streams.map((s) => s.id);
  check(fs.existsSync(path.join(DATA, 'config.json')), 'config persisted');

  const eng = (id) => engine.evaluate((id) => {
    const d = Engine.debug(); const c = d.ch[id];
    if (!c) return null;
    return { state: c.state, gain: +d.curGain(c).toFixed(3), real: +c.gain.gain.value.toFixed(3), t: +c.audio.currentTime.toFixed(2), paused: c.audio.paused, track: c.track, src: c.audio.getAttribute('src'), err: c.error, ctx: d.ctx.state };
  }, id);

  // play with fade in
  app.command({ cmd: 'toggle', id: P });
  await sleep(700);
  let e1 = await eng(P);
  check(e1 && e1.state === 'playing' && !e1.paused, 'piano playing', e1);
  check(e1.gain > 0.01 && e1.gain < 0.3, 'fade-in in progress', e1.gain);
  await sleep(1800);
  e1 = await eng(P);
  check(Math.abs(e1.gain - 0.36) < 0.01 && Math.abs(e1.real - 0.36) < 0.02, 'reached volume 60% (gain .36)', e1);
  check(app.snapshot().runtime[P].state === 'playing' && app.snapshot().runtime[P].total === 3, 'runtime reported to server', app.snapshot().runtime[P]);
  check(await panel.evaluate((id) => document.querySelector('[data-id="' + id + '"]').className, P) === 'card playing', 'panel card shows playing');

  // volume
  app.command({ cmd: 'volumeDelta', id: P, value: 10 });
  await sleep(300);
  e1 = await eng(P);
  check(Math.abs(e1.gain - 0.49) < 0.01, 'volume +10 → gain .49', e1.gain);

  // pause with fade out, resume same position
  app.command({ cmd: 'toggle', id: P });
  await sleep(900);
  e1 = await eng(P);
  check(e1.state === 'paused' && e1.gain > 0.02 && e1.gain < 0.49, 'fading out', e1);
  await sleep(1400);
  e1 = await eng(P);
  check(e1.paused && e1.real < 0.001, 'paused & silent after fade', e1);
  const posAtPause = e1.t; const trackAtPause = e1.track;
  app.command({ cmd: 'toggle', id: P });
  await sleep(500);
  e1 = await eng(P);
  check(e1.state === 'playing' && e1.track === trackAtPause && e1.t >= posAtPause, 'resume same track/position', { e1, posAtPause });

  // re-toggle during fade-in (quick double press)
  app.command({ cmd: 'toggle', id: P }); await sleep(150); app.command({ cmd: 'toggle', id: P }); await sleep(2300);
  e1 = await eng(P);
  check(e1.state === 'playing' && Math.abs(e1.gain - 0.49) < 0.01, 'interrupted fade recovers', e1);

  // solo: lo-fi pauses piano
  app.command({ cmd: 'play', id: L });
  await sleep(1500);
  const el = await eng(L); e1 = await eng(P);
  check(el && el.state === 'playing' && !el.paused, 'lo-fi playing (m4a)', el);
  check(e1.state === 'paused', 'solo paused piano', e1.state);

  // next track
  const before = el.track;
  app.command({ cmd: 'next', id: L });
  await sleep(1300);
  const el2 = await eng(L);
  check(el2.track !== before && el2.state === 'playing' && Math.abs(el2.gain - 0.36) < 0.02, 'next track switched', { before, after: el2.track, g: el2.gain });

  // stop resets
  app.command({ cmd: 'stop', id: L });
  await sleep(1300);
  const el3 = await eng(L);
  check(el3.state === 'stopped' && !el3.src && el3.track === '', 'stop clears', el3);

  // non-loop outro ends by itself (3s + 3s, sequential)
  app.command({ cmd: 'play', id: O });
  await sleep(800);
  let eo = await eng(O);
  check(eo.state === 'playing' && eo.track === 'end two', 'outro first track sorted', eo);
  await sleep(6200);
  eo = await eng(O);
  check(eo.state === 'stopped', 'outro stopped after last track (no loop)', eo);

  // piano was paused; stopAll from paused
  app.command({ cmd: 'stopAll' });
  await sleep(300);
  check((await eng(P)).state === 'stopped', 'stopAll stops paused stream');

  // ---------- crossfade between tracks ----------
  await panel.evaluate((m) => send({ t: 'saveStream', stream: { name: 'XF', folder: m + '/Piano', shuffle: false, solo: false, fadeIn: 0, fadeOut: 0, crossfade: 2 } }), MEDIA);
  await sleep(400);
  const XF = app.snapshot().config.streams.find((s) => s.name === 'XF').id;
  check(app.snapshot().config.streams.find((s) => s.name === 'XF').crossfade === 2, 'crossfade saved');
  app.command({ cmd: 'play', id: XF });
  const xfState = () => engine.evaluate((id) => { const c = Engine.debug().ch[id]; return { cur: c.cur, xf: !!c.xf, track: c.track, a: c.decks.map((d) => ({ g: +d.g.gain.value.toFixed(2), p: d.audio.paused, t: +d.audio.currentTime.toFixed(1) })) }; }, XF);
  await sleep(6600);
  let xs = await xfState();
  check(xs.xf && xs.track === 'Piano track 2' && !xs.a[0].p && !xs.a[1].p, 'crossfade running: both decks playing', xs);
  check(xs.a[0].g < 1 && xs.a[1].g > 0, 'gains crossing', xs.a);
  await sleep(2200);
  xs = await xfState();
  check(!xs.xf && xs.cur === 1 && xs.a[0].p && xs.a[1].g === 1 && xs.track === 'Piano track 2', 'crossfade finished, old deck stopped', xs);
  app.command({ cmd: 'pause', id: XF, fade: 0 }); await sleep(300);
  app.command({ cmd: 'play', id: XF, fade: 0 }); await sleep(300);
  xs = await xfState();
  check(!xs.a[1].p && xs.track === 'Piano track 2', 'resume after crossfade on second deck', xs);
  app.command({ cmd: 'stop', id: XF, fade: 0 }); await sleep(300);
  await panel.evaluate((id) => send({ t: 'deleteStream', id }), XF);
  await sleep(300);

  // ---------- random start ----------
  await panel.evaluate((m) => send({ t: 'saveStream', stream: { name: 'LONG', folder: m + '/Long', solo: false, fadeIn: 0, fadeOut: 0, randomStart: true } }), MEDIA);
  await sleep(400);
  const LG = app.snapshot().config.streams.find((s) => s.name === 'LONG');
  check(LG.randomStart === true, 'randomStart saved');
  const starts = [];
  for (let i = 0; i < 3; i++) {
    app.command({ cmd: 'play', id: LG.id }); await sleep(900);
    const e = await eng(LG.id);
    starts.push(e.t);
    check(e.state === 'playing' && e.t > 1 && e.t <= 300 + 2, 'random start position #' + (i + 1), e.t);
    app.command({ cmd: 'pause', id: LG.id, fade: 0 }); await sleep(200);
    app.command({ cmd: 'play', id: LG.id, fade: 0 }); await sleep(300);
    const r = await eng(LG.id);
    check(Math.abs(r.t - e.t) < 2, 'resume keeps position (no new random)', [e.t, r.t]);
    app.command({ cmd: 'stop', id: LG.id, fade: 0 }); await sleep(300);
  }
  check(new Set(starts.map((x) => Math.round(x))).size === 3, 'different start each time', starts);
  await panel.evaluate((id) => send({ t: 'deleteStream', id }), LG.id);
  await sleep(300);

  // ---------- scheduler ----------
  const base = new Date(); base.setSeconds(0, 0);
  const startD = new Date(base.getTime() + 2 * 60000);
  const endD = new Date(base.getTime() + 5 * 60000);
  const hm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (startD.getDate() === endD.getDate()) {
    await panel.evaluate((s) => send({ t: 'saveSchedules', schedules: [s] }), { streamId: P, days: [startD.getDay()], start: hm(startD), end: hm(endD), enabled: true });
    await sleep(300);
    const sc = app.snapshot().config.schedules;
    check(sc.length === 1 && sc[0].start === hm(startD), 'schedule saved', sc);
    check(app.snapshot().next && app.snapshot().next.name === 'Piano', 'next run computed', app.snapshot().next);
    fakeNow = startD.getTime() - 5000; app.tick(); await sleep(300);
    check((await eng(P)).state === 'stopped', 'not started before window');
    fakeNow = startD.getTime() + 1000; app.tick(); await sleep(1200);
    check((await eng(P)).state === 'playing', 'schedule started stream');
    app.command({ cmd: 'stop', id: P }); await sleep(2300);
    fakeNow = startD.getTime() + 60000; app.tick(); await sleep(500);
    check((await eng(P)).state === 'stopped', 'manual stop respected (no restart)');
    app.command({ cmd: 'play', id: P }); await sleep(2200);
    fakeNow = endD.getTime() - 1500; app.tick(); await sleep(300);
    const ef = await eng(P);
    check(ef.state === 'stopped' && ef.gain > 0, 'end window → fading stop', ef);
    await sleep(1500);
    check((await eng(P)).real < 0.001, 'silent at end time');
    const firedState = JSON.parse(fs.readFileSync(path.join(DATA, 'schedule-state.json'), 'utf8'));
    check(Object.keys(firedState).length === 2, 'fired state persisted', firedState);
    // catch-up: new schedule, server "starts" mid-window
    await panel.evaluate((s) => send({ t: 'saveSchedules', schedules: [s] }), { streamId: O, days: [startD.getDay()], start: hm(startD), end: hm(endD), enabled: true });
    await sleep(200);
    fakeNow = startD.getTime() + 90000; app.tick(); await sleep(800);
    check((await eng(O)).state !== 'playing', 'no catch-up: late start (90 s) is skipped', (await eng(O)).state);
    app.command({ cmd: 'stopAll' }); await sleep(300);

    // уже играет, когда наступает старт по расписанию — ничего не перезапускается
    app.command({ cmd: 'play', id: P }); await sleep(2500);
    const before = await eng(P);
    await panel.evaluate((s) => send({ t: 'saveSchedules', schedules: [s] }), { streamId: P, days: [startD.getDay()], start: hm(startD), end: hm(endD), enabled: true });
    await sleep(200);
    fakeNow = startD.getTime() + 1000; app.tick(); await sleep(600);
    const after = await eng(P);
    check(after.state === 'playing' && after.track === before.track && after.t >= before.t && Math.abs(after.gain - before.gain) < 0.01, 'scheduled start on already playing stream: no restart', { before, after });
    app.command({ cmd: 'stopAll', fade: 0 }); await sleep(300);

    // только стоп: не играет — ничего; играет — плавно останавливает к времени «до»
    await panel.evaluate((s) => send({ t: 'saveSchedules', schedules: [s] }), { streamId: P, days: [startD.getDay()], start: '', end: hm(endD), enabled: true });
    await sleep(200);
    const sc2 = app.snapshot().config.schedules[0];
    check(sc2.start === '' && sc2.end === hm(endD), 'stop-only rule saved (no start)', sc2);
    check(app.snapshot().next && app.snapshot().next.kind === 'stop', 'next shows stop', app.snapshot().next);
    fakeNow = startD.getTime() + 30000; app.tick(); await sleep(300);
    check((await eng(P)).state === 'stopped', 'stop-only rule does not start anything');
    app.command({ cmd: 'play', id: P }); await sleep(2500);
    fakeNow = endD.getTime() - 1500; app.tick(); await sleep(300);
    const so = await eng(P);
    check(so.state === 'stopped' && so.gain > 0, 'stop-only rule fades out playing stream', so);
    await sleep(1500);
    check((await eng(P)).real < 0.001, 'silent at end time (stop-only)');
    // правило «только стоп», когда поток не играет: окно не запускается и ничего не происходит
    await panel.evaluate((s) => send({ t: 'saveSchedules', schedules: [s] }), { streamId: O, days: [startD.getDay()], start: '', end: hm(endD), enabled: true });
    await sleep(200);
    fakeNow = endD.getTime() - 500; app.tick(); await sleep(300);
    check((await eng(O)).state === 'stopped', 'stop-only on idle stream: nothing happens');

    // автозапуск, когда играет другой поток — запускается запланированный
    app.command({ cmd: 'play', id: O }); await sleep(800);
    await panel.evaluate((s) => send({ t: 'saveSchedules', schedules: [s] }), { streamId: P, days: [startD.getDay()], start: hm(startD), end: hm(endD), enabled: true });
    await sleep(200);
    fakeNow = startD.getTime() + 2000; app.tick(); await sleep(800);
    check((await eng(P)).state === 'playing' && (await eng(O)).state !== 'playing', 'scheduled stream starts, other (solo) fades out');
    app.command({ cmd: 'stop', id: P, fade: 0 }); app.command({ cmd: 'play', id: O }); await sleep(800);
    // «все потоки»: стоп в указанное время, старт игнорируется
    await panel.evaluate((s) => send({ t: 'saveSchedules', schedules: [s] }), { streamId: '*', days: [startD.getDay()], start: '09:00', end: hm(endD), enabled: true });
    await sleep(200);
    const allRule = app.snapshot().config.schedules[0];
    check(allRule.streamId === '*' && allRule.start === '', 'all-streams rule: start dropped', allRule);
    check(app.snapshot().next && app.snapshot().next.name === 'все потоки', 'next shows all streams', app.snapshot().next);
    check(await panel.evaluate(() => document.querySelector('.srow .t-start').disabled), 'start input disabled for all-streams');
    fakeNow = endD.getTime() - 2000; app.tick(); await sleep(400);
    const ea = await eng(O);
    check(ea.state === 'stopped' && ea.gain > 0, 'all-streams rule fades out playing stream', ea);
    await sleep(2200);
    check((await eng(O)).real < 0.001, 'silent at end (all streams)');
    fakeNow = null;
  } else console.log('SKIP scheduler (near midnight)');

  // ---------- engine offline: queue + reconnect ----------
  await engine.close();
  await sleep(400);
  check(!app.snapshot().engineOnline, 'engine offline after window close');
  app.command({ cmd: 'toggle', id: P });
  await sleep(200);
  engine = await ctx.newPage();
  engine.on('pageerror', (e) => errors.push('engine2: ' + e.message));
  await engine.goto('http://127.0.0.1:' + port + '/?engine=1');
  await sleep(1500);
  check((await eng(P)) && (await eng(P)).state === 'playing', 'queued command executed after engine opened');
  // duplicate engine window
  const dup = await ctx.newPage();
  await dup.goto('http://127.0.0.1:' + port + '/?engine=1');
  await sleep(500);
  check(await dup.evaluate(() => role) === 'panel' && await dup.evaluate(() => !!document.querySelector('.banner.warn')), 'duplicate engine demoted to panel');
  await dup.close();

  // ---------- server restart while playing: music continues, state re-reported ----------
  await app.stop();
  await sleep(300);
  const app2 = createApp({ dataDir: DATA, port: 7790, noLaunch: true });
  await app2.start();
  await sleep(2500);
  check(app2.snapshot().engineOnline && app2.snapshot().runtime[P] && app2.snapshot().runtime[P].state === 'playing', 'engine reconnected after server restart, still playing', app2.snapshot().runtime[P]);

  // delete stream
  await panel.evaluate((id) => send({ t: 'deleteStream', id }), O);
  await sleep(400);
  check(app2.snapshot().config.streams.length === 2, 'stream deleted');

  // path traversal guard
  const r = await panel.evaluate(async (id) => (await fetch('/media/' + id + '?f=' + encodeURIComponent('../Lo-Fi/Чилл 1.m4a'))).status, P);
  check(r === 403, 'media path traversal blocked', r);
  const rr = await panel.evaluate(async (id) => { const x = await fetch('/media/' + id + '?f=' + encodeURIComponent('Piano track 1.mp3'), { headers: { Range: 'bytes=100-199' } }); return [x.status, (await x.arrayBuffer()).byteLength]; }, P);
  check(rr[0] === 206 && rr[1] === 100, 'range request', rr);

  // screenshots
  await panel.evaluate(() => window.scrollTo(0, 0));
  await engine.bringToFront();
  await sleep(300);
  await engine.screenshot({ path: path.join(__dirname, 'out', 'shot_engine.png'), fullPage: true });
  await panel.evaluate(() => openEditor(config.streams[0].id));
  await panel.screenshot({ path: path.join(__dirname, 'out', 'shot_editor.png') });
  await panel.evaluate(() => document.getElementById('browseBtn').click());
  await sleep(400);
  await panel.screenshot({ path: path.join(__dirname, 'out', 'shot_browse.png') });

  check(errors.length === 0, 'no page errors', errors);
  await browser.close();
  await app2.stop();
  console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
