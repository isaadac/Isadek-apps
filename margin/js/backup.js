/* Margin — backup & restore. A backup is a zip (.margin) holding every book file,
   reading position, highlight, note, bookmark, vocabulary card, goal and statistic. */

const PREFIX = 'margin:';
const allKeys = () => { const out = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PREFIX)) out[k.slice(PREFIX.length)] = localStorage.getItem(k); } } catch {} return out; };
const parse = v => { try { return JSON.parse(v); } catch { return null; } };
const setKey = (k, v) => { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch {} };

export async function makeBackup({ dbAll, includeBooks = true, onProgress }) {
  const zip = new window.JSZip();
  const entries = await dbAll();
  const books = [];
  let i = 0;
  for (const e of entries) {
    const meta = { ...e }; delete meta.data; delete meta.cover;
    delete meta.tracks;
    if (e.tracks) meta.trackList = e.tracks.map(t => ({ name: t.name, type: t.type, duration: t.duration, title: t.title }));
    if (includeBooks) {
      const name = `books/${encodeURIComponent(e.id)}`;
      if (e.tracks) {
        e.tracks.forEach((t, i) => zip.file(`${name}/${i}.bin`, t.blob, { compression: 'STORE' }));
        meta.trackDir = name;
      } else {
        zip.file(name + '.bin', typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data);
        meta.dataFile = name + '.bin'; meta.dataIsText = typeof e.data === 'string';
      }
      if (e.cover) { zip.file(name + '.cover', e.cover); meta.coverFile = name + '.cover'; meta.coverType = e.cover.type; }
    }
    books.push(meta);
    onProgress && onProgress(++i / Math.max(1, entries.length) * 0.5);
  }
  const keys = allKeys(); delete keys['seeded'];
  zip.file('margin.json', JSON.stringify({ app: 'Margin', version: 1, exported: new Date().toISOString(), includeBooks, books, keys }, null, 1));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }, m => onProgress && onProgress(0.5 + m.percent / 200));
  return { blob, count: entries.length };
}

/* Merge rules: books are added if missing; positions keep the most recent; highlights,
   bookmarks and vocabulary are combined by id; daily reading time keeps the larger value. */
export async function restoreBackup(file, { dbAll, dbPut }) {
  let zip;
  try { zip = await window.JSZip.loadAsync(await file.arrayBuffer()); } catch { throw new Error('This file is not a Margin backup.'); }
  const mf = zip.file('margin.json');
  if (!mf) throw new Error('This file is not a Margin backup.');
  const m = parse(await mf.async('text'));
  if (!m || m.app !== 'Margin') throw new Error('This file is not a Margin backup.');
  const have = new Set((await dbAll()).map(e => e.id));
  let added = 0;
  for (const b of m.books || []) {
    if (have.has(b.id)) continue;
    let rec;
    if (b.trackDir && b.trackList) {
      const tracks = [];
      for (let i = 0; i < b.trackList.length; i++) {
        const f = zip.file(`${b.trackDir}/${i}.bin`); if (!f) { tracks.length = 0; break; }
        const t = b.trackList[i];
        tracks.push({ ...t, blob: new File([await f.async('blob')], t.name, { type: t.type }) });
      }
      if (!tracks.length) continue;
      rec = { ...b, tracks }; delete rec.trackDir; delete rec.trackList;
    } else {
      if (!b.dataFile || !zip.file(b.dataFile)) continue;
      const buf = await zip.file(b.dataFile).async('arraybuffer');
      rec = { ...b, data: b.dataIsText ? new TextDecoder().decode(buf) : buf };
    }
    if (b.coverFile && zip.file(b.coverFile)) rec.cover = new Blob([await zip.file(b.coverFile).async('arraybuffer')], { type: b.coverType || 'image/jpeg' });
    delete rec.dataFile; delete rec.dataIsText; delete rec.coverFile; delete rec.coverType;
    await dbPut(rec); added++;
  }
  const cur = allKeys();
  let merged = 0;
  for (const [k, raw] of Object.entries(m.keys || {})) {
    const inc = parse(raw); if (inc == null) continue;
    const mine = cur[k] != null ? parse(cur[k]) : null;
    let out = inc;
    if (mine != null) {
      if (k.startsWith('pos:')) out = (mine.at || 0) >= (inc.at || 0) ? mine : inc;
      else if (k.startsWith('hl:') || k.startsWith('marks:')) out = unionById(mine, inc);
      else if (k === 'vocab') out = unionBy(mine, inc, x => x.word);
      else if (k === 'stats') out = mergeStats(mine, inc);
      else if (k === 'settings' || k === 'last') out = mine;
      else if (k.startsWith('meta:')) out = { ...inc, ...mine };
      else if (k === 'shelves' || k === 'goals' || k === 'catalogs') out = Array.isArray(mine) ? unionBy(mine, inc, x => x.id || x.url || JSON.stringify(x)) : { ...inc, ...mine };
      else out = mine;
    }
    setKey(k, out); merged++;
  }
  return { added, merged, books: (m.books || []).length };
}
const unionById = (a, b) => unionBy(a, b, x => x.id);
function unionBy(a, b, key) {
  if (!Array.isArray(a)) return b; if (!Array.isArray(b)) return a;
  const map = new Map(a.map(x => [key(x), x]));
  for (const x of b) { const k = key(x); const y = map.get(k); if (!y || (x.at || x.updated || 0) > (y.at || y.updated || 0)) map.set(k, y ? { ...y, ...x } : x); }
  return [...map.values()];
}
function mergeStats(a, b) {
  const out = { ...a, days: { ...(b.days || {}) }, books: { ...(b.books || {}) }, finished: { ...(b.finished || {}), ...(a.finished || {}) } };
  for (const [d, s] of Object.entries(a.days || {})) out.days[d] = Math.max(s, out.days[d] || 0);
  for (const [id, x] of Object.entries(a.books || {})) { const y = out.books[id]; out.books[id] = !y ? x : { ...y, ...x, secs: Math.max(x.secs || 0, y.secs || 0), chars: Math.max(x.chars || 0, y.chars || 0) }; }
  out.secs = Object.values(out.days).reduce((s, x) => s + x, 0);
  out.chars = Math.max(a.chars || 0, b.chars || 0);
  return out;
}
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
