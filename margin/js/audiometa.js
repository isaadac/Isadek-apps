/* Margin — audiobook metadata. Reads only the bytes it needs from (possibly very large) files.
   MP3: ID3v2.2/2.3/2.4 — title, artist, album, track number, cover (PIC/APIC), chapters (CHAP).
   MP4/M4B/M4A: iTunes tags (ilst), cover (covr), chapters (Nero chpl, or a QuickTime chapter text track). */

const read = async (blob, start, len) => new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

export async function readAudioMeta(blob, name = '') {
  const head = await read(blob, 0, 12);
  if (ascii(head, 0, 3) === 'ID3') return readId3(blob, head);
  if (ascii(head, 4, 4) === 'ftyp') return readMp4(blob);
  if (ascii(head, 0, 4) === 'OggS') return readOgg(blob);
  if (ascii(head, 0, 4) === 'fLaC') return readFlac(blob);
  return {};
}

/* ---------------- Vorbis comments (Ogg Vorbis, Opus, FLAC) ---------------- */
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function vorbisComments(b, o) {
  const out = { chapters: [] }, td = new TextDecoder('utf-8');
  const vlen = le32(b, o); o += 4 + vlen;
  const n = le32(b, o); o += 4;
  const chap = {};
  for (let i = 0; i < n && o + 4 <= b.length; i++) {
    const len = le32(b, o); o += 4;
    const kv = td.decode(b.subarray(o, o + len)); o += len;
    const eq = kv.indexOf('='); if (eq < 0) continue;
    const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1);
    if (k === 'TITLE') out.title = v; else if (k === 'ARTIST') out.artist = v; else if (k === 'ALBUMARTIST' || k === 'ALBUM ARTIST') out.albumArtist = v;
    else if (k === 'ALBUM') out.album = v; else if (k === 'TRACKNUMBER') out.track = parseInt(v, 10) || null; else if (k === 'DISCNUMBER') out.disc = parseInt(v, 10) || null;
    else if (k === 'METADATA_BLOCK_PICTURE') { try { out.cover = flacPicture(Uint8Array.from(atob(v), c => c.charCodeAt(0)), 0); } catch {} }
    else { const m = k.match(/^CHAPTER(\d+)(NAME)?$/); if (m) { const c = chap[m[1]] || (chap[m[1]] = {}); if (m[2]) c.title = v; else { const t = v.split(':').map(Number); c.start = t.reduce((a, x) => a * 60 + x, 0); } } }
  }
  out.chapters = Object.values(chap).filter(c => c.start != null).map(c => ({ title: c.title || '', start: c.start })).sort((a, b) => a.start - b.start);
  return out;
}
function flacPicture(b, o) {
  const u = (i) => u32(b, o + i);
  let p = 4; const mlen = u(p); p += 4; const mime = new TextDecoder().decode(b.subarray(o + p, o + p + mlen)); p += mlen;
  const dlen = u(p); p += 4 + dlen + 16; const len = u(p); p += 4;
  return new Blob([b.slice(o + p, o + p + len)], { type: mime || 'image/jpeg' });
}
async function readOgg(blob) {
  const b = await read(blob, 0, Math.min(blob.size, 2 * 1048576));
  // stitch the packets of the first pages together (the comment header can span pages)
  const parts = []; let o = 0;
  while (o + 27 <= b.length && ascii(b, o, 4) === 'OggS' && parts.length < 64) {
    const segs = b[o + 26]; let len = 0; for (let i = 0; i < segs; i++) len += b[o + 27 + i];
    parts.push(b.subarray(o + 27 + segs, o + 27 + segs + len)); o += 27 + segs + len;
  }
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let q = 0; for (const x of parts) { all.set(x, q); q += x.length; }
  let i = -1;
  for (let k = 0; k < all.length - 8; k++) { if (ascii(all, k, 8) === 'OpusTags') { i = k + 8; break; } if (all[k] === 3 && ascii(all, k + 1, 6) === 'vorbis') { i = k + 7; break; } }
  return i < 0 ? {} : vorbisComments(all, i);
}
async function readFlac(blob) {
  const b = await read(blob, 0, Math.min(blob.size, 16 * 1048576));
  let o = 4, out = {}, cover = null;
  while (o + 4 <= b.length) {
    const last = b[o] & 0x80, type = b[o] & 0x7f, len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; o += 4;
    if (type === 4) out = vorbisComments(b, o);
    else if (type === 6 && !cover) { try { cover = flacPicture(b, o); } catch {} }
    o += len; if (last) break;
  }
  if (cover && !out.cover) out.cover = cover;
  return out;
}

/* ---------------- ID3v2 ---------------- */
function decodeText(bytes, enc) {
  let s;
  if (enc === 0) s = new TextDecoder('latin1').decode(bytes);
  else if (enc === 1) s = new TextDecoder(bytes[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(bytes[0] === 0xff || bytes[0] === 0xfe ? bytes.subarray(2) : bytes);
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(bytes);
  else s = new TextDecoder('utf-8').decode(bytes);
  return s.replace(/\0+$/, '').split('\0')[0].trim();
}
function nullEnd(b, o, enc) { // index just past the terminator
  if (enc === 1 || enc === 2) { for (let i = o; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2; return b.length; }
  const i = b.indexOf(0, o); return i < 0 ? b.length : i + 1;
}
async function readId3(blob, head) {
  const ver = head[3], flags = head[5];
  const size = synchsafe(head, 6);
  const tag = await read(blob, 10, Math.min(size, 40 * 1048576));
  let o = 0;
  if (flags & 0x40 && ver >= 3) o += ver === 4 ? synchsafe(tag, 0) : u32(tag, 0) + 4; // extended header
  const out = { chapters: [] };
  const frames = (buf, start, end) => {
    const list = []; let p = start;
    const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
    while (p + hdr <= end) {
      const id = ascii(buf, p, idLen);
      if (!/^[A-Z0-9]+$/.test(id)) break;
      const sz = ver === 2 ? (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5] : ver === 4 ? synchsafe(buf, p + 4) : u32(buf, p + 4);
      if (sz <= 0 || p + hdr + sz > end) break;
      list.push({ id, data: buf.subarray(p + hdr, p + hdr + sz) });
      p += hdr + sz;
    }
    return list;
  };
  const text = d => decodeText(d.subarray(1), d[0]);
  for (const f of frames(tag, o, tag.length)) {
    const d = f.data;
    switch (f.id) {
      case 'TIT2': case 'TT2': out.title = text(d); break;
      case 'TPE1': case 'TP1': out.artist = text(d); break;
      case 'TPE2': case 'TP2': out.albumArtist = text(d); break;
      case 'TALB': case 'TAL': out.album = text(d); break;
      case 'TRCK': case 'TRK': out.track = parseInt(text(d), 10) || null; break;
      case 'TPOS': case 'TPA': out.disc = parseInt(text(d), 10) || null; break;
      case 'APIC': {
        if (out.cover && d[nullEnd(d, 1, 0)] !== 3) break; // prefer the front cover (type 3)
        const enc = d[0]; let p = nullEnd(d, 1, 0);
        const mime = new TextDecoder('latin1').decode(d.subarray(1, p - 1)) || 'image/jpeg';
        const type = d[p]; p = nullEnd(d, p + 1, enc);
        if (!out.cover || type === 3) out.cover = new Blob([d.slice(p)], { type: /^image\//.test(mime) ? mime : 'image/' + mime.toLowerCase() });
        break;
      }
      case 'PIC': { const fmt = ascii(d, 1, 3).toLowerCase(); const p = nullEnd(d, 5, d[0]); out.cover = new Blob([d.slice(p)], { type: fmt === 'png' ? 'image/png' : 'image/jpeg' }); break; }
      case 'CHAP': {
        const p = nullEnd(d, 0, 0);
        const start = u32(d, p) / 1000, end = u32(d, p + 4) / 1000;
        let title = '';
        for (const sf of frames(d, p + 16, d.length)) if (sf.id === 'TIT2') title = text(sf.data);
        out.chapters.push({ title, start, end });
        break;
      }
    }
  }
  out.chapters.sort((a, b) => a.start - b.start);
  return out;
}

/* ---------------- MP4 / M4B ---------------- */
async function boxes(blob, start, end) { // top-level scan using small header reads
  const list = []; let p = start;
  while (p + 8 <= end) {
    const h = await read(blob, p, 16);
    let size = u32(h, 0); const type = ascii(h, 4, 4); let hdr = 8;
    if (size === 1) { size = u32(h, 8) * 4294967296 + u32(h, 12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr) break;
    list.push({ type, start: p, hdr, size });
    p += size;
  }
  return list;
}
function children(buf, start, end) {
  const list = []; let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p); const type = ascii(buf, p + 4, 4); let hdr = 8;
    if (size === 1) { size = u32(buf, p + 8) * 4294967296 + u32(buf, p + 12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    list.push({ type, start: p, hdr, size, body: p + hdr, end: p + size });
    p += size;
  }
  return list;
}
const child = (buf, box, type) => children(buf, box.body, box.end).find(c => c.type === type);
const path = (buf, box, ...types) => { let b = box; for (const t of types) { b = b && child(buf, b, t); } return b; };

async function readMp4(blob, opts = {}) {
  const top = await boxes(blob, 0, blob.size);
  const moovBox = top.find(b => b.type === 'moov');
  if (!moovBox) return {};
  const buf = await read(blob, moovBox.start, moovBox.size);
  const moov = { start: 0, body: moovBox.hdr, end: moovBox.size };
  const out = { chapters: [] };

  const mvhd = child(buf, moov, 'mvhd');
  if (mvhd) {
    const v = buf[mvhd.body];
    const ts = v === 1 ? u32(buf, mvhd.body + 20) : u32(buf, mvhd.body + 12);
    const dur = v === 1 ? u32(buf, mvhd.body + 24) * 4294967296 + u32(buf, mvhd.body + 28) : u32(buf, mvhd.body + 16);
    if (ts) out.duration = dur / ts;
  }
  // iTunes-style tags: moov/udta/meta(full box)/ilst
  const meta = path(buf, moov, 'udta', 'meta');
  if (meta) {
    const ilst = children(buf, meta.body + 4, meta.end).find(c => c.type === 'ilst');
    if (ilst) for (const item of children(buf, ilst.body, ilst.end)) {
      const data = children(buf, item.body, item.end).find(c => c.type === 'data');
      if (!data) continue;
      const kind = u32(buf, data.body) & 0xffffff, payload = buf.subarray(data.body + 8, data.end);
      const str = () => new TextDecoder('utf-8').decode(payload).trim();
      switch (item.type) {
        case '\xa9nam': out.title = str(); break;
        case '\xa9ART': out.artist = str(); break;
        case 'aART': out.albumArtist = str(); break;
        case '\xa9alb': out.album = str(); break;
        case '\xa9wrt': out.composer = str(); break;
        case 'covr': out.cover = new Blob([payload.slice()], { type: kind === 14 ? 'image/png' : 'image/jpeg' }); break;
        case 'trkn': out.track = u16(payload, 2) || null; break;
      }
    }
  }
  // Nero chapters: moov/udta/chpl
  const chpl = !opts.skipChpl && path(buf, moov, 'udta', 'chpl');
  if (chpl) {
    let p = chpl.body; const version = buf[p]; p += 4;
    if (version) p += 4;
    const n = buf[p++];
    for (let i = 0; i < n && p + 9 <= chpl.end; i++) {
      const t = (u32(buf, p) * 4294967296 + u32(buf, p + 4)) / 1e7; p += 8;
      const len = buf[p++];
      out.chapters.push({ title: new TextDecoder('utf-8').decode(buf.subarray(p, p + len)).trim(), start: t });
      p += len;
    }
  }
  // QuickTime chapter track: a text track referenced from the audio track's tref/chap
  if (!out.chapters.length) {
    const traks = children(buf, moov.body, moov.end).filter(c => c.type === 'trak');
    const idOf = t => { const h = child(buf, t, 'tkhd'); return h ? u32(buf, h.body + (buf[h.body] === 1 ? 20 : 12)) : 0; };
    let chapId = 0;
    for (const t of traks) { const c = path(buf, t, 'tref', 'chap'); if (c && c.end - c.body >= 4) { chapId = u32(buf, c.body); break; } }
    const ct = traks.find(t => idOf(t) === chapId);
    if (ct) out.chapters = await qtChapters(blob, buf, ct);
  }
  out.chapters = out.chapters.filter(c => isFinite(c.start)).sort((a, b) => a.start - b.start);
  return out;
}
async function qtChapters(blob, buf, trak) {
  const mdhd = path(buf, trak, 'mdia', 'mdhd'); const stbl = path(buf, trak, 'mdia', 'minf', 'stbl');
  if (!mdhd || !stbl) return [];
  const ts = buf[mdhd.body] === 1 ? u32(buf, mdhd.body + 20) : u32(buf, mdhd.body + 12);
  const box = t => child(buf, stbl, t);
  const stts = box('stts'), stsz = box('stsz'), stco = box('stco') || box('co64'), stsc = box('stsc');
  if (!ts || !stts || !stsz || !stco || !stsc) return [];
  // sample durations
  const durs = []; for (let i = 0, n = u32(buf, stts.body + 4), p = stts.body + 8; i < n; i++, p += 8) for (let k = 0; k < u32(buf, p); k++) durs.push(u32(buf, p + 4));
  // sample sizes
  const fixed = u32(buf, stsz.body + 4), count = u32(buf, stsz.body + 8);
  const sizes = []; for (let i = 0; i < count; i++) sizes.push(fixed || u32(buf, stsz.body + 12 + i * 4));
  // chunk offsets
  const co64 = stco.type === 'co64', nChunks = u32(buf, stco.body + 4), chunks = [];
  for (let i = 0; i < nChunks; i++) chunks.push(co64 ? u32(buf, stco.body + 8 + i * 8) * 4294967296 + u32(buf, stco.body + 12 + i * 8) : u32(buf, stco.body + 8 + i * 4));
  // samples per chunk
  const runs = []; for (let i = 0, n = u32(buf, stsc.body + 4); i < n; i++) runs.push({ first: u32(buf, stsc.body + 8 + i * 12), per: u32(buf, stsc.body + 12 + i * 12) });
  const offsets = []; let s = 0;
  for (let c = 0; c < chunks.length && s < count; c++) {
    const run = runs.filter(r => r.first <= c + 1).pop(); let off = chunks[c];
    for (let k = 0; k < (run ? run.per : 1) && s < count; k++, s++) { offsets.push(off); off += sizes[s]; }
  }
  const out = []; let t = 0;
  for (let i = 0; i < count; i++) {
    const d = await read(blob, offsets[i], Math.min(sizes[i], 512));
    const len = u16(d, 0);
    const bytes = d.subarray(2, 2 + len);
    const title = bytes[0] === 0xfe && bytes[1] === 0xff ? new TextDecoder('utf-16be').decode(bytes.subarray(2)) : new TextDecoder('utf-8').decode(bytes);
    out.push({ title: title.trim(), start: t / ts });
    t += durs[i] || 0;
  }
  return out;
}
export const _test = { readMp4 };

/* ---------------- durations ---------------- */
export function audioDuration(blob) {
  return new Promise(res => {
    const a = new Audio(); const url = URL.createObjectURL(blob);
    let done = false;
    const finish = v => { if (done) return; done = true; URL.revokeObjectURL(url); a.removeAttribute('src'); res(isFinite(v) && v > 0 ? v : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (isFinite(a.duration)) finish(a.duration);
      else { a.currentTime = 1e9; a.ontimeupdate = () => finish(a.duration); } // some VBR files report Infinity until seeked
    };
    a.onerror = () => finish(0);
    setTimeout(() => finish(a.duration), 20000);
    a.src = url;
  });
}
export function canPlay(type, name) {
  const a = document.createElement('audio');
  const ext = (name.split('.').pop() || '').toLowerCase();
  const byExt = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', flac: 'audio/flac', wav: 'audio/wav', webm: 'audio/webm' }[ext] || '';
  // Files often carry non-standard types such as audio/x-m4b, so also try the type implied by the extension.
  return [type, byExt].some(t => t && !!a.canPlayType(t));
}
