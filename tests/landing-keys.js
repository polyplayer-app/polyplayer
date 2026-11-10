// Картинки кнопок Stream Deck для справки — теми же функциями, что рисует плагин.
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const BIN = path.join(__dirname, '..', 'plugin', 'com.polyplayer.deck.sdPlugin', 'bin');
const OUT = path.join(__dirname, '..', 'docs', 'img');
const src = fs.readFileSync(path.join(BIN, 'plugin.js'), 'utf8');
const grab = (n) => { const i = src.indexOf('function ' + n + '('); let d = 0; const j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
const KeyName = require(path.join(BIN, 'keyname.js'));
eval(['xml', 'textBlock', 'glyph', 'streamKeySvg', 'chooseKeySvg', 'chooseHintSvg', 'holdSvg', 'stopKeySvg', 'nextKeySvg'].map(grab).join('\n') + '\nvar svgUri = (s) => s;');
const P1 = { id: 'a', name: 'ВХОД', color: '#E9B44C', volume: 70 };
const P2 = { id: 'b', name: 'ПЕРЕРЫВ', color: '#2BB3A3', volume: 60 };
const P3 = { id: 'c', name: 'ФИНАЛ', color: '#4F86C6', volume: 65 };
const panel = 'data:image/png;base64,' + fs.readFileSync(path.join(BIN, '..', 'imgs', 'panel_tray@2x.png')).toString('base64');
const keys = {
  'k-a': streamKeySvg(P1, { state: 'playing' }),
  'k-b': streamKeySvg(P2, { state: 'stopped' }),
  'k-c': streamKeySvg(P3, { state: 'stopped' }),
  'k-hold': holdSvg('stop-ready', 0.4, P1.color),
  'k-stop': stopKeySvg(true),
  'k-next': nextKeySvg(P1),
  'k-app': '<img src="' + panel + '" width="144" height="144">'
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
