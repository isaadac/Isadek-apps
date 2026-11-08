/* Margin — additional formats.
   Reflowable: MOBI / AZW3 / KF8 and FB2 (via foliate-js), DOCX (via mammoth).
   Fixed layout: PDF (via pdf.js) and comics CBZ / CBR / CB7 / CBT (JSZip, libarchive.js). */
import { esc, inert, makeBook } from './parse.js';

const here = p => new URL(p, import.meta.url).href;
const IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const IMG_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/* ---------- format detection ---------- */
export function kindOf(name, type = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'epub' || type === 'application/epub+zip') return 'epub';
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (['mobi', 'azw', 'azw3', 'kf8', 'prc'].includes(ext)) return 'mobi';
  if (ext === 'fb2' || name.toLowerCase().endsWith('.fb2.zip') || ext === 'fbz') return 'fb2';
  if (ext === 'docx') return 'docx';
  if (['cbz', 'cbr', 'cb7', 'cbt'].includes(ext)) return 'comic';
  if (ext === 'txt' || ext === 'text' || ext === 'md' || type.startsWith('text/plain')) return 'txt';
  if (['m4b', 'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'webm'].includes(ext) || type.startsWith('audio/')) return 'audio';
  if (ext === 'zip') return 'zip';
  return null;
}
export const ACCEPT = '.epub,.pdf,.mobi,.azw,.azw3,.prc,.fb2,.fbz,.docx,.cbz,.cbr,.cb7,.cbt,.txt,.md,application/epub+zip,application/pdf,text/plain';

/* ---------- shared sanitising (for documents that are already parsed) ---------- */
export function sanitize(root) {
  root.querySelectorAll('script,style,link,meta,iframe,object,embed,form,input,button,select,textarea,base,audio,video,noscript,title,head').forEach(n => n.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'style' || n === 'class' || n === 'srcset' || n === 'align' || n === 'bgcolor' || n === 'filepos' ||
        ((n === 'width' || n === 'height') && el.localName === 'img')) el.removeAttribute(a.name);
    }
    if (el.id) el.id = 'x-' + el.id;
  }
  for (const img of root.querySelectorAll('img')) {
    const s = img.getAttribute('src') || '';
    if (!/^(blob:|data:image\/)/i.test(s)) img.remove(); else if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
  }
  for (const im of root.querySelectorAll('image')) {
    const s = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!/^(blob:|data:image\/)/i.test(s)) im.remove();
  }
  for (const a of root.querySelectorAll('a[href]')) {
    if (a.hasAttribute('data-link')) { a.setAttribute('href', '#'); continue; }
    const h = a.getAttribute('href').trim();
    if (/^https?:/i.test(h)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
    else a.removeAttribute('href');
  }
}
const nameOf = x => {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(nameOf).filter(Boolean).join(', ');
  if (x.name) return nameOf(x.name);
  if (typeof x === 'object') return String(Object.values(x)[0] || '');
  return String(x);
};

/* ---------- MOBI / AZW3 / FB2 through foliate-js ---------- */
export async function parseFoliate(file, kind, id) {
  let fbook;
  if (kind === 'mobi') {
    const { MOBI, isMOBI } = await import('../vendor/foliate/mobi.js');
    if (!(await isMOBI(file))) throw new Error('This file is not a valid MOBI or AZW3 book.');
    const fflate = await import('../vendor/foliate/fflate.js');
    try { fbook = await new MOBI({ unzlib: fflate.unzlibSync }).open(file); }
    catch (e) { throw new Error(/encrypt|drm/i.test(String(e)) ? 'This Kindle book is DRM-protected. Margin can only open DRM-free books.' : 'This MOBI/AZW3 file could not be read.'); }
  } else {
    let blob = file;
    if (/\.(fbz|fb2\.zip)$/i.test(file.name || '')) {
      const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
      const entry = Object.values(zip.files).find(f => /\.fb2$/i.test(f.name));
      if (!entry) throw new Error('This archive does not contain an FB2 book.');
      blob = new File([await entry.async('blob')], entry.name, { type: 'application/x-fictionbook+xml' });
    }
    const { makeFB2 } = await import('../vendor/foliate/fb2.js');
    fbook = await makeFB2(blob);
  }
  const sections = fbook.sections.map((s, i) => ({ s, i })).filter(x => x.s.createDocument && x.s.linear !== 'no');
  const docs = new Map();
  for (const { s, i } of sections) {
    try { docs.set(i, await s.createDocument()); } catch (e) { console.warn('section', i, e); }
  }
  // Resolve links and TOC targets against the original documents, before they are imported.
  let n = 0;
  const targetId = (index, anchor) => {
    const doc = docs.get(index); if (!doc) return null;
    let el = null;
    try { const t = typeof anchor === 'function' ? anchor(doc) : null; el = t && (t.nodeType === 1 ? t : t.startContainer ? (t.startContainer.nodeType === 1 ? t.startContainer : t.startContainer.parentElement) : null); } catch {}
    if (!el || el === doc.body || el === doc.documentElement) return '';
    if (!el.id) el.id = 'fl-' + (++n);
    return el.id;
  };
  const resolve = href => { try { return fbook.resolveHref(href); } catch { return null; } };
  for (const [index, doc] of docs) {
    for (const a of doc.querySelectorAll('a[href], a[filepos]')) {
      const href = a.getAttribute('href') || (a.getAttribute('filepos') ? `filepos:${a.getAttribute('filepos')}` : '');
      if (!href || /^https?:/i.test(href)) continue;
      const r = resolve(href);
      if (r && docs.has(r.index)) {
        const tid = targetId(r.index, r.anchor);
        a.setAttribute('data-link', `sec:${r.index}#${tid || ''}`);
      }
    }
  }
  const toc = [];
  const walk = (items, depth) => (items || []).forEach(it => {
    const r = it.href ? resolve(it.href) : null;
    if (r && docs.has(r.index)) {
      const tid = targetId(r.index, r.anchor);
      toc.push({ title: (it.label || '').trim(), sec: r.index, anchor: tid ? 'x-' + tid : null, depth });
    }
    walk(it.subitems, depth + 1);
  });
  walk(fbook.toc, 0);

  const chapters = [], pathIndex = new Map();
  for (const [index, doc] of docs) {
    const body = doc.body || doc.querySelector('body') || doc.documentElement;
    const wrap = inert.createElement('div');
    for (const node of Array.from(body.childNodes)) wrap.appendChild(inert.importNode(node, true));
    sanitize(wrap);
    if (!wrap.textContent.trim() && !wrap.querySelector('img,svg')) continue;
    const h = wrap.querySelector('h1,h2,h3');
    pathIndex.set(`sec:${index}`, chapters.length);
    chapters.push({ path: `sec:${index}`, html: wrap.innerHTML, title: '', firstHead: h ? h.textContent.replace(/\s+/g, ' ').trim().slice(0, 90) : '' });
  }
  if (!chapters.length) throw new Error('This book has no readable text.');
  const tocOut = toc.filter(t => t.title && pathIndex.has(`sec:${t.sec}`)).map(t => ({ title: t.title, ch: pathIndex.get(`sec:${t.sec}`), anchor: t.anchor, depth: t.depth }));
  for (const t of tocOut) if (!chapters[t.ch].title) chapters[t.ch].title = t.title;
  chapters.forEach((c, i) => { if (!c.title) c.title = c.firstHead || (i === 0 ? 'Opening' : ''); });
  let coverBlob = null;
  try { coverBlob = (await fbook.getCover?.()) || null; } catch {}
  const md = fbook.metadata || {};
  return makeBook({
    id, title: nameOf(md.title), author: nameOf(md.author), lang: (Array.isArray(md.language) ? md.language[0] : md.language) || 'en',
    chapters, toc: tocOut, pathIndex, coverBlob
  });
}

/* ---------- DOCX through mammoth ---------- */
async function loadScript(src) {
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('A component failed to load.')); document.head.appendChild(s); });
}
export async function parseDocx(buf, id, fallbackTitle) {
  if (!window.mammoth) await loadScript(here('../vendor/mammoth/mammoth.browser.min.js'));
  let html;
  try { ({ value: html } = await window.mammoth.convertToHtml({ arrayBuffer: buf.slice(0) })); }
  catch { throw new Error('This Word document could not be read.'); }
  const wrap = inert.createElement('div'); wrap.innerHTML = html;
  sanitize(wrap);
  const level = wrap.querySelector('h1') ? 'H1' : wrap.querySelector('h2') ? 'H2' : null;
  const chapters = []; let cur = null;
  for (const node of Array.from(wrap.childNodes)) {
    if (level && node.nodeName === level) { cur = { title: node.textContent.trim().slice(0, 90), parts: [node.outerHTML] }; chapters.push(cur); continue; }
    if (!cur) { cur = { title: '', parts: [] }; chapters.push(cur); }
    cur.parts.push(node.outerHTML || esc(node.textContent || ''));
  }
  const out = chapters.filter(c => c.parts.join('').replace(/<[^>]+>/g, '').trim() || /<img/.test(c.parts.join('')));
  if (!out.length) throw new Error('This document is empty.');
  out.forEach((c, i) => { if (!c.title) c.title = i === 0 ? 'Opening' : `Section ${i + 1}`; });
  return makeBook({ id, title: fallbackTitle, author: '', lang: 'en', chapters: out.map(c => ({ title: c.title, html: c.parts.join('') })) });
}

/* ---------- Comics (fixed layout) ---------- */
export async function openComic(file, id, fallbackTitle) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let entries = [];
  let info = null;
  const keep = p => IMG_RE.test(p) && !/(^|\/)(__MACOSX|\.)/.test(p);
  if (ext === 'cbz' || (await isZip(file))) {
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    for (const f of Object.values(zip.files)) {
      if (f.dir) continue;
      if (/comicinfo\.xml$/i.test(f.name)) info = await f.async('text');
      else if (keep(f.name)) entries.push({ path: f.name, load: () => f.async('blob') });
    }
  } else {
    const { Archive } = await import('../vendor/libarchive/libarchive.js');
    Archive.init({ workerUrl: here('../vendor/libarchive/worker-bundle.js') });
    let ar;
    try { ar = await Archive.open(file); await ar.extractFiles(); }
    catch { throw new Error('This comic archive could not be opened.'); }
    for (const { file: f, path } of await ar.getFilesArray()) {
      const full = path + f.name;
      if (/comicinfo\.xml$/i.test(full)) info = await f.text();
      else if (keep(full)) entries.push({ path: full, load: async () => f });
    }
  }
  if (!entries.length) throw new Error('No pages were found in this comic.');
  entries.sort((a, b) => natural.compare(a.path, b.path));
  const pages = [];
  for (const e of entries) {
    const b = await e.load();
    const ext2 = e.path.split('.').pop().toLowerCase();
    pages.push(new Blob([b], { type: IMG_MIME[ext2] || 'image/jpeg' }));
  }
  let title = fallbackTitle, author = '';
  if (info) {
    const d = new DOMParser().parseFromString(info, 'application/xml');
    const g = t => d.getElementsByTagName(t)[0]?.textContent?.trim() || '';
    const series = g('Series'), num = g('Number');
    title = g('Title') || (series ? series + (num ? ' #' + num : '') : title);
    author = g('Writer') || g('Penciller') || '';
  }
  const urls = new Map();
  const url = i => { if (!urls.has(i)) urls.set(i, URL.createObjectURL(pages[i])); return urls.get(i); };
  const sizes = new Map();
  return {
    id, title, author, fixed: true, kind: 'comic', pageCount: pages.length, coverBlob: pages[0], lang: 'en',
    toc: [], searchable: false,
    async aspect(i) {
      if (sizes.has(i)) return sizes.get(i);
      const im = new Image(); im.src = url(i);
      try { await im.decode(); } catch {}
      const r = im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : 0.66;
      sizes.set(i, r); return r;
    },
    async render(i, box) {
      const im = document.createElement('img'); im.className = 'fx-img'; im.alt = `Page ${i + 1}`; im.draggable = false;
      im.src = url(i); try { await im.decode(); } catch {}
      return im;
    }
  };
}
async function isZip(file) { const b = new Uint8Array(await file.slice(0, 4).arrayBuffer()); return b[0] === 0x50 && b[1] === 0x4b; }

/* ---------- PDF (fixed layout, with optional text view) ---------- */
let pdfjsP = null;
async function pdfjs() {
  if (!pdfjsP) pdfjsP = import('../vendor/pdfjs/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = here('../vendor/pdfjs/pdf.worker.min.mjs'); return m; });
  return pdfjsP;
}
export async function openPdf(buf, id, fallbackTitle) {
  const lib = await pdfjs();
  let doc;
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(buf.slice(0)), cMapUrl: here('../vendor/pdfjs/cmaps/'), cMapPacked: true,
      standardFontDataUrl: here('../vendor/pdfjs/standard_fonts/'), isEvalSupported: false
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected.');
    throw new Error('This PDF could not be read.');
  }
  let title = fallbackTitle, author = '';
  try { const m = await doc.getMetadata(); if (m.info?.Title && m.info.Title.trim().length > 1) title = m.info.Title.trim(); if (m.info?.Author) author = m.info.Author.trim(); } catch {}
  const toc = [];
  try {
    const outline = await doc.getOutline();
    const walk = async (items, depth) => {
      for (const it of items || []) {
        let page = null;
        try {
          const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
          if (dest && dest[0]) page = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
        } catch {}
        if (page != null) toc.push({ title: it.title.trim(), page, depth });
        if (depth < 3) await walk(it.items, depth + 1);
      }
    };
    await walk(outline, 0);
  } catch {}
  const aspects = new Map();
  const textCache = new Map();
  const book = {
    id, title, author, fixed: true, kind: 'pdf', pageCount: doc.numPages, toc, searchable: true, lang: 'en', doc,
    async aspect(i) {
      if (aspects.has(i)) return aspects.get(i);
      const p = await doc.getPage(i + 1); const v = p.getViewport({ scale: 1 });
      aspects.set(i, v.width / v.height); return v.width / v.height;
    },
    async render(i, box) {
      const p = await doc.getPage(i + 1);
      const v1 = p.getViewport({ scale: 1 });
      const scale = Math.min(box.w / v1.width, box.h / v1.height) * (box.zoom || 1);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const vp = p.getViewport({ scale: scale * dpr });
      const c = document.createElement('canvas'); c.className = 'fx-img';
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.style.width = Math.floor(vp.width / dpr) + 'px'; c.style.height = Math.floor(vp.height / dpr) + 'px';
      c.setAttribute('role', 'img'); c.setAttribute('aria-label', `Page ${i + 1}`);
      await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      return c;
    },
    async pageText(i) {
      if (textCache.has(i)) return textCache.get(i);
      const p = await doc.getPage(i + 1);
      const tc = await p.getTextContent();
      const t = linesFromItems(tc.items).map(l => l.text).join('\n');
      textCache.set(i, t); return t;
    },
    async pageLines(i) { const p = await doc.getPage(i + 1); return linesFromItems((await p.getTextContent()).items); }
  };
  try {
    const p = await doc.getPage(1); const v = p.getViewport({ scale: 1 }); const s = 360 / v.height;
    const vp = p.getViewport({ scale: s }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: x, viewport: vp }).promise;
    book.coverBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  } catch {}
  return book;
}
function linesFromItems(items) {
  const lines = [];
  for (const it of items) {
    if (!('str' in it)) continue;
    const y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
    let last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - y) > h * 0.5) { last = { y, h, x: it.transform[4], text: '' }; lines.push(last); }
    last.text += (last.text && !/\s$/.test(last.text) && it.str && !/^\s/.test(it.str) && (it.transform[4] - (last.endX || 0)) > h * 0.15 ? ' ' : '') + it.str;
    last.endX = it.transform[4] + (it.width || 0);
  }
  return lines.filter(l => l.text.trim());
}
/* Turn a PDF's text into a reflowable book (enables highlights, read-aloud, themes). */
export async function pdfToFlow(fx, onProgress) {
  const n = fx.pageCount;
  const pagesHtml = [];
  for (let i = 0; i < n; i++) {
    const lines = await fx.pageLines(i);
    const paras = []; let cur = '';
    const gaps = []; for (let k = 1; k < lines.length; k++) gaps.push(Math.abs(lines[k - 1].y - lines[k].y));
    const typical = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14;
    lines.forEach((l, k) => {
      const gap = k ? Math.abs(lines[k - 1].y - l.y) : 0;
      if (k && (gap > typical * 1.45 || (l.x - lines[k - 1].x) > l.h * 1.2)) { if (cur.trim()) paras.push(cur.trim()); cur = ''; }
      const t = l.text.trim();
      if (cur.endsWith('-') && /^[a-z]/.test(t)) cur = cur.slice(0, -1) + t; else cur += (cur ? ' ' : '') + t;
    });
    if (cur.trim()) paras.push(cur.trim());
    // drop a lone page number line
    const filtered = paras.filter(p => !/^\d{1,4}$/.test(p));
    pagesHtml.push(filtered.map(p => `<p>${esc(p)}</p>`).join(''));
    if (onProgress && i % 5 === 0) onProgress(i / n);
  }
  const tops = fx.toc.filter(t => t.depth === 0).sort((a, b) => a.page - b.page);
  const ranges = [];
  if (tops.length >= 2) {
    if (tops[0].page > 0) ranges.push({ title: 'Front matter', a: 0, b: tops[0].page });
    tops.forEach((t, k) => ranges.push({ title: t.title, a: t.page, b: k < tops.length - 1 ? tops[k + 1].page : n }));
  } else {
    for (let a = 0; a < n; a += 10) ranges.push({ title: `Pages ${a + 1}–${Math.min(n, a + 10)}`, a, b: Math.min(n, a + 10) });
  }
  const chapters = ranges.filter(r => r.b > r.a).map(r => ({
    title: r.title,
    html: `<h2>${esc(r.title)}</h2>` + pagesHtml.slice(r.a, r.b).join('')
  }));
  return makeBook({ id: fx.id + ':text', title: fx.title, author: fx.author, lang: 'en', chapters });
}
