/* Margin — audiobooks: building a book from one or many audio files, and the player engine. */
import { readAudioMeta, audioDuration } from './audiometa.js';

export const AUDIO_EXT = ['m4b', 'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'webm', 'mp4'];
export const isAudioName = n => AUDIO_EXT.includes((n.split('.').pop() || '').toLowerCase());
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', webm: 'audio/webm' };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const mimeFor = name => MIME[(name.split('.').pop() || '').toLowerCase()] || 'audio/mpeg';

export function fmtTime(s, withHours) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return h || withHours ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export function fmtLong(s) {
  s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${Math.max(1, m)} min`;
}
function cleanName(n) {
  return n.replace(/\.[^.]+$/, '').replace(/_64kb$|_128kb$/i, '').replace(/^[\d\s._-]+(?=\D)/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || n;
}

/* Unpack a zip that holds an audiobook (e.g. a LibriVox download). */
export async function filesFromZip(file) {
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const audio = [], images = [];
  for (const f of Object.values(zip.files)) {
    if (f.dir || /(^|\/)(__MACOSX|\.)/.test(f.name)) continue;
    const base = f.name.split('/').pop();
    if (isAudioName(base)) audio.push(new File([await f.async('blob')], base, { type: mimeFor(base) }));
    else if (IMAGE_RE.test(base)) images.push(new File([await f.async('blob')], base, { type: /png$/i.test(base) ? 'image/png' : 'image/jpeg' }));
  }
  const cover = images.find(i => /cover|folder|front/i.test(i.name)) || images.sort((a, b) => b.size - a.size)[0] || null;
  return { audio, cover };
}

/* Build an audiobook record from audio files (one file, or the tracks of one book). */
export async function buildAudiobook(files, { fallbackTitle = 'Audiobook', cover: extraCover = null, onProgress } = {}) {
  const items = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let meta = {};
    try { meta = await readAudioMeta(f, f.name); } catch {}
    items.push({ f, meta });
    onProgress && onProgress((i + 0.5) / files.length);
  }
  const numbered = items.every(x => x.meta.track);
  items.sort((a, b) => numbered ? ((a.meta.disc || 1) - (b.meta.disc || 1) || a.meta.track - b.meta.track || natural.compare(a.f.name, b.f.name)) : natural.compare(a.f.name, b.f.name));
  const tracks = [];
  for (let i = 0; i < items.length; i++) {
    const { f, meta } = items[i];
    const duration = meta.duration || await audioDuration(f);
    tracks.push({ name: f.name, type: f.type || mimeFor(f.name), duration, blob: f, title: meta.title || cleanName(f.name), chapters: meta.chapters || [] });
    onProgress && onProgress((i + 1) / items.length);
  }
  const chapters = []; let t = 0;
  for (const tr of tracks) {
    if (tr.chapters.length > 1) tr.chapters.forEach((c, k) => chapters.push({ title: c.title || `Chapter ${chapters.length + 1}`, start: t + (k === 0 ? 0 : c.start) }));
    else chapters.push({ title: tracks.length === 1 ? (tr.chapters[0]?.title || tr.title) : tr.title, start: t });
    t += tr.duration || 0;
  }
  const m0 = items[0].meta;
  const title = (tracks.length > 1 ? m0.album : (m0.album || m0.title)) || fallbackTitle;
  const author = m0.albumArtist || m0.artist || m0.composer || '';
  const cover = items.map(x => x.meta.cover).find(Boolean) || extraCover || null;
  for (const tr of tracks) delete tr.chapters;
  return { title: title.trim(), author: author.trim(), tracks, chapters, total: t, cover };
}

/* ---------------- player ---------------- */
export function createAudioPlayer({ onState, onEnded, onDurations }) {
  const el = new Audio(); el.preload = 'auto';
  if ('preservesPitch' in el) el.preservesPitch = true;
  let book = null, idx = -1, offsets = [], urls = [], rate = 1, pendingSeek = null, wantPlay = false;
  let sleep = null; // { until: ms } or { chapterEnd: seconds }
  const S = { get playing() { return !el.paused && !el.ended; } };

  const recompute = () => { offsets = []; let t = 0; for (const tr of book.tracks) { offsets.push(t); t += tr.duration || 0; } book.total = t; };
  const url = i => urls[i] || (urls[i] = URL.createObjectURL(book.tracks[i].blob));
  const trackAt = t => { let i = 0; for (let k = 0; k < offsets.length; k++) if (offsets[k] <= t + 0.001) i = k; return i; };
  const now = () => idx < 0 ? 0 : offsets[idx] + (pendingSeek != null ? pendingSeek : el.currentTime || 0);
  const chapterAt = t => { let i = 0; book.chapters.forEach((c, k) => { if (c.start <= t + 0.25) i = k; }); return i; };
  const chapterEnd = i => i < book.chapters.length - 1 ? book.chapters[i + 1].start : book.total;

  function load(i) {
    idx = i; el.src = url(i); el.playbackRate = rate; el.defaultPlaybackRate = rate;
  }
  function seek(t) {
    if (!book) return;
    t = Math.max(0, Math.min(book.total ? book.total - 0.05 : t, t));
    const i = trackAt(t);
    const local = t - offsets[i];
    if (i !== idx || !el.src) { load(i); pendingSeek = local; }
    else if (el.readyState >= 1) { el.currentTime = local; pendingSeek = null; }
    else pendingSeek = local;
    if (wantPlay) el.play().catch(() => {});
    emit();
  }
  el.addEventListener('loadedmetadata', () => {
    if (book && isFinite(el.duration) && el.duration > 0 && Math.abs((book.tracks[idx].duration || 0) - el.duration) > 0.5) {
      book.tracks[idx].duration = el.duration; recompute(); onDurations && onDurations(book);
    }
    if (pendingSeek != null) { try { el.currentTime = Math.min(pendingSeek, Math.max(0, el.duration - 0.05)); } catch {} pendingSeek = null; }
    el.playbackRate = rate;
    if (wantPlay) el.play().catch(() => {});
  });
  el.addEventListener('ended', () => {
    if (!book) return;
    if (idx < book.tracks.length - 1) { load(idx + 1); pendingSeek = 0; el.play().catch(() => {}); return; }
    wantPlay = false; emit(); onEnded && onEnded();
  });
  let lastEmit = 0;
  el.addEventListener('timeupdate', () => {
    checkSleep();
    const t = performance.now(); if (t - lastEmit > 240) { lastEmit = t; emit(); }
  });
  ['play', 'pause', 'ratechange', 'seeked', 'waiting', 'playing'].forEach(ev => el.addEventListener(ev, () => { emit(); session(); }));
  el.addEventListener('error', () => { emit('error'); });

  function checkSleep() {
    if (!sleep) { el.volume = 1; return; }
    const remain = sleep.until ? (sleep.until - Date.now()) / 1000 : (sleep.chapterEnd - now()) / rate;
    if (remain <= 0) { el.pause(); wantPlay = false; el.volume = 1; sleep = null; emit('slept'); return; }
    el.volume = remain < 10 ? Math.max(0.05, remain / 10) : 1; // fade out over the last 10 seconds
  }
  setInterval(() => { if (sleep && S.playing) checkSleep(); }, 1000);

  function state() {
    if (!book) return null;
    const t = now(), ci = chapterAt(t), cs = book.chapters[ci].start, ce = chapterEnd(ci);
    let sleepLeft = null;
    if (sleep) sleepLeft = sleep.until ? Math.max(0, (sleep.until - Date.now()) / 1000) : Math.max(0, (sleep.chapterEnd - t) / rate);
    return { t, total: book.total, playing: S.playing || (wantPlay && el.readyState < 3), chapter: ci, chStart: cs, chEnd: ce, rate, sleep: sleep ? (sleep.chapterEnd != null ? 'chapter' : 'timer') : null, sleepLeft, buffering: wantPlay && el.readyState < 3 };
  }
  const emit = kind => onState && onState(state(), kind);

  function session() {
    if (!('mediaSession' in navigator) || !book) return;
    try {
      const st = state();
      navigator.mediaSession.playbackState = st.playing ? 'playing' : 'paused';
      if (book.total && navigator.mediaSession.setPositionState) navigator.mediaSession.setPositionState({ duration: book.total, position: Math.min(st.t, book.total), playbackRate: rate });
    } catch {}
  }
  function bindSession() {
    if (!('mediaSession' in navigator) || !book) return;
    try {
      const art = book.coverUrl ? [{ src: book.coverUrl, sizes: '512x512', type: book.coverType || 'image/jpeg' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
      navigator.mediaSession.metadata = new MediaMetadata({ title: book.chapters[chapterAt(now())].title, artist: book.author || '', album: book.title, artwork: art });
      const h = {
        play: () => api.play(), pause: () => api.pause(),
        seekbackward: d => api.skip(-(d && d.seekOffset || 15)), seekforward: d => api.skip(d && d.seekOffset || 30),
        previoustrack: () => api.prevChapter(), nexttrack: () => api.nextChapter(),
        seekto: d => api.seek(d.seekTime), stop: () => api.pause()
      };
      for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} }
    } catch {}
  }

  const api = {
    get book() { return book; },
    get playing() { return S.playing; },
    open(b, t = 0) {
      api.close();
      book = b; urls = []; idx = -1; wantPlay = false; recompute();
      if (book.cover && !book.coverUrl) { book.coverUrl = URL.createObjectURL(book.cover); book.coverType = book.cover.type; }
      seek(t || 0); bindSession(); emit();
    },
    close() {
      wantPlay = false; el.pause(); el.removeAttribute('src'); try { el.load(); } catch {}
      urls.forEach(u => u && URL.revokeObjectURL(u)); urls = []; idx = -1; sleep = null; book = null; el.volume = 1;
      if ('mediaSession' in navigator) try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch {}
    },
    play() { if (!book) return; wantPlay = true; if (now() >= book.total - 0.1) seek(0); el.play().catch(() => {}); bindSession(); emit(); },
    pause() { wantPlay = false; el.pause(); emit(); },
    toggle() { (S.playing || wantPlay) ? api.pause() : api.play(); },
    seek(t) { seek(t); bindSession(); },
    skip(d) { seek(now() + d * (d > 0 ? 1 : 1)); },
    chapterAt, state,
    nextChapter() { const i = chapterAt(now()); if (i < book.chapters.length - 1) api.seek(book.chapters[i + 1].start); },
    prevChapter() { const t = now(), i = chapterAt(t); api.seek(t - book.chapters[i].start > 3 || i === 0 ? book.chapters[i].start : book.chapters[i - 1].start); },
    setRate(r) { rate = r; el.playbackRate = r; el.defaultPlaybackRate = r; emit(); session(); },
    get rate() { return rate; },
    setSleep(v) {
      if (v == null) sleep = null;
      else if (v === 'chapter') sleep = { chapterEnd: chapterEnd(chapterAt(now())) };
      else sleep = { until: Date.now() + v * 60000 };
      el.volume = 1; emit();
    }
  };
  return api;
}
