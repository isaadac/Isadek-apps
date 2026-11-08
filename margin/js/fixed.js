/* Margin — fixed-layout viewer for PDFs and comics: one or two pages, zoom and pan. */
export function createFixedView({ stage, host, settings, onChange, onTap, reduced }) {
  const spread = host.querySelector('.fx-spread');
  let book = null, page = 0, per = 1, zoom = 1, token = 0;

  const perScreen = () => {
    if (settings.spread === 'single') return 1;
    if (settings.spread === 'double') return stage.clientWidth >= 560 ? 2 : 1;
    return stage.clientWidth >= 820 && stage.clientWidth > stage.clientHeight * 1.15 ? 2 : 1;
  };
  const count = () => book ? book.pageCount : 0;
  // Two-up: the cover stands alone on the right, then facing pairs (like a printed book).
  const screens = () => per === 1 ? count() : 1 + Math.ceil((count() - 1) / 2);
  const screenOf = p => per === 1 ? p : (p === 0 ? 0 : Math.floor((p - 1) / 2) + 1);
  const pagesOf = s => {
    if (per === 1) return [s];
    if (s === 0) return [0];
    const a = 1 + (s - 1) * 2;
    return a + 1 < count() ? [a, a + 1] : [a];
  };

  async function draw(dir = 0) {
    if (!book) return;
    const my = ++token;
    const ps = pagesOf(screenOf(page));
    const W = Math.max(100, stage.clientWidth - 32), H = Math.max(100, stage.clientHeight - 32);
    const box = { w: ps.length === 2 ? W / 2 : W, h: H, zoom };
    let els;
    try { els = await Promise.all(ps.map(i => book.render(i, box))); } catch (e) { console.warn(e); return; }
    if (my !== token) return;
    for (const el of els) {
      if (el.tagName === 'IMG') {
        const ar = el.naturalWidth && el.naturalHeight ? el.naturalWidth / el.naturalHeight : 0.66;
        const w = Math.min(box.w, box.h * ar) * zoom;
        el.style.width = Math.floor(w) + 'px'; el.style.height = Math.floor(w / ar) + 'px';
      }
    }
    spread.replaceChildren(...els);
    spread.classList.toggle('two', ps.length === 2);
    spread.classList.toggle('solo-right', per === 2 && ps.length === 1 && ps[0] === 0);
    host.classList.toggle('zoomed', zoom > 1.01);
    spread.style.transform = '';
    if (dir && settings.anim && !reduced) spread.animate([{ opacity: .3, transform: `translateX(${dir * 36}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.22,.7,.18,1)' });
    onChange && onChange(state());
  }
  const state = () => ({ page, pages: pagesOf(screenOf(page)), screen: screenOf(page), screens: screens(), per, zoom, count: count() });

  const api = {
    open(b, start = 0) { book = b; zoom = 1; per = perScreen(); page = Math.max(0, Math.min(count() - 1, start)); host.hidden = false; host.scrollTo(0, 0); return draw(); },
    close() { book = null; token++; spread.replaceChildren(); host.hidden = true; },
    layout() { if (!book) return; per = perScreen(); draw(); },
    state,
    go(p, dir = 0) { if (!book) return; page = Math.max(0, Math.min(count() - 1, p)); if (zoom > 1) zoom = 1; host.scrollTo(0, 0); draw(dir); },
    next() { const s = screenOf(page); if (s < screens() - 1) api.go(pagesOf(s + 1)[0], 1); else return false; return true; },
    prev() { const s = screenOf(page); if (s > 0) api.go(pagesOf(s - 1)[0], -1); else return false; return true; },
    setZoom(z, cx, cy) {
      const old = zoom; zoom = Math.max(1, Math.min(5, z));
      if (Math.abs(old - zoom) < 0.01) return;
      const r = host.getBoundingClientRect();
      const fx = cx != null ? (host.scrollLeft + cx - r.left) / Math.max(1, host.scrollWidth) : 0.5;
      const fy = cy != null ? (host.scrollTop + cy - r.top) / Math.max(1, host.scrollHeight) : 0.5;
      draw().then(() => {
        host.scrollLeft = fx * host.scrollWidth - (cx != null ? cx - r.left : host.clientWidth / 2);
        host.scrollTop = fy * host.scrollHeight - (cy != null ? cy - r.top : host.clientHeight / 2);
      });
    },
    get zoom() { return zoom; },
    get open_() { return !!book; }
  };

  // ---- input ----
  let pointers = new Map(), pinch = null, swipe = null, lastTap = 0, wheelLock = 0;
  host.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || e.isPrimary) { pointers.clear(); pinch = null; }
    try { host.setPointerCapture(e.pointerId); } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      swipe = null;
    } else if (pointers.size === 1) swipe = { x: e.clientX, y: e.clientY, at: Date.now() };
  });
  host.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const s = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d;
      spread.style.transform = `scale(${Math.max(0.6, Math.min(4, s))})`;
      pinch.s = s;
    }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (pinch && pointers.size < 2) {
      const s = pinch.s || 1; const p = pinch; pinch = null;
      spread.style.transform = '';
      api.setZoom(p.z * s, p.cx, p.cy);
      swipe = null; return;
    }
    if (swipe && pointers.size === 0) {
      const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y, dt = Date.now() - swipe.at;
      const sw = swipe; swipe = null;
      if (zoom <= 1.01 && Math.abs(dx) > 45 && Math.abs(dy) < 90 && dt < 700) { onTap(dx < 0 ? 'next' : 'prev'); return; }
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 400) {
        const now = Date.now();
        if (now - lastTap < 300) { lastTap = 0; clearTimeout(api._t); api.setZoom(zoom > 1.01 ? 1 : 2.2, sw.x, sw.y); return; }
        lastTap = now;
        const r = host.getBoundingClientRect(), x = (sw.x - r.left) / r.width;
        api._t = setTimeout(() => {
          if (zoom > 1.01) { onTap('middle'); return; }
          onTap(x < 0.28 ? 'prev' : x > 0.72 ? 'next' : 'middle');
        }, 260);
      }
    }
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); pinch = null; swipe = null; spread.style.transform = ''; });
  host.addEventListener('wheel', e => {
    if (!book) return;
    if (e.ctrlKey) { e.preventDefault(); api.setZoom(zoom * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX, e.clientY); return; }
    if (zoom > 1.01) return;
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock) { wheelLock = now + 200; return; }
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 6) return;
    wheelLock = now + 340;
    onTap(d > 0 ? 'next' : 'prev');
  }, { passive: false });
  return api;
}
