// Название потока на кнопке Stream Deck.
// Правило: название пишется заглавными, по словам раскладывается не больше чем на 2 строки,
// с полями от левого и правого края. Сначала пробуем обычный размер; если не помещается —
// уменьшаем весь текст по шагу и раскладываем заново. Если не помещается даже при минимальном
// размере — такое название ввести нельзя.
// Этот же файл используют окно программы (ввод, предпросмотр, точная раскладка по настоящему шрифту)
// и плагин Stream Deck (рисует готовую раскладку; если её нет — считает сам, приблизительно).
(function (root) {
  'use strict';

  const FONT_MAX = 21;     // обычный размер (картинка кнопки 144×144): так помещается «ПЕРЕРЫВ»
  const FONT_MIN = 13;     // минимальный размер (примерно в 1,6 раза меньше) — мельче на кнопке не читается
  const STEP = 0.5;
  const MAX_LINES = 2;
  const PAD = 10;          // минимальное расстояние от букв до левого и правого края
  const MAX_W = 144 - 2 * PAD;
  const LINE_H = 1.12;     // высота строки относительно размера шрифта
  const FAMILY = 'Arial Black, Arial, Helvetica, sans-serif';

  // приблизительная ширина заглавных букв Arial Black (доли от размера шрифта) — для плагина и запасной расчёт
  const W = {};
  const set = (chars, w) => { for (const ch of chars) W[ch] = w; };
  set('Г', 0.67); set('ЕЁЗРТЬ', 0.72); set('АБВКСУХЧЭЯ', 0.78); set('ДИЙНОПЛЦ', 0.83);
  set('Ъ', 0.89); set('МФ', 0.94); set('Ы', 1.0); set('ЖШ', 1.06); set('ЩЮ', 1.11);
  set('IJ', 0.39); set('F', 0.67); set('ELPTZS', 0.72); set('ABCKRVXY', 0.78); set('DGHNOQU', 0.83); set('M', 0.94); set('W', 1.06);
  set('0123456789', 0.67); set(' ', 0.33); set('-–—', 0.45); set('.,:;!\'"', 0.33); set('?&+/()', 0.6);

  function approxWidth(text, size) {
    let em = 0;
    for (const ch of String(text)) em += W[ch] != null ? W[ch] : 0.8;
    return em * size;
  }

  function words(name) { return String(name || '').trim().toUpperCase().split(/\s+/).filter(Boolean); }

  // раскладка: { size, lines } или null, если не помещается даже при минимальном размере.
  // measure(text, size) — ширина строки в пикселях кнопки (по умолчанию — приблизительная)
  function layout(name, measure) {
    const m = measure || approxWidth;
    const w = words(name);
    if (!w.length) return { size: FONT_MAX, lines: [''] };
    for (let size = FONT_MAX; size >= FONT_MIN - 1e-9; size -= STEP) {
      const sz = Math.round(size * 10) / 10;
      const all = w.join(' ');
      if (m(all, sz) <= MAX_W) return { size: sz, lines: [all] }; // помещается в одну строку
      // две строки: из всех способов разделить слова берём тот, где строки ровнее
      let best = null;
      for (let k = 1; k < w.length; k++) {
        const a = w.slice(0, k).join(' '), b = w.slice(k).join(' ');
        const wa = m(a, sz), wb = m(b, sz);
        if (wa <= MAX_W && wb <= MAX_W && (!best || Math.max(wa, wb) < best.w)) best = { w: Math.max(wa, wb), lines: [a, b] };
      }
      if (best) return { size: sz, lines: best.lines };
    }
    return null;
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])); }

  // готовая раскладка из настроек потока (её считает окно программы по настоящему шрифту)
  function savedLayout(stream) {
    const k = stream && stream.keyLayout;
    if (!k || k.name !== stream.name || !Array.isArray(k.lines) || !k.lines.length || k.lines.length > MAX_LINES) return null;
    const size = Number(k.size);
    if (!(size >= FONT_MIN - 0.01 && size <= FONT_MAX + 0.01)) return null;
    return { size, lines: k.lines.map(String) };
  }

  // раскладка для рисования: сохранённая → расчёт → (старое слишком длинное название) минимальный размер
  function forStream(stream) {
    const name = stream ? stream.name : '';
    return savedLayout(stream) || layout(name) || { size: FONT_MIN, lines: words(name).length > 1 ? [words(name)[0], words(name).slice(1).join(' ')] : words(name) };
  }

  // текст для SVG-кнопки: строки по центру между top и bottom, все одного размера
  function textSvg(lay, cx, top, bottom, color) {
    const size = lay.size, lines = lay.lines;
    const lh = size * LINE_H;
    const total = lh * lines.length;
    const y0 = top + (bottom - top - total) / 2 + size * 0.86;
    return lines.map((l, i) =>
      '<text x="' + cx + '" y="' + (y0 + i * lh).toFixed(1) + '" text-anchor="middle" font-family="' + FAMILY + '" font-weight="900" font-size="' + size + '" fill="' + color + '">' + esc(l) + '</text>'
    ).join('');
  }

  const api = { FONT_MAX, FONT_MIN, STEP, MAX_LINES, PAD, MAX_W, FAMILY, approxWidth, words, layout, savedLayout, forStream, textSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KeyName = api;
})(typeof window !== 'undefined' ? window : this);
