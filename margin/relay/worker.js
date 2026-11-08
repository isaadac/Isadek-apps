/* Margin download relay — a Cloudflare Worker (free plan is enough).
   Margin calls  https://<your-worker>/?url=<encoded book or catalog URL>
   and this worker fetches it and adds the CORS header browsers need.

   Deploy:  dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker →
            Edit code → paste this file → Deploy. Copy the *.workers.dev address into
            Margin → Discover → Download relay.

   Safety: it only fetches from the hosts listed below (add your own OPDS servers),
   only GET requests, and refuses files over 1 GB (audiobooks can be large). */

const ALLOWED_HOSTS = [
  'gutendex.com',
  'www.gutenberg.org', 'gutenberg.org', 'aleph.gutenberg.org',
  'standardebooks.org',
  'm.gutenberg.org',
  'librivox.org', 'archive.org', 'www.archive.org',
  // 'opds.example.org',   // add your own catalog hosts here
];
// Set to the address you serve Margin from (e.g. 'https://you.github.io') to stop other sites using your relay. '*' allows any.
const ALLOW_ORIGIN = '*';
const MAX_BYTES = 1024 * 1024 * 1024;

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept',
      'Access-Control-Expose-Headers': 'Content-Type, Content-Length, Content-Disposition',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Only GET is allowed', { status: 405, headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    let url;
    try { url = new URL(target); } catch { return new Response('Add ?url=<address>', { status: 400, headers: cors }); }
    if (!['http:', 'https:'].includes(url.protocol) || !ALLOWED_HOSTS.includes(url.hostname))
      return new Response(`Host not allowed: ${url.hostname}. Add it to ALLOWED_HOSTS in the worker.`, { status: 403, headers: cors });

    const upstream = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Margin-Relay/1.0', Accept: request.headers.get('Accept') || '*/*' },
      redirect: 'follow',
    });
    const len = Number(upstream.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) return new Response('File too large', { status: 413, headers: cors });

    const headers = new Headers(cors);
    for (const h of ['Content-Type', 'Content-Length', 'Content-Disposition', 'Last-Modified', 'ETag']) {
      const v = upstream.headers.get(h); if (v) headers.set(h, v);
    }
    headers.set('Cache-Control', 'public, max-age=3600');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
