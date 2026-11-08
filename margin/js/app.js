/* Margin — reader application. */
import { esc, parasToHtml, makeBook, parseTxt, parseEpub, titleFromName, inert } from './parse.js';
import { SAMPLE } from './sample.js';
import { kindOf, parseFoliate, parseDocx, openComic, openPdf, pdfToFlow } from './formats.js';
import { createFixedView } from './fixed.js';
import { createAudioPlayer, buildAudiobook, filesFromZip, isAudioName, fmtTime, fmtLong } from './audio.js';
import { canPlay } from './audiometa.js';
import { initExtras } from './extras.js';
import { createDiscover } from './discover.js';
import { lookup, vocab, translate, canTranslateOnDevice, webTranslateUrl, LANGS, normalizeWord } from './dict.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const COLORS = ['yellow', 'green', 'blue', 'pink', 'violet'];
const THEMES = ['auto', 'paper', 'sepia', 'dusk', 'night'];

/* =========================================================
   Storage
   ========================================================= */
let frozen = false;
const store = {
  get(k, d) { try { const v = localStorage.getItem('margin:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { if (frozen) return; try { localStorage.setItem('margin:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('margin:' + k); } catch {} }
};
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open('margin-reader', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('books', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('books', mode);
    const req = fn(tx.objectStore('books'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const dbAll = () => idb('readonly', s => s.getAll()).catch(() => []);
const dbPut = r => idb('readwrite', s => s.put(r)).catch(() => {});
const dbDel = id => idb('readwrite', s => s.delete(id)).catch(() => {});

/* =========================================================
   Settings
   ========================================================= */
const DEFAULTS = {
  size: 19, lh: 1.6, font: 'literata', theme: 'auto', margin: 'normal', layout: 'paged', spread: 'auto',
  ls: 0, ws: 0, ruler: false, bionic: false, focus: false, autoWpm: 240, shelf: 'all', trLang: (navigator.language || 'en').slice(0, 2),
  para: 'indent', warmth: 0, justify: innerWidth >= 700, dropcap: true, anim: true, furniture: true, rate: 1, voice: '', sort: 'recent'
};
const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
const FONTS = {
  literata: '"Literata", Georgia, serif',
  newsreader: '"Newsreader", Georgia, serif',
  atkinson: '"Atkinson Hyperlegible", system-ui, sans-serif',
  figtree: '"Figtree", system-ui, sans-serif',
  dyslexic: '"OpenDyslexic", "Atkinson Hyperlegible", sans-serif'
};
const MARGIN_EM = { narrow: 1.1, normal: 2.0, wide: 3.1 };
const MEASURE = { narrow: 38, normal: 33, wide: 28 };

/* =========================================================
   Elements & state
   ========================================================= */
const app = $('#app'), stage = $('#stage'), pageEl = $('#page'), flow = $('#flow'), frame = $('#frame');
const drawer = $('#drawer'), scrim = $('#scrim'), pop = $('#settings'), seltool = $('#seltool'), fnpop = $('#fnpop');
// off: first character on screen. anchor: the character the reader is actually at; it only moves when they
// navigate, so re-layouts (fonts loading, resizing, setting changes) return to it instead of drifting.
const st = { ch: 0, page: 0, pages: 1, cols: 1, n: 1, V: 0, m: 0, c: 0, top: 0, bot: 0, off: 0, anchor: null };
let book = null, entryCur = null;
const cache = new Map();
const memEntries = new Map();
const coverUrls = new Map();
const paged = () => settings.layout === 'paged';
const readerOpen = () => !$('#reader').hidden;
/* ---------- audiobook player ---------- */
const ap = createAudioPlayer({
  onState: (s0, kind) => { if (book && book.audio) updateAudio(s0, kind); updateNowPlaying(s0); },
  onEnded: () => { saveAudioPos(); if (book && book.audio) finished(); },
  onDurations: b => persistDurations(b)
});
let audScrubbing = false, audioSaveT = 0, lastAudCh = -1;
function saveAudioPos() {
  const s0 = ap.state(); if (!s0 || !ap.book) return;
  store.set('pos:' + ap.book.id, { t: s0.t, pct: s0.total ? Math.min(1, s0.t / s0.total) : 0, at: Date.now(), chTitle: ap.book.chapters[s0.chapter].title, secsLeft: Math.max(0, s0.total - s0.t) });
}
async function persistDurations(b) {
  const e = (await dbAll()).find(x => x.id === b.id) || memEntries.get(b.id); if (!e) return;
  let t = 0; const starts = b.tracks.map(tr => { const v = t; t += tr.duration || 0; return v; });
  e.tracks.forEach((tr, i) => { tr.duration = b.tracks[i].duration; });
  if (b.chapters.length === b.tracks.length) b.chapters.forEach((c, i) => { c.start = starts[i]; });
  e.chapters = b.chapters.map(c => ({ ...c })); e.total = t; b.total = t;
  dbPut(e); if (book && book.audio) buildTicks();
}
function renderAudioHeader(e) {
  $('#aud-title').textContent = book.title; $('#aud-author').textContent = book.author || '';
  $('#aud-eyebrow').textContent = `Audiobook · ${fmtLong(book.total)} · ${book.chapters.length} ${book.chapters.length === 1 ? 'chapter' : 'chapters'}`;
  const art = $('#aud-art'), bg = $('#aud-bg');
  if (book.cover) {
    if (!coverUrls.has(e.id)) coverUrls.set(e.id, URL.createObjectURL(book.cover));
    const u = coverUrls.get(e.id);
    art.innerHTML = `<img src="${u}" alt="Cover of ${esc(book.title)}">`; bg.style.backgroundImage = `url("${u}")`; art.style.removeProperty('--cv');
  } else {
    const { k } = coverStyle(e);
    art.style.setProperty('--cv', `var(--cv-${k})`);
    art.innerHTML = `<div class="gen s-rule"><span class="gt">${esc(book.title)}</span><span class="rule"></span><span class="ga">${esc(book.author || '')}</span></div>`;
    bg.style.backgroundImage = 'none';
  }
}
function updateAudio(s0, kind) {
  if (!s0 || !ap.book) return;
  const b = ap.book, ch = b.chapters[s0.chapter], chLen = Math.max(1, s0.chEnd - s0.chStart), into = Math.max(0, s0.t - s0.chStart), long = chLen >= 3600;
  $('#aud-chap').textContent = ch.title;
  if (!audScrubbing) { $('#aud-pos').value = Math.round(into / chLen * 1000); $('#aud-fill').style.width = Math.min(100, into / chLen * 100) + '%'; }
  $('#aud-el').textContent = fmtTime(into, long); $('#aud-left').textContent = '−' + fmtTime(s0.chEnd - s0.t, long);
  const play = $('#aud-play');
  play.innerHTML = `<svg class="i"><use href="#i-${s0.playing ? 'pause' : 'play'}"/></svg>`;
  play.setAttribute('aria-label', s0.playing ? 'Pause' : 'Play'); play.classList.toggle('busy', !!s0.buffering);
  $('#aud-rate').textContent = `${s0.rate}×`;
  $('#aud-sleep').classList.toggle('on', !!s0.sleep);
  $('#aud-sleep-l').textContent = s0.sleep === 'chapter' ? 'End of chapter' : s0.sleep ? fmtTime(s0.sleepLeft) : 'Sleep timer';
  const pct = s0.total ? s0.t / s0.total : 0;
  $('#aud-book').textContent = `Chapter ${s0.chapter + 1} of ${b.chapters.length} · ${Math.round(pct * 100)}% of the book · ${fmtLong((s0.total - s0.t) / s0.rate)} left${s0.rate !== 1 ? ` at ${s0.rate}×` : ''}`;
  $('#f-chap').textContent = `${fmtTime(s0.t, true)} of ${fmtTime(s0.total, true)}`;
  if (!scrubbing) { $('#scrub').value = Math.round(pct * 1000); $('#scrub-fill').style.width = (pct * 100) + '%'; }
  const bm = currentBookmark(); $('#b-mark').setAttribute('aria-pressed', String(!!bm)); $('#aud-bm').classList.toggle('on', !!bm);
  if (s0.chapter !== lastAudCh) { lastAudCh = s0.chapter; try { if (navigator.mediaSession && navigator.mediaSession.metadata) navigator.mediaSession.metadata.title = ch.title; } catch {} if (drawer.classList.contains('open')) markCurrentToc(); }
  if (drawer.classList.contains('open')) drawerProgress();
  if (kind === 'slept') toast('Sleep timer ended, so playback is paused.', 3500);
  if (kind === 'error') toast('This audio couldn’t be played. The file may be damaged, or this browser can’t play its format.', 5000);
  const nowMs = Date.now(); if (!s0.playing || nowMs - audioSaveT > 4000) { audioSaveT = nowMs; saveAudioPos(); }
  if (s0.playing) touchActive();
}
function updateNowPlaying(s0) {
  const show = !!(ap.book && !$('#library').hidden);
  $('#np').hidden = !show; if (!show) return;
  s0 = s0 || ap.state(); if (!s0) return;
  const b = ap.book;
  $('#np-title').textContent = b.title;
  $('#np-chap').textContent = `${b.chapters[s0.chapter].title} · ${fmtLong((s0.total - s0.t) / s0.rate)} left`;
  $('#np-play').innerHTML = `<svg class="i"><use href="#i-${s0.playing ? 'pause' : 'play'}"/></svg>`;
  $('#np-play').setAttribute('aria-label', s0.playing ? 'Pause' : 'Play');
  const art = $('#np-art');
  if (art.dataset.id !== b.id) { art.dataset.id = b.id; art.innerHTML = b.coverUrl ? `<img src="${b.coverUrl}" alt="">` : ''; }
}
const AUD_RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function setAudioRate(r) { ap.setRate(r); settings.audioRate = r; saveSettings(); }
function stepAudioRate(d) { const i = AUD_RATES.findIndex(r => r >= ap.rate - 0.001); setAudioRate(AUD_RATES[clamp((i < 0 ? 2 : i) + d, 0, AUD_RATES.length - 1)]); toast(`Speed ${ap.rate}×`, 1200); }
$('#aud-play').addEventListener('click', () => ap.toggle());
$('#aud-back').addEventListener('click', () => ap.skip(-15));
$('#aud-fwd').addEventListener('click', () => ap.skip(30));
$('#aud-prevch').addEventListener('click', () => ap.prevChapter());
$('#aud-nextch').addEventListener('click', () => ap.nextChapter());
$('#aud-chap').addEventListener('click', () => openDrawer('toc'));
$('#aud-bm').addEventListener('click', () => toggleBookmark());
$('#aud-pos').addEventListener('input', () => {
  const s0 = ap.state(); if (!s0) return; audScrubbing = true;
  const f = $('#aud-pos').value / 1000; $('#aud-fill').style.width = (f * 100) + '%';
  $('#aud-el').textContent = fmtTime(f * (s0.chEnd - s0.chStart), s0.chEnd - s0.chStart >= 3600);
});
$('#aud-pos').addEventListener('change', () => { const s0 = ap.state(); audScrubbing = false; if (s0) ap.seek(s0.chStart + $('#aud-pos').value / 1000 * (s0.chEnd - s0.chStart)); });
$('#aud-rate').addEventListener('click', ev => extras.menu(ev.currentTarget, AUD_RATES.map(r => [`${r}×${Math.abs(r - ap.rate) < 0.001 ? '   ✓' : ''}`, () => setAudioRate(r)])));
$('#aud-sleep').addEventListener('click', ev => extras.menu(ev.currentTarget, [
  ['Off', () => ap.setSleep(null)], ['In 5 minutes', () => ap.setSleep(5)], ['In 15 minutes', () => ap.setSleep(15)], ['In 30 minutes', () => ap.setSleep(30)],
  ['In 45 minutes', () => ap.setSleep(45)], ['In 1 hour', () => ap.setSleep(60)], ['At the end of this chapter', () => ap.setSleep('chapter')]
]));
$('#np-play').addEventListener('click', () => ap.toggle());
$('#np-back').addEventListener('click', () => ap.skip(-15));
$('#np-open').addEventListener('click', async () => { if (!ap.book) return; book = ap.book; await swapView(() => { showReader(); }); $('#np').hidden = true; updateAudio(ap.state()); showChrome(); });

const fx = createFixedView({
  stage, host: $('#fixed'), settings, reduced,
  onChange: () => { if (book && book.fixed) update(); },
  onTap: z => { touchActive(); if (z === 'next') next(); else if (z === 'prev') prev(); else chromeOn ? hideChrome() : showChrome(); }
});

/* =========================================================
   Sample book
   ========================================================= */
const SAMPLE_ENTRY = { id: 'sample-pride', kind: 'sample', title: 'Pride and Prejudice', author: 'Jane Austen', sample: true };
function sampleBook() {
  return makeBook({
    id: SAMPLE_ENTRY.id, title: SAMPLE_ENTRY.title, author: SAMPLE_ENTRY.author, lang: 'en',
    chapters: SAMPLE.map(c => ({ title: c.title, html: parasToHtml(c.title, c.text.split(/\n\s*\n/).map(s => s.trim())) }))
  });
}

/* =========================================================
   Stats
   ========================================================= */
const stats = Object.assign({ days: {}, books: {}, finished: {}, secs: 0, chars: 0 }, store.get('stats', {}));
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const saveStats = debounce(() => store.set('stats', stats), 400);
let lastActive = 0;
const touchActive = () => { lastActive = Date.now(); };
function wpm() {
  if (stats.secs > 240 && stats.chars > 4000) return clamp(Math.round((stats.chars / 5.8) / (stats.secs / 60)), 120, 650);
  return 230;
}
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
function streak() {
  let n = 0; const d = new Date();
  if (!(stats.days[dayKey(d)] >= 60)) d.setDate(d.getDate() - 1);
  while (stats.days[dayKey(d)] >= 60) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function weekSecs() {
  let s = 0; const d = new Date();
  for (let i = 0; i < 7; i++) { s += stats.days[dayKey(d)] || 0; d.setDate(d.getDate() - 1); }
  return s;
}
setInterval(() => {
  if (!book || !readerOpen() || document.visibilityState !== 'visible') return;
  if (Date.now() - lastActive > 120000 && !tts.playing && !ap.playing) return;
  const k = dayKey();
  stats.days[k] = (stats.days[k] || 0) + 5;
  stats.secs += 5;
  const b = stats.books[book.id] || (stats.books[book.id] = { secs: 0, chars: 0, title: book.title });
  b.secs += 5; b.title = book.title;
  saveStats();
}, 5000);

/* =========================================================
   Text-offset helpers (highlights, search, bookmarks, read-aloud)
   ========================================================= */
function textNodes() {
  const out = []; const w = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT); let acc = 0;
  for (let n; (n = w.nextNode());) { out.push({ n, s: acc }); acc += n.nodeValue.length; }
  return out;
}
function locate(nodes, off, preferEnd) {
  let lo = 0, hi = nodes.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid].s <= off) lo = mid; else hi = mid - 1; }
  let x = nodes[lo]; if (!x) return null;
  if (preferEnd && off === x.s && lo > 0) x = nodes[lo - 1];
  return [x.n, clamp(off - x.s, 0, x.n.nodeValue.length)];
}
function rangeFor(start, end) {
  const nodes = textNodes(); if (!nodes.length) return null;
  const a = locate(nodes, start, false), b = locate(nodes, Math.max(start, end), true);
  const r = document.createRange();
  try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); } catch { return null; }
  return r;
}
function rangeOffsets(r) {
  const pre = document.createRange(); pre.setStart(flow, 0); pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return { start, end: start + r.toString().length };
}
const INLINE = /^(p|span|a|i|em|b|strong|li|h[1-6]|blockquote|small|sup|sub|q|cite|mark|u|s|dd|dt|td|th|figcaption|code|abbr|dfn|var|kbd|samp|big|font|label)$/;
function wrap(start, end, make) {
  const made = [];
  for (const { n, s } of textNodes()) {
    const e = s + n.nodeValue.length;
    if (e <= start) continue;
    if (s >= end) break;
    const pe = n.parentElement;
    if (!pe || pe.closest('.ch-next')) continue;
    if (!n.nodeValue.trim() && !INLINE.test(pe.localName)) continue;
    let node = n; const a = Math.max(start, s) - s, b = Math.min(end, e) - s;
    if (b < node.nodeValue.length) node.splitText(b);
    if (a > 0) node = node.splitText(a);
    const m = make(); node.parentNode.insertBefore(m, node); m.appendChild(node); made.push(m);
  }
  return made;
}
function unwrap(sel) {
  const ms = flow.querySelectorAll(sel); if (!ms.length) return;
  ms.forEach(m => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); m.remove(); });
  flow.normalize();
}
function firstRect(r) {
  if (!r) return null;
  const rs = Array.from(r.getClientRects());
  return rs.find(x => x.width > 0) || rs[rs.length - 1] || r.getBoundingClientRect();
}

/* Which text offset begins the current page/view? (independent of animation in progress) */
function firstVisibleOffset() {
  const fl = flow.getBoundingClientRect().left;
  const top = pageEl.getBoundingClientRect().top + 2;
  const before = r => paged() ? (r.right - fl) <= st.page * st.V + 1 : r.bottom <= top;
  const rg = document.createRange();
  for (const { n, s } of textNodes()) {
    const len = n.nodeValue.length; if (!len || !n.nodeValue.trim()) continue;
    rg.selectNodeContents(n);
    const rects = Array.from(rg.getClientRects());
    if (!rects.length || rects.every(before)) continue;
    let lo = 0, hi = len - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      rg.setStart(n, mid); rg.setEnd(n, mid + 1);
      const rr = rg.getClientRects();
      const r = rr.length ? rr[rr.length - 1] : rg.getBoundingClientRect();
      if (before(r)) lo = mid + 1; else hi = mid;
    }
    // Never anchor on a space: at a line break it has boxes on both sides of the page edge.
    while (lo < len - 1 && /\s/.test(n.nodeValue[lo])) lo++;
    return s + lo;
  }
  return book ? book.chapters[st.ch].text.length : 0;
}
function pageOfRect(r) { return clamp(Math.floor((r.left - flow.getBoundingClientRect().left + 1) / st.V), 0, st.pages - 1); }
function goToOffset(off) {
  const c = book.chapters[st.ch];
  if (off >= c.text.length) { if (paged()) goPage(st.pages - 1); else pageEl.scrollTop = pageEl.scrollHeight; return; }
  const r = firstRect(rangeFor(off, off + 1)); if (!r) return;
  if (paged()) goPage(pageOfRect(r));
  else pageEl.scrollTop += r.top - pageEl.getBoundingClientRect().top - 72;
}
function isOffsetOnScreen(off) {
  const r = firstRect(rangeFor(off, off + 1)); if (!r) return false;
  if (paged()) return pageOfRect(r) === st.page;
  const pr = pageEl.getBoundingClientRect();
  return r.top >= pr.top - 2 && r.top < pr.bottom - 2;
}

/* =========================================================
   Layout
   ========================================================= */
function geometry() {
  const rs = settings.size, W = stage.clientWidth, H = stage.clientHeight;
  const em = rs * MARGIN_EM[settings.margin];
  const m = clamp(Math.round(W < 640 ? Math.min(em, W * (settings.margin === 'wide' ? 0.1 : settings.margin === 'narrow' ? 0.045 : 0.07)) : em), 16, 110);
  const cw = Math.round(rs * 31);
  let n = 1;
  if (settings.spread === 'double' && W >= 2 * rs * 14 + 4 * m) n = 2;
  if (settings.spread === 'auto' && W >= 2 * rs * 23 + 4 * m && H >= 440) n = 2;
  let V = n === 2 ? Math.min(W, 2 * cw + 4 * m) : Math.min(W, cw + 2 * m);
  V = n * Math.floor(V / n);
  return { n, V, m, H };
}
function layout() {
  if (!book) return;
  if (paged()) {
    const g = geometry();
    Object.assign(st, { n: g.n, V: g.V, m: g.m });
    pageEl.style.width = g.V + 'px';
    const top = clamp(Math.round(g.H * 0.085), 44, 84), bot = clamp(Math.round(g.H * 0.085), 46, 84);
    const c = g.V / g.n - 2 * g.m;
    Object.assign(st, { top, bot, c });
    app.classList.toggle('narrow', c < settings.size * 22);
    Object.assign(flow.style, {
      width: g.V + 'px', paddingTop: top + 'px', paddingBottom: bot + 'px', paddingLeft: g.m + 'px', paddingRight: g.m + 'px',
      columnWidth: c + 'px', columnGap: (2 * g.m) + 'px'
    });
    flow.style.setProperty('--colh', (g.H - top - bot - 10) + 'px');
    const s = flow.querySelector('.sentinel');
    const off = s ? s.getBoundingClientRect().left - flow.getBoundingClientRect().left : 0;
    st.cols = Math.max(1, Math.floor((off + 1) / (g.V / g.n)) + 1);
    st.pages = Math.max(1, Math.ceil(st.cols / g.n));
    buildFrame();
  } else {
    pageEl.style.width = '';
    flow.removeAttribute('style');
    pageEl.style.setProperty('--measure', MEASURE[settings.margin]);
    Object.assign(st, { n: 1, pages: 1, cols: 1 });
    app.classList.toggle('narrow', pageEl.clientWidth < settings.size * 24);
    frame.innerHTML = '';
  }
}
function buildFrame() {
  frame.innerHTML = '';
  if (!settings.furniture) return;
  const w = st.V / st.n;
  for (let k = 0; k < st.n; k++) {
    const left = Math.round(k * w + st.m);
    const h = document.createElement('div'); h.className = 'rh'; h.dataset.k = k;
    Object.assign(h.style, { left: left + 'px', width: st.c + 'px', top: Math.round(st.top * 0.42 - 8) + 'px' });
    const f = document.createElement('div'); f.className = 'folio'; f.dataset.k = k;
    Object.assign(f.style, { left: left + 'px', width: st.c + 'px', bottom: Math.round(st.bot * 0.4 - 8) + 'px' });
    frame.append(h, f);
  }
  if (st.n === 2) { const g = document.createElement('div'); g.className = 'gutter'; g.style.left = (st.V / 2) + 'px'; frame.appendChild(g); }
}
function updateFrame() {
  if (!paged() || !settings.furniture) return;
  const c = book.chapters[st.ch];
  frame.querySelectorAll('.rh').forEach(h => {
    const k = +h.dataset.k, col = st.page * st.n + k;
    const text = st.n === 2 && k === 0 ? book.title : c.title;
    h.textContent = col === 0 || col >= st.cols ? '' : text;
  });
  frame.querySelectorAll('.folio').forEach(f => {
    const k = +f.dataset.k, col = st.page * st.n + k;
    f.textContent = col < st.cols ? String(col + 1) : '';
  });
}
function setOffset(anim) {
  if (!paged()) return;
  flow.style.transition = anim && settings.anim && !reduced ? 'transform .5s cubic-bezier(.22,.7,.18,1)' : 'none';
  flow.style.transform = `translate3d(${-st.page * st.V}px,0,0)`;
}
function goPage(n, anim) { st.page = clamp(n, 0, st.pages - 1); setOffset(anim); }

let relayoutQueued = false;
function relayout() {
  if (book && book.audio) return;
  if (book && book.fixed) { if (readerOpen()) fx.layout(); return; }
  if (relayoutQueued || !book || !readerOpen()) return;
  relayoutQueued = true;
  requestAnimationFrame(() => {
    relayoutQueued = false;
    const off = st.anchor != null ? st.anchor : st.off;
    layout(); goToOffset(off); setOffset(false); update('keep');
  });
}
new ResizeObserver(relayout).observe(stage);
if (document.fonts) document.fonts.ready.then(relayout);

/* =========================================================
   Rendering a chapter
   ========================================================= */
function renderChapter(i, pos = {}) {
  const c = book.chapters[i]; if (!c) return;
  const dir = i > st.ch ? 1 : -1;
  const changed = i !== st.ch || !flow.childNodes.length;
  st.ch = i; st.page = 0;
  hideSel(); hideFn();
  let html = c.html + '<div class="sentinel" aria-hidden="true"></div>';
  if (!paged() && i < book.chapters.length - 1)
    html += `<div class="ch-next"><button type="button" data-next>Next · ${esc(book.chapters[i + 1].title)} <svg class="i"><use href="#i-next"/></svg></button></div>`;
  flow.innerHTML = html;
  flow.lang = book.lang || 'en';
  flow.querySelectorAll('img').forEach(im => { if (!im.complete) im.addEventListener('load', relayout, { once: true }); });
  if (settings.bionic) applyBionic();
  applyHighlights();
  pageEl.scrollTop = 0; pageEl.scrollLeft = 0;
  layout();
  if (pos.end) { if (paged()) goPage(st.pages - 1); else pageEl.scrollTop = pageEl.scrollHeight; }
  else if (pos.anchor) { const el = flow.querySelector('#' + CSS.escape(pos.anchor)); if (el) gotoEl(el); }
  else if (pos.find) { wrap(pos.find.start, pos.find.start + pos.find.len, () => Object.assign(document.createElement('mark'), { className: 'find' })); goToOffset(pos.find.start); }
  else if (pos.off != null) { st.anchor = pos.off; goToOffset(pos.off); }
  else if (pos.frac) { if (paged()) goPage(Math.floor(pos.frac * st.pages)); else pageEl.scrollTop = pos.frac * pageEl.scrollHeight; }
  setOffset(false);
  update(pos.off != null ? 'keep' : undefined);
  if (changed && pos.animate !== false && settings.anim && !reduced)
    pageEl.animate([{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.22,.7,.18,1)' });
}
function gotoEl(el) {
  const r = el.getClientRects()[0] || el.getBoundingClientRect();
  if (paged()) goPage(pageOfRect(r));
  else pageEl.scrollTop += r.top - pageEl.getBoundingClientRect().top - 72;
}

/* =========================================================
   Navigation
   ========================================================= */
function next(fromUser = true) {
  if (!book) return;
  if (book.audio) { ap.nextChapter(); return; }
  if (book.fixed) { touchActive(); if (!fx.next()) finished(); if (fromUser) hideChrome(); return; }
  hideSel(); hideFn(); touchActive();
  if (paged()) {
    if (st.page < st.pages - 1) {
      const c = book.chapters[st.ch];
      stats.chars += c.len / st.pages; const b = stats.books[book.id]; if (b) b.chars += c.len / st.pages; saveStats();
      goPage(st.page + 1, true); update();
    } else if (st.ch < book.chapters.length - 1) renderChapter(st.ch + 1, {});
    else finished();
  } else {
    const atEnd = pageEl.scrollTop + pageEl.clientHeight >= pageEl.scrollHeight - 2;
    if (atEnd) { if (st.ch < book.chapters.length - 1) renderChapter(st.ch + 1, {}); else finished(); }
    else pageEl.scrollBy({ top: pageEl.clientHeight * 0.86, behavior: reduced ? 'auto' : 'smooth' });
  }
  if (fromUser) hideChrome();
}
function prev(fromUser = true) {
  if (!book) return;
  if (book.audio) { ap.prevChapter(); return; }
  if (book.fixed) { touchActive(); fx.prev(); if (fromUser) hideChrome(); return; }
  hideSel(); hideFn(); touchActive();
  if (paged()) {
    if (st.page > 0) { goPage(st.page - 1, true); update(); }
    else if (st.ch > 0) renderChapter(st.ch - 1, { end: true });
  } else {
    if (pageEl.scrollTop <= 0) { if (st.ch > 0) renderChapter(st.ch - 1, { end: true }); }
    else pageEl.scrollBy({ top: -pageEl.clientHeight * 0.86, behavior: reduced ? 'auto' : 'smooth' });
  }
  if (fromUser) hideChrome();
}
function finished() {
  if (!stats.finished[book.id]) {
    stats.finished[book.id] = Date.now(); saveStats();
    toast(`You finished ${book.title}.`, 4000);
  } else toast('This is the last page.');
}

/* =========================================================
   Status / chrome
   ========================================================= */
function within() {
  if (paged()) return (st.page + 1) / st.pages;
  const max = pageEl.scrollHeight - pageEl.clientHeight;
  return max <= 0 ? 1 : (pageEl.scrollTop + pageEl.clientHeight) / pageEl.scrollHeight;
}
function overall() { const c = book.chapters[st.ch]; return clamp((c.start + within() * c.len) / book.total, 0, 1); }
function update(mode) {
  if (!book) return;
  if (book.audio) return updateAudio(ap.state());
  if (book.fixed) return updateFixed();
  const c = book.chapters[st.ch];
  st.off = firstVisibleOffset();
  if (mode !== 'keep' || st.anchor == null) st.anchor = st.off;
  const pct = overall();
  const startFrac = clamp(st.off / Math.max(1, c.text.length), 0, 1);
  const minsCh = Math.ceil(c.words * (1 - startFrac) / wpm());
  $('#f-chap').textContent = c.title;
  let where;
  if (paged()) {
    const a = st.page * st.n + 1, b = Math.min(st.cols, a + st.n - 1);
    where = (b > a ? `Pages ${a}–${b} of ${st.cols}` : `Page ${a} of ${st.cols}`);
  } else where = `${Math.round(startFrac * 100)}% of chapter`;
  const pagesLeftCh = paged() ? st.pages - 1 - st.page : 99;
  where += pagesLeftCh > 0 && pagesLeftCh <= 3 ? ` · Chapter ends in ${pagesLeftCh} ${pagesLeftCh === 1 ? 'page' : 'pages'}` : minsCh > 0 ? ` · ${minsCh} min left in chapter` : ' · End of chapter';
  where += ` · ${Math.round(pct * 100)}%`;
  $('#f-where').textContent = where;
  if (!scrubbing) { $('#scrub').value = Math.round(pct * 1000); $('#scrub-fill').style.width = (pct * 100) + '%'; }
  updateFrame();
  const atStart = st.ch === 0 && (paged() ? st.page === 0 : pageEl.scrollTop <= 0);
  const atEnd = st.ch === book.chapters.length - 1 && (paged() ? st.page >= st.pages - 1 : within() >= 0.999);
  $('#t-prev').disabled = atStart; $('#t-next').disabled = atEnd;
  const bm = currentBookmark();
  $('#b-mark').setAttribute('aria-pressed', String(!!bm));
  $('#b-mark').setAttribute('aria-label', bm ? 'Remove bookmark' : 'Bookmark this page');
  if (drawer.classList.contains('open')) { markCurrentToc(); drawerProgress(); }
  savePos(pct);
  if (settings.focus) focusFromOffset();
}
function fixedTocTitle(page) {
  let t = null; for (const x of book.toc) if (x.page <= page) t = x; else if (t) break;
  return t ? t.title : '';
}
function fixedPct() { const s = fx.state(); return s.count > 1 ? (s.pages[s.pages.length - 1] + 1) / s.count : 1; }
function updateFixed() {
  const s = fx.state(); if (!s.count) return;
  const pct = fixedPct();
  const a = s.pages[0] + 1, b = s.pages[s.pages.length - 1] + 1;
  const left = s.count - b;
  $('#f-chap').textContent = fixedTocTitle(s.page) || book.title;
  $('#f-where').textContent = `${b > a ? `Pages ${a}–${b}` : `Page ${a}`} of ${s.count}${left ? ` · ${left} ${left === 1 ? 'page' : 'pages'} left` : ' · Last page'} · ${Math.round(pct * 100)}%`;
  if (!scrubbing) { $('#scrub').value = Math.round((s.count > 1 ? s.page / (s.count - 1) : 1) * 1000); $('#scrub-fill').style.width = (pct * 100) + '%'; }
  $('#t-prev').disabled = s.screen === 0; $('#t-next').disabled = s.screen >= s.screens - 1;
  const bm = currentBookmark();
  $('#b-mark').setAttribute('aria-pressed', String(!!bm));
  $('#b-mark').setAttribute('aria-label', bm ? 'Remove bookmark' : 'Bookmark this page');
  if (drawer.classList.contains('open')) { drawerProgress(); markThumbs(); }
  saveFixedPos(s, pct, left);
}
const saveFixedPos = debounce((s, pct, left) => {
  if (!book || !book.fixed) return;
  store.set('pos:' + book.id, { page: s.page, pct, at: Date.now(), chTitle: fixedTocTitle(s.page) || `Page ${s.page + 1}`, pagesLeft: left });
}, 200);
const savePos = debounce(pct => {
  if (!book) return;
  const c = book.chapters[st.ch];
  store.set('pos:' + book.id, { ch: st.ch, off: st.anchor != null ? st.anchor : st.off, pct, at: Date.now(), chTitle: c.title, wordsLeft: Math.round(book.words * (1 - pct)) });
}, 200);

let chromeOn = true, chromeT = 0;
function showChrome(autoHide) {
  chromeOn = true; app.classList.remove('chrome-off');
  clearTimeout(chromeT);
  if (autoHide) chromeT = setTimeout(() => { if (!overBars) hideChrome(); }, 2600);
}
function hideChrome() {
  if (book && book.audio) return;
  if (!readerOpen() || drawer.classList.contains('open') || !pop.hidden) return;
  chromeOn = false; app.classList.add('chrome-off'); clearTimeout(chromeT);
}
let overBars = false;
['#topbar', '#botbar', '#tts'].forEach(s => {
  $(s).addEventListener('pointerenter', () => { overBars = true; clearTimeout(chromeT); });
  $(s).addEventListener('pointerleave', () => { overBars = false; });
});
stage.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  const r = stage.getBoundingClientRect();
  if (e.clientY - r.top < 90 || r.bottom - e.clientY < 110) showChrome(true);
});

/* =========================================================
   Scrubber
   ========================================================= */
let scrubbing = false;
const scrub = $('#scrub'), tip = $('#scrub-tip');
function chapterAt(f) {
  const at = f * book.total;
  let i = book.chapters.findIndex(c => at < c.start + c.len);
  if (i < 0) i = book.chapters.length - 1;
  const c = book.chapters[i];
  return { i, frac: clamp((at - c.start) / c.len, 0, 0.9999) };
}
function showTip(f) {
  if (book.audio) {
    const t = f * ap.book.total;
    tip.textContent = `${fmtTime(t, ap.book.total >= 3600)} · ${ap.book.chapters[ap.chapterAt(t)].title}`; tip.hidden = false;
    const w1 = $('#scrub-wrap').clientWidth; tip.style.left = clamp(f * w1, 70, w1 - 70) + 'px'; return;
  }
  if (book.fixed) {
    const p = Math.round(f * (book.pageCount - 1));
    tip.textContent = `Page ${p + 1}${fixedTocTitle(p) ? ' · ' + fixedTocTitle(p) : ''}`; tip.hidden = false;
    const w0 = $('#scrub-wrap').clientWidth; tip.style.left = clamp(f * w0, 60, w0 - 60) + 'px'; return;
  }
  const t = chapterAt(f);
  tip.textContent = `${book.chapters[t.i].title} · ${Math.round(f * 100)}%`;
  tip.hidden = false;
  const w = $('#scrub-wrap').clientWidth;
  tip.style.left = clamp(f * w, 60, w - 60) + 'px';
}
scrub.addEventListener('input', () => {
  if (!book) return; scrubbing = true;
  const f = scrub.value / 1000; $('#scrub-fill').style.width = (f * 100) + '%'; showTip(f);
});
scrub.addEventListener('change', () => {
  if (!book) return; scrubbing = false; tip.hidden = true;
  if (book.audio) { ap.seek(scrub.value / 1000 * ap.book.total); return; }
  if (book.fixed) { fx.go(Math.round(scrub.value / 1000 * (book.pageCount - 1))); return; }
  const t = chapterAt(scrub.value / 1000);
  renderChapter(t.i, { frac: t.frac });
});
$('#scrub-wrap').addEventListener('pointermove', e => {
  if (!book || scrubbing || e.pointerType !== 'mouse') return;
  const r = $('#scrub-wrap').getBoundingClientRect();
  showTip(clamp((e.clientX - r.left) / r.width, 0, 1));
});
$('#scrub-wrap').addEventListener('pointerleave', () => { if (!scrubbing) tip.hidden = true; });
function buildTicks() {
  const t = $('#ticks'); t.innerHTML = '';
  if (book.audio) {
    if (book.total) book.chapters.slice(1, 200).forEach(c => { const s2 = document.createElement('span'); s2.className = 'tick'; s2.style.left = (c.start / book.total * 100) + '%'; t.appendChild(s2); });
    return;
  }
  if (book.fixed) {
    if (book.pageCount > 1) book.toc.filter(x => x.depth === 0 && x.page > 0).slice(0, 150).forEach(x => { const s = document.createElement('span'); s.className = 'tick'; s.style.left = (x.page / (book.pageCount - 1) * 100) + '%'; t.appendChild(s); });
    return;
  }
  if (book.chapters.length > 150) return;
  book.chapters.forEach((c, i) => { if (!i) return; const s = document.createElement('span'); s.className = 'tick'; s.style.left = (c.start / book.total * 100) + '%'; t.appendChild(s); });
}

/* =========================================================
   Pointer, touch, wheel, keys on the page
   ========================================================= */
let touch = null, suppressClick = false;
pageEl.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  touchActive();
  if (e.target.closest('[data-next]')) { renderChapter(st.ch + 1, {}); return; }
  const mark = e.target.closest('mark.hl');
  const sel = getSelection();
  if (sel && !sel.isCollapsed && String(sel).trim()) return;
  if (mark) { showSelForHighlight(mark.dataset.id, mark); return; }
  const img = e.target.closest('#flow img');
  if (img && !e.target.closest('a')) { openLightbox(img.src, img.alt); return; }
  const link = e.target.closest('a');
  if (link) { onLink(e, link); return; }
  if (!seltool.hidden || !fnpop.hidden) { hideSel(); hideFn(); return; }
  const r = pageEl.getBoundingClientRect();
  const x = (e.clientX - stage.getBoundingClientRect().left) / stage.clientWidth;
  if (paged() && x < 0.28) prev();
  else if (paged() && x > 0.72) next();
  else chromeOn ? hideChrome() : showChrome(false);
});
$('#t-prev').addEventListener('click', () => prev());
$('#t-next').addEventListener('click', () => next());
pageEl.addEventListener('touchstart', e => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY, at: Date.now() }; }, { passive: true });
pageEl.addEventListener('touchend', e => {
  if (!touch || !paged()) return;
  const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
  const sel = getSelection();
  if (Math.abs(dx) > 45 && Math.abs(dy) < 80 && Date.now() - touch.at < 700 && !(sel && !sel.isCollapsed)) {
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 400);
    dx < 0 ? next() : prev();
  }
  touch = null;
});
let wheelLock = 0;
pageEl.addEventListener('wheel', e => {
  if (!paged() || !book) return;
  e.preventDefault();
  const now = Date.now();
  if (now < wheelLock) { wheelLock = now + 200; return; }
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (Math.abs(d) < 6) return;
  wheelLock = now + 340;
  d > 0 ? next() : prev();
}, { passive: false });
let scrollQueued = false;
pageEl.addEventListener('scroll', () => {
  if (!book) return;
  if (paged()) { if (pageEl.scrollLeft || pageEl.scrollTop) { pageEl.scrollLeft = 0; pageEl.scrollTop = 0; } return; }
  touchActive(); hideSel(); hideFn();
  if (!scrollQueued) { scrollQueued = true; requestAnimationFrame(() => { scrollQueued = false; update(); }); }
});

document.addEventListener('keydown', e => {
  const typing = e.target.closest && e.target.closest('input,textarea,select,[contenteditable]');
  if (e.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return;
    if (!lb.hidden) { closeLightbox(); return; }
    if (!$('#menu').hidden) return;
    if (!seltool.hidden || !fnpop.hidden) { hideSel(); hideFn(); return; }
    if (drawer.classList.contains('open') || !pop.hidden) { closeDrawer(); closeSettings(); return; }
    if (readerOpen() && !document.querySelector('dialog[open]')) { if (!chromeOn) showChrome(); else showLibrary(); }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (!readerOpen()) return;
  touchActive();
  const k = e.key;
  if (book && book.audio) {
    if (k === ' ') { e.preventDefault(); ap.toggle(); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? ap.prevChapter() : ap.skip(-15); return; }
    if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? ap.nextChapter() : ap.skip(30); return; }
    if (k === '+' || k === '=') { stepAudioRate(1); return; }
    if (k === '-' || k === '_') { stepAudioRate(-1); return; }
    if (k === 'PageUp' || k === 'PageDown') { e.preventDefault(); k === 'PageUp' ? ap.prevChapter() : ap.nextChapter(); return; }
  }
  if (['ArrowRight', 'PageDown'].includes(k) || (k === ' ' && !e.shiftKey)) { e.preventDefault(); next(); }
  else if (['ArrowLeft', 'PageUp'].includes(k) || (k === ' ' && e.shiftKey)) { e.preventDefault(); prev(); }
  else if (k === 't' || k === 'T') openDrawer('toc');
  else if (k === 'n' || k === 'N') openDrawer('notes');
  else if (k === 'f' || k === 'F' || k === '/') { e.preventDefault(); openDrawer('find'); }
  else if (k === 'b' || k === 'B') toggleBookmark();
  else if (k === 'l' || k === 'L') ttsToggle();
  else if (book && book.fixed && (k === '+' || k === '=')) fx.setZoom(fx.zoom * 1.25);
  else if (book && book.fixed && (k === '-' || k === '_')) fx.setZoom(fx.zoom / 1.25);
  else if (k === '+' || k === '=') setSetting('size', clamp(settings.size + 1, 13, 32));
  else if (k === '-' || k === '_') setSetting('size', clamp(settings.size - 1, 13, 32));
  else if (k === 'd' || k === 'D') setSetting('theme', THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length]);
  else if (k === 'h' || k === 'H') chromeOn ? hideChrome() : showChrome();
  else if (k === '?') $('#keys-dlg').showModal();
});

/* =========================================================
   Links & footnotes
   ========================================================= */
function onLink(e, link) {
  const dl = link.getAttribute('data-link');
  if (!dl) return;
  e.preventDefault();
  const hashAt = dl.indexOf('#');
  const p = dl.slice(0, hashAt), frag = dl.slice(hashAt + 1);
  const ch = book.pathIndex.get(p);
  const anchor = frag ? 'x-' + frag : null;
  if (ch === undefined) return;
  // Footnote? Show it in place instead of leaving the page.
  if (anchor) {
    let target = null;
    if (ch === st.ch) target = flow.querySelector('#' + CSS.escape(anchor));
    else { const d = inert.createElement('div'); d.innerHTML = book.chapters[ch].html; target = d.querySelector('#' + CSS.escape(anchor)); }
    const type = link.getAttribute('epub:type') || '';
    const txt = link.textContent.trim();
    const looksLikeNote = /noteref/.test(type) || link.closest('sup') || /^[\[(]?[0-9*†‡§a-z]{1,3}[\])]?$/i.test(txt);
    if (target && looksLikeNote) {
      const box = target.closest('aside,li,p,div,dd') || target;
      const content = (box.textContent || '').trim() ? box : target;
      if ((content.textContent || '').trim().length < 2500) { showFn(link, content, ch, anchor); return; }
    }
  }
  if (ch === st.ch && anchor) { const el = flow.querySelector('#' + CSS.escape(anchor)); if (el) { gotoEl(el); setOffset(true); update(); } }
  else renderChapter(ch, { anchor });
}
function showFn(link, content, ch, anchor) {
  const clone = content.cloneNode(true);
  clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  clone.removeAttribute && clone.removeAttribute('id');
  clone.querySelectorAll('a[data-link]').forEach(a => a.replaceWith(...a.childNodes));
  fnpop.className = 'fnpop';
  fnpop.innerHTML = `<div class="fn-h"><span>Note</span><button class="mini" type="button" data-go>Go to note</button></div>`;
  const body = document.createElement('div'); body.appendChild(document.importNode(clone, true)); fnpop.appendChild(body);
  fnpop.hidden = false;
  const r = link.getBoundingClientRect();
  const w = fnpop.offsetWidth, h = fnpop.offsetHeight;
  let top = r.bottom + 10; if (top + h > innerHeight - 12) top = Math.max(12, r.top - h - 10);
  fnpop.style.top = top + 'px';
  fnpop.style.left = clamp(r.left + r.width / 2 - w / 2, 12, innerWidth - w - 12) + 'px';
  fnpop.querySelector('[data-go]').onclick = () => { hideFn(); renderChapter(ch, { anchor }); };
}
function hideFn() { fnpop.hidden = true; }

/* =========================================================
   Highlights & notes
   ========================================================= */
const hlKey = () => 'hl:' + book.id;
const getHls = () => store.get(hlKey(), []);
const setHls = l => { store.set(hlKey(), l); updateNotesCount(); };
function applyHighlights() {
  unwrap('mark.hl');
  for (const h of getHls().filter(h => h.ch === st.ch)) {
    wrap(h.start, h.end, () => { const m = document.createElement('mark'); m.className = 'hl' + (h.note ? ' note' : ''); m.dataset.c = h.color; m.dataset.id = h.id; return m; });
  }
}
function refreshMarks() { const off = st.anchor != null ? st.anchor : st.off; applyHighlights(); if (paged()) { goToOffset(off); setOffset(false); } }
function addHighlight(start, end, color, note = '') {
  const c = book.chapters[st.ch];
  const text = c.text.slice(start, end).replace(/\s+/g, ' ').trim();
  const h = { id: uid(), ch: st.ch, chTitle: c.title, start, end, color, note, text, at: Date.now() };
  const l = getHls(); l.push(h); l.sort((a, b) => a.ch - b.ch || a.start - b.start); setHls(l);
  refreshMarks();
  return h;
}
function updateHighlight(id, patch) {
  const l = getHls(); const h = l.find(x => x.id === id); if (!h) return;
  Object.assign(h, patch); setHls(l); refreshMarks();
}
function deleteHighlight(id) { setHls(getHls().filter(x => x.id !== id)); refreshMarks(); toast('Highlight deleted'); }

let selState = null;
const onSelChange = debounce(() => {
  if (!readerOpen() || !book) return;
  const sel = getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !String(sel).trim()) { if (selState && selState.mode === 'new') hideSel(); return; }
  const r = sel.getRangeAt(0);
  if (!flow.contains(r.commonAncestorContainer)) return;
  const { start, end } = rangeOffsets(r);
  if (end <= start) return;
  showSel({ mode: 'new', start, end, rect: r.getBoundingClientRect(), text: String(sel) });
}, 160);
document.addEventListener('selectionchange', onSelChange);

function showSel(s) {
  selState = s;
  const words = (s.text || '').trim().split(/\s+/).length;
  const h = s.mode === 'edit' ? getHls().find(x => x.id === s.id) : null;
  const colors = COLORS.map(c => `<button class="c" data-c="${c}" aria-label="Highlight ${c}" aria-pressed="${h ? h.color === c : false}"></button>`).join('');
  let actions = `<span class="sep"></span>
    <button class="t" data-a="note"><svg class="i"><use href="#i-note"/></svg>${h && h.note ? 'Edit note' : 'Note'}</button>
    <button class="t" data-a="copy"><svg class="i"><use href="#i-copy"/></svg>Copy</button>`;
  if (s.mode === 'new') {
    if (words <= 3) actions += `<button class="t" data-a="define"><svg class="i"><use href="#i-define"/></svg>Define</button>`;
    actions += `<button class="t" data-a="translate"><svg class="i"><use href="#i-translate"/></svg>Translate</button>`;
    actions += `<button class="t" data-a="image"><svg class="i"><use href="#i-image"/></svg>Image</button>`;
    actions += `<button class="t" data-a="find"><svg class="i"><use href="#i-search"/></svg>Find</button>`;
    if ('speechSynthesis' in window) actions += `<button class="t" data-a="speak"><svg class="i"><use href="#i-listen"/></svg>Listen</button>`;
  } else actions += `<button class="t" data-a="image"><svg class="i"><use href="#i-image"/></svg>Image</button><button class="t" data-a="delete"><svg class="i"><use href="#i-trash"/></svg>Delete</button>`;
  seltool.innerHTML = colors + actions;
  seltool.hidden = false;
  const w = seltool.offsetWidth, hh = seltool.offsetHeight, r = s.rect;
  let top = coarse ? r.bottom + 14 : r.top - hh - 12;
  if (top < 60) top = r.bottom + 12;
  if (top + hh > innerHeight - 10) top = Math.max(60, r.top - hh - 12);
  seltool.style.top = top + 'px';
  seltool.style.left = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8) + 'px';
}
function showSelForHighlight(id, mark) {
  const h = getHls().find(x => x.id === id); if (!h) return;
  const marks = flow.querySelectorAll(`mark.hl[data-id="${CSS.escape(id)}"]`);
  const rect = (marks[0] || mark).getBoundingClientRect();
  showSel({ mode: 'edit', id, start: h.start, end: h.end, rect, text: h.text });
}
function hideSel() { seltool.hidden = true; selState = null; }
seltool.addEventListener('pointerdown', e => e.preventDefault());
seltool.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || !selState) return;
  const s = selState;
  const clear = () => { const sel = getSelection(); sel && sel.removeAllRanges(); };
  if (b.dataset.c) {
    if (s.mode === 'new') addHighlight(s.start, s.end, b.dataset.c);
    else updateHighlight(s.id, { color: b.dataset.c });
    clear(); hideSel(); return;
  }
  const a = b.dataset.a;
  if (a === 'note') {
    let h = s.mode === 'edit' ? getHls().find(x => x.id === s.id) : addHighlight(s.start, s.end, 'yellow');
    clear(); hideSel(); openNote(h);
  } else if (a === 'copy') {
    const text = s.mode === 'edit' ? s.text : book.chapters[st.ch].text.slice(s.start, s.end);
    try { await navigator.clipboard.writeText(text.trim()); toast('Copied'); } catch { toast('Copy is blocked here. Use your system copy shortcut.'); }
    hideSel();
  } else if (a === 'define') {
    const rect = s.rect; clear(); hideSel(); showDefinition(book.chapters[st.ch].text.slice(s.start, s.end), s.start, rect);
  } else if (a === 'translate') {
    const rect = s.rect; clear(); hideSel(); showTranslation(book.chapters[st.ch].text.slice(s.start, s.end).trim(), rect);
  } else if (a === 'image') {
    const text = (s.mode === 'edit' ? s.text : book.chapters[st.ch].text.slice(s.start, s.end)).replace(/\s+/g, ' ').trim();
    clear(); hideSel(); extras.quoteCard({ text, book: book.title, author: book.author, entryId: entryCur.id });
  } else if (a === 'find') {
    const q = book.chapters[st.ch].text.slice(s.start, s.end).trim().slice(0, 80);
    clear(); hideSel(); openDrawer('find'); $('#find-q').value = q; runFind();
  } else if (a === 'speak') {
    clear(); hideSel(); ttsStart(s.start);
  } else if (a === 'delete') {
    hideSel(); deleteHighlight(s.id);
  }
});
document.addEventListener('pointerdown', e => {
  if (!seltool.hidden && !seltool.contains(e.target) && !e.target.closest('#flow')) hideSel();
  if (!fnpop.hidden && !fnpop.contains(e.target) && !e.target.closest('#flow a')) hideFn();
});

// Note dialog
const noteDlg = $('#note-dlg');
let noteFor = null;
function openNote(h) {
  noteFor = h.id;
  $('#note-quote').textContent = h.text;
  $('#note-quote').style.setProperty('--qc', `var(--dot-${h.color})`);
  $('#note-text').value = h.note || '';
  noteDlg.returnValue = '';
  noteDlg.showModal();
  setTimeout(() => $('#note-text').focus(), 30);
}
noteDlg.addEventListener('close', () => {
  const v = noteDlg.returnValue;
  if (!noteFor) return;
  if (v === 'save') { updateHighlight(noteFor, { note: $('#note-text').value.trim() }); toast('Note saved'); }
  else if (v === 'delete') deleteHighlight(noteFor);
  noteFor = null;
  if (!$('#p-notes').hidden) renderNotes();
});
$('#note-text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); noteDlg.close('save'); } });

/* =========================================================
   Bookmarks
   ========================================================= */
const bmKey = () => 'marks:' + book.id;
const getBms = () => store.get(bmKey(), []).filter(b => b.off != null || b.page != null || b.t != null);
function currentBookmark() {
  if (!book) return null;
  if (book.audio) { const s0 = ap.state(); return s0 ? getBms().find(b => b.t != null && Math.abs(b.t - s0.t) < 5) || null : null; }
  if (book.fixed) { const ps = fx.state().pages; return getBms().find(b => ps.includes(b.page)) || null; }
  return getBms().find(b => b.ch === st.ch && isOffsetOnScreen(b.off)) || null;
}
function toggleBookmark() {
  if (!book) return;
  const cur = currentBookmark();
  let l = getBms();
  if (cur) { l = l.filter(b => b.id !== cur.id); toast('Bookmark removed'); }
  else if (book.audio) {
    const s0 = ap.state(), c0 = ap.book.chapters[s0.chapter];
    l.push({ id: uid(), t: s0.t, pct: s0.total ? s0.t / s0.total : 0, text: `${c0.title} · ${fmtTime(s0.t - c0.start, s0.chEnd - s0.chStart >= 3600)}`, at: Date.now() });
    toast('Bookmarked this moment');
  } else if (book.fixed) {
    const p = fx.state().page;
    l.push({ id: uid(), page: p, pct: fixedPct(), text: fixedTocTitle(p) ? `${fixedTocTitle(p)}, page ${p + 1}` : `Page ${p + 1}`, at: Date.now() });
    toast('Page bookmarked');
  } else {
    const t = book.chapters[st.ch].text.slice(st.off, st.off + 140).replace(/\s+/g, ' ').trim();
    l.push({ id: uid(), ch: st.ch, off: st.off, pct: overall(), text: t.length >= 120 ? t.slice(0, 120).replace(/\s\S*$/, '') + '…' : t, at: Date.now() });
    toast('Page bookmarked');
  }
  l.sort((a, b) => book.audio ? a.t - b.t : book.fixed ? a.page - b.page : (a.ch - b.ch || a.off - b.off));
  store.set(bmKey(), l);
  update(); updateNotesCount();
  if (!$('#p-notes').hidden) renderNotes();
}
$('#b-mark').addEventListener('click', toggleBookmark);

/* =========================================================
   Drawer: contents, notes, search
   ========================================================= */
function openDrawer(tab) {
  closeSettings(); hideSel(); hideFn(); showChrome();
  showTab(tab);
  drawerProgress();
  drawer.classList.add('open'); scrim.classList.add('on');
  drawer.setAttribute('aria-hidden', 'false'); drawer.inert = false;
  setTimeout(() => {
    if (tab === 'find') $('#find-q').focus();
    else { const cur = drawer.querySelector('#toc-list [aria-current="true"]'); (cur || $('#b-close')).focus({ preventScroll: true }); cur && cur.scrollIntoView({ block: 'center' }); }
  }, 80);
}
function closeDrawer() {
  if (!drawer.classList.contains('open')) return;
  drawer.classList.remove('open'); scrim.classList.remove('on');
  drawer.setAttribute('aria-hidden', 'true'); drawer.inert = true;
  pageEl.focus({ preventScroll: true });
}
function drawerProgress() {
  if (book.audio) {
    const s0 = ap.state(); if (!s0) return; const p = s0.total ? s0.t / s0.total : 0;
    $('#dr-bar').style.width = (p * 100) + '%';
    $('#dr-pct').textContent = `${Math.round(p * 100)}% · ${fmtLong((s0.total - s0.t) / s0.rate)} left`;
    return;
  }
  if (book.fixed) {
    const p = fixedPct(), left = book.pageCount - (fx.state().pages.slice(-1)[0] + 1);
    $('#dr-bar').style.width = (p * 100) + '%';
    $('#dr-pct').textContent = `${Math.round(p * 100)}% · ${left ? `${left} ${left === 1 ? 'page' : 'pages'} left` : 'last page'}`;
    return;
  }
  const p = overall();
  $('#dr-bar').style.width = (p * 100) + '%';
  const left = Math.round(book.words * (1 - p) / wpm() * 60);
  $('#dr-pct').textContent = `${Math.round(p * 100)}% · ${left > 60 ? fmtDur(left) + ' left' : 'almost done'}`;
}
function showTab(tab) {
  $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  $('#p-toc').hidden = tab !== 'toc'; $('#p-notes').hidden = tab !== 'notes'; $('#p-find').hidden = tab !== 'find';
  if (tab === 'toc') renderToc();
  if (tab === 'notes') renderNotes();
}
$$('.tab').forEach(t => t.addEventListener('click', () => { showTab(t.dataset.tab); if (t.dataset.tab === 'find') $('#find-q').focus(); }));
$('#b-toc').addEventListener('click', () => openDrawer('toc'));
$('#b-search').addEventListener('click', () => openDrawer('find'));
$('#b-close').addEventListener('click', closeDrawer);
scrim.addEventListener('click', () => { closeDrawer(); closeSettings(); });

function currentTocIndex() {
  let best = -1;
  book.toc.forEach((t, i) => {
    if (t.ch < st.ch) best = i;
    else if (t.ch === st.ch) {
      if (!t.anchor) { best = i; return; }
      const el = flow.querySelector('#' + CSS.escape(t.anchor));
      if (!el) { best = i; return; }
      const r = el.getClientRects()[0] || el.getBoundingClientRect();
      const reached = paged() ? pageOfRect(r) <= st.page : r.top <= pageEl.getBoundingClientRect().top + pageEl.clientHeight / 2;
      if (reached) best = i;
    }
  });
  return best;
}
let thumbObs = null;
function renderFixedToc() {
  const ul = $('#toc-list'); ul.innerHTML = '';
  const cur = fx.state().page;
  if (book.toc.length) {
    let curIdx = -1; book.toc.forEach((t, i) => { if (t.page <= cur) curIdx = i; });
    book.toc.forEach((t, i) => {
      const li = document.createElement('li'); const b = document.createElement('button');
      b.className = 'row d' + Math.min(t.depth, 2); b.type = 'button'; b.style.paddingLeft = (14 + t.depth * 16) + 'px';
      b.innerHTML = `<span>${esc(t.title)}</span><span class="n">p. ${t.page + 1}</span>`;
      if (i === curIdx) b.setAttribute('aria-current', 'true');
      b.onclick = () => { closeDrawer(); fx.go(t.page); };
      li.appendChild(b); ul.appendChild(li);
    });
  }
  const h = document.createElement('li'); h.className = 'sec-h'; h.textContent = 'Pages'; ul.appendChild(h);
  const grid = document.createElement('li'); grid.className = 'thumbs'; ul.appendChild(grid);
  if (thumbObs) thumbObs.disconnect();
  thumbObs = new IntersectionObserver(ents => ents.forEach(async en => {
    if (!en.isIntersecting) return; thumbObs.unobserve(en.target);
    const i = +en.target.dataset.p;
    try { const el = await book.render(i, { w: 92, h: 130, zoom: 1 }); el.removeAttribute('style'); en.target.querySelector('.tb').replaceChildren(el); } catch {}
  }), { root: $('#p-toc'), rootMargin: '200px' });
  for (let i = 0; i < book.pageCount; i++) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'thumb'; b.dataset.p = i;
    b.innerHTML = `<span class="tb"></span><span>${i + 1}</span>`;
    b.onclick = () => { closeDrawer(); fx.go(i); };
    grid.appendChild(b); thumbObs.observe(b);
  }
  markThumbs();
}
function markThumbs() {
  if (!book.fixed || $('#p-toc').hidden) return;
  const ps = fx.state().pages;
  $$('#toc-list .thumb').forEach(t => ps.includes(+t.dataset.p) ? t.setAttribute('aria-current', 'true') : t.removeAttribute('aria-current'));
}
function renderAudioToc() {
  const ul = $('#toc-list'); ul.innerHTML = '';
  const s0 = ap.state(); const cur = s0 ? s0.chapter : -1; const long = ap.book.total >= 3600;
  ap.book.chapters.forEach((c, i) => {
    const li = document.createElement('li'); const b = document.createElement('button');
    b.className = 'row d0 audrow'; b.type = 'button';
    const end = i < ap.book.chapters.length - 1 ? ap.book.chapters[i + 1].start : ap.book.total;
    b.innerHTML = `<span>${esc(c.title)}</span><span class="n">${fmtTime(c.start, long)} · ${fmtLong(end - c.start)}</span>`;
    if (i === cur) b.setAttribute('aria-current', 'true');
    b.onclick = () => { closeDrawer(); ap.seek(c.start); };
    li.appendChild(b); ul.appendChild(li);
  });
}
function renderToc() {
  if (book.audio) return renderAudioToc();
  if (book.fixed) return renderFixedToc();
  const ul = $('#toc-list'); ul.innerHTML = '';
  const cur = currentTocIndex();
  const frag = document.createDocumentFragment();
  book.toc.forEach((t, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'row d' + Math.min(t.depth, 2); b.type = 'button';
    b.style.paddingLeft = (14 + t.depth * 16) + 'px';
    b.innerHTML = `<span>${esc(t.title)}</span><span class="n">${Math.round(book.chapters[t.ch].start / book.total * 100)}%</span>`;
    if (i === cur) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => { closeDrawer(); renderChapter(t.ch, { anchor: t.anchor }); });
    li.appendChild(b); frag.appendChild(li);
  });
  ul.appendChild(frag);
}
function markCurrentToc() {
  if ($('#p-toc').hidden || book.fixed) return;
  if (book.audio) { const s0 = ap.state(); $$('#toc-list .row').forEach((b, i) => i === (s0 && s0.chapter) ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')); return; }
  const cur = currentTocIndex();
  $$('#toc-list .row').forEach((b, i) => i === cur ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current'));
}
function updateNotesCount() {
  if (!book) return;
  const n = getHls().length + getBms().length;
  $('#notes-n').textContent = n ? String(n) : '';
}
const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function renderNotes() {
  const p = $('#p-notes'); p.innerHTML = '';
  const hls = getHls(), bms = getBms();
  if (!hls.length && !bms.length) {
    p.innerHTML = `<p class="empty">Select any passage to highlight it in one of five colours or attach a note. Bookmark a page with the ribbon at the top, or press <kbd>B</kbd>. Everything you save appears here and can be exported as Markdown.</p>`;
    return;
  }
  const head = document.createElement('div'); head.className = 'sec-h';
  head.innerHTML = `<span>${hls.length} ${hls.length === 1 ? 'highlight' : 'highlights'} · ${bms.length} ${bms.length === 1 ? 'bookmark' : 'bookmarks'}</span><span class="acts"><button class="mini" data-x2="copy">Copy</button></span>`;
  p.appendChild(head);
  const ex = document.createElement('div'); ex.className = 'export-row'; ex.style.cssText = 'padding:0 12px;margin:2px 0 6px';
  ex.innerHTML = '<span class="dlg-note" style="align-self:center">Export:</span>' + extras.exportButtons();
  p.appendChild(ex);
  extras.wireExports(ex, () => extras.allHighlights().filter(h => h.bookId === book.id));
  head.querySelector('[data-x2="copy"]').onclick = async () => { try { await navigator.clipboard.writeText(notesMarkdown()); toast('Notes copied as Markdown'); } catch { toast('Copy is blocked here. Use Export instead.'); } };
  if (bms.length) {
    const h = document.createElement('div'); h.className = 'sec-h'; h.textContent = 'Bookmarks'; p.appendChild(h);
    const ul = document.createElement('ul'); ul.className = 'list';
    bms.forEach(b => {
      const li = document.createElement('li'); li.className = 'ann';
      li.innerHTML = `<button class="row" type="button"><span class="q">${esc(b.text)}</span><span class="meta">${book.fixed || book.audio ? '' : esc(book.chapters[b.ch] ? book.chapters[b.ch].title : '') + ' · '}${book.audio ? fmtTime(b.t, true) + ' · ' : ''}${Math.round((b.pct || 0) * 100)}% · ${shortDate(b.at)}</span></button><button class="icon-btn" aria-label="Remove bookmark"><svg class="i"><use href="#i-x"/></svg></button>`;
      li.querySelector('.row').onclick = () => { closeDrawer(); if (book.audio) ap.seek(b.t); else if (book.fixed) fx.go(b.page); else renderChapter(b.ch, { off: b.off }); };
      li.querySelector('.icon-btn').onclick = () => { store.set(bmKey(), getBms().filter(x => x.id !== b.id)); renderNotes(); update(); updateNotesCount(); };
      ul.appendChild(li);
    });
    p.appendChild(ul);
  }
  let lastCh = -1, ul = null;
  hls.forEach(hl => {
    if (hl.ch !== lastCh) {
      lastCh = hl.ch;
      const h = document.createElement('div'); h.className = 'sec-h'; h.textContent = book.chapters[hl.ch] ? book.chapters[hl.ch].title : 'Section';
      p.appendChild(h); ul = document.createElement('ul'); ul.className = 'list'; p.appendChild(ul);
    }
    const li = document.createElement('li'); li.className = 'ann';
    li.innerHTML = `<button class="row" type="button"><span class="q"><mark data-c="${hl.color}">${esc(hl.text)}</mark></span>${hl.note ? `<span class="nt">${esc(hl.note)}</span>` : ''}<span class="meta">${shortDate(hl.at)}</span></button>
      <button class="icon-btn" aria-label="Edit note"><svg class="i"><use href="#i-pencil"/></svg></button>`;
    li.querySelector('.row').onclick = () => { closeDrawer(); if (hl.ch === st.ch) { goToOffset(hl.start); setOffset(true); update(); } else renderChapter(hl.ch, { off: hl.start }); };
    li.querySelector('.icon-btn').onclick = () => openNote(hl);
    ul.appendChild(li);
  });
}
function notesMarkdown() {
  let md = `# ${book.title}\n${book.author ? `*${book.author}*\n` : ''}\nExported from Margin on ${new Date().toLocaleDateString()}\n`;
  const bms = getBms();
  if (bms.length) { md += `\n## Bookmarks\n\n`; bms.forEach(b => { md += `- ${book.chapters[b.ch].title} (${Math.round(b.pct * 100)}%): ${b.text}\n`; }); }
  let last = -1;
  getHls().forEach(h => {
    if (h.ch !== last) { last = h.ch; md += `\n## ${book.chapters[h.ch].title}\n\n`; }
    md += `> ${h.text}\n\n`;
    if (h.note) md += `${h.note}\n\n`;
  });
  return md;
}
function exportNotes() {
  const blob = new Blob([notesMarkdown()], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${book.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) || 'Notes'} — notes.md`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Notes exported');
}

// Search
const runFindD = debounce(runFind, 220);
$('#find-form').addEventListener('submit', e => { e.preventDefault(); runFind(); });
$('#find-q').addEventListener('input', runFindD);
let findToken = 0;
async function runFindFixed(q) {
  const my = ++findToken;
  const ul = $('#find-list'), count = $('#find-count'); ul.innerHTML = '';
  if (!book.searchable) { count.textContent = 'This book is made of images, so it has no text to search.'; return; }
  if (q.length < 2) { count.textContent = q ? 'Type at least two characters.' : ''; return; }
  const ql = q.toLowerCase(); let total = 0;
  for (let i = 0; i < book.pageCount; i++) {
    if (my !== findToken) return;
    if (i % 20 === 0) count.textContent = `Searching… page ${i + 1} of ${book.pageCount}${total ? ` · ${total} found` : ''}`;
    const t = (await book.pageText(i)).replace(/\s+/g, ' '), tl = t.toLowerCase();
    let at = 0;
    while ((at = tl.indexOf(ql, at)) >= 0 && total < 300) {
      const a = Math.max(0, at - 60), z = Math.min(t.length, at + q.length + 80);
      const li = document.createElement('li'); li.className = 'hit';
      li.innerHTML = `<button class="row" type="button"><span class="snip">${a > 0 ? '…' : ''}${esc(t.slice(a, at))}<mark>${esc(t.slice(at, at + q.length))}</mark>${esc(t.slice(at + q.length, z))}${z < t.length ? '…' : ''}</span><span class="meta">Page ${i + 1}</span></button>`;
      const pg = i; li.querySelector('button').onclick = () => { closeDrawer(); fx.go(pg); };
      ul.appendChild(li); total++; at += ql.length;
    }
  }
  if (my === findToken) count.textContent = total ? `${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'}${total >= 300 ? ' · showing the first 300' : ''}` : `No matches for “${q}”.`;
}
function runFind() {
  if (book && book.audio) {
    const q = $('#find-q').value.trim().toLowerCase(), ul = $('#find-list'); ul.innerHTML = '';
    const hits = ap.book.chapters.map((c, i) => ({ c, i })).filter(x => !q || x.c.title.toLowerCase().includes(q));
    $('#find-count').textContent = q ? `${hits.length} ${hits.length === 1 ? 'chapter matches' : 'chapters match'} “${$('#find-q').value.trim()}”. Audiobooks can be searched by chapter title.` : 'Audiobooks can be searched by chapter title.';
    hits.slice(0, 300).forEach(({ c }) => { const li = document.createElement('li'); li.className = 'hit'; li.innerHTML = `<button class="row" type="button"><span class="snip">${esc(c.title)}</span><span class="meta">${fmtTime(c.start, true)}</span></button>`; li.querySelector('button').onclick = () => { closeDrawer(); ap.seek(c.start); }; ul.appendChild(li); });
    return;
  }
  if (book && book.fixed) return runFindFixed($('#find-q').value.trim());
  const q = $('#find-q').value.trim();
  const ul = $('#find-list'); ul.innerHTML = '';
  const count = $('#find-count');
  if (q.length < 2) { count.textContent = q ? 'Type at least two characters.' : ''; return; }
  const ql = q.toLowerCase();
  let total = 0; const MAX = 300; const frag = document.createDocumentFragment();
  book.chapters.forEach((c, i) => {
    const t = c.text, tl = t.toLowerCase();
    let at = 0;
    while ((at = tl.indexOf(ql, at)) >= 0) {
      if (total < MAX) {
        const a = Math.max(0, at - 60), z = Math.min(t.length, at + q.length + 80);
        let before = t.slice(a, at).replace(/\s+/g, ' ');
        if (a > 0) before = '…' + before.replace(/^\S*\s/, '');
        const li = document.createElement('li'); li.className = 'hit';
        const b = document.createElement('button'); b.className = 'row'; b.type = 'button';
        b.innerHTML = `<span class="snip">${esc(before)}<mark>${esc(t.slice(at, at + q.length))}</mark>${esc(t.slice(at + q.length, z).replace(/\s+/g, ' '))}${z < t.length ? '…' : ''}</span><span class="meta">${esc(c.title)}</span>`;
        const start = at;
        b.addEventListener('click', () => { closeDrawer(); renderChapter(i, { find: { start, len: q.length } }); });
        li.appendChild(b); frag.appendChild(li);
      }
      total++; at += ql.length;
    }
  });
  ul.appendChild(frag);
  count.textContent = total ? `${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'}${total > MAX ? ` · showing the first ${MAX}` : ''}` : `No matches for “${q}”.`;
}

/* =========================================================
   Read aloud
   ========================================================= */
const tts = { on: false, playing: false, sents: [], idx: 0, ch: -1, utter: null };
const RATES = [0.8, 1, 1.15, 1.3, 1.5, 1.75, 2];
function sentencesOf(ch) {
  const text = book.chapters[ch].text, out = [];
  if (window.Intl && Intl.Segmenter) {
    const seg = new Intl.Segmenter(book.lang || 'en', { granularity: 'sentence' });
    for (const s of seg.segment(text)) push(s.index, s.index + s.segment.length);
  } else {
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g; let m;
    while ((m = re.exec(text))) { push(m.index, m.index + m[0].length); if (!m[0].length) re.lastIndex++; }
  }
  function push(a, b) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b - a < 1) return;
    // split very long sentences so the engine doesn't stall
    while (b - a > 280) { let cut = text.lastIndexOf(' ', a + 260); if (cut <= a) cut = a + 260; out.push({ a, b: cut }); a = cut + 1; }
    out.push({ a, b });
  }
  return out;
}
let voices = [];
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices();
  const sel = $('#voice');
  if (!voices.length) return;
  $('#row-voice').hidden = false;
  const lang = (book && book.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
  const pref = voices.filter(v => v.lang.toLowerCase().startsWith(lang));
  const list = pref.length ? pref : voices;
  sel.innerHTML = '<option value="">System default</option>' + list.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)}${v.localService ? '' : ' (online)'}</option>`).join('');
  sel.value = settings.voice || '';
}
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', loadVoices); }
else $('#b-listen').hidden = true;
$('#voice').addEventListener('change', e => { settings.voice = e.target.value; saveSettings(); if (tts.playing) ttsSpeak(); });

function ttsStart(fromOff) {
  if (book && book.audio) { ap.toggle(); return; }
  if (book && book.fixed) { toast(book.kind === 'pdf' ? 'Switch this PDF to text view to listen.' : 'Comics can’t be read aloud.'); return; }
  if (!('speechSynthesis' in window)) { toast('Read aloud isn’t available in this browser.'); return; }
  tts.on = true; tts.ch = st.ch; tts.sents = sentencesOf(st.ch);
  const off = fromOff != null ? fromOff : st.off;
  tts.idx = Math.max(0, tts.sents.findIndex(s => s.b > off));
  $('#tts').hidden = false; $('#b-listen').setAttribute('aria-pressed', 'true');
  ttsPlay();
}
function ttsPlay() { tts.playing = true; $('#tts').classList.add('playing'); setPlayIcon(); ttsSpeak(); mediaSession(); }
function ttsPause() {
  tts.playing = false; tts.utter = null; speechSynthesis.cancel();
  $('#tts').classList.remove('playing'); setPlayIcon();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}
function ttsStop() {
  ttsPause(); tts.on = false; $('#tts').hidden = true; $('#b-listen').setAttribute('aria-pressed', 'false'); unwrap('mark.speak');
}
function ttsToggle() { if (!tts.on) ttsStart(); else if (tts.playing) ttsPause(); else ttsPlay(); }
function setPlayIcon() {
  const b = $('#tts-play');
  b.innerHTML = `<svg class="i"><use href="#i-${tts.playing ? 'pause' : 'play'}"/></svg>`;
  b.setAttribute('aria-label', tts.playing ? 'Pause' : 'Play');
}
function ttsSpeak() {
  if (!tts.on || !book) return;
  if (tts.ch !== st.ch) { renderChapter(tts.ch, { off: 0 }); }
  const s = tts.sents[tts.idx];
  if (!s) {
    if (tts.ch < book.chapters.length - 1) {
      tts.ch++; tts.sents = sentencesOf(tts.ch); tts.idx = 0;
      renderChapter(tts.ch, {}); return ttsSpeak();
    }
    ttsStop(); finished(); return;
  }
  unwrap('mark.speak');
  const marks = wrap(s.a, s.b, () => Object.assign(document.createElement('mark'), { className: 'speak' }));
  if (marks[0]) setCurPara(marks[0].closest(PARA));
  if (marks[0] && !isOffsetOnScreen(s.a)) { goToOffset(s.a); setOffset(true); update(); }
  else if (marks[0] && !paged()) {
    const r = marks[marks.length - 1].getBoundingClientRect(), pr = pageEl.getBoundingClientRect();
    if (r.bottom > pr.bottom - 120) pageEl.scrollBy({ top: r.top - pr.top - 120, behavior: reduced ? 'auto' : 'smooth' });
  }
  $('#tts-lbl').textContent = book.chapters[tts.ch].title;
  const u = new SpeechSynthesisUtterance(book.chapters[tts.ch].text.slice(s.a, s.b));
  u.rate = settings.rate; u.lang = book.lang || 'en';
  const v = voices.find(v => v.voiceURI === settings.voice); if (v) u.voice = v;
  u.onend = () => { if (tts.playing && tts.utter === u) { tts.idx++; ttsSpeak(); } };
  u.onerror = ev => { if (tts.utter === u && ev.error !== 'interrupted' && ev.error !== 'canceled') { toast('Read aloud stopped: the voice engine reported an error.'); ttsPause(); } };
  tts.utter = u;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  touchActive();
}
function mediaSession() {
  if (!('mediaSession' in navigator) || !book) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: book.chapters[tts.ch].title, artist: book.author || '', album: book.title, artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
    navigator.mediaSession.playbackState = 'playing';
    navigator.mediaSession.setActionHandler('play', ttsPlay);
    navigator.mediaSession.setActionHandler('pause', ttsPause);
    navigator.mediaSession.setActionHandler('previoustrack', () => { tts.idx = Math.max(0, tts.idx - 1); ttsSpeak(); });
    navigator.mediaSession.setActionHandler('nexttrack', () => { tts.idx++; ttsSpeak(); });
  } catch {}
}
$('#b-listen').addEventListener('click', () => { if (tts.on) ttsStop(); else ttsStart(); });
$('#tts-play').addEventListener('click', () => tts.playing ? ttsPause() : ttsPlay());
$('#tts-prev').addEventListener('click', () => { tts.idx = Math.max(0, tts.idx - 1); if (tts.playing) ttsSpeak(); else { tts.playing = true; ttsPlay(); } });
$('#tts-next').addEventListener('click', () => { tts.idx++; if (tts.playing) ttsSpeak(); else ttsPlay(); });
$('#tts-close').addEventListener('click', ttsStop);
$('#tts-rate').addEventListener('click', () => {
  const i = RATES.indexOf(settings.rate);
  settings.rate = RATES[(i + 1) % RATES.length]; saveSettings(); rateLabel();
  if (tts.playing) ttsSpeak();
});
const rateLabel = () => { $('#tts-rate').textContent = settings.rate.toFixed(settings.rate % 1 ? (String(settings.rate).length > 3 ? 2 : 1) : 1) + '×'; };
rateLabel();

/* =========================================================
   Settings
   ========================================================= */
const saveSettings = () => store.set('settings', settings);
function setSetting(k, v) { settings[k] = v; applySettings(k === 'layout'); }
function applySettings(rerender, noLayout) {
  const off = st.anchor != null ? st.anchor : st.off;
  if (settings.theme === 'auto') delete app.dataset.rtheme; else app.dataset.rtheme = settings.theme;
  pageEl.style.setProperty('--rs', settings.size + 'px');
  pageEl.style.setProperty('--lh', settings.lh);
  pageEl.style.setProperty('--rf', FONTS[settings.font] || FONTS.literata);
  app.classList.toggle('paged', paged());
  app.classList.toggle('scroll', !paged());
  app.classList.toggle('justify', !!settings.justify);
  app.classList.toggle('dropcap', !!settings.dropcap);
  app.classList.toggle('indent', settings.para === 'indent');
  app.classList.toggle('spaced', settings.para === 'spaced');
  app.classList.toggle('focus-dim', !!settings.focus);
  app.classList.toggle('bionic', !!settings.bionic);
  pageEl.style.setProperty('--lsx', settings.ls ? (settings.ls / 100) + 'em' : 'normal');
  pageEl.style.setProperty('--wsx', settings.ws ? (settings.ws / 100) + 'em' : 'normal');
  $('#ls').value = settings.ls; $('#ws').value = settings.ws;
  $('#ls-out').textContent = settings.ls ? `+${settings.ls}%` : 'Normal'; $('#ws-out').textContent = settings.ws ? `+${settings.ws}%` : 'Normal';
  $('#opt-ruler').checked = !!settings.ruler; $('#opt-bionic').checked = !!settings.bionic; $('#opt-focus').checked = !!settings.focus;
  if (typeof placeRuler === 'function' && readerOpen()) placeRuler();
  $('#warm').style.opacity = String(settings.warmth / 100);
  $('#warm-out').textContent = settings.warmth ? Math.round(settings.warmth / 60 * 100) + '%' : 'Off';
  $('#warmth').value = settings.warmth;
  $('#sz').value = settings.size; $('#sz-out').textContent = settings.size + ' px';
  $('#sz-dn').disabled = settings.size <= 13; $('#sz-up').disabled = settings.size >= 32;
  $('#opt-justify').checked = !!settings.justify; $('#opt-dropcap').checked = !!settings.dropcap;
  $('#opt-anim').checked = !!settings.anim; $('#opt-furniture').checked = !!settings.furniture;
  $('#row-spread').hidden = !paged() && !(book && book.fixed);
  $$('[data-key]').forEach(g => g.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v == settings[g.dataset.key]))));
  $$('#sort button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === settings.sort)));
  saveSettings();
  requestAnimationFrame(() => {
    const bg = getComputedStyle(app).getPropertyValue('--bg').trim();
    if (bg) $$('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bg));
  });
  if (!book || !readerOpen() || noLayout) return;
  if (book.audio) return;
  if (book.fixed) { fx.layout(); return; }
  if (rerender) renderChapter(st.ch, { off, animate: false });
  else { layout(); goToOffset(off); setOffset(false); update('keep'); }
}
function openSettings() {
  closeDrawer(); hideSel(); hideFn(); showChrome();
  pop.classList.toggle('fixed-mode', !!(book && (book.fixed || book.audio)));
  pop.classList.toggle('audio-mode', !!(book && book.audio));
  pop.querySelector('.fixed-only').textContent = book && book.audio ? 'Speed and the sleep timer are on the player. These settings change how Margin looks.' : 'This book is laid out as fixed pages, so text settings don’t apply. For a PDF, switch to text view to change the type.';
  pop.hidden = false; $('#b-set').setAttribute('aria-expanded', 'true');
  if (innerWidth <= 760) scrim.classList.add('on');
}
function closeSettings() {
  if (pop.hidden) return;
  pop.hidden = true; $('#b-set').setAttribute('aria-expanded', 'false');
  scrim.classList.toggle('on', drawer.classList.contains('open'));
}
$('#b-set').addEventListener('click', e => { e.stopPropagation(); pop.hidden ? openSettings() : closeSettings(); });
document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#b-set')) closeSettings(); });
$('#sz').addEventListener('input', e => setSetting('size', +e.target.value));
$('#sz-dn').addEventListener('click', () => setSetting('size', clamp(settings.size - 1, 13, 32)));
$('#sz-up').addEventListener('click', () => setSetting('size', clamp(settings.size + 1, 13, 32)));
$('#warmth').addEventListener('input', e => { settings.warmth = +e.target.value; $('#warm').style.opacity = String(settings.warmth / 100); $('#warm-out').textContent = settings.warmth ? Math.round(settings.warmth / 60 * 100) + '%' : 'Off'; saveSettings(); });
[['#opt-justify', 'justify'], ['#opt-dropcap', 'dropcap'], ['#opt-anim', 'anim'], ['#opt-furniture', 'furniture']].forEach(([s, k]) =>
  $(s).addEventListener('change', e => setSetting(k, e.target.checked)));
$$('[data-key]').forEach(g => g.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  const k = g.dataset.key;
  setSetting(k, k === 'lh' ? parseFloat(b.dataset.v) : b.dataset.v);
})));

/* =========================================================
   Toast
   ========================================================= */
let toastT = 0;
function toast(msg, ms = 2200, action) {
  const t = $('#toast'); t.textContent = ''; t.append(msg); t.hidden = false;
  if (action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label;
    b.addEventListener('click', () => { t.hidden = true; action.run(); });
    t.appendChild(b);
  }
  clearTimeout(toastT); if (ms) toastT = setTimeout(() => { t.hidden = true; }, ms);
}

/* =========================================================
   Covers
   ========================================================= */
function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function coverStyle(e) {
  if (e.sample) return { k: 1, s: 'rule' };
  const h = hash(e.title + (e.author || ''));
  return { k: h % 8 + 1, s: ['rule', 'disc', 'band'][(h >> 3) % 3] };
}
function bookObject(e) {
  let face;
  const badge = e.kind === 'audio' ? '<span class="aud-badge" aria-label="Audiobook"><svg class="i"><use href="#i-headphones"/></svg></span>' : '';
  if (e.kind === 'audio' && e.cover) {
    if (!coverUrls.has(e.id)) coverUrls.set(e.id, URL.createObjectURL(e.cover));
    const u = coverUrls.get(e.id);
    return `<div class="face aud-face"><img class="ab" src="${u}" alt=""><img class="as" src="${u}" alt="" loading="lazy">${badge}</div><div class="pages"></div>`;
  }
  if (e.cover) {
    if (!coverUrls.has(e.id)) coverUrls.set(e.id, URL.createObjectURL(e.cover));
    face = `<div class="face"><img src="${coverUrls.get(e.id)}" alt="" loading="lazy"></div>`;
  } else {
    const { k, s } = coverStyle(e);
    const t = esc(e.title), a = esc(e.author || '');
    const inner = s === 'rule' ? `<span class="gt">${t}</span><span class="rule"></span><span class="ga">${a}</span>`
      : s === 'disc' ? `<span class="gt">${t}</span><span class="ga">${a}</span>`
      : `<div class="band"><span class="gt">${t}</span></div><span class="ga">${a}</span>`;
    face = `<div class="face" style="--cv:var(--cv-${k})"><div class="gen s-${s}">${inner}</div>${badge}</div>`;
  }
  return face + '<div class="pages"></div>';
}
async function tintFor(e) {
  const meta = store.get('meta:' + e.id, {});
  if (meta.tint) return meta.tint;
  if (!e.cover) return `var(--cv-${coverStyle(e).k})`;
  try {
    const bmp = await createImageBitmap(e.cover);
    const c = document.createElement('canvas'); c.width = 12; c.height = 18;
    const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, 12, 18);
    const d = x.getImageData(0, 0, 12, 18).data; let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const sat = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); const w = 1 + sat / 40; r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w; }
    const tint = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
    store.set('meta:' + e.id, Object.assign(meta, { tint }));
    return tint;
  } catch { return 'var(--accent)'; }
}

/* =========================================================
   Library
   ========================================================= */
let libEntries = [];
async function allEntries() {
  const fromDb = await dbAll();
  const map = new Map(fromDb.map(e => [e.id, e]));
  memEntries.forEach((e, id) => { if (!map.has(id)) map.set(id, e); });
  const sm = store.get('meta:' + SAMPLE_ENTRY.id, {});
  const sample = { ...SAMPLE_ENTRY, title: sm.title || SAMPLE_ENTRY.title, author: sm.author != null ? sm.author : SAMPLE_ENTRY.author };
  return store.get('sampleRemoved', false) ? [...map.values()] : [sample, ...map.values()];
}
const posOf = id => store.get('pos:' + id, null);
async function renderLibrary() {
  libEntries = await allEntries();
  updateWordsBadge();
  await renderHero();
  renderStrip();
  renderGrid();
}
async function renderHero() {
  const hero = $('#hero');
  const ranked = libEntries.map(e => ({ e, p: posOf(e.id) })).filter(x => x.p && !stats.finished[x.e.id]).sort((a, b) => (b.p.at || 0) - (a.p.at || 0));
  if (!libEntries.length) {
    hero.style.removeProperty('--tint');
    hero.innerHTML = `<div class="hero-copy" style="grid-column:1/-1"><span class="eyebrow">Your library is empty</span><h1 class="hero-title">Add your first book</h1>
      <p class="hero-author">Open an EPUB, PDF, MOBI, comic or audiobook from this device, or find free books in Discover.</p>
      <div class="hero-actions"><button class="btn primary" data-add><svg class="i"><use href="#i-plus"/></svg>Add a book</button><button class="btn" data-disc>Browse free books</button></div></div>`;
    hero.querySelector('[data-add]').onclick = () => $('#file').click();
    hero.querySelector('[data-disc]').onclick = () => showView('discover');
    return;
  }
  const pick = ranked[0] || { e: libEntries.find(e => !stats.finished[e.id]) || libEntries[0], p: posOf(libEntries[0].id) };
  const { e, p } = pick;
  hero.style.setProperty('--tint', await tintFor(e));
  const pct = p ? Math.round((p.pct || 0) * 100) : 0;
  const left = p && p.wordsLeft != null ? Math.round(p.wordsLeft / wpm() * 60) : null;
  const when = p && p.at ? relTime(p.at) : '';
  hero.innerHTML = `
    <div class="hero-book"><div class="book">${bookObject(e)}</div></div>
    <div class="hero-copy">
      <span class="eyebrow">${p ? 'Continue reading' : 'Start reading'}${when ? ` · ${when}` : ''}</span>
      <h1 class="hero-title">${esc(e.title)}</h1>
      <p class="hero-author">${esc(e.author || '')}</p>
      ${p && p.chTitle ? `<p class="hero-chap">${esc(p.chTitle)}</p>` : ''}
      <div class="progress"><span class="bar-track"><i style="width:${pct}%"></i></span><span>${pct}%${left != null && left > 0 ? ` · about ${fmtDur(left)} left` : p && p.secsLeft ? ` · ${fmtLong(p.secsLeft)} of listening left` : p && p.pagesLeft ? ` · ${p.pagesLeft} ${p.pagesLeft === 1 ? 'page' : 'pages'} left` : ''}</span></div>
      <div class="hero-actions"><button class="btn primary" data-open>${p ? 'Resume' : 'Open book'}<svg class="i"><use href="#i-next"/></svg></button></div>
    </div>`;
  hero.querySelector('[data-open]').onclick = () => openEntry(e);
  hero.querySelector('.hero-book').onclick = () => openEntry(e);
}
function relTime(t) {
  const d = Date.now() - t, m = Math.round(d / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24); if (days === 1) return 'yesterday'; if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function renderStrip() {
  const s = $('#stat-strip');
  const today = stats.days[dayKey()] || 0, str = streak(), fin = Object.keys(stats.finished).length;
  s.innerHTML = `
    <button class="stat" data-stats><b>${Math.round(today / 60)} / ${goalDaily()} min</b><span>Today’s goal${today / 60 >= goalDaily() ? ' · done' : ''}</span></button>
    <button class="stat" data-stats><b>${fmtDur(weekSecs())}</b><span>This week</span></button>
    <button class="stat" data-stats><b>${str} ${str === 1 ? 'day' : 'days'}</b><span>Reading streak</span></button>
    <button class="stat" data-stats><b>${fin}</b><span>${fin === 1 ? 'Book finished' : 'Books finished'}</span></button>`;
  s.querySelectorAll('[data-stats]').forEach(b => b.onclick = () => showView('insights'));
}
function renderGrid() {
  const grid = $('#grid');
  const q = $('#lib-q').value.trim().toLowerCase();
  extras.renderChips(libEntries);
  const tagQ = q.startsWith('#') ? q.slice(1) : null;
  let list = extras.filterByShelf(libEntries).filter(e => {
    if (!q) return true;
    const m = extras.meta(e.id);
    if (tagQ != null) return (m.tags || []).some(t => t.toLowerCase().startsWith(tagQ));
    return (e.title + ' ' + (e.author || '') + ' ' + (m.tags || []).join(' ')).toLowerCase().includes(q);
  });
  const pos = id => posOf(id) || {};
  const by = {
    recent: (a, b) => (pos(b.id).at || b.added || 0) - (pos(a.id).at || a.added || 0),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.author || '~').split(' ').pop().localeCompare((b.author || '~').split(' ').pop()) || a.title.localeCompare(b.title),
    progress: (a, b) => (pos(b.id).pct || 0) - (pos(a.id).pct || 0)
  };
  list.sort(by[settings.sort] || by.recent);
  grid.innerHTML = '';
  list.forEach((e, i) => {
    const p = posOf(e.id);
    const pct = p ? Math.round((p.pct || 0) * 100) : 0;
    const fin = stats.finished[e.id];
    const card = document.createElement('div'); card.className = 'card' + (selecting ? ' pickable' : '') + (sel.has(e.id) ? ' selected' : ''); card.style.setProperty('--i', i); card.dataset.id = e.id;
    const meta = fin ? `<span class="pill">Finished</span>`
      : p ? `<span class="bar-track"><i style="width:${pct}%"></i></span><span>${pct}%</span>`
      : `<span class="pill">${e.sample ? 'Sample' : e.kind === 'audio' ? 'Audiobook' : 'New'}</span>`;
    card.innerHTML = `
      <button class="card-open" type="button" aria-label="${selecting ? `Select ${esc(e.title)}` : `Open ${esc(e.title)}`}"${selecting ? ` aria-pressed="${sel.has(e.id)}"` : ''}>
        <div class="book">${bookObject(e)}${selecting ? '<span class="pick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>' : ''}</div>
        <span><span class="card-t">${esc(e.title)}</span><span class="card-a">${esc(e.author || (e.kind === 'txt' ? 'Plain text' : e.kind === 'audio' ? `Audiobook · ${fmtLong(e.total)}` : 'Unknown author'))}</span></span>
      </button>
      ${(extras.meta(e.id).tags || []).length ? `<span class="tags">${extras.meta(e.id).tags.map(t => `<span class="tag-chip">#${esc(t)}</span>`).join('')}</span>` : ''}
      <div class="card-meta">${meta}<button class="more" type="button" aria-label="More for ${esc(e.title)}" aria-haspopup="menu"><svg class="i"><use href="#i-more"/></svg></button></div>`;
    card.querySelector('.card-open').addEventListener('click', () => {
      if (!selecting) return openEntry(e);
      sel.has(e.id) ? sel.delete(e.id) : sel.add(e.id);
      card.classList.toggle('selected', sel.has(e.id)); card.querySelector('.card-open').setAttribute('aria-pressed', String(sel.has(e.id))); updateSelBar();
    });
    card.querySelector('.card-open').addEventListener('keydown', ev => { if ((ev.key === 'Delete' || ev.key === 'Backspace') && !selecting) { ev.preventDefault(); requestRemove([e]); } });
    card.querySelector('.more').addEventListener('click', ev => { ev.stopPropagation(); extras.cardMenu(e, ev.currentTarget); });
    card.addEventListener('contextmenu', ev => { ev.preventDefault(); extras.cardMenu(e, card.querySelector('.more')); });
    grid.appendChild(card);
  });
  $('#lib-restore').hidden = !store.get('sampleRemoved', false);
  $('#b-select').hidden = !libEntries.length && !selecting;
  if (selecting) updateSelBar();
  if (!q && !selecting) {
    const add = document.createElement('div'); add.className = 'card'; add.style.setProperty('--i', list.length);
    add.innerHTML = `<button class="add-tile" type="button"><svg class="i"><use href="#i-plus"/></svg><b>Add a book</b><span>EPUB, PDF, MOBI, comics…<br>or drop files here</span></button>`;
    add.querySelector('button').addEventListener('click', () => $('#file').click());
    grid.appendChild(add);
  }
  $('#shelf-count').textContent = `${libEntries.length} ${libEntries.length === 1 ? 'book' : 'books'}`;
  const nm = $('#no-match'); nm.hidden = !(q && !list.length);
  if (!q && !list.length && settings.shelf !== 'all') { nm.hidden = false; nm.textContent = 'This shelf is empty. Add books to it from their ⋯ menu.'; return; } nm.textContent = `Nothing on your shelf matches “${$('#lib-q').value.trim()}”.`;
}
$('#lib-q').addEventListener('input', debounce(renderGrid, 120));
$$('#sort button').forEach(b => b.addEventListener('click', () => { settings.sort = b.dataset.v; saveSettings(); $$('#sort button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderGrid(); }));

async function swapView(fn) {
  if (document.startViewTransition && !reduced) {
    const t = document.startViewTransition(fn);
    try { await t.updateCallbackDone; } catch { fn(); }
  } else fn();
}
function showLibrary() {
  closeDrawer(); closeSettings(); hideSel(); hideFn();
  if (tts.on) ttsStop();
  if (auto.on) autoStop();
  ruler.hidden = true;
  swapView(() => { $('#reader').hidden = true; $('#library').hidden = false; app.classList.remove('chrome-off'); updateNowPlaying(null); });
  renderLibrary();
  document.title = 'Margin';
}
function showReader() { $('#library').hidden = true; $('#reader').hidden = false; $('#np').hidden = true; }
$('#b-lib').addEventListener('click', showLibrary);
$('#b-pdfmode').addEventListener('click', () => {
  if (!entryCur || entryCur.kind !== 'pdf') return;
  const meta = store.get('meta:' + entryCur.id, {}); meta.textView = !meta.textView; store.set('meta:' + entryCur.id, meta);
  toast(meta.textView ? 'Text view: highlights, themes and read-aloud now work. Layout may differ from the original.' : 'Showing the original pages', 3500);
  openEntry(entryCur);
});
$('#b-open').addEventListener('click', () => $('#file').click());
$('#b-backup').addEventListener('click', () => extras.openBackup());
$('#file').addEventListener('change', async e => {
  const files = Array.from(e.target.files || []); e.target.value = '';
  importFiles(files);
});

/* =========================================================
   Opening & importing books
   ========================================================= */
async function openEntry(e) {
  if (e.kind === 'audio' && ap.book && ap.book.id === e.id && book && book.id === e.id) {
    await swapView(() => { showReader(); }); updateNowPlaying(null); updateAudio(ap.state()); showChrome(); return;
  }
  if (tts.on) ttsStop();
  const status = $('#status');
  await swapView(() => { showReader(); });
  $('#status-t').textContent = `Opening ${e.title}…`; status.hidden = false;
  let b = cache.get(e.id);
  const textView = e.kind === 'pdf' && store.get('meta:' + e.id, {}).textView;
  try {
    if (!b) {
      b = await loadBook(e);
      if (!b.title) b.title = e.title;
      if (!b.author) b.author = e.author || '';
      cache.set(e.id, b);
    }
    if (textView) {
      let t = cache.get(e.id + ':text');
      if (!t) { t = await pdfToFlow(b, p => { $('#status-t').textContent = `Preparing text view… ${Math.round(p * 100)}%`; }); cache.set(e.id + ':text', t); }
      b = t;
    }
  } catch (err) {
    status.hidden = true;
    toast(err.message || 'This book could not be opened.', 4500);
    showLibrary();
    return;
  }
  book = b; entryCur = e;
  store.set('last', e.id);
  if (!e.sample) { e.opened = Date.now(); dbPut(e); }
  $('#h-title').textContent = book.title;
  $('#h-author').textContent = book.author || '';
  $('#dr-title').textContent = book.title; $('#dr-author').textContent = book.author || '';
  $('#dr-cover').innerHTML = bookObject(e);
  document.title = `${book.title} · Margin`;
  $('#find-q').value = ''; $('#find-list').innerHTML = ''; $('#find-count').textContent = '';
  if (!stats.books[book.id]) stats.books[book.id] = { secs: 0, chars: 0, title: book.title };
  if (book.title !== e.title && e.userTitle) book.title = e.title;
  $('#b-pdfmode').hidden = e.kind !== 'pdf';
  $('#b-pdfmode').innerHTML = `<svg class="i"><use href="#i-${textView ? 'page' : 'reflow'}"/></svg>`;
  $('#b-pdfmode').setAttribute('aria-label', textView ? 'Show original pages' : 'Switch to text view');
  $('#b-pdfmode').title = textView ? 'Original pages' : 'Text view: reflow this PDF for highlights, themes and read-aloud';
  $('#b-listen').hidden = !!book.fixed || !!book.audio || !('speechSynthesis' in window);
  $('#audiov').hidden = !book.audio; app.classList.toggle('audio-mode', !!book.audio);
  if (book.audio) {
    pageEl.hidden = true; fx.close(); flow.innerHTML = ''; frame.innerHTML = '';
    if (ap.book && ap.book.id !== book.id) saveAudioPos();
    const apos = store.get('pos:' + book.id, { t: 0 });
    applySettings(false, true);
    renderAudioHeader(e);
    ap.open(book, apos.t && apos.t < book.total - 2 ? apos.t : 0);
    ap.setRate(settings.audioRate || 1);
    buildTicks(); updateNotesCount(); updateAudio(ap.state());
    status.hidden = true; showChrome(); touchActive();
    return;
  }
  if (ap.book) { saveAudioPos(); ap.close(); }
  if (book.fixed) {
    pageEl.hidden = true; flow.innerHTML = ''; frame.innerHTML = '';
    const fpos = store.get('pos:' + book.id, { page: 0 });
    applySettings(false, true);
    await fx.open(book, fpos.page || 0);
    buildTicks(); updateNotesCount();
    status.hidden = true;
    showChrome(); chromeT = setTimeout(() => { if (!overBars && readerOpen()) hideChrome(); }, 3500);
    touchActive();
    return;
  }
  fx.close(); pageEl.hidden = false;
  const pos = store.get('pos:' + book.id, { ch: 0, off: 0 });
  st.anchor = null; st.page = 0;
  applySettings(false, true);
  buildTicks();
  updateNotesCount();
  loadVoices();
  st.ch = -1;
  renderChapter(clamp(pos.ch || 0, 0, book.chapters.length - 1), { off: pos.off != null ? pos.off : null, frac: pos.frac, animate: false });
  status.hidden = true;
  showChrome(); chromeT = setTimeout(() => { if (!overBars && readerOpen()) hideChrome(); }, 3500);
  touchActive();
  pageEl.focus({ preventScroll: true });
  // Fonts may finish loading after first layout
  if (document.fonts) document.fonts.ready.then(relayout);
}

async function loadBook(e) {
  if (e.kind === 'audio') return { id: e.id, title: e.title, author: e.author || '', audio: true, tracks: e.tracks.map(t => ({ ...t })), chapters: e.chapters.map(c => ({ ...c })), total: e.total, cover: e.cover || null, coverBlob: e.cover || null, toc: [], lang: 'en' };
  if (e.kind === 'sample') return sampleBook();
  if (e.kind === 'epub') return parseEpub(e.data, e.id);
  if (e.kind === 'txt') return parseTxt(e.data, e.title, e.id);
  const file = new File([e.data], e.fileName || e.title, { type: e.mime || '' });
  if (e.kind === 'mobi' || e.kind === 'fb2') return parseFoliate(file, e.kind, e.id);
  if (e.kind === 'docx') return parseDocx(e.data, e.id, e.title);
  if (e.kind === 'comic') return openComic(file, e.id, e.title);
  if (e.kind === 'pdf') return openPdf(e.data, e.id, e.title);
  throw new Error('This book’s format isn’t supported.');
}
/* Several files at once: the audio files among them become one audiobook (its tracks). */
async function importFiles(files) {
  if (!files.length) return;
  const audio = files.filter(f => isAudioName(f.name)), rest = files.filter(f => !isAudioName(f.name));
  const added = [];
  if (audio.length > 1) { const e = await importAudiobook(audio, false); if (e) added.push(e); }
  else if (audio.length === 1) rest.unshift(audio[0]);
  for (const f of rest) { const e = await importFile(f, false); if (e) added.push(e); }
  if (added.length === 1) openEntry(added[0]);
  else if (added.length > 1) { toast(`Added ${added.length} books`); showLibrary(); }
}
async function importAudiobook(files, open = true, opts = {}) {
  const fallback = titleFromName((opts.name || files[0].name).replace(/_(64|128)kb/i, ''));
  toast(`Adding ${fallback}…`, 60000);
  try {
    const playable = files.filter(f => canPlay(f.type, f.name));
    if (!playable.length) throw new Error(`This browser can’t play ${(files[0].name.split('.').pop() || '').toUpperCase()} audio. The Margin desktop app, Chrome, Edge and Safari play M4B and MP3.`);
    const ab = await buildAudiobook(playable, { fallbackTitle: fallback, cover: opts.cover, onProgress: p => toast(`Adding ${fallback}… ${Math.round(p * 100)}%`, 60000) });
    if (!ab.total) throw new Error('These audio files couldn’t be read. They may be damaged or in a format this browser can’t play.');
    const size = playable.reduce((n, f) => n + f.size, 0);
    const id = ('audio:' + ab.title + ':' + size).replace(/\s+/g, '_');
    const entry = { id, kind: 'audio', title: ab.title, author: ab.author, tracks: ab.tracks, chapters: ab.chapters, total: ab.total, cover: ab.cover, size, added: Date.now() };
    cache.delete(id); memEntries.set(id, entry);
    await dbPut(entry);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
    toast(`Added ${entry.title} · ${fmtLong(entry.total)}, ${entry.chapters.length} ${entry.chapters.length === 1 ? 'chapter' : 'chapters'}`, 3500);
    if (open) openEntry(entry);
    return entry;
  } catch (err) {
    toast(err.message || 'These audio files couldn’t be added.', 6000);
    return null;
  }
}
async function importFile(file, open = true) {
  const kind = kindOf(file.name, file.type || '');
  if (kind === 'audio') return importAudiobook([file], open);
  if (kind === 'zip') {
    try {
      const z = await filesFromZip(file);
      if (!z.audio.length) { toast(`${file.name} doesn’t contain audio files or a book Margin can open.`, 4500); return null; }
      return importAudiobook(z.audio, open, { cover: z.cover, name: file.name });
    } catch { toast(`${file.name} couldn’t be unpacked.`, 4500); return null; }
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const id = (ext + ':' + file.name + ':' + file.size).replace(/\s+/g, '_');
  const nameTitle = titleFromName(file.name.replace(/\.fb2\.zip$/i, ''));
  toast(`Adding ${nameTitle}…`, 15000);
  try {
    if (!kind) throw new Error(`${file.name} isn’t a format Margin reads. Try EPUB, PDF, MOBI, AZW3, FB2, DOCX, CBZ, CBR, TXT, or an audiobook (M4B, MP3).`);
    const data = kind === 'txt' ? await file.text() : await file.arrayBuffer();
    const probe = { id, kind, data, title: nameTitle, fileName: file.name, mime: file.type || '' };
    const b = await loadBook(probe);
    if (!b.title) b.title = nameTitle;
    cache.set(id, b);
    const entry = { ...probe, title: b.title, author: b.author || '', cover: b.coverBlob || null, added: Date.now() };
    memEntries.set(id, entry);
    await dbPut(entry);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
    toast(`Added ${entry.title}`);
    if (open) openEntry(entry);
    return entry;
  } catch (err) {
    toast(err.message || 'This file could not be opened.', 4500);
    return null;
  }
}

// Drag & drop
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  importFiles(Array.from(e.dataTransfer.files));
});

/* =========================================================
   Stats dialog (single-series bar chart: minutes read per day)
   ========================================================= */
function renderStatsInto(chartHost, bigHost, totalEl) {
  const days = []; const d = new Date(); d.setDate(d.getDate() - 13);
  for (let i = 0; i < 14; i++) { days.push({ key: dayKey(d), date: new Date(d), min: Math.round((stats.days[dayKey(d)] || 0) / 60) }); d.setDate(d.getDate() + 1); }
  totalEl.textContent = `${days.reduce((s2, x) => s2 + x.min, 0)} min in total`;
  const fin = Object.keys(stats.finished).length, str = streak();
  bigHost.innerHTML = `<div><b>${fmtDur(weekSecs())}</b><span>Last 7 days</span></div><div><b>${str} ${str === 1 ? 'day' : 'days'}</b><span>Current streak</span></div>
    <div><b>${fmtDur(stats.secs)}</b><span>All time</span></div><div><b>${fin}</b><span>${fin === 1 ? 'Book finished' : 'Books finished'}</span></div>
    <div><b>${wpm()}</b><span>Words per minute${stats.secs > 240 ? '' : ' (default until you read more)'}</span></div><div><b>${vocab.get(store).length}</b><span>Words collected</span></div>`;
  drawChart(chartHost, days);
}
function openStats() {
  const dlg = $('#stats-dlg'), body = $('#stats-body');
  const days = []; const d = new Date(); d.setDate(d.getDate() - 13);
  for (let i = 0; i < 14; i++) { days.push({ key: dayKey(d), date: new Date(d), min: Math.round((stats.days[dayKey(d)] || 0) / 60) }); d.setDate(d.getDate() + 1); }
  const total14 = days.reduce((s, x) => s + x.min, 0);
  const fin = Object.keys(stats.finished).length, str = streak();
  const books = Object.entries(stats.books).filter(([, b]) => b.secs >= 60).sort((a, b) => b[1].secs - a[1].secs).slice(0, 6);
  const maxSecs = books.length ? books[0][1].secs : 1;
  body.innerHTML = `
    <div class="dlg-head"><h2>Your reading</h2><button class="icon-btn" data-close aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></div>
    <div class="big-stats">
      <div><b>${fmtDur(stats.days[dayKey()] || 0)}</b><span>Today</span></div>
      <div><b>${fmtDur(weekSecs())}</b><span>Last 7 days</span></div>
      <div><b>${str} ${str === 1 ? 'day' : 'days'}</b><span>Current streak</span></div>
      <div><b>${fmtDur(stats.secs)}</b><span>All time</span></div>
      <div><b>${fin}</b><span>${fin === 1 ? 'Book finished' : 'Books finished'}</span></div>
      <div><b>${wpm()}</b><span>Words per minute${stats.secs > 240 ? '' : ' (default until you read more)'}</span></div>
    </div>
    <div class="chart-h"><h3>Minutes read, last 14 days</h3><span>${total14} min in total</span></div>
    <div class="chart" id="chart"></div>
    ${books.length ? `<div class="chart-h"><h3>Time per book</h3></div><ul class="per-book">${books.map(([id, b]) => `<li><b>${esc(b.title || 'Untitled')}</b><span>${fmtDur(b.secs)}</span><span class="bar-track"><i style="width:${Math.max(3, b.secs / maxSecs * 100)}%"></i></span></li>`).join('')}</ul>` : ''}`;
  body.querySelector('[data-close]').onclick = () => dlg.close();
  drawChart($('#chart'), days);
  dlg.showModal();
}
function niceStep(max) {
  for (const s of [5, 10, 15, 20, 30, 60, 90, 120, 180, 240]) if (max / s <= 4) return s;
  return Math.ceil(max / 4 / 60) * 60;
}
function drawChart(host, days) {
  const W = Math.max(320, Math.round(host.clientWidth || 640)), H = 210, L = 34, R = 6, T = 10, B = 30;
  const max = Math.max(10, ...days.map(x => x.min));
  const step = niceStep(max), top = Math.ceil(max / step) * step;
  const iw = W - L - R, ih = H - T - B, slot = iw / days.length, bw = Math.min(26, slot * 0.58);
  const y = v => T + ih - (v / top) * ih;
  let g = '';
  for (let v = 0; v <= top; v += step) g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const todayKey = dayKey();
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  const fmtLong = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  let bars = '', labels = '';
  days.forEach((dd, i) => {
    const cx = L + slot * i + slot / 2, x = cx - bw / 2, h = (dd.min / top) * ih, yb = T + ih;
    const r = Math.min(4, h);
    const path = h > 0 ? `M${x},${yb}V${yb - h + r}Q${x},${yb - h} ${x + r},${yb - h}H${x + bw - r}Q${x + bw},${yb - h} ${x + bw},${yb - h + r}V${yb}Z` : '';
    bars += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${ih}"/>`;
    if (path) bars += `<path class="bar${dd.key === todayKey ? '' : ' dim'}" data-b="${i}" d="${path}"/>`;
    const isT = dd.key === todayKey;
    labels += `<text class="ax${isT ? ' today' : ''}" x="${cx}" y="${H - 10}" text-anchor="middle">${isT ? 'Today' : fmt.format(dd.date)}</text>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Minutes read per day over the last 14 days. ${days.map(dd => `${fmtLong.format(dd.date)}: ${dd.min} minutes`).join('; ')}">${g}${bars}${labels}</svg><div class="chart-tip" hidden></div>`;
  const svg = host.querySelector('svg'), tipEl = host.querySelector('.chart-tip');
  svg.addEventListener('pointermove', e => {
    const hit = e.target.closest('.hit');
    svg.querySelectorAll('.bar.on').forEach(b => b.classList.remove('on'));
    if (!hit) { tipEl.hidden = true; return; }
    const i = +hit.dataset.i, dd = days[i];
    const bar = svg.querySelector(`[data-b="${i}"]`); if (bar) bar.classList.add('on');
    const sr = svg.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const scale = sr.width / W;
    tipEl.textContent = `${fmtLong.format(dd.date)} · ${dd.min} min`;
    tipEl.hidden = false;
    tipEl.style.left = (L + slot * i + slot / 2) * scale + (sr.left - hr.left) + 'px';
    tipEl.style.top = (y(dd.min) - 8) * scale + (sr.top - hr.top) + 'px';
  });
  svg.addEventListener('pointerleave', () => { tipEl.hidden = true; svg.querySelectorAll('.bar.on').forEach(b => b.classList.remove('on')); });
}

/* =========================================================
   Installable app
   ========================================================= */
/* Desktop app (Windows installer): files opened from Explorer arrive through the bridge. */
const desktop = window.marginDesktop || null;
if (desktop) document.documentElement.classList.add('desktop');
async function takeDesktopFiles(files) {
  await importFiles(files.map(f => new File([f.data], f.name)));
}
if (desktop) desktop.onOpenFiles(files => { if (files && files.length) takeDesktopFiles(files); });

// The desktop app ships its own files, so it doesn't need the offline cache.
if (!desktop && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    toast('Margin has been updated.', 0, { label: 'Reload', run: () => { reloading = true; location.reload(); } });
  });
}
let installEvt = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#b-install').hidden = false; });
window.addEventListener('appinstalled', () => { installEvt = null; $('#b-install').hidden = true; toast('Margin is installed.'); });
$('#b-install').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch {}
  installEvt = null; $('#b-install').hidden = true;
});
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !standalone) $('#ios-hint').hidden = false;

let launchedWithFile = false;
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (!params.files || !params.files.length) return;
    launchedWithFile = true;
    const fs = []; for (const h of params.files) fs.push(await h.getFile());
    await importFiles(fs);
  });
}
async function takeSharedFile() {
  if (!new URLSearchParams(location.search).has('share') || !('caches' in window)) return false;
  history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('margin-share');
    const res = await c.match('shared-book');
    if (!res) return false;
    await c.delete('shared-book');
    const name = decodeURIComponent(res.headers.get('x-file-name') || 'Shared book.epub');
    const blob = await res.blob();
    importFile(new File([blob], name, { type: blob.type }));
    return true;
  } catch { return false; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && ap.book) saveAudioPos();
  if (document.visibilityState === 'hidden') { store.set('stats', stats); if (book) savePos(overall()); }
});


/* =========================================================
   Library sections, extras, discover
   ========================================================= */
const goalDaily = () => Object.assign({ daily: 20 }, store.get('goals', {})).daily;
/* ---------- removing books (with confirmation and Undo) ---------- */
const relatedKeys = id => ['pos:', 'marks:', 'hl:', 'meta:'].flatMap(p => [p + id, p + id + ':text']);
function bookNotes(id) {
  let hl = 0, bm = 0;
  for (const x of [id, id + ':text']) { hl += store.get('hl:' + x, []).length; bm += store.get('marks:' + x, []).length; }
  return { hl, bm };
}
function removeEntry(e) { return requestRemove([e]); }
function requestRemove(list) {
  list = list.filter(Boolean); if (!list.length) return;
  const d = document.createElement('dialog');
  const one = list.length === 1;
  const notes = list.map(e => ({ e, ...bookNotes(e.id) }));
  const tot = notes.reduce((n, x) => ({ hl: n.hl + x.hl, bm: n.bm + x.bm }), { hl: 0, bm: 0 });
  const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
  const what = [tot.hl ? `${plural(tot.hl, 'highlight', 'highlights')} (with any notes)` : '', tot.bm ? plural(tot.bm, 'bookmark', 'bookmarks') : ''].filter(Boolean).join(', ');
  const listHtml = one ? '' : `<ul class="rm-list">${notes.map(x => {
    const extra = [x.hl ? plural(x.hl, 'highlight', 'highlights') : '', x.bm ? plural(x.bm, 'bookmark', 'bookmarks') : ''].filter(Boolean).join(', ');
    return `<li>${esc(x.e.title)}${extra ? ` <span>· ${extra}</span>` : ''}</li>`;
  }).join('')}</ul>`;
  d.innerHTML = `<form class="dlg" method="dialog" style="max-width:520px">
    <div class="dlg-head"><h2>${one ? `Remove “${esc(list[0].title)}”?` : `Remove ${list.length} books?`}</h2></div>
    ${listHtml}
    <p class="dlg-p">${one ? 'The book is' : 'These books are'} deleted from this device, along with ${what ? `${what}, ` : ''}${one ? 'its reading position' : 'their reading positions'} and shelf details. Your reading time stays in your stats.</p>
    ${list.some(e => e.sample) ? '<p class="dlg-note">You can restore the sample book later from the bottom of your library.</p>' : ''}
    <div class="dlg-acts"><button class="btn" value="cancel">Cancel</button><button class="btn danger-solid" value="remove" autofocus>${one ? 'Remove book' : `Remove ${list.length} books`}</button></div></form>`;
  document.body.appendChild(d); d.showModal();
  d.addEventListener('close', () => { if (d.returnValue === 'remove') doRemove(list); d.remove(); });
}
async function doRemove(list) {
  const fromDb = await dbAll();
  const snaps = list.map(e => {
    const keys = {};
    for (const k of relatedKeys(e.id)) { try { const v = localStorage.getItem('margin:' + k); if (v != null) keys[k] = v; } catch {} }
    return { e, rec: e.sample ? null : (fromDb.find(x => x.id === e.id) || memEntries.get(e.id) || null), keys, wasLast: store.get('last') === e.id };
  });
  for (const { e } of snaps) {
    if (ap.book && ap.book.id === e.id) { ap.close(); updateNowPlaying(null); }
    if (book && (book.id === e.id || book.id === e.id + ':text')) book = null;
    if (e.sample) store.set('sampleRemoved', true);
    else { await dbDel(e.id); memEntries.delete(e.id); }
    cache.delete(e.id); cache.delete(e.id + ':text'); coverUrls.delete(e.id);
    relatedKeys(e.id).forEach(k => store.del(k));
    if (store.get('last') === e.id) store.del('last');
  }
  if (selecting) { selecting = false; $('#b-select').textContent = 'Select'; $('#b-select').setAttribute('aria-pressed', 'false'); $('#selbar').hidden = true; }
  sel.clear();
  if (!$('#library').hidden) renderLibrary(); else showLibrary();
  toast(list.length === 1 ? `Removed “${list[0].title}”` : `Removed ${list.length} books`, 10000, {
    label: 'Undo', run: async () => {
      for (const sn of snaps) {
        if (sn.e.sample) store.del('sampleRemoved');
        else if (sn.rec) { memEntries.set(sn.e.id, sn.rec); await dbPut(sn.rec); }
        for (const [k, v] of Object.entries(sn.keys)) { try { localStorage.setItem('margin:' + k, v); } catch {} }
        if (sn.wasLast) store.set('last', sn.e.id);
      }
      renderLibrary();
      toast(list.length === 1 ? `Restored “${list[0].title}”` : `Restored ${list.length} books`);
    }
  });
}
// Select several books to remove at once
let selecting = false; const sel = new Set();
function setSelecting(on) {
  selecting = on; sel.clear();
  $('#b-select').textContent = on ? 'Cancel' : 'Select';
  $('#b-select').setAttribute('aria-pressed', String(on));
  renderGrid(); updateSelBar();
}
function updateSelBar() {
  $('#selbar').hidden = !selecting;
  $('#sel-count').textContent = `${sel.size} selected`;
  $('#sel-remove').disabled = !sel.size;
  $('#sel-remove').lastChild.textContent = sel.size ? `Remove ${sel.size}` : 'Remove';
  const vis = $$('#grid .card[data-id]').map(c => c.dataset.id);
  $('#sel-all').textContent = vis.length && vis.every(id => sel.has(id)) ? 'Select none' : 'Select all';
  if (selecting) $('#np').hidden = true; else updateNowPlaying(null);
}
$('#b-select').addEventListener('click', () => setSelecting(!selecting));
$('#sel-done').addEventListener('click', () => setSelecting(false));
$('#sel-all').addEventListener('click', () => {
  const vis = $$('#grid .card[data-id]').map(c => c.dataset.id);
  if (vis.every(id => sel.has(id))) vis.forEach(id => sel.delete(id)); else vis.forEach(id => sel.add(id));
  renderGrid(); updateSelBar();
});
$('#sel-remove').addEventListener('click', () => requestRemove(libEntries.filter(e => sel.has(e.id))));
$('#b-restore-sample').addEventListener('click', () => { store.del('sampleRemoved'); renderLibrary(); toast('The sample book is back on your shelf'); });
// From inside a book: the side panel's ⋯ menu
$('#b-bookmenu').addEventListener('click', ev => {
  const e = entryCur; if (!e) return;
  extras.menu(ev.currentTarget, [
    ['Book details…', () => { closeDrawer(); extras.openEdit(libEntries.find(x => x.id === e.id) || e); }],
    '-',
    ['Remove from library…', () => { closeDrawer(); requestRemove([libEntries.find(x => x.id === e.id) || e]); }, true]
  ]);
});
async function openAt(entryId, textView, h) {
  const e = libEntries.find(x => x.id === entryId) || (await allEntries()).find(x => x.id === entryId);
  if (!e) { toast('That book is no longer in your library.'); return; }
  if (e.kind === 'pdf') { const m = store.get('meta:' + e.id, {}); m.textView = !!textView; store.set('meta:' + e.id, m); }
  await openEntry(e);
  if (book && !book.fixed && h) renderChapter(clamp(h.ch, 0, book.chapters.length - 1), { off: h.start });
}
const extras = initExtras({
  store, toast, settings, saveSettings: () => saveSettings(), stats, saveStats: () => saveStats(), posOf,
  renderGrid: () => renderGrid(), renderLibrary: () => renderLibrary(), openEntry: e => openEntry(e), removeEntry, bookObject, coverUrls, cache,
  dbAll, dbPut, dayKey, streak, fmtDur, entries: () => libEntries, tintFor, renderStatsInto, openAt,
  updateWordsBadge: () => updateWordsBadge(), flush: () => { store.set('stats', stats); }, suspendSaving: () => { frozen = true; }
});
const discover = createDiscover({ store, toast, importFile: (f, open) => importFile(f, open), openEntry: e => openEntry(e), host: $('#v-discover') });
let libView = 'shelf';
function showView(v) {
  libView = v;
  $$('#lib-tabs [data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  ['shelf', 'discover', 'highlights', 'words', 'insights'].forEach(x => { $('#v-' + x).hidden = x !== v; });
  $('.lib-search:not(.disc-bar .lib-search)').style.visibility = v === 'shelf' ? '' : 'hidden';
  if (v === 'discover') discover.render();
  if (v === 'highlights') extras.renderHighlights($('#v-highlights'));
  if (v === 'words') extras.renderWords($('#v-words'));
  if (v === 'insights') extras.renderInsights($('#v-insights'));
  if (v === 'shelf') renderLibrary();
  $('#lib-scroll').scrollTo({ top: 0 });
}
$$('#lib-tabs [data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
function updateWordsBadge() { const n = extras.wordsDue(); $('#words-due').textContent = n ? String(n) : ''; }
updateWordsBadge();

/* =========================================================
   Dictionary & translation popovers
   ========================================================= */
function sentenceAround(text, at) {
  let a = at; while (a > 0 && !/[.!?…]\s/.test(text.slice(a - 2, a)) && at - a < 300) a--;
  let b = at; while (b < text.length && !/[.!?…]/.test(text[b]) && b - at < 300) b++;
  return text.slice(a, b + 1).replace(/\s+/g, ' ').trim();
}
function placePop(rect) {
  fnpop.hidden = false;
  const w = fnpop.offsetWidth, h = fnpop.offsetHeight;
  let top = rect.bottom + 10; if (top + h > innerHeight - 12) top = Math.max(12, rect.top - h - 10);
  fnpop.style.top = top + 'px';
  fnpop.style.left = clamp(rect.left + rect.width / 2 - w / 2, 12, innerWidth - w - 12) + 'px';
}
async function showDefinition(raw, at, rect) {
  const word = normalizeWord(raw);
  fnpop.className = 'fnpop dict';
  fnpop.innerHTML = `<div class="fn-h"><span>Dictionary</span></div><div class="dw">${esc(word)}</div><div class="loading"><span class="spin"></span>Looking up… (the first lookup loads the offline dictionary)</div>`;
  placePop(rect);
  let res;
  try { res = await lookup(word); } catch (e) { fnpop.querySelector('.loading').textContent = e.message || 'The dictionary could not be loaded.'; return; }
  let context = '';
  try {
    const r0 = rangeFor(at, at + 1);
    const para = r0 && (r0.startContainer.nodeType === 1 ? r0.startContainer : r0.startContainer.parentElement).closest(PARA);
    const pt = para ? para.textContent : book.chapters[st.ch].text;
    const i = pt.toLowerCase().indexOf(word);
    context = sentenceAround(pt, i >= 0 ? i : 0);
  } catch {}
  const wik = `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
  if (!res) {
    fnpop.innerHTML = `<div class="fn-h"><span>Dictionary</span></div><div class="dw">${esc(word)}</div><p>No entry in the offline English dictionary. It may be a name, a rare form, or another language.</p>
      <div class="acts"><a class="mini" href="${wik}" target="_blank" rel="noopener">Wiktionary</a><button class="mini" data-tr>Translate</button></div>`;
  } else {
    fnpop.innerHTML = `<div class="fn-h"><span>Dictionary</span></div><div class="dw">${esc(res.word)}</div>` +
      res.groups.map(g => `<div class="pos">${g.pos}</div><ol>${g.senses.map(x => `<li>${esc(x.def)}${x.ex ? `<span class="ex">“${esc(x.ex)}”</span>` : ''}${x.syn.length ? `<span class="syn">Also: ${esc(x.syn.join(', '))}</span>` : ''}</li>`).join('')}</ol>`).join('') +
      `<div class="acts"><button class="btn primary" data-add style="padding:7px 12px">Add to Words</button><button class="mini" data-tr>Translate</button><a class="mini" href="${wik}" target="_blank" rel="noopener">Wiktionary</a></div>`;
    const add = fnpop.querySelector('[data-add]');
    add.onclick = () => {
      const g = res.groups[0];
      const isNew = vocab.add(store, { word: res.word, pos: g.pos, def: g.senses[0].def, context, book: book.title, bookId: book.id });
      add.textContent = isNew ? 'Added ✓' : 'Already in Words'; add.disabled = true; updateWordsBadge();
    };
  }
  fnpop.querySelector('[data-tr]').onclick = () => showTranslation(raw.trim(), rect);
  placePop(rect);
}
async function showTranslation(text, rect) {
  fnpop.className = 'fnpop dict';
  const opts = Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === settings.trLang ? ' selected' : ''}>${v}</option>`).join('');
  fnpop.innerHTML = `<div class="fn-h"><span>Translate</span><select aria-label="Translate to" id="tr-lang">${opts}</select></div><p style="color:var(--muted);margin:0 0 6px">${esc(text.length > 300 ? text.slice(0, 300) + '…' : text)}</p><div class="tr" id="tr-out"><span class="loading"><span class="spin"></span>Translating…</span></div><div class="acts"><a class="mini" id="tr-web" target="_blank" rel="noopener">Open in Google Translate</a></div>`;
  placePop(rect);
  const run = async () => {
    const to = settings.trLang;
    fnpop.querySelector('#tr-web').href = webTranslateUrl(text, to);
    const out = fnpop.querySelector('#tr-out');
    if (!canTranslateOnDevice()) { out.innerHTML = `<span class="dlg-note">On-device translation isn’t available in this browser (it’s built into recent Chrome and Edge). Use the link below to translate online.</span>`; return; }
    out.innerHTML = '<span class="loading"><span class="spin"></span>Translating… the first time may download a language pack.</span>';
    try {
      const r = await Promise.race([translate(text, book.lang && book.lang !== 'en' ? book.lang : 'auto', to), new Promise((_, rej) => setTimeout(() => rej(new Error('the language pack is still downloading; try again shortly, or use the online link')), 12000))]);
      if (!r || r.unavailable) out.innerHTML = `<span class="dlg-note">This language pair isn’t available on this device. Try the online link.</span>`;
      else if (r.same) out.innerHTML = `<span class="dlg-note">The text is already in ${esc(LANGS[to] || to)}.</span>`;
      else out.textContent = r.text;
    } catch (e) { out.innerHTML = `<span class="dlg-note">Translation failed: ${esc(e.message || String(e))}</span>`; }
    placePop(rect);
  };
  fnpop.querySelector('#tr-lang').onchange = e => { settings.trLang = e.target.value; saveSettings(); run(); };
  run();
}

/* =========================================================
   Reading aids: bionic, focus, ruler, auto-advance, image viewer
   ========================================================= */
function applyBionic() {
  const w = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT); const nodes = [];
  for (let n; (n = w.nextNode());) if (n.nodeValue.trim() && !n.parentElement.closest('h1,h2,h3,h4,h5,h6,.ch-next,b.bio,pre,code')) nodes.push(n);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    for (const p of n.nodeValue.split(/(\s+)/)) {
      if (!p) continue;
      const m = p.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}][\p{L}\p{N}'’-]*)([\s\S]*)$/u);
      if (!m) { frag.append(p); continue; }
      const word = m[2], k = word.length <= 3 ? 1 : Math.ceil(word.length * 0.45);
      const b = document.createElement('b'); b.className = 'bio'; b.textContent = word.slice(0, k);
      frag.append(m[1], b, word.slice(k) + m[3]);
    }
    n.replaceWith(frag);
  }
}
const PARA = 'p,li,blockquote,h1,h2,h3,h4,h5,h6';
function setCurPara(el) { if (!settings.focus) return; flow.querySelectorAll('.cur').forEach(x => x !== el && x.classList.remove('cur')); if (el) el.classList.add('cur'); }
function focusFromOffset() {
  if (!settings.focus || book.fixed) return;
  const r = rangeFor(st.off, st.off + 1); if (!r) return;
  const el = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement).closest(PARA);
  if (paged() || !flow.querySelector('.cur')) setCurPara(el);
}
flow.addEventListener('pointerover', e => { if (settings.focus && e.pointerType === 'mouse') { const p = e.target.closest(PARA); if (p) setCurPara(p); } });
pageEl.addEventListener('scroll', () => {
  if (!settings.focus || paged()) return;
  const pr = pageEl.getBoundingClientRect(), y = pr.top + pr.height * 0.42;
  const el = document.elementFromPoint(pr.left + pr.width / 2, y); const p = el && el.closest && el.closest(PARA); if (p && flow.contains(p)) setCurPara(p);
}, { passive: true });

const ruler = $('#ruler');
let rulerY = null;
function placeRuler(y) {
  if (!settings.ruler || !readerOpen() || (book && book.fixed)) { ruler.hidden = true; return; }
  const h = settings.size * settings.lh + 6;
  const sr = stage.getBoundingClientRect();
  rulerY = clamp(y != null ? y : (rulerY != null ? rulerY : sr.top + sr.height * 0.38), sr.top + h / 2, sr.bottom - h / 2);
  ruler.style.height = h + 'px'; ruler.style.top = (rulerY - h / 2) + 'px'; ruler.hidden = false;
}
stage.addEventListener('pointermove', e => { if (settings.ruler && (e.pointerType === 'mouse' || e.buttons)) placeRuler(e.clientY); });
stage.addEventListener('pointerdown', e => { if (settings.ruler && e.pointerType !== 'mouse') placeRuler(e.clientY); });
document.addEventListener('keydown', e => {
  if (!settings.ruler || !readerOpen() || e.target.closest('input,textarea,select') || document.querySelector('dialog[open]')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); placeRuler((rulerY || 0) + (e.key === 'ArrowDown' ? 1 : -1) * settings.size * settings.lh); }
});

const auto = { on: false, playing: false, timer: 0, raf: 0, last: 0 };
function autoLabel() { $('#auto-rate').textContent = book && book.fixed && book.kind === 'comic' ? `${Math.round(60000 / autoDelayFixed() * 10) / 10}/min` : `${settings.autoWpm} wpm`; }
const autoDelayFixed = () => book.kind === 'comic' ? clamp(240 / settings.autoWpm * 9000, 3000, 30000) : 250 / settings.autoWpm * 60000 * fx.state().pages.length;
function autoSchedule() {
  clearTimeout(auto.timer); cancelAnimationFrame(auto.raf);
  if (!auto.on || !auto.playing || !book) return;
  if (book.fixed) { auto.timer = setTimeout(() => { if (!fx.next()) { autoStop(); finished(); return; } autoSchedule(); }, autoDelayFixed()); return; }
  const c = book.chapters[st.ch];
  if (paged()) {
    const words = c.words / st.pages * (1 - 0) ;
    auto.timer = setTimeout(() => {
      if (st.ch === book.chapters.length - 1 && st.page >= st.pages - 1) { autoStop(); finished(); return; }
      next(false); setTimeout(autoSchedule, 600);
    }, Math.max(2500, words / settings.autoWpm * 60000));
  } else {
    auto.last = performance.now();
    const step = t => {
      if (!auto.on || !auto.playing) return;
      const dt = (t - auto.last) / 1000; auto.last = t;
      const pxPerWord = pageEl.scrollHeight / Math.max(1, book.chapters[st.ch].words);
      pageEl.scrollTop += pxPerWord * settings.autoWpm / 60 * dt;
      if (pageEl.scrollTop + pageEl.clientHeight >= pageEl.scrollHeight - 2) {
        if (st.ch === book.chapters.length - 1) { autoStop(); finished(); return; }
        next(false); auto.last = performance.now();
      }
      auto.raf = requestAnimationFrame(step);
    };
    auto.raf = requestAnimationFrame(step);
  }
}
function autoStart() { if (!book) return; auto.on = true; auto.playing = true; $('#auto').hidden = false; $('#auto').classList.add('playing'); autoIcon(); autoLabel(); closeSettings(); hideChrome(); autoSchedule(); }
function autoStop() { auto.on = false; auto.playing = false; clearTimeout(auto.timer); cancelAnimationFrame(auto.raf); $('#auto').hidden = true; }
function autoIcon() { $('#auto-play').innerHTML = `<svg class="i"><use href="#i-${auto.playing ? 'pause' : 'play'}"/></svg>`; $('#auto-play').setAttribute('aria-label', auto.playing ? 'Pause' : 'Resume'); }
$('#b-auto').addEventListener('click', autoStart);
$('#auto-close').addEventListener('click', autoStop);
$('#auto-play').addEventListener('click', () => { auto.playing = !auto.playing; autoIcon(); autoSchedule(); });
$('#auto-slower').addEventListener('click', () => { settings.autoWpm = clamp(settings.autoWpm - 20, 80, 900); saveSettings(); autoLabel(); autoSchedule(); });
$('#auto-faster').addEventListener('click', () => { settings.autoWpm = clamp(settings.autoWpm + 20, 80, 900); saveSettings(); autoLabel(); autoSchedule(); });

// Image viewer
const lb = $('#lightbox'), lbImg = $('#lb-img');
const lbs = { z: 1, x: 0, y: 0, ptrs: new Map(), pinch: null, drag: null };
function lbApply() { lbImg.style.transform = `translate(${lbs.x}px,${lbs.y}px) scale(${lbs.z})`; lb.classList.toggle('zoomed', lbs.z > 1.01); }
function openLightbox(src, alt) { lbImg.src = src; lbImg.alt = alt || ''; Object.assign(lbs, { z: 1, x: 0, y: 0 }); lbApply(); lb.hidden = false; $('#lb-close').focus(); }
function closeLightbox() { lb.hidden = true; lbImg.removeAttribute('src'); }
$('#lb-close').onclick = closeLightbox;
lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
lb.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
lbImg.addEventListener('dblclick', e => { if (lbs.z > 1.01) Object.assign(lbs, { z: 1, x: 0, y: 0 }); else { lbs.z = 2.5; } lbApply(); });
lb.addEventListener('wheel', e => { e.preventDefault(); lbs.z = clamp(lbs.z * (e.deltaY < 0 ? 1.12 : 0.89), 1, 8); if (lbs.z === 1) { lbs.x = 0; lbs.y = 0; } lbApply(); }, { passive: false });
lb.addEventListener('pointerdown', e => {
  lbs.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (lbs.ptrs.size === 2) { const [a, b] = [...lbs.ptrs.values()]; lbs.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: lbs.z }; }
  else lbs.drag = { x: e.clientX - lbs.x, y: e.clientY - lbs.y };
});
lb.addEventListener('pointermove', e => {
  if (!lbs.ptrs.has(e.pointerId)) return; lbs.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (lbs.pinch && lbs.ptrs.size === 2) { const [a, b] = [...lbs.ptrs.values()]; lbs.z = clamp(lbs.pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / lbs.pinch.d, 1, 8); lbApply(); }
  else if (lbs.drag && lbs.z > 1.01) { lbs.x = e.clientX - lbs.drag.x; lbs.y = e.clientY - lbs.drag.y; lbApply(); }
});
const lbEnd = e => { lbs.ptrs.delete(e.pointerId); if (lbs.ptrs.size < 2) lbs.pinch = null; if (!lbs.ptrs.size) lbs.drag = null; };
lb.addEventListener('pointerup', lbEnd); lb.addEventListener('pointercancel', lbEnd);

// Spacing & aid settings
$('#ls').addEventListener('input', e => setSetting('ls', +e.target.value));
$('#ws').addEventListener('input', e => setSetting('ws', +e.target.value));
[['#opt-ruler', 'ruler'], ['#opt-bionic', 'bionic'], ['#opt-focus', 'focus']].forEach(([sel, k]) =>
  $(sel).addEventListener('change', e => { settings[k] = e.target.checked; applySettings(k === 'bionic'); if (k === 'ruler') placeRuler(); if (k === 'focus') focusFromOffset(); }));

/* =========================================================
   Boot
   ========================================================= */
applySettings();
(async () => {
  if (await takeSharedFile()) return;
  await new Promise(r => setTimeout(r, 0));
  if (launchedWithFile) return;
  if (desktop) {
    try { const pf = await desktop.pendingFiles(); if (pf && pf.length) { $('#library').hidden = false; takeDesktopFiles(pf); return; } } catch {}
  }
  const last = store.get('last', null);
  let entry = null;
  if (last === SAMPLE_ENTRY.id && !store.get('sampleRemoved', false)) entry = SAMPLE_ENTRY;
  else if (last) entry = (await dbAll()).find(e => e.id === last) || null;
  if (entry) openEntry(entry);
  else { $('#library').hidden = false; renderLibrary(); }
})();

// Expose for debugging in devtools
window.margin = { get book() { return book; }, st, settings, stats };
