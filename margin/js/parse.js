/* Margin — book parsing: EPUB 2/3, plain text, and the built-in sample. */

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const inert = document.implementation.createHTMLDocument('');

export function smart(s) {
  return s
    .replace(/(^|[\s(\[—-])"/g, '$1“').replace(/"/g, '”')
    .replace(/(^|[\s(\[—-])'/g, '$1‘').replace(/'/g, '’')
    .replace(/--/g, '—');
}

export function parasToHtml(title, paras) {
  return (title ? `<h2>${esc(title)}</h2>` : '') + paras.map(p => `<p>${esc(smart(p))}</p>`).join('');
}

/* ---------- book model ---------- */
export function makeBook(b) {
  let total = 0, words = 0;
  b.chapters.forEach((c, i) => {
    const d = inert.createElement('div');
    d.innerHTML = c.html;
    d.querySelectorAll('aside').forEach(a => { if (/footnote|endnote|rearnote/.test(a.getAttribute('epub:type') || '')) a.remove(); });
    // Text used for search/offsets must equal the rendered flow's textContent, so keep the full text too.
    const full = inert.createElement('div'); full.innerHTML = c.html;
    c.text = full.textContent;
    c.words = (d.textContent.match(/\S+/g) || []).length;
    c.len = Math.max(c.text.length, 300);
    c.start = total; total += c.len; words += c.words;
    if (!c.title) c.title = `Section ${i + 1}`;
  });
  b.total = total || 1;
  b.words = words;
  if (!b.toc || !b.toc.length) b.toc = b.chapters.map((c, i) => ({ title: c.title, ch: i, anchor: null, depth: 0 }));
  if (!b.pathIndex) b.pathIndex = new Map();
  return b;
}

/* ---------- plain text ---------- */
export function titleFromName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

export function parseTxt(text, fallbackTitle, id) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let title = fallbackTitle, author = '';
  const tm = text.slice(0, 4000).match(/^Title:\s*(.+)$/m); if (tm) title = tm[1].trim();
  const am = text.slice(0, 4000).match(/^Author:\s*(.+)$/m); if (am) author = am[1].trim();
  if (tm || am) text = text.slice(0, 4000).replace(/^(Title|Author|Release date|Language|Credits|Most recently updated):.*$/gim, '') + text.slice(4000);
  const s = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*/i);
  if (s >= 0) text = text.slice(text.indexOf('\n', s) + 1);
  const e = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (e >= 0) text = text.slice(0, e);
  const head = /^\s*(chapter|book|part|letter|act|stave|canto|section)\s+([0-9]+|[ivxlcdm]+|[a-z-]+)\b[.:\s\S]{0,80}$/i;
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const chapters = []; let cur = { title: '', paras: [] };
  for (const b of blocks) {
    const firstLine = b.split('\n')[0];
    if (head.test(firstLine) && firstLine.length < 90) {
      if (cur.paras.length || cur.title) chapters.push(cur);
      cur = { title: firstLine.trim().replace(/\.$/, ''), paras: [] };
      const rest = b.split('\n').slice(1).join(' ').trim();
      if (rest) { if (rest.length < 90) cur.title += ': ' + rest; else cur.paras.push(rest); }
    } else {
      cur.paras.push(b.replace(/\s*\n\s*/g, ' '));
    }
  }
  if (cur.paras.length || cur.title) chapters.push(cur);
  let out = chapters;
  if (out.length <= 1) {
    const paras = out[0] ? out[0].paras : [];
    out = [];
    for (let i = 0; i < paras.length; i += 60) out.push({ title: `Part ${out.length + 1}`, paras: paras.slice(i, i + 60) });
    if (!out.length) out.push({ title: '', paras: ['This file has no text.'] });
  } else if (!out[0].title) {
    out[0].title = 'Opening';
  }
  return makeBook({
    id, title, author, lang: 'en',
    chapters: out.map(c => ({ title: c.title, html: parasToHtml(c.title, c.paras) }))
  });
}

/* ---------- EPUB ---------- */
const XLINK = 'http://www.w3.org/1999/xlink';
const OPS = 'http://www.idpf.org/2007/ops';
const parseXml = t => new DOMParser().parseFromString(t, 'application/xml');
const byTag = (d, t) => Array.from(d.getElementsByTagNameNS('*', t));
const kids = (el, ...names) => Array.from(el.children).filter(c => names.includes(c.localName));
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
function resolve(dir, href) {
  const out = [];
  for (const part of (dir + dec(href)).split('/')) {
    if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}
function resolveHref(dir, h) {
  const i = h.indexOf('#');
  const p = i >= 0 ? h.slice(0, i) : h, frag = i >= 0 ? dec(h.slice(i + 1)) : '';
  return { path: p ? resolve(dir, p) : null, frag };
}
function parseChapterDoc(raw) {
  let d = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
  if (d.getElementsByTagName('parsererror').length) d = new DOMParser().parseFromString(raw, 'text/html');
  return d;
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif' };

export async function parseEpub(buf, id) {
  if (!window.JSZip) throw new Error('The EPUB unpacker did not load. Reload Margin and try again.');
  let zip;
  try { zip = await window.JSZip.loadAsync(buf); } catch { throw new Error('This file is not a valid EPUB archive.'); }
  const lower = {}; zip.forEach((p, f) => { if (!f.dir) lower[p.toLowerCase()] = f; });
  const get = p => p ? (zip.file(p) || lower[p.toLowerCase()] || null) : null;
  const cf = get('META-INF/container.xml');
  if (!cf) throw new Error('This EPUB is missing its container file.');
  const rf = byTag(parseXml(await cf.async('text')), 'rootfile')[0];
  const opfPath = rf && rf.getAttribute('full-path');
  const opfFile = get(opfPath);
  if (!opfFile) throw new Error('This EPUB is missing its package file.');
  const encFile = get('META-INF/encryption.xml');
  if (encFile) {
    const enc = await encFile.async('text');
    if (/EncryptedData/.test(enc) && !/obfuscation|font/i.test(enc)) throw new Error('This EPUB is DRM-protected. Margin can only open DRM-free books.');
  }
  const opf = parseXml(await opfFile.async('text'));
  const opfDir = dirOf(opfPath);
  const meta = n => { const el = byTag(opf, n)[0]; return el ? el.textContent.trim() : ''; };
  const manifest = new Map();
  byTag(opf, 'item').forEach(it => manifest.set(it.getAttribute('id'), {
    href: resolve(opfDir, (it.getAttribute('href') || '').split('#')[0]),
    type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || ''
  }));
  const spineEl = byTag(opf, 'spine')[0];
  const spine = byTag(opf, 'itemref').map(r => manifest.get(r.getAttribute('idref')))
    .filter(it => it && /html|xml/.test(it.type) && !/ncx/.test(it.type));

  const imgCache = new Map();
  async function blobUrl(path) {
    if (imgCache.has(path)) return imgCache.get(path);
    const f = get(path); if (!f) return null;
    const ext = path.split('.').pop().toLowerCase();
    const u = URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type: MIME[ext] || 'application/octet-stream' }));
    imgCache.set(path, u); return u;
  }
  async function clean(root, dir, ownPath) {
    root.querySelectorAll('script,style,link,meta,iframe,object,embed,form,input,button,select,textarea,base,audio,video,noscript,title,head').forEach(n => n.remove());
    for (const el of root.querySelectorAll('*')) {
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || n === 'style' || n === 'class' || n === 'srcset' || n === 'align' || n === 'bgcolor' ||
          ((n === 'width' || n === 'height') && el.localName === 'img')) el.removeAttribute(a.name);
      }
      if (el.id) el.id = 'x-' + el.id;
      if (el.localName === 'a' && el.getAttribute('name') && !el.id) el.id = 'x-' + el.getAttribute('name');
    }
    for (const img of root.querySelectorAll('img')) {
      const s = img.getAttribute('src') || '';
      if (/^data:image\//i.test(s)) continue;
      const u = s && !/^[a-z]+:/i.test(s) ? await blobUrl(resolve(dir, s.split('#')[0])) : null;
      if (u) { img.setAttribute('src', u); if (!img.hasAttribute('alt')) img.setAttribute('alt', ''); }
      else img.remove();
    }
    for (const im of root.querySelectorAll('image')) {
      const s = im.getAttribute('href') || im.getAttributeNS(XLINK, 'href') || '';
      const u = s && !/^[a-z]+:/i.test(s) ? await blobUrl(resolve(dir, s.split('#')[0])) : null;
      if (u) { im.setAttribute('href', u); im.removeAttributeNS(XLINK, 'href'); } else im.remove();
    }
    for (const a of root.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href').trim();
      if (/^https?:/i.test(h)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
      else if (/^[a-z]+:/i.test(h)) a.removeAttribute('href');
      else {
        const r = resolveHref(dir, h);
        a.setAttribute('data-link', (r.path || ownPath) + '#' + r.frag);
        a.setAttribute('href', '#');
      }
    }
  }

  const chapters = [], pathIndex = new Map();
  for (const it of spine) {
    const f = get(it.href); if (!f) continue;
    const src = parseChapterDoc(await f.async('text'));
    const bodyEl = src.body || byTag(src, 'body')[0] || src.documentElement;
    const wrap = inert.createElement('div');
    for (const n of Array.from(bodyEl.childNodes)) wrap.appendChild(inert.importNode(n, true));
    await clean(wrap, dirOf(it.href), it.href);
    const h = wrap.querySelector('h1,h2,h3');
    pathIndex.set(it.href, chapters.length);
    chapters.push({ path: it.href, html: wrap.innerHTML, title: '', firstHead: h ? h.textContent.replace(/\s+/g, ' ').trim().slice(0, 90) : '' });
  }
  if (!chapters.length) throw new Error('This EPUB has no readable chapters.');

  const toc = [];
  const add = (title, target, depth) => {
    title = (title || '').replace(/\s+/g, ' ').trim();
    if (!title || !target || !target.path) return;
    const ch = pathIndex.get(target.path);
    if (ch === undefined) return;
    toc.push({ title, ch, anchor: target.frag ? 'x-' + target.frag : null, depth });
  };
  const navItem = [...manifest.values()].find(m => /\bnav\b/.test(m.props));
  if (navItem && get(navItem.href)) {
    const nd = parseChapterDoc(await get(navItem.href).async('text'));
    const navs = byTag(nd, 'nav');
    const nav = navs.find(n => /toc/.test(n.getAttributeNS(OPS, 'type') || n.getAttribute('epub:type') || '')) || navs[0];
    const ndir = dirOf(navItem.href);
    const walk = (list, depth) => {
      for (const li of kids(list, 'li')) {
        const a = kids(li, 'a', 'span')[0];
        if (a) { const h = a.getAttribute('href'); if (h) add(a.textContent, resolveHref(ndir, h), depth); }
        const sub = kids(li, 'ol', 'ul')[0];
        if (sub) walk(sub, depth + 1);
      }
    };
    const list = nav && (kids(nav, 'ol', 'ul')[0] || byTag(nav, 'ol')[0]);
    if (list) walk(list, 0);
  }
  if (!toc.length) {
    const ncxId = spineEl && spineEl.getAttribute('toc');
    const ncx = manifest.get(ncxId) || [...manifest.values()].find(m => /ncx/.test(m.type));
    if (ncx && get(ncx.href)) {
      const nd = parseXml(await get(ncx.href).async('text'));
      const ndir = dirOf(ncx.href);
      const walk = (el, depth) => {
        for (const np of kids(el, 'navPoint')) {
          const lab = kids(np, 'navLabel')[0];
          const content = kids(np, 'content')[0];
          if (content) add(lab ? lab.textContent : '', resolveHref(ndir, content.getAttribute('src') || ''), depth);
          walk(np, depth + 1);
        }
      };
      const map = byTag(nd, 'navMap')[0];
      if (map) walk(map, 0);
    }
  }
  for (const t of toc) if (!chapters[t.ch].title) chapters[t.ch].title = t.title;
  chapters.forEach((c, i) => { if (!c.title) c.title = c.firstHead || (i === 0 ? 'Cover' : ''); });

  let coverItem = [...manifest.values()].find(m => /cover-image/.test(m.props));
  if (!coverItem) {
    const cm = byTag(opf, 'meta').find(m => m.getAttribute('name') === 'cover');
    if (cm) coverItem = manifest.get(cm.getAttribute('content'));
  }
  let coverBlob = null;
  if (coverItem && /^image\//.test(coverItem.type) && get(coverItem.href)) {
    coverBlob = new Blob([await get(coverItem.href).async('arraybuffer')], { type: coverItem.type });
  }
  return makeBook({
    id, title: meta('title'), author: meta('creator'), lang: meta('language') || 'en',
    publisher: meta('publisher'), chapters, toc, pathIndex, coverBlob
  });
}
