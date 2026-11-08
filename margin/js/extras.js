/* Margin — library extras: shelves & tags, book details, goals & reminders, insights & year in review,
   highlights across all books with exports, vocabulary flashcards, quote cards, backup. */
import { esc } from './parse.js';
import { vocab } from './dict.js';
import { makeBackup, restoreBackup, download } from './backup.js';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 9);

export function initExtras(ctx) {
  const { store, toast } = ctx;
  const meta = id => store.get('meta:' + id, {});
  const setMeta = (id, patch) => store.set('meta:' + id, Object.assign(meta(id), patch));
  const shelves = () => store.get('shelves', []);
  const baseId = id => id.replace(/:text$/, '');

  /* =============== shelves =============== */
  function shelfOf(e) {
    const fin = ctx.stats.finished[e.id], pos = ctx.posOf(e.id);
    return { reading: !!pos && !fin, toread: !pos && !fin, finished: !!fin };
  }
  function filterByShelf(list) {
    const s = ctx.settings.shelf || 'all';
    if (s === 'all') return list;
    if (s === 'reading' || s === 'toread' || s === 'finished') return list.filter(e => shelfOf(e)[s]);
    return list.filter(e => (meta(e.id).shelves || []).includes(s));
  }
  function renderChips(entries) {
    const host = $('#shelf-chips');
    const cur = ctx.settings.shelf || 'all';
    const counts = { all: entries.length, reading: 0, toread: 0, finished: 0 };
    entries.forEach(e => { const s = shelfOf(e); for (const k of ['reading', 'toread', 'finished']) if (s[k]) counts[k]++; });
    const base = [['all', 'All'], ['reading', 'Reading'], ['toread', 'To read'], ['finished', 'Finished']];
    const custom = shelves().map(s => [s.id, s.name, entries.filter(e => (meta(e.id).shelves || []).includes(s.id)).length]);
    host.innerHTML = base.map(([id, name]) => `<button class="chip" data-shelf="${id}" aria-pressed="${cur === id}">${name}<span class="n">${counts[id]}</span></button>`).join('') +
      custom.map(([id, name, n]) => `<button class="chip" data-shelf="${esc(id)}" aria-pressed="${cur === id}">${esc(name)}<span class="n">${n}</span></button>`).join('') +
      `<button class="chip" data-new>+ New shelf</button>`;
    host.querySelectorAll('[data-shelf]').forEach(b => {
      b.onclick = () => { ctx.settings.shelf = b.dataset.shelf; ctx.saveSettings(); ctx.renderGrid(); };
      if (!['all', 'reading', 'toread', 'finished'].includes(b.dataset.shelf)) b.oncontextmenu = ev => { ev.preventDefault(); shelfMenu(b.dataset.shelf, b); };
    });
    host.querySelector('[data-new]').onclick = () => promptText('New shelf', 'Shelf name', '', name => {
      const l = shelves(); const id = 's' + uid(); l.push({ id, name }); store.set('shelves', l);
      ctx.settings.shelf = id; ctx.saveSettings(); ctx.renderGrid(); toast(`Shelf “${name}” created. Add books from their ⋯ menu.`, 3200);
    });
  }
  function shelfMenu(id, anchor) {
    const s = shelves().find(x => x.id === id); if (!s) return;
    menu(anchor, [
      ['Rename shelf', () => promptText('Rename shelf', 'Shelf name', s.name, name => { const l = shelves(); l.find(x => x.id === id).name = name; store.set('shelves', l); ctx.renderGrid(); })],
      ['Delete shelf', () => { store.set('shelves', shelves().filter(x => x.id !== id)); ctx.settings.shelf = 'all'; ctx.saveSettings(); ctx.renderGrid(); toast('Shelf deleted. Its books stay in your library.'); }, true]
    ]);
  }

  /* =============== menus & prompts =============== */
  function menu(anchor, items) {
    const m = $('#menu');
    m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button role="menuitem" data-i="${i}"${it[2] ? ' class="danger"' : ''}>${esc(it[0])}</button>`).join('');
    m.hidden = false;
    const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = clamp(r.right - w, 8, innerWidth - w - 8) + 'px';
    m.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
    m.querySelectorAll('[data-i]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const it = items[+b.dataset.i]; if (it[3]) { it[1](b); return; } m.hidden = true; it[1](); });
    setTimeout(() => m.querySelector('button')?.focus(), 20);
  }
  document.addEventListener('pointerdown', e => { const m = $('#menu'); if (!m.hidden && !m.contains(e.target)) m.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#menu').hidden = true; });
  function promptText(title, label, value, done) {
    const d = document.createElement('dialog');
    d.innerHTML = `<form class="dlg" method="dialog" style="min-width:min(420px,calc(100vw - 48px))"><div class="dlg-head"><h2>${esc(title)}</h2></div>
      <label class="fld"><span>${esc(label)}</span><input required maxlength="60" value="${esc(value)}"></label>
      <div class="dlg-acts"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div></form>`;
    document.body.appendChild(d); d.showModal();
    d.addEventListener('close', () => { const v = d.querySelector('input').value.trim(); if (d.returnValue === 'ok' && v) done(v); d.remove(); });
  }

  /* =============== book card menu & details =============== */
  function cardMenu(e, anchor) {
    const fin = ctx.stats.finished[e.id];
    const items = [
      ['Open', () => ctx.openEntry(e)],
      ['Edit details and shelves…', () => openEdit(e)],
      [fin ? 'Mark as not finished' : 'Mark as finished', () => { if (fin) delete ctx.stats.finished[e.id]; else ctx.stats.finished[e.id] = Date.now(); ctx.saveStats(); ctx.renderLibrary(); }],
    ];
    items.push('-', ['Remove from library…', () => ctx.removeEntry(e), true]);
    menu(anchor, items);
  }
  let editing = null, newCover;
  function openEdit(e) {
    editing = e; newCover = undefined;
    const m = meta(e.id);
    $('#ed-title').value = m.title || e.title; $('#ed-author').value = m.author || e.author || '';
    $('#ed-tags').value = (m.tags || []).join(', ');
    const sel = new Set(m.shelves || []);
    $('#ed-shelves').innerHTML = shelves().length ? shelves().map(s => `<button type="button" class="chip" data-s="${esc(s.id)}" aria-pressed="${sel.has(s.id)}">${esc(s.name)}</button>`).join('')
      : '<span class="dlg-note">No shelves yet. Create one with “+ New shelf” in your library.</span>';
    $('#ed-shelves').querySelectorAll('[data-s]').forEach(b => b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
    $('#ed-cover').innerHTML = ctx.bookObject(e);
    $('#edit-dlg').returnValue = '';
    $('#edit-dlg').showModal();
  }
  $('#ed-cover-pick').onclick = () => $('#ed-cover-file').click();
  $('#ed-cover-file').onchange = ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    newCover = f; $('#ed-cover').innerHTML = ctx.bookObject({ ...editing, cover: f, id: 'preview' + uid() });
  };
  $('#ed-cover-reset').onclick = () => { newCover = null; $('#ed-cover').innerHTML = ctx.bookObject({ ...editing, cover: null, id: 'preview' + uid() }); };
  $('#edit-dlg').addEventListener('close', async () => {
    const e = editing; editing = null;
    if ($('#edit-dlg').returnValue === 'remove' && e) { ctx.removeEntry(e); return; }
    if ($('#edit-dlg').returnValue !== 'save' || !e) return;
    const title = $('#ed-title').value.trim() || e.title, author = $('#ed-author').value.trim();
    const tags = $('#ed-tags').value.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean).slice(0, 12);
    const sh = [...$('#ed-shelves').querySelectorAll('[aria-pressed="true"]')].map(b => b.dataset.s);
    setMeta(e.id, { title, author, tags, shelves: sh, tint: undefined });
    if (!e.sample) {
      e.title = title; e.author = author; e.userTitle = true;
      if (newCover !== undefined) e.cover = newCover;
      ctx.coverUrls.delete(e.id);
      await ctx.dbPut(e);
    }
    const b = ctx.cache.get(e.id); if (b) { b.title = title; b.author = author; }
    toast('Details saved'); ctx.renderLibrary();
  });

  /* =============== goals & reminders =============== */
  const goals = () => Object.assign({ daily: 20, yearly: 12, remind: false, at: '20:30' }, store.get('goals', {}));
  function ring(value, max, label, sub) {
    const r = 46, c = 2 * Math.PI * r, f = max ? clamp(value / max, 0, 1) : 0;
    return `<svg class="ring" viewBox="0 0 110 110" role="img" aria-label="${esc(label)} ${Math.round(f * 100)} percent of goal"><circle class="bg" cx="55" cy="55" r="${r}"/><circle class="fg" cx="55" cy="55" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - f)}" transform="rotate(-90 55 55)"/><text x="55" y="56" text-anchor="middle">${esc(label)}</text><text class="sub" x="55" y="74" text-anchor="middle">${esc(sub)}</text></svg>`;
  }
  function checkReminder() {
    const g = goals(); if (!g.remind || !('Notification' in window) || Notification.permission !== 'granted') return;
    const now = new Date(), [hh, mm] = g.at.split(':').map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;
    const key = ctx.dayKey(); if (store.get('reminded') === key) return;
    const mins = Math.round((ctx.stats.days[key] || 0) / 60);
    if (mins >= g.daily) return;
    store.set('reminded', key);
    const body = `You’ve read ${mins} of your ${g.daily} minutes today. A few pages before bed?`;
    navigator.serviceWorker?.getRegistration().then(r => r ? r.showNotification('Time to read', { body, icon: 'icons/icon-192.png', tag: 'margin-goal' }) : new Notification('Time to read', { body }))
      .catch(() => { try { new Notification('Time to read', { body }); } catch {} });
  }
  setInterval(checkReminder, 60000); setTimeout(checkReminder, 4000);

  /* =============== insights (stats, goals, year in review) =============== */
  function renderInsights(host) {
    const g = goals(), st = ctx.stats, key = ctx.dayKey();
    const today = Math.round((st.days[key] || 0) / 60);
    const year = new Date().getFullYear();
    const finYear = Object.entries(st.finished).filter(([, t]) => new Date(t).getFullYear() === year);
    host.innerHTML = `<h2 class="sec-title">Insights</h2><p class="sec-sub">Your reading time, goals and the year so far. Everything is measured on this device while a book is open.</p>
      <div class="ins-grid">
        <div class="panel-card"><h3>Today</h3><div class="ring-row">${ring(today, g.daily, `${today}m`, `of ${g.daily} min`)}<div><div class="dlg-p">${today >= g.daily ? 'Daily goal reached. Nicely done.' : `${g.daily - today} minutes to go today.`}</div><div class="dlg-note" style="margin-top:6px">Streak: ${ctx.streak()} ${ctx.streak() === 1 ? 'day' : 'days'}</div></div></div></div>
        <div class="panel-card"><h3>${year} goal</h3><div class="ring-row">${ring(finYear.length, g.yearly, `${finYear.length}`, `of ${g.yearly} books`)}<div class="dlg-p">${finYear.length >= g.yearly ? 'Goal reached!' : `${g.yearly - finYear.length} more ${g.yearly - finYear.length === 1 ? 'book' : 'books'} to reach your goal.`}</div></div></div>
        <div class="panel-card"><h3>Goals &amp; reminder</h3>
          <form class="goal-form" id="goal-form">
            <label class="fld num"><span>Minutes a day</span><input type="number" min="1" max="600" name="daily" value="${g.daily}"></label>
            <label class="fld num"><span>Books in ${year}</span><input type="number" min="1" max="500" name="yearly" value="${g.yearly}"></label>
            <label class="fld num"><span>Remind me at</span><input type="time" name="at" value="${g.at}"></label>
          </form>
          <label class="switch">Daily reminder if I haven’t met my goal<input type="checkbox" id="goal-remind" ${g.remind ? 'checked' : ''}></label>
          <p class="dlg-note">Reminders appear while Margin is open or running in the background. Browsers can’t wake a closed web app on a schedule.</p>
        </div>
      </div>
      <div class="panel-card" style="margin-bottom:22px"><div class="chart-h"><h3>Minutes read, last 14 days</h3><span id="ins-total"></span></div><div class="chart" id="ins-chart"></div>
        <div class="big-stats" id="ins-big"></div></div>
      <div id="yir"></div>`;
    const form = host.querySelector('#goal-form');
    form.oninput = () => {
      const fd = new FormData(form);
      store.set('goals', { ...goals(), daily: clamp(+fd.get('daily') || 20, 1, 600), yearly: clamp(+fd.get('yearly') || 12, 1, 500), at: fd.get('at') || '20:30' });
    };
    form.onchange = () => renderInsights(host);
    host.querySelector('#goal-remind').onchange = async e => {
      let on = e.target.checked;
      if (on && 'Notification' in window && Notification.permission !== 'granted') {
        try { on = (await Notification.requestPermission()) === 'granted'; } catch { on = false; }
        if (!on) { e.target.checked = false; toast('Notifications are blocked for Margin. Allow them in your browser or system settings.', 4500); }
      }
      if (!('Notification' in window)) { e.target.checked = false; on = false; toast('This browser doesn’t support notifications.'); }
      store.set('goals', { ...goals(), remind: on });
    };
    ctx.renderStatsInto(host.querySelector('#ins-chart'), host.querySelector('#ins-big'), host.querySelector('#ins-total'));
    renderYearInReview(host.querySelector('#yir'), year);
  }
  function renderYearInReview(host, year) {
    const st = ctx.stats;
    const days = Object.entries(st.days).filter(([d]) => d.startsWith(year + '-'));
    const secs = days.reduce((s, [, v]) => s + v, 0);
    const daysRead = days.filter(([, v]) => v >= 60).length;
    let best = 0, run = 0; const d0 = new Date(year, 0, 1), end = new Date(Math.min(Date.now(), new Date(year, 11, 31).getTime()));
    for (const d = new Date(d0); d <= end; d.setDate(d.getDate() + 1)) { if ((st.days[ctx.dayKey(d)] || 0) >= 60) best = Math.max(best, ++run); else run = 0; }
    const months = Array(12).fill(0); days.forEach(([d, v]) => { months[+d.slice(5, 7) - 1] += v; });
    const topMonth = months.indexOf(Math.max(...months));
    const fin = Object.entries(st.finished).filter(([, t]) => new Date(t).getFullYear() === year).sort((a, b) => a[1] - b[1]);
    const entries = ctx.entries();
    const byId = new Map(entries.map(e => [e.id, e]));
    const topBook = Object.entries(st.books).sort((a, b) => b[1].secs - a[1].secs)[0];
    const words = Math.round((st.chars || 0) / 5.8);
    const quotes = allHighlights().filter(h => new Date(h.at).getFullYear() === year).sort((a, b) => (b.note ? 1 : 0) - (a.note ? 1 : 0) || b.at - a.at).slice(0, 3);
    if (!secs && !fin.length) {
      host.innerHTML = `<div class="yir"><span class="eyebrow">${year} in books</span><div class="big">Your year starts here.</div><p class="dlg-p">Read a little and come back: your finished books, hours, longest streak and favourite highlights from ${year} will appear here.</p></div>`;
      return;
    }
    const monthName = new Date(year, topMonth, 1).toLocaleDateString(undefined, { month: 'long' });
    host.innerHTML = `<div class="yir">
      <span class="eyebrow">${year} in books</span>
      <div class="big">${fin.length ? `${fin.length} ${fin.length === 1 ? 'book' : 'books'} finished` : `${fmtH(secs)} of reading`}</div>
      <div class="yir-stats">
        <div><b>${fmtH(secs)}</b><span>Time spent reading</span></div>
        <div><b>${daysRead}</b><span>Days you read</span></div>
        <div><b>${best} ${best === 1 ? 'day' : 'days'}</b><span>Longest streak</span></div>
        <div><b>${months[topMonth] ? monthName : '—'}</b><span>Your biggest month</span></div>
        <div><b>${words ? words.toLocaleString() : '—'}</b><span>Words read (estimate)</span></div>
        <div><b>${allHighlights().filter(h => new Date(h.at).getFullYear() === year).length}</b><span>Passages highlighted</span></div>
      </div>
      ${fin.length ? `<div><span class="eyebrow">Finished this year</span><div class="yir-shelf">${fin.map(([id]) => byId.get(id) ? `<button class="card-open" data-open="${esc(id)}" title="${esc(byId.get(id).title)}"><div class="book">${ctx.bookObject(byId.get(id))}</div></button>` : '').join('')}</div></div>` : ''}
      ${topBook && topBook[1].secs > 300 ? `<p class="dlg-p">You spent the most time with <b>${esc(topBook[1].title || 'one book')}</b>: ${ctx.fmtDur(topBook[1].secs)}.</p>` : ''}
      ${quotes.map(q => `<blockquote>${esc(q.text)}${q.note ? `<br><span class="dlg-note">${esc(q.note)}</span>` : ''}<cite>${esc(q.book)}</cite></blockquote>`).join('')}
    </div>`;
    host.querySelectorAll('[data-open]').forEach(b => b.onclick = () => ctx.openEntry(byId.get(b.dataset.open)));
  }
  const fmtH = s => s >= 3600 ? `${(s / 3600).toFixed(s >= 36000 ? 0 : 1)} h` : `${Math.round(s / 60)} min`;

  /* =============== highlights across all books =============== */
  function allHighlights() {
    const out = []; const entries = ctx.entries(); const byId = new Map(entries.map(e => [e.id, e]));
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i); if (!k || !k.startsWith('margin:hl:')) continue;
        const id = k.slice('margin:hl:'.length);
        const e = byId.get(baseId(id)); const m = meta(baseId(id));
        const book = m.title || (e && e.title) || (ctx.stats.books[id] && ctx.stats.books[id].title) || 'Untitled';
        const author = m.author || (e && e.author) || '';
        for (const h of JSON.parse(localStorage.getItem(k)) || []) out.push({ ...h, bookId: id, entryId: baseId(id), book, author, chapter: h.chTitle || `Section ${h.ch + 1}` });
      }
    } catch {}
    return out.sort((a, b) => a.book.localeCompare(b.book) || a.ch - b.ch || a.start - b.start);
  }
  function renderHighlights(host) {
    const all = allHighlights();
    host.innerHTML = `<h2 class="sec-title">Highlights</h2><p class="sec-sub">Every passage you’ve highlighted, across all your books. Search them, open them in context, turn them into images, or export them.</p>
      <div class="disc-bar"><label class="lib-search"><svg class="i"><use href="#i-search"/></svg><span class="sr">Search highlights</span><input id="hl-q" type="search" placeholder="Search highlights and notes"></label>
      <div class="chips" id="hl-colors" style="margin:0">${['all', 'yellow', 'green', 'blue', 'pink', 'violet', 'notes'].map(c => `<button class="chip" data-c="${c}" aria-pressed="${c === 'all'}" aria-label="${c === 'all' ? 'All highlights' : c === 'notes' ? 'Highlights with notes' : c[0].toUpperCase() + c.slice(1) + ' highlights'}">${c === 'all' ? 'All' : c === 'notes' ? 'With notes' : `<span class="bar" data-c="${c}" style="width:10px;height:10px;border-radius:50%;display:inline-block"></span>`}</button>`).join('')}</div></div>
      <div class="export-row"><span class="dlg-note" style="align-self:center;margin-right:6px">Export all:</span>${exportButtons()}</div>
      <div id="hl-out"></div>`;
    let color = 'all';
    const out = host.querySelector('#hl-out'), q = host.querySelector('#hl-q');
    const draw = () => {
      const s = q.value.trim().toLowerCase();
      const list = all.filter(h => (color === 'all' || (color === 'notes' ? h.note : h.color === color)) && (!s || (h.text + ' ' + (h.note || '') + ' ' + h.book).toLowerCase().includes(s)));
      if (!all.length) { out.innerHTML = `<p class="empty-filter">No highlights yet. While reading, select any passage and pick a colour.</p>`; return; }
      if (!list.length) { out.innerHTML = `<p class="empty-filter">No highlights match.</p>`; return; }
      const groups = new Map(); list.forEach(h => { if (!groups.has(h.bookId)) groups.set(h.bookId, []); groups.get(h.bookId).push(h); });
      out.innerHTML = '';
      for (const [, hs] of groups) {
        const g = document.createElement('section'); g.className = 'hl-group';
        g.innerHTML = `<h3>${esc(hs[0].book)}</h3><div class="by">${esc(hs[0].author)}${hs[0].author ? ' · ' : ''}${hs.length} ${hs.length === 1 ? 'highlight' : 'highlights'}</div>`;
        for (const h of hs) {
          const it = document.createElement('div'); it.className = 'hl-item';
          it.innerHTML = `<span class="bar" data-c="${esc(h.color)}"></span><div><p class="q">${mark(h.text, s)}</p>${h.note ? `<div class="nt">${mark(h.note, s)}</div>` : ''}<div class="meta">${esc(h.chapter)} · ${new Date(h.at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</div></div>
            <div class="acts"><button class="icon-btn" data-a="open" aria-label="Open in book" title="Open in book"><svg class="i"><use href="#i-next"/></svg></button><button class="icon-btn" data-a="img" aria-label="Share as image" title="Share as image"><svg class="i"><use href="#i-image"/></svg></button></div>`;
          it.querySelector('[data-a="open"]').onclick = () => ctx.openAt(h.entryId, h.bookId.endsWith(':text'), h);
          it.querySelector('[data-a="img"]').onclick = () => quoteCard({ text: h.text, book: h.book, author: h.author, entryId: h.entryId });
          g.appendChild(it);
        }
        out.appendChild(g);
      }
    };
    q.oninput = draw;
    host.querySelectorAll('#hl-colors [data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; host.querySelectorAll('#hl-colors [data-c]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); draw(); });
    wireExports(host, () => all);
    draw();
  }
  const mark = (t, s) => { const e = esc(t); if (!s) return e; const i = t.toLowerCase().indexOf(s); return i < 0 ? e : esc(t.slice(0, i)) + `<mark>${esc(t.slice(i, i + s.length))}</mark>` + esc(t.slice(i + s.length)); };

  /* =============== exports =============== */
  const exportButtons = () => ['md', 'obsidian', 'readwise', 'notion'].map(f => `<button class="mini" data-x="${f}">${{ md: 'Markdown', obsidian: 'Obsidian', readwise: 'Readwise CSV', notion: 'Notion CSV' }[f]}</button>`).join('');
  function wireExports(host, getList) {
    host.querySelectorAll('[data-x]').forEach(b => b.onclick = () => exportHighlights(getList(), b.dataset.x));
  }
  const csv = rows => rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
  const ts = t => { const d = new Date(t); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const safe = s => (s || 'Untitled').replace(/[\\/:*?"<>|#^[\]]+/g, '').trim().slice(0, 80) || 'Untitled';
  function mdFor(hs, obsidian) {
    const h0 = hs[0];
    let md = obsidian ? `---\ntitle: "${h0.book.replace(/"/g, '\\"')}"\nauthor: "${(h0.author || '').replace(/"/g, '\\"')}"\nsource: Margin\nhighlights: ${hs.length}\nexported: ${new Date().toISOString().slice(0, 10)}\ntags: [book, highlights]\n---\n\n` : '';
    md += `# ${h0.book}\n${h0.author ? `*${h0.author}*\n` : ''}\n`;
    let ch = null;
    for (const h of hs) {
      if (h.chapter !== ch) { ch = h.chapter; md += `\n## ${ch}\n\n`; }
      if (obsidian) md += `> [!quote]\n> ${h.text.replace(/\n/g, '\n> ')}\n${h.note ? `\n${h.note}\n` : ''}\n`;
      else md += `> ${h.text}\n\n${h.note ? h.note + '\n\n' : ''}`;
    }
    return md;
  }
  async function exportHighlights(list, fmt) {
    if (!list.length) { toast('There are no highlights to export yet.'); return; }
    const groups = new Map(); list.forEach(h => { if (!groups.has(h.bookId)) groups.set(h.bookId, []); groups.get(h.bookId).push(h); });
    const one = groups.size === 1, name0 = safe(list[0].book);
    if (fmt === 'readwise') {
      const rows = [['Highlight', 'Title', 'Author', 'URL', 'Note', 'Location', 'Date']];
      list.forEach(h => rows.push([h.text, h.book, h.author, '', h.note || '', h.start, ts(h.at)]));
      download(new Blob([csv(rows)], { type: 'text/csv' }), one ? `${name0} — Readwise.csv` : 'Margin highlights — Readwise.csv');
    } else if (fmt === 'notion') {
      const rows = [['Highlight', 'Book', 'Author', 'Chapter', 'Note', 'Colour', 'Date']];
      list.forEach(h => rows.push([h.text, h.book, h.author, h.chapter, h.note || '', h.color, ts(h.at)]));
      download(new Blob(['\ufeff' + csv(rows)], { type: 'text/csv' }), one ? `${name0} — Notion.csv` : 'Margin highlights — Notion.csv');
    } else if (one) {
      download(new Blob([mdFor(list, fmt === 'obsidian')], { type: 'text/markdown' }), `${name0}.md`);
    } else {
      const zip = new window.JSZip();
      for (const [, hs] of groups) zip.file(`${safe(hs[0].book)}.md`, mdFor(hs, fmt === 'obsidian'));
      download(await zip.generateAsync({ type: 'blob' }), fmt === 'obsidian' ? 'Margin highlights (Obsidian).zip' : 'Margin highlights (Markdown).zip');
    }
    toast('Exported');
  }

  /* =============== quote cards =============== */
  let quoteState = null;
  async function quoteCard({ text, book, author, entryId }) {
    let tint = '#1f3b57';
    const e = ctx.entries().find(x => x.id === entryId);
    if (e) { const t = await ctx.tintFor(e); tint = t.startsWith('var(') ? getComputedStyle(document.documentElement).getPropertyValue(t.slice(4, -1)).trim() || tint : t; }
    quoteState = { text, book, author, tint, style: store.get('quoteStyle', 'cover') };
    $('#quote-style').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === quoteState.style)));
    await drawQuote();
    $('#quote-dlg').showModal();
  }
  $('#quote-style').querySelectorAll('button').forEach(b => b.onclick = () => { quoteState.style = b.dataset.v; store.set('quoteStyle', b.dataset.v); $('#quote-style').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); drawQuote(); });
  $('#quote-dlg').querySelector('[data-close]').onclick = () => $('#quote-dlg').close();
  async function drawQuote() {
    const c = $('#quote-canvas'), x = c.getContext('2d'), W = c.width, H = c.height, s = quoteState;
    try { await Promise.all([document.fonts.load('italic 48px Literata'), document.fonts.load('60px "Instrument Serif"'), document.fonts.load('600 26px Figtree')]); } catch {}
    const pal = s.style === 'paper' ? { bg: '#f3f1ea', fg: '#1d1f22', mute: '#6b6f73', acc: s.tint } : s.style === 'ink' ? { bg: '#111315', fg: '#ecebe6', mute: '#8b9196', acc: '#d6a55e' } : { bg: s.tint, fg: '#f6f3ec', mute: 'rgba(246,243,236,.72)', acc: 'rgba(246,243,236,.9)' };
    x.fillStyle = pal.bg; x.fillRect(0, 0, W, H);
    if (s.style === 'cover') { const g = x.createRadialGradient(W * .1, H * .05, 0, W * .1, H * .05, H); g.addColorStop(0, 'rgba(255,255,255,.14)'); g.addColorStop(1, 'rgba(0,0,0,.18)'); x.fillStyle = g; x.fillRect(0, 0, W, H); }
    x.fillStyle = pal.acc; x.font = '220px "Instrument Serif", Georgia, serif'; x.textBaseline = 'alphabetic'; x.fillText('“', 92, 300);
    const pad = 110, maxW = W - pad * 2;
    let size = 64, lines;
    const words = s.text.trim().split(/\s+/);
    for (; size >= 30; size -= 2) {
      x.font = `italic ${size}px Literata, Georgia, serif`;
      lines = []; let cur = '';
      for (const w of words) { const t = cur ? cur + ' ' + w : w; if (x.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
      if (cur) lines.push(cur);
      if (lines.length * size * 1.42 <= H - 640) break;
    }
    const maxLines = Math.floor((H - 640) / (size * 1.42));
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
    x.fillStyle = pal.fg;
    const block = lines.length * size * 1.42, avail = H - 300 - 330;
    let y = 330 + Math.max(0, (avail - block) / 2) + size; for (const l of lines) { x.fillText(l, pad, y); y += size * 1.42; }
    x.fillStyle = pal.acc; x.fillRect(pad, H - 250, 90, 3);
    x.fillStyle = pal.fg; x.font = '58px "Instrument Serif", Georgia, serif';
    let t = s.book; while (x.measureText(t).width > maxW && t.length > 4) t = t.slice(0, -2); if (t !== s.book) t += '…';
    x.fillText(t, pad, H - 180);
    x.fillStyle = pal.mute; x.font = '600 28px Figtree, system-ui, sans-serif'; x.fillText((s.author || '').toUpperCase(), pad, H - 130);
    x.font = '500 22px Figtree, system-ui, sans-serif'; x.textAlign = 'right'; x.fillText('Margin', W - pad, H - 130); x.textAlign = 'left';
  }
  const quoteBlob = () => new Promise(r => $('#quote-canvas').toBlob(r, 'image/png'));
  $('#quote-save').onclick = async () => { download(await quoteBlob(), `${safe(quoteState.book)} quote.png`); toast('Image saved'); };
  $('#quote-share').onclick = async () => {
    const f = new File([await quoteBlob()], `${safe(quoteState.book)} quote.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], title: quoteState.book, text: `“${quoteState.text}” — ${quoteState.book}` }); } catch {} }
    else { download(f, f.name); toast('Sharing isn’t available here, so the image was saved instead.', 3200); }
  };

  /* =============== words & flashcards =============== */
  function wordsDue() { return vocab.due(store).length; }
  function renderWords(host, reviewMode) {
    const list = vocab.get(store), due = vocab.due(store);
    if (reviewMode && due.length) return review(host, due.slice().sort(() => Math.random() - .5));
    host.innerHTML = `<h2 class="sec-title">Words</h2><p class="sec-sub">Words you looked up while reading, with the sentence you found them in. Review them with flashcards; each card comes back less often as you learn it.</p>
      <div class="words-top"><div class="review-card"><span class="eyebrow">Review</span><b>${due.length ? `${due.length} ${due.length === 1 ? 'card' : 'cards'} due` : list.length ? 'All caught up' : 'No words yet'}</b>
        <span class="dlg-p">${due.length ? 'A few minutes of review keeps new words in memory.' : list.length ? 'Come back later; cards return on a schedule.' : 'Select a word while reading and choose Define, then Add to Words.'}</span>
        ${due.length ? '<button class="btn primary" id="w-start" style="align-self:flex-start">Start review</button>' : ''}</div></div>
      ${list.length ? `<div class="disc-bar"><label class="lib-search"><svg class="i"><use href="#i-search"/></svg><span class="sr">Search words</span><input id="w-q" type="search" placeholder="Search your words"></label><button class="mini" id="w-export">Export CSV</button></div><ul class="word-list" id="w-list"></ul>` : ''}`;
    const st = host.querySelector('#w-start'); if (st) st.onclick = () => renderWords(host, true);
    const ul = host.querySelector('#w-list'); if (!ul) return;
    const draw = () => {
      const s = (host.querySelector('#w-q').value || '').toLowerCase();
      ul.innerHTML = '';
      list.filter(w => !s || (w.word + ' ' + w.def).toLowerCase().includes(s)).forEach(w => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="w">${esc(w.word)}<button class="icon-btn" aria-label="Remove ${esc(w.word)}" style="width:30px;height:30px"><svg class="i"><use href="#i-x"/></svg></button></span>
          <span class="d">${w.pos ? `<i>${esc(w.pos)}</i> · ` : ''}${esc(w.def || '')}</span>${w.context ? `<span class="c">“${esc(w.context)}”</span>` : ''}
          <span class="m"><span class="boxes" title="Learning progress">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= (w.box || 1) ? 'on' : ''}"></i>`).join('')}</span>${esc(w.book || '')}</span>`;
        li.querySelector('button').onclick = () => { vocab.remove(store, w.word); renderWords(host); ctx.updateWordsBadge(); };
        ul.appendChild(li);
      });
    };
    host.querySelector('#w-q').oninput = draw;
    host.querySelector('#w-export').onclick = () => download(new Blob([csv([['Word', 'Part of speech', 'Definition', 'Context', 'Book', 'Added'], ...list.map(w => [w.word, w.pos, w.def, w.context, w.book, ts(w.at)])])], { type: 'text/csv' }), 'Margin words.csv');
    draw();
  }
  function review(host, queue) {
    let i = 0, right = 0;
    const show = () => {
      if (i >= queue.length) {
        host.innerHTML = `<h2 class="sec-title">Review done</h2><p class="sec-sub">${right} of ${queue.length} remembered. Cards you missed will come back in a few minutes; the rest are scheduled further out.</p><button class="btn primary" id="w-back">Back to Words</button>`;
        host.querySelector('#w-back').onclick = () => renderWords(host); ctx.updateWordsBadge(); return;
      }
      const w = queue[i];
      const ctxHtml = w.context ? esc(w.context).replace(new RegExp(`\\b(${w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'i'), '<b>$1</b>') : '';
      host.innerHTML = `<h2 class="sec-title">Review</h2><p class="sec-sub">Card ${i + 1} of ${queue.length}. Recall the meaning, then tap the card to check.</p>
        <div class="flash"><div class="flash-card" id="fc" tabindex="0" role="button" aria-label="Flip card">
          <div class="flash-face"><span class="flash-word">${esc(w.word)}</span>${ctxHtml ? `<span class="flash-ctx">“${ctxHtml}”</span>` : ''}<span class="dlg-note">Tap or press Space to flip</span></div>
          <div class="flash-face back"><span class="flash-word" style="font-size:32px">${esc(w.word)}</span><span class="dict"><span class="pos">${esc(w.pos || '')}</span></span><span class="dlg-p" style="color:var(--fg)">${esc(w.def || '')}</span>${w.book ? `<span class="dlg-note">From ${esc(w.book)}</span>` : ''}</div>
        </div><div class="flash-acts" id="fa" hidden><button class="btn" id="f-again">Didn’t know it</button><button class="btn primary" id="f-good">Knew it</button></div></div>`;
      const fc = host.querySelector('#fc');
      const flip = () => { fc.classList.toggle('flipped'); host.querySelector('#fa').hidden = false; };
      fc.onclick = flip; fc.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } };
      host.querySelector('#f-again').onclick = () => { vocab.grade(store, w.word, false); i++; show(); };
      host.querySelector('#f-good').onclick = () => { vocab.grade(store, w.word, true); right++; i++; show(); };
      fc.focus();
    };
    show();
  }

  /* =============== backup dialog =============== */
  const bk = $('#backup-dlg');
  async function openBackup() {
    $('#bk-status').textContent = '';
    const entries = await ctx.dbAll();
    const bytes = entries.reduce((s, e) => s + (e.data ? (e.data.byteLength || e.data.length || 0) : 0) + (e.tracks ? e.tracks.reduce((n, t) => n + (t.blob ? t.blob.size : 0), 0) : 0), 0);
    $('#bk-size').textContent = `${entries.length} ${entries.length === 1 ? 'book' : 'books'} you added (${(bytes / 1048576).toFixed(1)} MB). The sample book is always included.`;
    bk.showModal();
  }
  bk.querySelector('[data-close]').onclick = () => bk.close();
  $('#bk-make').onclick = async () => {
    const st = $('#bk-status'); st.textContent = 'Preparing backup…';
    try {
      ctx.flush();
      const { blob, count } = await makeBackup({ dbAll: ctx.dbAll, includeBooks: $('#bk-books').checked, onProgress: p => { st.textContent = `Preparing backup… ${Math.round(p * 100)}%`; } });
      download(blob, `Margin backup ${new Date().toISOString().slice(0, 10)}.margin`);
      st.textContent = `Backup downloaded: ${count} ${count === 1 ? 'book' : 'books'}, ${(blob.size / 1048576).toFixed(1)} MB.`;
    } catch (e) { st.textContent = 'The backup could not be created: ' + (e.message || e); }
  };
  $('#bk-restore').onclick = () => $('#bk-file').click();
  $('#bk-file').onchange = async ev => {
    const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
    const st = $('#bk-status'); st.textContent = 'Restoring…';
    try {
      ctx.flush();
      const r = await restoreBackup(f, { dbAll: ctx.dbAll, dbPut: ctx.dbPut });
      st.textContent = `Restored: ${r.added} new ${r.added === 1 ? 'book' : 'books'} added, reading data merged. Reloading…`;
      ctx.suspendSaving();
      setTimeout(() => location.reload(), 1200);
    } catch (e) { st.textContent = e.message || 'Restore failed.'; }
  };

  return { filterByShelf, renderChips, cardMenu, openEdit, renderInsights, renderHighlights, renderWords, wordsDue, openBackup, quoteCard, exportHighlights, allHighlights, exportButtons, wireExports, meta, menu };
}
