/* Margin service worker: offline app shell + receiving shared files. */
const VERSION = 'margin-v11';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/parse.js',
  './js/sample.js',
  './js/formats.js',
  './js/fixed.js',
  './js/backup.js',
  './js/dict.js',
  './js/discover.js',
  './js/extras.js',
  './js/audio.js',
  './js/audiometa.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './vendor/libarchive/libarchive.js',
  './vendor/libarchive/worker-bundle.js',
  './vendor/libarchive/libarchive.wasm',
  './vendor/foliate/mobi.js',
  './vendor/foliate/fb2.js',
  './vendor/foliate/fflate.js',
  './vendor/mammoth/mammoth.browser.min.js',
  './manifest.webmanifest',
  './vendor/jszip.min.js',
  './fonts/fonts.css',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Font files are listed in fonts.css; cache them all so reading works offline.
    const css = await (await fetch('./fonts/fonts.css')).text();
    const fonts = [...css.matchAll(/url\(\.\/([^)]+)\)/g)].map(m => './fonts/' + m[1]);
    await cache.addAll([...new Set(fonts)]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('margin-v') && k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Android share sheet: a book shared to Margin arrives as a POST to ./share
  if (req.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('book');
        if (file && typeof file !== 'string') {
          const cache = await caches.open('margin-share');
          await cache.put('shared-book', new Response(file, {
            headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'Shared book') }
          }));
        }
      } catch (e) { /* fall through to the app */ }
      return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: try the network for fresh code, fall back to the cached app offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        if (fresh.ok) cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Everything else: cache first, then network (and remember it).
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
    return res;
  })());
});
