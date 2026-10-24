const C = 'hi-v0.8.0';
const FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/docx.umd.js', 'lib/jszip.min.js', 'lib/qrcode.js', 'lib/jsQR.js', 'lib/jspdf.umd.min.js', 'gbp/mapping.json', 'gbp/drainage-mapping.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // the plan PDFs (20 MB 建築, 36 MB 渠務) are kept in IndexedDB by the app; don't duplicate them here
  if (url.pathname.endsWith('/gbp/plans.pdf') || url.pathname.endsWith('/gbp/drainage.pdf')) return;
  // app code and mapping: network first so updates arrive, cache when offline;
  // no-cache makes the browser revalidate instead of reusing GitHub Pages' 10-minute HTTP cache
  const net = fetch(new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })).then(res => { if (res.ok) { const cp = res.clone(); caches.open(C).then(c => c.put(e.request, cp)); } return res; });
  const cached = () => caches.match(e.request, { ignoreSearch: true });
  // weak site signal: fall back to the cached copy after 3 s
  e.respondWith(Promise.race([net, new Promise(r => setTimeout(r, 3000))]).then(res => res || cached().then(c => c || net))
    .catch(() => cached().then(r => r || caches.match('index.html'))));
});
