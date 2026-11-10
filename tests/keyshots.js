// Картинки кнопок Stream Deck для справки — теми же функциями, что рисует плагин.
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const BIN = path.join(__dirname, '..', 'plugin', 'com.polyplayer.deck.sdPlugin', 'bin');
const OUT = path.join(__dirname, '..', 'app', 'public', 'help');
const src = fs.readFileSync(path.join(BIN, 'plugin.js'), 'utf8');
const grab = (n) => { const i = src.indexOf('function ' + n + '('); let d = 0; const j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const KeyName = require(path.join(BIN, 'keyname.js'));
eval(['xml', 'textBlock', 'glyph', 'streamKeySvg', 'chooseKeySvg', 'chooseHintSvg', 'holdSvg', 'stopKeySvg', 'nextKeySvg'].map(grab).join('\n') + '\nvar svgUri = (s) => s;');
const P1 = { id: 'a', name: 'ПЛЕЙЛИСТ 1', color: '#6A994E', volume: 70 };
const P2 = { id: 'b', name: 'ПЛЕЙЛИСТ 2', color: '#4F86C6', volume: 55 };
const panel = 'data:image/png;base64,' + fs.readFileSync(path.join(BIN, '..', 'imgs', 'panel_tray@2x.png')).toString('base64');
const keys = {
  'key-choose': chooseKeySvg(P1, 0, 2),
  'key-hint': chooseHintSvg(P1, 0, 2),
  'key-select': holdSvg('select', 0.6, P2.color, 'ПЛЕЙЛИСТ 2'),
  'key-playing': streamKeySvg(P1, { state: 'playing' }),
  'key-stopped': streamKeySvg(P2, { state: 'stopped' }),
  'key-hold-stop': holdSvg('stop-ready', 0.4, P1.color),
  'key-hold-choose': holdSvg('choose-ready', 1, P1.color),
  'key-stopall': stopKeySvg(true),
  'key-next': nextKeySvg(P1),
  'key-panel': '<img src="' + panel + '" width="144" height="144">'
};
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 144, height: 144 }, deviceScaleFactor: 1 });
  for (const [name, svg] of Object.entries(keys)) {
    await p.setContent('<body style="margin:0;background:transparent"><div style="width:144px;height:144px;border-radius:18px;overflow:hidden">' + svg + '</div></body>');
    await p.waitForTimeout(50);
    await p.screenshot({ path: path.join(OUT, name + '.png'), omitBackground: true });
  }
  await b.close();
})();
