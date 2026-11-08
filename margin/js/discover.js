/* Margin — Discover: Project Gutenberg (via the Gutendex API) and any OPDS catalog.
   Downloads try the source directly, then the optional relay, then fall back to a manual link. */
import { esc } from './parse.js';

const GUTENDEX = 'https://gutendex.com/books/';
const ACQ = 'http://opds-spec.org/acquisition';
const TYPES_PREF = ['application/epub+zip', 'application/x-mobipocket-ebook', 'application/pdf', 'application/x-fictionbook+xml', 'application/vnd.comicbook+zip', 'text/plain'];
const EXT = { 'application/epub+zip': 'epub', 'application/x-mobipocket-ebook': 'mobi', 'application/pdf': 'pdf', 'application/x-fictionbook+xml': 'fb2', 'application/vnd.comicbook+zip': 'cbz', 'application/x-cbz': 'cbz', 'application/x-cbr': 'cbr', 'text/plain': 'txt' };

export function createDiscover(ctx) {
  const { store, toast, importFile, host } = ctx;
  let state = { source: 'gutenberg', q: '', topic: '', page: 1, stack: [] };
  let token = 0;
  const relay = () => (store.get('relay', '') || '').trim();
  const catalogs = () => store.get('catalogs', []);

  async function fetchVia(url, as = 'json') {
    // The desktop app downloads through its own process, which isn't subject to browser cross-site rules.
    if (window.marginDesktop) {
      const r = await window.marginDesktop.fetchUrl(url);
      if (r.status === 401) throw Object.assign(new Error('This catalog needs a sign-in, which Margin doesn’t support yet.'), { auth: true });
      if (!r.ok) throw new Error(`The server answered ${r.status}.`);
      const bytes = new Uint8Array(r.data);
      if (as === 'json') return JSON.parse(new TextDecoder().decode(bytes));
      if (as === 'xml') return new TextDecoder().decode(bytes);
      return new Blob([bytes], { type: r.type || '' });
    }
    const tries = [url];
    if (relay()) tries.push(relay().replace(/\/?$/, '/') + '?url=' + encodeURIComponent(url));
    let lastErr;
    for (const u of tries) {
      try {
        const r = await fetch(u, { headers: as === 'xml' ? { Accept: 'application/atom+xml, application/xml, */*' } : {} });
        if (r.status === 401) throw Object.assign(new Error('This catalog needs a sign-in, which Margin doesn’t support yet.'), { auth: true });
        if (!r.ok) throw new Error(`The server answered ${r.status}.`);
        return as === 'json' ? await r.json() : as === 'xml' ? await r.text() : await r.blob();
      } catch (e) { lastErr = e; if (e.auth) throw e; }
    }
    throw lastErr || new Error('Network error');
  }

  function shell(title, sub, inner) {
    host.innerHTML = `<h2 class="sec-title">${title}</h2><p class="sec-sub">${sub}</p>
      <div class="chips" id="disc-src"></div>${inner}`;
    const chips = host.querySelector('#disc-src');
    const srcs = [{ id: 'gutenberg', name: 'Project Gutenberg' }, { id: 'openaccess', name: 'Open-access books (recent)' }, { id: 'textbooks', name: 'Open textbooks' }, { id: 'librivox', name: 'LibriVox audiobooks' }, ...catalogs().map(c => ({ id: c.id, name: c.title || c.url }))];
    chips.innerHTML = srcs.map(s => `<button class="chip" data-s="${esc(s.id)}" aria-pressed="${state.source === s.id}">${esc(s.name)}</button>`).join('') +
      `<button class="chip" data-add>+ Add catalog</button>${window.marginDesktop ? '' : `<button class="chip" data-relay>Download relay${relay() ? ' ✓' : ''}</button>`}`;
    chips.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { state = { source: b.dataset.s, q: '', topic: '', page: 1, stack: [] }; render(); });
    chips.querySelector('[data-add]').onclick = addCatalog;
    const rb = chips.querySelector('[data-relay]'); if (rb) rb.onclick = editRelay;
  }

  async function render() {
    if (state.source === 'gutenberg') return renderGutenberg();
    if (state.source === 'librivox') return renderLibriVox();
    if (state.source === 'openaccess') return renderOpenAccess();
    if (state.source === 'textbooks') return renderTextbooks();
    const c = catalogs().find(x => x.id === state.source);
    if (!c) { state.source = 'gutenberg'; return renderGutenberg(); }
    return renderOpds(c);
  }

  /* ---------- Project Gutenberg ---------- */
  // Subcategories. Gutendex filters on one subject phrase at a time, so a subcategory either merges
  // several phrases ({ topics }) or pages through one phrase and keeps only matching books ({ topic, keep }).
  const tags = b => [...(b.subjects || []), ...(b.bookshelves || [])];
  const NOT_CHRISTIAN_OR_ISLAMIC = /christian|bible|catholic|protestant|church|jesus|islam|koran|qur.?an|muslim|muhammad|mohammed/i; // subjects only, not titles
  const SUBCATS = {
    Religion: {
      all: 'All religion',
      subs: {
        christianity: { label: 'Christianity', topics: ['christian', 'bible', 'catholic', 'protestant'] },
        islam: { label: 'Islam', topics: ['islam', 'koran', 'muhammad'] },
        other: { label: 'Other religions', all: 'All other religions', topic: 'religion', keep: b => !NOT_CHRISTIAN_OR_ISLAMIC.test(tags(b).join(' ')) },
        judaism: { label: 'Judaism', topics: ['judaism', 'talmud', 'midrash'], parent: 'other' },
        buddhism: { label: 'Buddhism', topics: ['buddhis'], parent: 'other' },
        hinduism: { label: 'Hinduism', topics: ['hindu', 'vedas', 'upanishads', 'bhagavad'], parent: 'other' },
        taoism: { label: 'Taoism', topics: ['taoism'], parent: 'other' },
        confucianism: { label: 'Confucianism', topics: ['confuci'], parent: 'other' },
        zoroastrianism: { label: 'Zoroastrianism', topics: ['zoroastrian'], parent: 'other' }
      }
    },
    Science: {
      all: 'All science',
      // "science" also matches science fiction, so keep only books tagged with science itself
      main: { topic: 'science', keep: b => tags(b).some(t => /science(?![\s-]*fiction)/i.test(t)) },
      subs: {
        physics: { label: 'Physics', topics: ['physics', 'mechanics', 'optics'] },
        chemistry: { label: 'Chemistry', topics: ['chemistry'] },
        biology: { label: 'Biology & nature', topics: ['biology', 'zoology', 'botany', 'natural history', 'evolution'] },
        astronomy: { label: 'Astronomy', topics: ['astronomy'] },
        mathematics: { label: 'Mathematics', topics: ['mathematics', 'geometry', 'algebra', 'arithmetic'] },
        earth: { label: 'Earth sciences', topics: ['geology', 'meteorology', 'physical geography'] },
        medicine: { label: 'Medicine & health', topics: ['medicine', 'anatomy', 'physiology', 'hygiene'] }
      }
    },
    Technology: {
      all: 'All technology',
      main: { topics: ['technology', 'engineering', 'inventions', 'machinery'] },
      subs: {
        // Gutenberg shelves most technical books under "Engineering & Technology", so require engineering in the book's own subjects
        engineering: { label: 'Engineering', topics: ['engineering'], match: /engineer/i },
        electricity: { label: 'Electricity & radio', topics: ['electric', 'radio', 'telegraph', 'telephone'] },
        inventions: { label: 'Inventions', topics: ['inventions', 'inventors', 'patents'] },
        transport: { label: 'Transport', topics: ['railroads', 'aeronautics', 'automobiles', 'steam-navigation', 'shipbuilding'] },
        industry: { label: 'Industry & manufacturing', topics: ['manufactures', 'machinery', 'industrial arts', 'textile'] },
        building: { label: 'Building & architecture', topics: ['building', 'architecture', 'carpentry'] },
        agriculture: { label: 'Agriculture', topics: ['agriculture', 'gardening'] },
        computing: { label: 'Computing', topics: ['computer'] }
      }
    }
  };
  const TOPICS = ['Fiction', 'Science Fiction', 'Mystery', 'Adventure', 'Romance', 'Horror', 'Humor', 'Children', 'Poetry', 'Drama', 'Philosophy', 'Religion', 'History', 'Biography', 'Science', 'Technology', 'Travel'];
  async function renderGutenberg() {
    const my = ++token;
    shell('Discover', 'Over 70,000 free public-domain books from Project Gutenberg. Search by title or author, or browse a subject.',
      `<div class="disc-bar"><label class="lib-search"><svg class="i"><use href="#i-search"/></svg><span class="sr">Search Project Gutenberg</span><input id="disc-q" type="search" placeholder="Search title or author" value="${esc(state.q)}"></label>
       <div class="seg sm" id="g-sort" role="group" aria-label="Order"><button data-v="popular" aria-pressed="${state.gsort !== 'recent'}">Most popular</button><button data-v="recent" aria-pressed="${state.gsort === 'recent'}">Recently added</button></div></div>
       <div class="chips" id="disc-topics">${TOPICS.map(t => `<button class="chip" data-t="${t}" aria-pressed="${state.topic === t}">${t}</button>`).join('')}</div>
       ${SUBCATS[state.topic] ? subRows(state.topic) : ''}
       <div id="disc-out"><div class="loading"><span class="spin"></span>Loading books…</div></div>`);
    host.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { state.sub = b.dataset.sub; state.page = 1; state.cursors = null; renderGutenberg(); });
    const q = host.querySelector('#disc-q');
    host.querySelectorAll('#g-sort button').forEach(b => b.onclick = () => { state.gsort = b.dataset.v; state.page = 1; state.cursors = null; renderGutenberg(); });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { state.q = q.value.trim(); state.topic = ''; state.page = 1; renderGutenberg(); } });
    host.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { state.topic = state.topic === b.dataset.t ? '' : b.dataset.t; state.sub = ''; state.cursors = null; state.q = ''; state.page = 1; renderGutenberg(); });
    const cat = SUBCATS[state.topic];
    if (cat && state.sub) return renderSub(my, cat.subs[state.sub], crumb());
    if (cat && cat.main) return renderSub(my, cat.main, state.topic);
    const params = new URLSearchParams({ languages: 'en' });
    if (state.q) params.set('search', state.q);
    if (state.topic) params.set('topic', state.topic.toLowerCase());
    if (state.page > 1) params.set('page', state.page);
    if (state.gsort === 'recent') params.set('sort', 'descending');
    const out = host.querySelector('#disc-out');
    let data;
    try { data = await fetchVia(GUTENDEX + '?' + params, 'json'); }
    catch (e) { if (my === token) out.innerHTML = offlineNotice('Project Gutenberg could not be reached.', e); return; }
    if (my !== token) return;
    if (!data.results || !data.results.length) { out.innerHTML = `<p class="empty-filter">No books found${state.q ? ` for “${esc(state.q)}”` : ''}.</p>`; return; }
    out.innerHTML = `<p class="dlg-note" style="margin-bottom:16px">${data.count.toLocaleString()} ${data.count === 1 ? "book" : "books"}${state.topic ? ` in ${esc(state.topic)}` : ''}${state.q ? ` matching “${esc(state.q)}”` : state.gsort === 'recent' ? ', newest additions first' : ', most downloaded first'}</p><div class="disc-grid"></div>
      <div class="dlg-acts" style="justify-content:center;margin-top:28px">${state.page > 1 ? '<button class="btn" data-prev>Previous</button>' : ''}${data.next ? '<button class="btn" data-next>More books</button>' : ''}</div>`;
    gutenbergCards(out.querySelector('.disc-grid'), data.results);
    pager(out);
  }
  function gutenbergCards(grid, results) {
    for (const b of results) {
      const author = (b.authors || []).map(a => a.name.split(', ').reverse().join(' ')).join(', ');
      const f = b.formats || {};
      const epub = f['application/epub+zip'];
      const txt = Object.keys(f).find(k => k.startsWith('text/plain') && !f[k].endsWith('.zip'));
      const cover = f['image/jpeg'];
      grid.appendChild(card({
        title: b.title, author, cover, meta: b.download_count ? `${b.download_count.toLocaleString()} downloads` : 'New on Gutenberg',
        url: epub || (txt && f[txt]), ext: epub ? 'epub' : 'txt',
        page: `https://www.gutenberg.org/ebooks/${b.id}`
      }));
    }
  }
  function pager(out) {
    const nx = out.querySelector('[data-next]'), pv = out.querySelector('[data-prev]');
    if (nx) nx.onclick = () => { state.page++; renderGutenberg(); host.scrollIntoView({ block: 'start' }); };
    if (pv) pv.onclick = () => { state.page--; renderGutenberg(); };
  }
  function subRows(topic) {
    const cat = SUBCATS[topic], sub = state.sub || '', node = cat.subs[sub];
    const parent = node ? (node.parent || (Object.values(cat.subs).some(n => n.parent === sub) ? sub : '')) : '';
    const chip = (id, label) => `<button class="chip" data-sub="${id}" aria-pressed="${sub === id}">${esc(label)}</button>`;
    const top = Object.entries(cat.subs).filter(([, n]) => !n.parent);
    let html = `<div class="chips sub" role="group" aria-label="${esc(topic)} subcategories"><span class="sub-l">${esc(topic)}</span>${chip('', cat.all)}${top.map(([id, n]) => chip(id, n.label)).join('')}</div>`;
    if (parent) {
      const p = cat.subs[parent];
      html += `<div class="chips sub sub2" role="group" aria-label="${esc(p.label)}"><span class="sub-l">${esc(p.label)}</span>${chip(parent, p.all || 'All')}${Object.entries(cat.subs).filter(([, n]) => n.parent === parent).map(([id, n]) => chip(id, n.label)).join('')}</div>`;
    }
    return html;
  }
  const crumb = () => { const cat = SUBCATS[state.topic], n = cat.subs[state.sub]; return n.parent ? `${state.topic} › ${cat.subs[n.parent].label} › ${n.label}` : `${state.topic} › ${n.label}`; };
  async function renderSub(my, r, label) {
    const out = host.querySelector('#disc-out');
    let results = [], more = false;
    try {
      if (r.topics) {
        // one request per subject phrase, merged and ordered by popularity
        const pages = await Promise.allSettled(r.topics.map(t => fetchVia(GUTENDEX + '?' + new URLSearchParams({ languages: 'en', topic: t, ...(state.page > 1 ? { page: state.page } : {}), ...(state.gsort === 'recent' ? { sort: 'descending' } : {}) }), 'json')));
        const ok = pages.filter(x => x.status === 'fulfilled').map(x => x.value);
        if (!ok.length) throw pages[0].reason;
        const seen = new Set();
        results = ok.flatMap(d => d.results || []).filter(b => !seen.has(b.id) && seen.add(b.id)).filter(b => !r.match || r.match.test((b.subjects || []).join(' '))).sort((a, b) => state.gsort === 'recent' ? b.id - a.id : (b.download_count || 0) - (a.download_count || 0));
        more = ok.some(d => d.next);
      } else {
        // one phrase, filtered (e.g. "All other religions", or Science without science fiction), gathered across pages
        state.cursors = state.cursors || [1];
        let pg = state.cursors[state.page - 1] || 1;
        for (let n = 0; n < 4 && results.length < 24 && pg; n++) {
          const d = await fetchVia(GUTENDEX + '?' + new URLSearchParams({ languages: 'en', topic: r.topic, page: pg, ...(state.gsort === 'recent' ? { sort: 'descending' } : {}) }), 'json');
          results.push(...(d.results || []).filter(r.keep));
          pg = d.next ? pg + 1 : 0;
        }
        state.cursors[state.page] = pg; more = !!pg;
      }
    } catch (e) { if (my === token) out.innerHTML = offlineNotice('Project Gutenberg could not be reached.', e); return; }
    if (my !== token) return;
    if (!results.length) { out.innerHTML = `<p class="empty-filter">No books found in ${esc(label)}.</p>`; return; }
    out.innerHTML = `<p class="dlg-note" style="margin-bottom:16px">${esc(label)}, ${state.gsort === 'recent' ? 'newest additions first' : 'most downloaded first'}</p><div class="disc-grid"></div>
      <div class="dlg-acts" style="justify-content:center;margin-top:28px">${state.page > 1 ? '<button class="btn" data-prev>Previous</button>' : ''}${more ? '<button class="btn" data-next>More books</button>' : ''}</div>`;
    gutenbergCards(out.querySelector('.disc-grid'), results);
    pager(out);
  }

  function card({ title, author, cover, meta, url, ext, page, links, audio, square }) {
    const el = document.createElement('div'); el.className = 'disc-card';
    const k = (hashStr(title) % 8) + 1;
    const badge = audio ? '<span class="aud-badge" aria-label="Audiobook"><svg class="i"><use href="#i-headphones"/></svg></span>' : '';
    el.innerHTML = `<div class="book">${cover && (audio || square) ? `<div class="face aud-face"><img class="ab" src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"><img class="as" src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">${badge}</div>` : cover ? `<div class="face"><img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>` :
      `<div class="face" style="--cv:var(--cv-${k})"><div class="gen s-rule"><span class="gt">${esc(title)}</span><span class="rule"></span><span class="ga">${esc(author)}</span></div></div>`}<div class="pages"></div></div>
      <span><span class="card-t">${esc(title)}</span><span class="card-a">${esc(author || 'Unknown author')}</span></span>
      <span class="meta">${esc(meta || '')}</span>
      <button class="btn dl" type="button"><svg class="i"><use href="#i-down"/></svg>${audio ? 'Get audiobook' : 'Get book'}</button>`;
    if ((audio || square) && cover) el.querySelectorAll('img').forEach(im => { im.onerror = () => { const f = im.closest('.face'); f.className = 'face'; f.style.setProperty('--cv', `var(--cv-${k})`); f.innerHTML = `<div class="gen s-rule"><span class="gt">${esc(title)}</span><span class="rule"></span><span class="ga">${esc(author)}</span></div>${badge}`; }; });
    const img = !audio && !square && el.querySelector('img'); if (img) img.onerror = () => { img.parentElement.style.setProperty('--cv', `var(--cv-${k})`); img.replaceWith(Object.assign(document.createElement('div'), { className: 'gen s-rule', innerHTML: `<span class="gt">${esc(title)}</span><span class="rule"></span><span class="ga">${esc(author)}</span>` })); };
    const btn = el.querySelector('.dl');
    if (!url) { btn.disabled = true; btn.textContent = 'No supported format'; }
    btn.onclick = () => getBook({ title, url, ext, page, btn, links, audio });
    return el;
  }

  async function getBook({ title, url, ext, page, btn, audio }) {
    const label = btn.innerHTML; btn.disabled = true; btn.textContent = audio ? 'Downloading… (audiobooks are large)' : 'Downloading…';
    try {
      const blob = await fetchVia(url, 'blob');
      if (ext === 'pdf' || ext === 'epub') {
        const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
        const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46, isZip = head[0] === 0x50 && head[1] === 0x4b;
        if (!isPdf && !isZip) throw new Error('not-a-book');
      }
      const name = `${title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80)}.${ext}`;
      const e = await importFile(new File([blob], name, { type: blob.type }), false);
      if (e) { btn.innerHTML = `<svg class="i"><use href="#i-next"/></svg>${audio ? 'Listen now' : 'Read now'}`; btn.disabled = false; btn.onclick = () => ctx.openEntry(e); }
      else { btn.innerHTML = label; btn.disabled = false; }
    } catch (err) {
      btn.innerHTML = label; btn.disabled = false;
      manualDownload(title, url, page, err && err.message === 'not-a-book');
    }
  }
  function manualDownload(title, url, page, viaPublisher) {
    const m = document.createElement('dialog');
    // Open-access books live on many publishers' sites; a relay can't cover them all, so only suggest it for the catalogues it supports.
    const publisherBook = viaPublisher || ['openaccess'].includes(state.source);
    const tip = window.marginDesktop || publisherBook ? '' : `<p class="dlg-p">To download straight into Margin next time, set up the free download relay (see the README) and paste its address under <i>Download relay</i>.</p>`;
    m.innerHTML = `<div class="dlg" style="max-width:520px"><div class="dlg-head"><h2>${publisherBook ? 'Get it from the publisher' : 'Download it yourself'}</h2><button class="icon-btn" data-close aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></div>
      <p class="dlg-p">${publisherBook ? `<b>${esc(title)}</b> is free, but its publisher only hands out the file on its own website.` : `The site that hosts <b>${esc(title)}</b> doesn’t let apps download files directly.`} Download it in your browser, then drop the file onto Margin or use <i>Add book</i>.</p>
      ${tip}
      <div class="dlg-acts">${page ? `<a class="btn" href="${esc(page)}" target="_blank" rel="noopener">${publisherBook ? 'Publisher page' : 'Book page'}</a>` : ''}<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">Download file</a></div></div>`;
    document.body.appendChild(m); m.showModal();
    m.querySelector('[data-close]').onclick = () => m.close();
    m.addEventListener('close', () => m.remove());
  }
  function offlineNotice(what, e) {
    const off = !navigator.onLine;
    return `<div class="notice"><b>${esc(what)}</b>${off ? 'You’re offline. Discover needs a connection; your library still works offline.' : esc(e && e.message && !/failed to fetch|networkerror|load failed/i.test(e.message) ? e.message : 'The connection failed or was blocked. Please try again in a moment.')}${!off && !relay() ? '<br>If this keeps happening, the site may block apps from loading it directly. A download relay (see the README) fixes that.' : ''}</div>`;
  }

  /* ---------- Open-access books (recent; via OpenAlex, which indexes OAPEN, DOAB and publishers) ---------- */
  const OPENALEX = 'https://api.openalex.org/works';
  const OA_FIELDS = [['History & humanities', '12'], ['Social sciences', '33'], ['Economics & finance', '20'], ['Business & management', '14'],
    ['Psychology', '32'], ['Medicine & health', '27|36|29'], ['Computer science', '17'], ['Engineering', '22|15|25'], ['Environment & climate', '23|19|21'],
    ['Physics & astronomy', '31'], ['Life sciences', '11|13|24|28'], ['Mathematics', '26'], ['Chemistry', '16']];
  const LICENSES = { 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA', 'cc-by-nc': 'CC BY-NC', 'cc-by-nd': 'CC BY-ND', 'cc-by-nc-sa': 'CC BY-NC-SA', 'cc-by-nc-nd': 'CC BY-NC-ND', 'cc0': 'CC0', 'public-domain': 'Public domain' };
  const names = list => { const seen = new Set(); const n = list.filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())); return n.length > 3 ? n.slice(0, 3).join(', ') + ' et al.' : n.join(', '); };
  async function renderOpenAccess() {
    const my = ++token;
    const year = new Date().getFullYear();
    state.oaSort = state.oaSort || 'popular'; state.oaYears = state.oaYears || 'recent';
    shell('Discover', 'Recent nonfiction and academic books that publishers and universities release free under open licences: history, science, economics, medicine, technology and more. Indexed by OpenAlex, which includes the OAPEN and DOAB open-access libraries.',
      `<div class="disc-bar"><label class="lib-search"><svg class="i"><use href="#i-search"/></svg><span class="sr">Search open-access books</span><input id="disc-q" type="search" placeholder="Search titles and topics" value="${esc(state.q)}"></label>
       <div class="seg sm" id="oa-sort" role="group" aria-label="Order"><button data-v="popular" aria-pressed="${state.oaSort === 'popular'}">Most read</button><button data-v="newest" aria-pressed="${state.oaSort === 'newest'}">Newest</button></div>
       <div class="seg sm" id="oa-years" role="group" aria-label="Published"><button data-v="recent" aria-pressed="${state.oaYears === 'recent'}">${year - 2}–${year}</button><button data-v="decade" aria-pressed="${state.oaYears === 'decade'}">Since ${year - 10}</button></div></div>
       <div class="chips" id="disc-topics">${OA_FIELDS.map(([label]) => `<button class="chip" data-t="${esc(label)}" aria-pressed="${state.topic === label}">${esc(label)}</button>`).join('')}</div>
       <div id="disc-out"><div class="loading"><span class="spin"></span>Loading open-access books…</div></div>`);
    const q = host.querySelector('#disc-q');
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { state.q = q.value.trim(); state.page = 1; renderOpenAccess(); } });
    host.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { state.topic = state.topic === b.dataset.t ? '' : b.dataset.t; state.page = 1; renderOpenAccess(); });
    host.querySelectorAll('#oa-sort button').forEach(b => b.onclick = () => { state.oaSort = b.dataset.v; state.page = 1; renderOpenAccess(); });
    host.querySelectorAll('#oa-years button').forEach(b => b.onclick = () => { state.oaYears = b.dataset.v; state.page = 1; renderOpenAccess(); });
    const filters = ['type:book', 'is_oa:true', 'language:en', `publication_year:${state.oaYears === 'recent' ? year - 2 : year - 10}-${year}`];
    const field = OA_FIELDS.find(f => f[0] === state.topic);
    if (field) filters.push(`primary_topic.field.id:${field[1]}`);
    const params = new URLSearchParams({ filter: filters.join(','), per_page: '50', page: String(state.page), sort: state.oaSort === 'newest' ? 'publication_date:desc' : 'cited_by_count:desc',
      select: 'id,display_name,publication_year,authorships,best_oa_location,primary_location,doi' });
    if (state.q) params.set('search', state.q);
    const out = host.querySelector('#disc-out');
    let data;
    try { data = await fetchVia(OPENALEX + '?' + params, 'json'); }
    catch (e) { if (my === token) out.innerHTML = offlineNotice('The open-access index could not be reached.', e); return; }
    if (my !== token) return;
    // Only books with a direct download; the rest can only be read on the publisher's site.
    const books = (data.results || []).filter(w => w.best_oa_location && w.best_oa_location.pdf_url && w.display_name).slice(0, 30);
    const total = (data.meta && data.meta.count) || 0;
    if (!books.length) { out.innerHTML = `<p class="empty-filter">No downloadable open-access books found${state.q ? ` for “${esc(state.q)}”` : ''}${field ? ` in ${esc(field[0])}` : ''}. Try another subject or a wider date range.</p>`; return; }
    out.innerHTML = `<p class="dlg-note" style="margin-bottom:16px">${total.toLocaleString()} open-access books${field ? ` in ${esc(field[0])}` : ''}${state.q ? ` matching “${esc(state.q)}”` : ''}, ${state.oaSort === 'newest' ? 'newest first' : 'most read first'}. Showing the ones with a free download.</p><div class="disc-grid"></div>
      <div class="dlg-acts" style="justify-content:center;margin-top:28px">${state.page > 1 ? '<button class="btn" data-prev>Previous</button>' : ''}${state.page * 50 < total ? '<button class="btn" data-next>More books</button>' : ''}</div>`;
    const grid = out.querySelector('.disc-grid');
    for (const w of books) {
      const loc = w.best_oa_location, src = (loc.source || (w.primary_location && w.primary_location.source) || {});
      const publisher = String(src.display_name || src.host_organization_name || '').replace(/\s+eBooks?$/i, '');
      grid.appendChild(card({
        title: w.display_name.trim(), author: names((w.authorships || []).map(a => a.author && a.author.display_name)),
        meta: [w.publication_year, publisher, LICENSES[loc.license] || ''].filter(Boolean).join(' · '),
        url: loc.pdf_url, ext: 'pdf', page: loc.landing_page_url || w.doi || ''
      }));
    }
    const nx = out.querySelector('[data-next]'), pv = out.querySelector('[data-prev]');
    if (nx) nx.onclick = () => { state.page++; renderOpenAccess(); host.scrollIntoView({ block: 'start' }); };
    if (pv) pv.onclick = () => { state.page--; renderOpenAccess(); };
  }

  /* ---------- Open textbooks (OpenStax) ---------- */
  const OPENSTAX = 'https://openstax.org/apps/cms/api/v2/pages/?type=books.Book&fields=*&limit=250';
  let osBooks = null;
  const osLicense = b => {
    const n = String(b.license_name || ''), v = b.license_version ? ' ' + b.license_version : '';
    if (!/creative commons/i.test(n)) return n;
    const parts = ['BY', /noncommercial/i.test(n) && 'NC', /sharealike/i.test(n) && 'SA', /noderiv/i.test(n) && 'ND'].filter(Boolean);
    return 'CC ' + parts.join('-') + v;
  };
  async function renderTextbooks() {
    const my = ++token;
    state.tsort = state.tsort || 'newest';
    shell('Discover', 'Current, peer-reviewed college and university textbooks from OpenStax at Rice University, free to download and kept up to date.',
      `<div class="disc-bar"><label class="lib-search"><svg class="i"><use href="#i-search"/></svg><span class="sr">Search textbooks</span><input id="disc-q" type="search" placeholder="Search textbooks" value="${esc(state.q)}"></label>
       <div class="seg sm" id="t-sort" role="group" aria-label="Order"><button data-v="newest" aria-pressed="${state.tsort === 'newest'}">Newest</button><button data-v="az" aria-pressed="${state.tsort === 'az'}">A–Z</button></div></div>
       <div class="chips" id="disc-topics"></div>
       <div id="disc-out"><div class="loading"><span class="spin"></span>Loading textbooks…</div></div>`);
    const out = host.querySelector('#disc-out');
    try { if (!osBooks) osBooks = ((await fetchVia(OPENSTAX, 'json')).items || []).filter(b => ['live', 'new_edition_available'].includes(b.book_state) && (b.high_resolution_pdf_url || b.pdf_url)); }
    catch (e) { if (my === token) out.innerHTML = offlineNotice('OpenStax could not be reached.', e); return; }
    if (my !== token) return;
    const subjectsOf = b => (b.book_subjects || []).map(s => s.subject_name).filter(Boolean);
    const subjects = [...new Set(osBooks.flatMap(subjectsOf))].sort();
    const chips = host.querySelector('#disc-topics');
    chips.innerHTML = subjects.map(sname => `<button class="chip" data-t="${esc(sname)}" aria-pressed="${state.topic === sname}">${esc(sname)}</button>`).join('');
    chips.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { state.topic = state.topic === b.dataset.t ? '' : b.dataset.t; renderTextbooks(); });
    const q = host.querySelector('#disc-q');
    q.addEventListener('input', () => { state.q = q.value.trim(); draw(); });
    host.querySelectorAll('#t-sort button').forEach(b => b.onclick = () => { state.tsort = b.dataset.v; renderTextbooks(); });
    function draw() {
      const s = state.q.toLowerCase();
      const list = osBooks.filter(b => (!state.topic || subjectsOf(b).includes(state.topic)) && (!s || b.title.toLowerCase().includes(s)))
        .sort((a, b) => state.tsort === 'az' ? a.title.localeCompare(b.title) : String(b.publish_date || '').localeCompare(String(a.publish_date || '')));
      if (!list.length) { out.innerHTML = `<p class="empty-filter">No textbooks found${state.q ? ` for “${esc(state.q)}”` : ''}.</p>`; return; }
      out.innerHTML = `<p class="dlg-note" style="margin-bottom:16px">${list.length} ${list.length === 1 ? 'textbook' : 'textbooks'}${state.topic ? ` in ${esc(state.topic)}` : ''}, ${state.tsort === 'az' ? 'A–Z' : 'newest first'}</p><div class="disc-grid"></div>`;
      const grid = out.querySelector('.disc-grid');
      for (const b of list) {
        const authors = (b.authors || []).map(a => a.value && a.value.name).filter(Boolean);
        const lang = b.meta && b.meta.locale && b.meta.locale !== 'en' ? ({ es: 'Español', pl: 'Polski' }[b.meta.locale] || b.meta.locale) : '';
        grid.appendChild(card({
          title: b.title, author: names(authors) || 'OpenStax', cover: b.cover_url || null, square: true,
          meta: [b.publish_date ? String(b.publish_date).slice(0, 4) : '', osLicense(b), lang].filter(Boolean).join(' · '),
          url: b.high_resolution_pdf_url || b.pdf_url, ext: 'pdf', page: (b.meta && b.meta.html_url) || ''
        }));
      }
    }
    draw();
  }

  /* ---------- LibriVox (free public-domain audiobooks) ---------- */
  const LV = 'https://librivox.org/api/feed/audiobooks/';
  const LV_STARTERS = [['Jane Austen', 'author', 'Austen'], ['Charles Dickens', 'author', 'Dickens'], ['Mark Twain', 'author', 'Twain'], ['Arthur Conan Doyle', 'author', 'Doyle'],
    ['Shakespeare', 'author', 'Shakespeare'], ['Poetry', 'title', 'poems'], ['Fairy tales', 'title', 'fairy'], ['The Bible', 'title', 'bible'], ['Philosophy', 'title', 'philosophy']];
  const lvAuthor = a => (a.authors || []).map(x => [x.first_name, x.last_name].filter(Boolean).join(' ')).join(', ');
  const lvTime = t => { const [h = 0, m = 0, sec = 0] = String(t || '').split(':').map(Number); if (!(h || m || sec)) return ''; return h ? `${h} h ${m} min` : m ? `${m} min` : 'under 1 min'; };
  async function lvFetch(params) {
    try { const d = await fetchVia(LV + '?' + new URLSearchParams({ format: 'json', extended: '1', limit: '24', ...params }), 'json'); return d.books || []; }
    catch (e) { if (/404/.test(e.message)) return []; throw e; }
  }
  async function renderLibriVox() {
    const my = ++token;
    shell('Discover', 'Free public-domain audiobooks read by LibriVox volunteers. Downloads arrive as an audiobook with chapters, ready to play offline.',
      `<div class="disc-bar"><label class="lib-search"><svg class="i"><use href="#i-search"/></svg><span class="sr">Search LibriVox</span><input id="disc-q" type="search" placeholder="Search title or author" value="${esc(state.q)}"></label></div>
       <div class="chips" id="disc-topics">${LV_STARTERS.map(([label]) => `<button class="chip" data-t="${esc(label)}" aria-pressed="${state.topic === label}">${esc(label)}</button>`).join('')}</div>
       <div id="disc-out"><div class="loading"><span class="spin"></span>Loading audiobooks…</div></div>`);
    const q = host.querySelector('#disc-q');
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { state.q = q.value.trim(); state.topic = ''; state.page = 1; renderLibriVox(); } });
    host.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { state.topic = state.topic === b.dataset.t ? '' : b.dataset.t; state.q = ''; state.page = 1; renderLibriVox(); });
    const out = host.querySelector('#disc-out');
    const offset = String((state.page - 1) * 24);
    let books, label;
    try {
      if (state.q) {
        const [byTitle, byAuthor] = await Promise.all([lvFetch({ title: state.q, offset }), lvFetch({ author: state.q.split(/\s+/).pop(), offset })]);
        const seen = new Set(); books = [...byTitle, ...byAuthor].filter(b => !seen.has(b.id) && seen.add(b.id));
        label = `matching “${esc(state.q)}”`;
      } else if (state.topic) {
        const [, kind, value] = LV_STARTERS.find(x => x[0] === state.topic);
        books = await lvFetch({ [kind]: value, offset }); label = `for ${esc(state.topic)}`;
      } else {
        books = await lvFetch({ since: String(Math.floor(Date.now() / 1000) - 120 * 86400), offset }); label = 'released recently';
      }
    } catch (e) { if (my === token) out.innerHTML = offlineNotice('LibriVox could not be reached.', e); return; }
    if (my !== token) return;
    books = books.filter(b => b.url_zip_file);
    if (!books.length) { out.innerHTML = `<p class="empty-filter">No audiobooks found ${label}.</p>`; return; }
    out.innerHTML = `<p class="dlg-note" style="margin-bottom:16px">${books.length}${books.length === 24 ? '+' : ''} audiobooks ${label}</p><div class="disc-grid"></div>
      <div class="dlg-acts" style="justify-content:center;margin-top:28px">${state.page > 1 ? '<button class="btn" data-prev>Previous</button>' : ''}${books.length >= 24 ? '<button class="btn" data-next>More audiobooks</button>' : ''}</div>`;
    const grid = out.querySelector('.disc-grid');
    for (const b of books) {
      const ia = String(b.url_iarchive || '').match(/archive\.org\/details\/([^/?#]+)/);
      const lang = b.language && b.language !== 'English' ? ` · ${b.language}` : '';
      grid.appendChild(card({
        title: b.title.trim(), author: lvAuthor(b), audio: true,
        cover: ia ? `https://archive.org/services/img/${ia[1]}` : null,
        meta: [lvTime(b.totaltime), b.num_sections ? `${b.num_sections} sections` : '', lang.replace(' · ', '')].filter(Boolean).join(' · '),
        url: String(b.url_zip_file).replace(/^http:/, 'https:'), ext: 'zip', page: b.url_librivox
      }));
    }
    const nx = out.querySelector('[data-next]'), pv = out.querySelector('[data-prev]');
    if (nx) nx.onclick = () => { state.page++; renderLibriVox(); host.scrollIntoView({ block: 'start' }); };
    if (pv) pv.onclick = () => { state.page--; renderLibriVox(); };
  }

  /* ---------- OPDS ---------- */
  async function renderOpds(cat) {
    const my = ++token;
    const url = state.stack.length ? state.stack[state.stack.length - 1].url : cat.url;
    shell(esc(cat.title || 'Catalog'), `An OPDS catalog at ${esc(new URL(cat.url).host)}. <button class="mini" data-rm>Remove catalog</button>`,
      `<div class="disc-bar" id="opds-search" hidden><label class="lib-search"><svg class="i"><use href="#i-search"/></svg><span class="sr">Search this catalog</span><input id="opds-q" type="search" placeholder="Search this catalog"></label></div>
       <div class="crumbs" id="crumbs"></div><div id="disc-out"><div class="loading"><span class="spin"></span>Loading catalog…</div></div>`);
    host.querySelector('[data-rm]').onclick = () => { store.set('catalogs', catalogs().filter(c => c.id !== cat.id)); state.source = 'gutenberg'; render(); };
    const crumbs = host.querySelector('#crumbs');
    crumbs.innerHTML = [`<button data-i="-1">${esc(cat.title || 'Home')}</button>`, ...state.stack.map((s, i) => `<span>›</span><button data-i="${i}">${esc(s.title)}</button>`)].join('');
    crumbs.querySelectorAll('button').forEach(b => b.onclick = () => { state.stack = state.stack.slice(0, +b.dataset.i + 1); render(); });
    const out = host.querySelector('#disc-out');
    let xml;
    try { xml = await fetchVia(url, 'xml'); } catch (e) { if (my === token) out.innerHTML = offlineNotice('This catalog could not be loaded.', e); return; }
    if (my !== token) return;
    const feed = parseOpds(xml, url);
    if (!feed) { out.innerHTML = `<div class="notice"><b>This address isn’t an OPDS catalog.</b>Check the URL; OPDS feeds usually end in <code>/opds</code>.</div>`; return; }
    if (!cat.title && feed.title) { const l = catalogs(); const c = l.find(x => x.id === cat.id); if (c) { c.title = feed.title; store.set('catalogs', l); } }
    if (feed.search) {
      const box = host.querySelector('#opds-search'); box.hidden = false;
      const inp = host.querySelector('#opds-q');
      inp.onkeydown = async e => {
        if (e.key !== 'Enter' || !inp.value.trim()) return;
        let tpl = feed.search.template;
        if (!tpl && feed.search.osd) {
          try { const d = new DOMParser().parseFromString(await fetchVia(feed.search.osd, 'xml'), 'application/xml'); const u = [...d.getElementsByTagName('Url')].find(u => /atom|opds/.test(u.getAttribute('type') || '')) || d.getElementsByTagName('Url')[0]; tpl = u && new URL(u.getAttribute('template'), feed.search.osd).href; } catch {}
        }
        if (!tpl) { toast('This catalog’s search isn’t supported.'); return; }
        const su = tpl.replace(/\{searchTerms\??\}/g, encodeURIComponent(inp.value.trim())).replace(/\{[^}]+\?\}/g, '');
        state.stack.push({ title: `“${inp.value.trim()}”`, url: su }); render();
      };
    }
    out.innerHTML = '';
    if (feed.nav.length) {
      const list = document.createElement('div'); list.className = 'folder-list';
      for (const n of feed.nav) {
        const b = document.createElement('button'); b.className = 'folder'; b.type = 'button';
        b.innerHTML = `<b>${esc(n.title)}</b>${n.summary ? `<span>${esc(n.summary)}</span>` : ''}`;
        b.onclick = () => { state.stack.push({ title: n.title, url: n.href }); render(); };
        list.appendChild(b);
      }
      out.appendChild(list);
    }
    if (feed.books.length) {
      const grid = document.createElement('div'); grid.className = 'disc-grid';
      for (const bk of feed.books) {
        const best = TYPES_PREF.map(t => bk.acq.find(a => a.type.startsWith(t))).find(Boolean) || bk.acq[0];
        grid.appendChild(card({ title: bk.title, author: bk.author, cover: bk.cover, meta: best ? (EXT[best.type.split(';')[0]] || '').toUpperCase() : '', url: best && best.href, ext: best ? (EXT[best.type.split(';')[0]] || 'epub') : 'epub', page: bk.page }));
      }
      out.appendChild(grid);
    }
    if (feed.next) {
      const more = document.createElement('div'); more.className = 'dlg-acts'; more.style.cssText = 'justify-content:center;margin-top:28px';
      more.innerHTML = '<button class="btn">More</button>';
      more.querySelector('button').onclick = () => { state.stack.push({ title: 'More', url: feed.next }); render(); };
      out.appendChild(more);
    }
    if (!feed.nav.length && !feed.books.length) out.innerHTML = '<p class="empty-filter">This section is empty.</p>';
  }
  function parseOpds(xml, base) {
    const d = new DOMParser().parseFromString(xml, 'application/xml');
    if (d.getElementsByTagName('parsererror').length || d.documentElement.localName !== 'feed') return null;
    const abs = h => { try { return new URL(h, base).href; } catch { return h; } };
    const kids = (el, n) => [...el.children].filter(c => c.localName === n);
    const txt = (el, n) => (kids(el, n)[0]?.textContent || '').trim();
    const feed = { title: txt(d.documentElement, 'title'), nav: [], books: [], next: null, search: null };
    for (const l of kids(d.documentElement, 'link')) {
      const rel = l.getAttribute('rel') || '', type = l.getAttribute('type') || '';
      if (rel === 'next') feed.next = abs(l.getAttribute('href'));
      if (rel === 'search') feed.search = /opensearchdescription/.test(type) ? { osd: abs(l.getAttribute('href')) } : { template: abs(l.getAttribute('href')).replace(/%7B/g, '{').replace(/%7D/g, '}') };
    }
    for (const e of kids(d.documentElement, 'entry')) {
      const links = kids(e, 'link').map(l => ({ rel: l.getAttribute('rel') || '', type: l.getAttribute('type') || '', href: abs(l.getAttribute('href') || '') }));
      const acq = links.filter(l => l.rel.startsWith(ACQ) && !/indirect|borrow|buy|subscribe|sample/.test(l.rel));
      const title = txt(e, 'title');
      if (acq.length) {
        const author = kids(e, 'author').map(a => txt(a, 'name')).filter(Boolean).join(', ');
        const cover = (links.find(l => /thumbnail/.test(l.rel)) || links.find(l => /opds-spec.org\/image/.test(l.rel)) || {}).href;
        const page = (links.find(l => l.rel === 'alternate' && /html/.test(l.type)) || {}).href;
        feed.books.push({ title, author, cover, acq, page });
      } else {
        const nav = links.find(l => /atom|opds/.test(l.type) && !/acquisition$/.test(l.rel)) || links.find(l => l.href);
        if (nav) feed.nav.push({ title, href: nav.href, summary: txt(e, 'content') || txt(e, 'summary') });
      }
    }
    return feed;
  }

  function addCatalog() {
    const m = document.createElement('dialog');
    m.innerHTML = `<form class="dlg" method="dialog" style="max-width:520px"><div class="dlg-head"><h2>Add a catalog</h2><button class="icon-btn" value="cancel" aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></div>
      <p class="dlg-p">Paste the address of an OPDS catalog. Examples: your Calibre library (<code>http://your-computer:8080/opds</code>), a Kavita or Komga server, or a public library feed.</p>
      <label class="fld"><span>Catalog address</span><input name="url" type="url" required placeholder="https://example.org/opds"></label>
      <div class="dlg-acts"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Add</button></div></form>`;
    document.body.appendChild(m); m.showModal();
    m.addEventListener('close', () => {
      const v = m.querySelector('input').value.trim();
      if (m.returnValue === 'ok' && v) {
        const l = catalogs(); const id = 'c' + Date.now().toString(36);
        l.push({ id, url: v, title: '' }); store.set('catalogs', l);
        state = { source: id, q: '', topic: '', page: 1, stack: [] }; render();
      }
      m.remove();
    });
  }
  function editRelay() {
    const m = document.createElement('dialog');
    m.innerHTML = `<form class="dlg" method="dialog" style="max-width:560px"><div class="dlg-head"><h2>Download relay</h2><button class="icon-btn" value="cancel" aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></div>
      <p class="dlg-p">Some sites don’t let web apps download files. A relay is a tiny free service you run (the README has a one-file Cloudflare Worker) that fetches the book for Margin. Leave this empty to download books yourself.</p>
      <label class="fld"><span>Relay address</span><input name="r" type="url" placeholder="https://margin-relay.yourname.workers.dev" value="${esc(relay())}"></label>
      <div class="dlg-acts"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Save</button></div></form>`;
    document.body.appendChild(m); m.showModal();
    m.addEventListener('close', () => { if (m.returnValue === 'ok') { store.set('relay', m.querySelector('input').value.trim()); render(); } m.remove(); });
  }
  return { render };
}
function hashStr(s) { let h = 7; for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
