// Название потока на кнопке Stream Deck: один размер шрифта для всех кнопок, поля от краёв, ограничения длины.
// Этот же файл используют окно программы (проверка и предпросмотр) и плагин Stream Deck (рисование кнопки).
(function (root) {
  'use strict';

  const FONT = 21;        // размер букв на кнопке (картинка 144×144) — одинаковый для всех кнопок
  const PAD = 10;         // минимальное расстояние от букв до левого и правого края
  const MAX_W = 144 - 2 * PAD;
  const MAX_WORDS = 2;    // одно или два слова — одна или две строки
  const MAX_WORD = 9;     // букв в одном слове
  const MAX_TOTAL = 21;   // всего символов вместе с пробелом
  const FAMILY = 'Arial Black, Arial, Helvetica, sans-serif';

  // ширина заглавных букв Arial Black (доли от размера шрифта)
  const W = {};
  const set = (chars, w) => { for (const ch of chars) W[ch] = w; };
  set('Г', 0.67); set('ЕЁЗРТЬ', 0.72); set('АБВКСУХЧЭЯ', 0.78); set('ДИЙНОПЛЦ', 0.83);
  set('Ъ', 0.89); set('МФ', 0.94); set('Ы', 1.0); set('ЖШ', 1.06); set('ЩЮ', 1.11);
  set('IJ', 0.39); set('F', 0.67); set('ELPTZS', 0.72); set('ABCKRVXY', 0.78); set('DGHNOQU', 0.83); set('M', 0.94); set('W', 1.06);
  set('0123456789', 0.67); set(' ', 0.33); set('-–—', 0.45); set('.,:;!\'"', 0.33); set('?&+/()', 0.6);

  function lineWidth(text, size) {
    let em = 0;
    for (const ch of String(text)) em += W[ch] != null ? W[ch] : 0.8;
    return em * (size || FONT);
  }

  function words(name) { return String(name || '').trim().toUpperCase().split(/\s+/).filter(Boolean); }

  // проверка названия: { ok, lines, error }
  function check(name) {
    const w = words(name);
    if (!w.length) return { ok: false, lines: [''], error: 'Дайте потоку название' };
    const lines = w.length <= MAX_WORDS ? w : [w[0], w.slice(1).join(' ')];
    if (w.length > MAX_WORDS) return { ok: false, lines, error: 'Не больше двух слов — каждое слово пишется на кнопке отдельной строкой' };
    if (w.join(' ').length > MAX_TOTAL) return { ok: false, lines, error: 'Слишком длинно: не больше ' + MAX_TOTAL + ' символов вместе с пробелом' };
    for (const x of w) {
      if (x.length > MAX_WORD) return { ok: false, lines, error: 'Слово «' + x + '» длиннее ' + MAX_WORD + ' букв — сократите' };
      if (lineWidth(x) > MAX_W) return { ok: false, lines, error: 'Слово «' + x + '» не помещается на кнопку — сократите (широкие буквы Ш, Ж, Ы, Ю, М занимают больше места)' };
    }
    return { ok: true, lines, error: '' };
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

  // текст названия для SVG-кнопки: строки по центру между top и bottom, всегда одним размером.
  // Если строка всё же шире допустимого (старое длинное название) — уменьшается только она, поля сохраняются.
  function textSvg(lines, cx, top, bottom, color, maxW) {
    const limit = maxW || MAX_W;
    const lh = FONT * 1.12;
    const total = lh * lines.length;
    const y0 = top + (bottom - top - total) / 2 + FONT * 0.86;
    return lines.map((l, i) => {
      const w = lineWidth(l);
      const size = w > limit ? Math.max(11, Math.floor(FONT * limit / w)) : FONT;
      return '<text x="' + cx + '" y="' + (y0 + i * lh).toFixed(1) + '" text-anchor="middle" font-family="' + FAMILY + '" font-weight="900" font-size="' + size + '" fill="' + color + '">' + esc(l) + '</text>';
    }).join('');
  }

  const api = { FONT, PAD, MAX_W, MAX_WORDS, MAX_WORD, MAX_TOTAL, lineWidth, check, textSvg, words };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KeyName = api;
})(typeof window !== 'undefined' ? window : this);
