'use strict';
/* 竣工驗收記錄 — offline iPad PWA
   Bundled GBP plans (vector PDF) + location mapping; items (pin + photos + text) live in IndexedDB on the device. */
const VERSION = '0.8.6';
const $ = s => document.querySelector(s);
// an update can arrive as new app.js under a stale cached index.html: reload the page once, bypassing caches
(() => {
  let tried = false; try { tried = sessionStorage.getItem('hiStale') === VERSION; } catch (e) { }
  if (!document.querySelector('#stage > #ov') && !tried) { try { sessionStorage.setItem('hiStale', VERSION); } catch (e) { } location.replace(location.pathname + '?r=' + Date.now()); throw new Error('stale page, reloading'); }
  if (/[?&]r=\d+/.test(location.search)) history.replaceState(null, '', location.pathname);
})();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ROOMS = ['Living/Dining', 'Master Bedroom', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Kitchen', 'Bathroom', 'Master Bathroom', 'Balcony', 'Utility Platform', 'Store', 'Corridor', 'Flat Entrance'];
const CROP_W = { s: 200, m: 320, l: 480 }; // crop width in drawing points (A0 at 1:100 → 320pt ≈ 11m on site)

/* ---------------- storage ---------------- */
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('handover-inspect', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const n of ['kv', 'drawings', 'items', 'files']) if (!d.objectStoreNames.contains(n)) n === 'kv' ? d.createObjectStore('kv') : d.createObjectStore(n, { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  st(n, m = 'readonly') { return this.db.transaction(n, m).objectStore(n); },
  /* Safari in Private Browsing (and some low-storage states) refuses Blobs in IndexedDB with
     "Error preparing Blob/File data to be stored in object store". Then files are stored as raw bytes
     ({__b, t}) and turned back into Blobs on every read. */
  noBlobs: false,
  async write(store, v, k) {
    if (!this.noBlobs) { try { return await rq(k === undefined ? this.st(store, 'readwrite').put(v) : this.st(store, 'readwrite').put(v, k)); } catch (e) { if (!/blob|file/i.test(String(e && e.message))) throw e; this.noBlobs = true; blobWarning(); } }
    const enc = await encBlobs(v); return rq(k === undefined ? this.st(store, 'readwrite').put(enc) : this.st(store, 'readwrite').put(enc, k));
  },
  async all(n) { return (await rq(this.st(n).getAll())).map(decBlobs); },
  async get(n, k) { return decBlobs(await rq(this.st(n).get(k))); },
  put(n, v) { return this.write(n, v); },
  del(n, k) { return rq(this.st(n, 'readwrite').delete(k)); },
  async kget(k) { return decBlobs(await rq(this.st('kv').get(k))); },
  kset(k, v) { return this.write('kv', v, k); },
};
const plainObj = v => v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Array.isArray(v));
async function encBlobs(v) {
  if (v instanceof Blob) return { __b: await v.arrayBuffer(), t: v.type };
  if (Array.isArray(v)) return Promise.all(v.map(encBlobs));
  if (plainObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = await encBlobs(x); return o; }
  return v;
}
function decBlobs(v) { // in place: records come straight from storage
  if (!v || typeof v !== 'object' || !plainObj(v)) return v;
  if (v.__b instanceof ArrayBuffer) return new Blob([v.__b], { type: v.t || '' });
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = decBlobs(v[i]); return v; }
  for (const k of Object.keys(v)) { const x = v[k]; if (x && typeof x === 'object') v[k] = decBlobs(x); }
  return v;
}
let blobWarned = false;
function blobWarning() {
  if (blobWarned) return; blobWarned = true;
  const show = () => { if (S.panel || !$('#busy').hidden) return setTimeout(show, 1500); openPanel('private', '請勿用「無痕瀏覽」', `<div class="note"><b>這個瀏覽器不讓程式以一般方式保存相片及圖紙</b>，通常是因為 Safari 開了「無痕瀏覽」（例如從 WhatsApp 連結開啟）。程式已改用後備方式保存，可以照常使用，但<b>無痕瀏覽的資料在關閉分頁後會全部消失</b>。</div>
    <div class="note">請這樣做：<br>① 在 Safari 底部按分頁按鈕，切換到一般（非無痕）分頁<br>② 在一般分頁打開本網址<br>③ 按分享按鈕 →「加入主畫面」，以後從主畫面圖示開啟<br>如果不是無痕瀏覽，請檢查 iPhone 的儲存空間是否已滿。</div>
    <button class="btn dk" data-a="close2">知道了</button>`, { compact: true }); panel.querySelector('[data-a="close2"]').onclick = () => closePanel(); };
  setTimeout(show, 600);
}

const S = {
  project: { name: '', site: '', date: today(), inspector: '', company: '' },
  settings: { autoCam: true, showZones: true, crop: 'm', keyPlan: true },
  floorSel: {}, recentAreas: [], views: {}, rots: {}, repSub: '',
  drawings: [], items: [], rounds: [], fixOnlyOpen: false, fixItem: null, cur: null, mode: 'inspect', tool: 'select',
  view: { x: 0, y: 0, k: 1 }, editing: null, draft: null, sel: null, panel: null, listScope: 'cur',
};
const imgCache = new Map(); // drawingId -> {url, img}

/* ---------------- UI helpers ---------------- */
let toastT;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
function busy(msg) { $('#busy').hidden = !msg; if (msg) $('#busyMsg').textContent = msg; }
const blobURLs = [];
function burl(b) { try { const u = URL.createObjectURL(b); blobURLs.push(u); return u; } catch (e) { return 'data:,'; } } // 'data:,' fails to load, so the image's fallback kicks in
function freeURLs() { while (blobURLs.length) URL.revokeObjectURL(blobURLs.pop()); }
function loadImgOnce(url) { return new Promise((res, rej) => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = () => rej(new Error('decode')); i.src = url; }); }
/* iPad Safari sometimes loses the file behind a photo blob kept from IndexedDB (often on the 2nd report in a row),
   so try several ways: object URL → bitmap → a fresh copy of the bytes → data URL */
async function loadImg(src) {
  if (!src) throw new Error('圖片資料不存在');
  if (typeof src === 'string') { try { return await loadImgOnce(src); } catch (e) { throw new Error('圖片無法讀取'); } }
  const tryUrl = async b => { const u = URL.createObjectURL(b); try { return await loadImgOnce(u); } catch (e) { URL.revokeObjectURL(u); throw e; } };
  try { return await tryUrl(src); } catch (e) { }
  if (window.createImageBitmap) { try { const bm = await createImageBitmap(src); bm.naturalWidth = bm.width; bm.naturalHeight = bm.height; return bm; } catch (e) { } }
  let bytes = null; try { bytes = await src.arrayBuffer(); } catch (e) { }
  if (bytes && bytes.byteLength) {
    const fresh = new Blob([bytes], { type: src.type || 'image/jpeg' });
    try { return await tryUrl(fresh); } catch (e) { }
    try { return await loadImgOnce(await blobToDataURL(fresh)); } catch (e) { }
  }
  throw new Error(`圖片無法讀取（${src.type || '未知格式'}，${Math.round((src.size || 0) / 1024)} KB${bytes ? '' : '，檔案已失效'}）`);
}
/* iOS Safari moves a photo to a new file whenever its record is written again, and the Blob still held in
   memory then points at the old, deleted file ("檔案已失效") while storage keeps a good copy. So every write
   of a record re-reads its photo handles straight away, and anything that has to read a photo can fall
   back to the stored copy. */
const allPhotos = it => [...(it.photos || []), ...((it.fix && it.fix.photos) || [])];
async function refreshPhotos(it) {
  let f = null; try { f = await DB.get('items', it.id); } catch (e) { return; } if (!f) return;
  const byId = new Map(allPhotos(f).map(p => [p.id, p]));
  for (const p of allPhotos(it)) { const q = byId.get(p.id); if (q) { if (q.orig) p.orig = q.orig; if (q.out) p.out = q.out; } }
}
/* per-field edit times, so merging copies from several devices keeps each field's latest edit instead of
   letting a newer copy of the whole record wipe, say, a 分判 set on another device.
   fs = signature of each field group as last saved, fm = time a group was last really edited */
const FG = { note: it => it.note || '', sub: it => subText(it), code: it => [it.code, it.ord, it.origLabel],
  loc: it => [it.drawingId, it.x, it.y, it.loc, it.locText, it.locEdited], round: it => it.round || '',
  fix: it => it.fix ? [it.fix.status, it.fix.reply || '', it.fix.done || 0, it.fix.by || '', (it.fix.photos || []).map(p => [p.id, p.shapes])] : null };
const sigOf = (it, g) => { const t = JSON.stringify(FG[g](it)) || ''; let h = 5381; for (let i = 0; i < t.length; i++) h = (h * 33 + t.charCodeAt(i)) | 0; return h.toString(36) + t.length; };
const sigsOf = it => Object.fromEntries(Object.keys(FG).map(g => [g, sigOf(it, g)]));
function stampEdits(it) {
  const now = Date.now(); it.fm = it.fm || {};
  if (!it.fs) { it.fs = sigsOf(it); return; }
  for (const g of Object.keys(FG)) { const sg = sigOf(it, g); if (it.fs[g] !== sg) { it.fm[g] = now; it.fs[g] = sg; } }
}
async function saveItem(it, merged) { if (merged) it.fs = sigsOf(it); else stampEdits(it); await DB.put('items', it); await refreshPhotos(it); }
async function canRead(b) { if (!(b instanceof Blob) || !b.size) return false; try { return (await b.slice(0, 64).arrayBuffer()).byteLength > 0; } catch (e) { return false; } }
// a readable copy of a photo's marked-up image: memory, then storage, then the original
async function photoOut(it, ph) {
  if (await canRead(ph.out)) return ph.out;
  await refreshPhotos(it); if (await canRead(ph.out)) return ph.out;
  if (await canRead(ph.orig)) return ph.shapes && ph.shapes.length ? renderOut(ph.orig, ph.shapes) : ph.orig;
  return ph.out;
}
/* re-read records from IndexedDB before a report, so every photo comes with a fresh, valid file handle */
async function freshItems(items) { const out = []; for (const it of items) { let f = null; try { f = await DB.get('items', it.id); } catch (e) { } out.push(f && f.photos ? f : it); } return out; }
// Android has no "save image" target in the share sheet: a plain download lands in Download/, which the gallery shows
const IS_ANDROID = /Android/i.test(navigator.userAgent);
// iPadOS reports itself as a Mac; touch points tell them apart
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// only phones and tablets get the share sheet; on a computer (Windows' share dialog cannot save a file) files download
function saveFile(blob, filename) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000); }
const canvasBlob = (c, type = 'image/jpeg', q = 0.86) => new Promise(r => c.toBlob(r, type, q));
async function shrink(blob, max) { const img = await loadImg(blob); const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)); if (k >= 1) { URL.revokeObjectURL(img.src); return blob; } const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src); return canvasBlob(c, 'image/jpeg', 0.8); }
const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();
function curD() { return S.drawings.find(d => d.id === S.cur) || null; }
// drawing sets shown one at a time (top-bar switch); drawings imported on the device join the set that was showing
const SETS = [
  { id: 'gbp', name: '建築', mapping: 'gbp/mapping.json', size: '20 MB', fileRef: '20260708_BD_GBP 13th Amd Approval Drawing', works: "BUILDER'S WORKS" },
  { id: 'drainage', name: '渠務', mapping: 'gbp/drainage-mapping.json', size: '36 MB', fileRef: '20260921_7th Drainage Amendment Approval Drawing', works: 'DRAINAGE WORKS' }];
const curSet = () => SETS.some(x => x.id === S.settings.set) ? S.settings.set : 'gbp';
const setName = (k = curSet()) => (SETS.find(x => x.id === k) || SETS[0]).name;
const setOf = d => (d && d.set) || 'gbp';
const setDrawings = () => S.drawings.filter(d => setOf(d) === curSet());
async function saveKV() { for (const k of ['project', 'settings', 'floorSel', 'recentAreas']) await DB.kset(k, S[k]); }
const sheetMQ = matchMedia('(max-width:700px), (orientation:portrait) and (max-width:1100px)');
const panelOpen = () => !$('#panel').hidden;

/* ---------------- PDF ---------------- */
const pdfDocs = new Map();
async function getPdf(fileId) {
  if (pdfDocs.has(fileId)) return pdfDocs.get(fileId);
  const f = await DB.get('files', fileId); if (!f) throw new Error('找不到圖紙原檔');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  const p = pdfjsLib.getDocument({ data: new Uint8Array(await f.blob.arrayBuffer()) }).promise;
  pdfDocs.set(fileId, p); return p;
}
async function renderRegion(d, rx, ry, rw, rh, outW) {
  const outH = Math.round(outW * rh / rw);
  const c = document.createElement('canvas'); c.width = outW; c.height = outH; const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH);
  if (d.kind === 'pdf') {
    const page = await (await getPdf(d.fileId)).getPage(d.page); const s = outW / rw;
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: s, offsetX: -rx * s, offsetY: -ry * s }) }).promise;
    page.cleanup();
  } else {
    const img = await drawingImg(d); const k = img.naturalWidth / d.w;
    ctx.drawImage(img, rx * k, ry * k, rw * k, rh * k, 0, 0, outW, outH);
  }
  return c;
}
/* the preview image is only a backdrop: zoomed-in detail is re-rendered from the PDF, so keep it modest
   (iPad Safari silently returns a blank canvas when it runs short of memory) */
function blankCanvas(c) {
  const x = c.getContext('2d'); let dark = 0;
  for (let i = 0; i < 400; i++) { const px = x.getImageData(Math.floor(Math.random() * c.width), Math.floor(Math.random() * c.height), 1, 1).data; if (px[3] > 0 && (px[0] < 200 || px[1] < 200 || px[2] < 200)) dark++; }
  // also scan a few full rows: drawings are mostly white, so random samples can miss thin lines
  for (const fy of [0.3, 0.5, 0.7]) { const row = x.getImageData(0, Math.floor(c.height * fy), c.width, 1).data; for (let i = 0; i < row.length; i += 4) if (row[i + 3] > 0 && row[i] < 160) { dark++; break; } }
  return dark === 0;
}
const suspectBase = d => d.base && (!d.base.blob || !d.base.blob.size || d.base.blob.size / (d.w * d.h * d.base.scale * d.base.scale) < 0.012 || d.base.v !== 2);
async function ensureBase(d, quiet, force) {
  if (d.kind !== 'pdf') return;
  if (d.base && !force && !suspectBase(d)) return;
  if (!quiet) busy(`正在準備圖紙「${d.name}」…`);
  try {
    let err;
    for (const mp of [7e6, 4e6, 2e6]) {
      const s = Math.min(1, Math.sqrt(mp / (d.w * d.h)));
      try {
        const c = await renderRegion(d, 0, 0, d.w, d.h, Math.floor(d.w * s));
        if (blankCanvas(c)) { c.width = c.height = 0; err = new Error('圖紙渲染結果空白'); continue; }
        const blob = await canvasBlob(c, 'image/jpeg', 0.85); c.width = c.height = 0;
        if (!blob || !blob.size) { err = new Error('圖紙轉換失敗'); continue; }
        d.base = { blob, scale: s, v: 2 }; d.thumb = null;
        const cc = imgCache.get(d.id); if (cc) { URL.revokeObjectURL(cc.url); imgCache.delete(d.id); }
        await DB.put('drawings', d); try { await makeThumb(d); } catch (e) { } return;
      } catch (e) { err = e; }
    }
    throw err || new Error('圖紙轉換失敗');
  } finally { if (!quiet) busy(); }
}

/* ---------------- geometry / location ---------------- */
function inPoly(x, y, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function area(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); }
const inBox = (x, y, b) => x >= b[0] && y >= b[1] && x <= b[2] && y <= b[3];
function viewAt(d, x, y) { const v = (d.views || []).filter(v => inBox(x, y, v.bbox)).sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])); return v[0] || null; }
function viewById(d, id) { return (d.views || []).find(v => v.id === id) || null; }
const stripPre = l => String(l).replace(/^T\d+-/, '');
function span(lines, v, other) {
  if (!lines || !lines.length) return '';
  let s = lines.filter(l => l.from == null || (other >= l.from - 30 && other <= l.to + 30));
  if (!s.length) s = lines;
  s = [...s].sort((a, b) => a.pos - b.pos);
  if (s.length === 1) return stripPre(s[0].label); // part plans often show a single grid line
  if (v < s[0].pos) return `${stripPre(s[0].label)}外`;
  for (let i = 0; i < s.length - 1; i++) if (v >= s[i].pos && v <= s[i + 1].pos) { const p = [stripPre(s[i].label), stripPre(s[i + 1].label)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })); return `${p[0]}-${p[1]}`; }
  return `${stripPre(s[s.length - 1].label)}外`;
}
function floorFor(v) { if (!v) return ''; const f = S.floorSel[v.id]; return f && (!v.floors.length || v.floors.includes(f)) ? f : (v.floors[0] || ''); }
function resolveLoc(d, x, y) {
  const v = viewAt(d, x, y);
  const L = { viewId: v ? v.id : '', tower: v ? v.tower || '' : '', floor: floorFor(v), flat: '', room: '', area: '', grid: '', zoneIds: [] };
  if (!v) return L;
  const all = (v.zones || []).filter(z => inPoly(x, y, z.pts));
  const tz = all.find(z => z.kind === 'tower'); if (tz) L.tower = tz.name;
  const hits = all.filter(z => z.kind !== 'tower').sort((a, b) => area(a.pts) - area(b.pts));
  const first = hits[0];
  if (first && first.kind === 'area') { L.area = first.name; if (first.tower) L.tower = first.tower; if (first.floor) L.floor = first.floor; L.zoneIds = [first.id]; }
  else {
    const fz = hits.find(z => z.kind === 'flat');
    const rz = hits.find(z => z.kind === 'room' && (!fz || !z.flat || (z.flat === fz.name && (!z.tower || !fz.tower || z.tower === fz.tower))));
    if (fz) { L.flat = fz.name; L.zoneIds.push(fz.id); if (fz.tower) L.tower = fz.tower; }
    if (rz) { L.room = rz.name; L.zoneIds.push(rz.id); if (!fz && rz.flat) L.flat = rz.flat; if (!fz && rz.tower) L.tower = rz.tower; }
  }
  const gx = span(v.gx, x, y), gy = span(v.gy, y, x);
  if (gx || gy) L.grid = [gy, gx].filter(Boolean).join('/');
  return L;
}
function indexText(L) { return [L.tower, L.floor, L.flat ? 'FLAT ' + L.flat : '', L.room || L.area].filter(Boolean).join('-'); }
function fmtLoc(L) { const i = indexText(L); return [i, L.grid ? 'Grid ' + L.grid : ''].filter(Boolean).join('　'); }
function nextNo() { const d = S.settings.dev || 'A'; return S.items.filter(i => devOf(i) === d && inRound(i)).reduce((m, i) => Math.max(m, i.no || 0), 0) + 1; }
function nextLabel(lines, axis) {
  if (!lines.length) return axis === 'gx' ? '1' : 'A';
  const last = [...lines].sort((a, b) => a.pos - b.pos).pop().label; const pre = (last.match(/^T\d+-/) || [''])[0], core = last.slice(pre.length);
  if (/^\d+$/.test(core)) return pre + (+core + 1);
  if (/^[A-Z]$/i.test(core)) { let c = core.toUpperCase().charCodeAt(0) + 1; if (c === 73) c++; return pre + String.fromCharCode(Math.min(c, 90)); }
  return last + "'";
}
function parseFloors(str) {
  const out = []; const skip = new Set();
  const m = String(str || '').match(/(?:略過|skip)\s*([\d,\s]+)/i); if (m) m[1].split(/[,\s]+/).filter(Boolean).forEach(n => skip.add(+n));
  String(str || '').replace(/(?:略過|skip)\s*[\d,\s]+/i, '').split(/[,，\s]+/).filter(Boolean).forEach(t => {
    const r = t.match(/^(\d+)\s*[-~至]\s*(\d+)F?$/i);
    if (r) { for (let n = +r[1]; n <= +r[2]; n++) if (!skip.has(n)) out.push(n + 'F'); }
    else if (/^\d+$/.test(t)) out.push(t + 'F'); else out.push(t.toUpperCase());
  });
  return out;
}
const floorsToText = f => (f || []).join(', ');

/* ---------------- view / rendering ---------------- */
const stage = $('#stage'), board = $('#board'), dwg = $('#dwg'), ov = $('#ov'), hires = $('#hires');
let raf = 0, hiT = 0;
/* each drawing can be turned in quarter turns (clockwise). S.view maps the turned drawing to the screen;
   pins, zones and records always keep plain drawing coordinates, so reports are unaffected */
const rotOf = d => (d && S.rots[d.id]) || 0;
const rotDims = d => rotOf(d) % 2 ? [d.h, d.w] : [d.w, d.h];
function fwd(d, x, y) { const r = rotOf(d); return r === 1 ? { x: d.h - y, y: x } : r === 2 ? { x: d.w - x, y: d.h - y } : r === 3 ? { x: y, y: d.w - x } : { x, y }; }
function inv(d, x, y) { const r = rotOf(d); return r === 1 ? { x: y, y: d.h - x } : r === 2 ? { x: d.w - x, y: d.h - y } : r === 3 ? { x: d.w - y, y: x } : { x, y }; }
// the same turn as fwd(), written as a transform: [dx, dy, degrees]
function rotT(d) { const r = rotOf(d); return [r === 1 ? d.h : r === 2 ? d.w : 0, r === 2 ? d.h : r === 3 ? d.w : 0, r * 90]; }
// the overlay sits outside the zoomed board and maps drawing coordinates through its viewBox, so the
// browser draws pins and numbers at screen resolution instead of enlarging a bitmap
function ovFrame() { const r = stageRect(), k = S.view.k || 1; ov.setAttribute('viewBox', `${-S.view.x / k} ${-S.view.y / k} ${r.width / k} ${r.height / k}`); }
let viewSaveT = 0, stageWas = null;
function applyView() {
  if (!stageWas) { const r = stageRect(); if (r.width) stageWas = { w: r.width, h: r.height }; }
  clearTimeout(viewSaveT); viewSaveT = setTimeout(() => { if (S.cur) { S.views[S.cur] = { ...S.view }; DB.kset('views', S.views); } }, 400);
  const [tx, ty, deg] = rotT(curD() || {});
  board.style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})` + (deg ? ` translate(${tx}px,${ty}px) rotate(${deg}deg)` : ''); ovFrame(); placeHires();
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderOverlay(); });
  clearTimeout(hiT); hiT = setTimeout(renderHires, 220);
}
function stageRect() { return stage.getBoundingClientRect(); }
function toDwg(cx, cy) { const r = stageRect(); return inv(curD() || {}, (cx - r.left - S.view.x) / S.view.k, (cy - r.top - S.view.y) / S.view.k); }
function visibleArea() {
  const r = stageRect(); const pw = (panelOpen() && !sheetMQ.matches) ? 400 : 0, ph = (panelOpen() && sheetMQ.matches) ? r.height * 0.55 : 0;
  return { w: r.width - pw, h: r.height - ph, top: 60 };
}
function fitBox(b) {
  const A = visibleArea(); const W = A.w, H = A.h - A.top; const bw = b[2] - b[0], bh = b[3] - b[1];
  const k = Math.min(W / bw, H / bh) * 0.94; S.view = { k, x: (W - bw * k) / 2 - b[0] * k, y: A.top + (H - bh * k) / 2 - b[1] * k }; applyView();
}
function fit() { const d = curD(); if (d) fitBox([0, 0, ...rotDims(d)]); }
function zoomAt(f, cx, cy) {
  const r = stageRect(); cx ??= r.width / 2; cy ??= r.height / 2;
  const k = clamp(S.view.k * f, 0.03, 12); const px = (cx - S.view.x) / S.view.k, py = (cy - S.view.y) / S.view.k;
  S.view = { k, x: cx - px * k, y: cy - py * k }; applyView();
}
function centerOn(x, y, k) { ({ x, y } = fwd(curD() || {}, x, y)); const A = visibleArea(); k = k || S.view.k; S.view = { k, x: A.w / 2 - x * k, y: 30 + A.h / 2 - y * k }; applyView(); }
function ensureVisible(p) {
  const A = visibleArea(), q = fwd(curD() || {}, p.x, p.y); const sx = S.view.x + q.x * S.view.k, sy = S.view.y + q.y * S.view.k;
  if (sx < 30 || sy < 70 || sx > A.w - 30 || sy > A.h - 30) centerOn(p.x, p.y);
}

/* sharp rendering of the visible area once zoomed past the base image resolution.
   The canvas sits outside the scaled board and is sized in screen pixels: iPad Safari rasterises a
   will-change:transform layer once and then just magnifies that bitmap, which blurred the sharp render. */
let hiTask = null, hiSeq = 0, hiBox = null;
function placeHires() {
  if (!hiBox) return; const k = S.view.k, [x0, y0, x1, y1] = hiBox;
  Object.assign(hires.style, { left: (S.view.x + x0 * k) + 'px', top: (S.view.y + y0 * k) + 'px', width: ((x1 - x0) * k) + 'px', height: ((y1 - y0) * k) + 'px' });
}
async function renderHires() {
  const d = curD(); if (!d || d.kind !== 'pdf' || !d.base) { hires.hidden = true; return; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2); const s = S.view.k * dpr;
  if (s <= d.base.scale * 1.15) { hires.hidden = true; return; }
  const r = stageRect(), [rw, rh] = rotDims(d);
  const X0 = Math.max(0, -S.view.x / S.view.k), Y0 = Math.max(0, -S.view.y / S.view.k);
  const X1 = Math.min(rw, (r.width - S.view.x) / S.view.k), Y1 = Math.min(rh, (r.height - S.view.y) / S.view.k);
  if (X1 <= X0 || Y1 <= Y0) return;
  const a = inv(d, X0, Y0), b = inv(d, X1, Y1), x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), rot = rotOf(d);
  let sc = s; const maxPx = 6e6; if ((x1 - x0) * (y1 - y0) * sc * sc > maxPx) sc = Math.sqrt(maxPx / ((x1 - x0) * (y1 - y0)));
  const seq = ++hiSeq;
  try {
    if (hiTask) { hiTask.cancel(); hiTask = null; }
    const page = await (await getPdf(d.fileId)).getPage(d.page);
    if (seq !== hiSeq) return;
    const c = document.createElement('canvas'); c.width = Math.ceil((x1 - x0) * sc); c.height = Math.ceil((y1 - y0) * sc);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    hiTask = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: sc, offsetX: -x0 * sc, offsetY: -y0 * sc }) });
    await hiTask.promise; hiTask = null;
    if (seq !== hiSeq || S.cur !== d.id || rot !== rotOf(d)) return;
    // turn the pixels here rather than with CSS, so iPad shows them 1:1
    hires.width = rot % 2 ? c.height : c.width; hires.height = rot % 2 ? c.width : c.height;
    const hx = hires.getContext('2d'); hx.translate(rot === 1 || rot === 2 ? hires.width : 0, rot === 2 || rot === 3 ? hires.height : 0); hx.rotate(rot * Math.PI / 2); hx.drawImage(c, 0, 0); c.width = c.height = 0;
    hiBox = [X0, Y0, X1, Y1]; placeHires(); hires.hidden = false;
  } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.warn(e); }
}

function renderOverlay() {
  const d = curD(); if (!d) { ov.innerHTML = ''; return; }
  const k = S.view.k, u = 1 / k;
  ovFrame();
  const map = S.mode === 'map'; const font = '-apple-system,PingFang TC,sans-serif';
  let h = '';
  const edZ = new Set(S.editing && S.editing.loc ? S.editing.loc.zoneIds || [] : []);
  for (const v of d.views || []) {
    const [bx0, by0, bx1, by1] = v.bbox;
    if (map && d.views.length > 1) h += `<rect x="${bx0}" y="${by0}" width="${bx1 - bx0}" height="${by1 - by0}" fill="none" stroke="#2f7d4f" stroke-width="1.5" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/><text x="${bx0 + 6 * u}" y="${by0 + 16 * u}" font-size="${13 * u}" fill="#2f7d4f" font-weight="700" font-family="${font}">${esc(v.title)}</text>`;
    if (map || S.settings.showZones) for (const z of v.zones || []) {
      const sel = S.sel && S.sel.type === 'zone' && S.sel.id === z.id, ed = edZ.has(z.id);
      const col = z.kind === 'flat' ? '31,111,156' : z.kind === 'area' ? '47,125,79' : z.kind === 'tower' ? '214,120,0' : '212,42,30';
      if (!map && !ed && (z.kind === 'room' || z.kind === 'tower')) continue;
      if (z.kind === 'tower' && !sel) { h += `<polygon points="${z.pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="rgba(214,120,0,.8)" stroke-width="2" stroke-dasharray="14 6" vector-effect="non-scaling-stroke"/><text x="${z.pts[0][0] + 8 * u}" y="${z.pts[0][1] + 18 * u}" font-size="${14 * u}" fill="rgb(214,120,0)" font-weight="700" font-family="${font}">${esc(z.name)} 範圍</text>`; continue; }
      const fa = sel ? 0.22 : ed ? 0.16 : map ? 0.07 : 0.03;
      h += `<polygon points="${z.pts.map(p => p.join(',')).join(' ')}" fill="rgba(${col},${fa})" stroke="rgba(${col},${map || ed ? 0.85 : 0.3})" stroke-width="${sel ? 3 : 1.4}" vector-effect="non-scaling-stroke" ${map ? '' : 'stroke-dasharray="6 4"'}/>`;
      if (map || sel || ed) { const cx = Math.min(...z.pts.map(p => p[0])) + 6 * u, cy = Math.min(...z.pts.map(p => p[1])) + 14 * u; h += `<text x="${cx}" y="${cy}" font-size="${12 * u}" fill="rgb(${col})" stroke="#fff" stroke-width="${3 * u}" paint-order="stroke" font-family="${font}" font-weight="700">${esc(z.kind === 'flat' ? 'FLAT ' + z.name : z.name)}</text>`; }
    }
    const gl = (lines, axis) => {
      for (const g of lines || []) {
        const sel = S.sel && S.sel.type === axis && S.sel.id === g.id; const col = sel ? '#d42a1e' : '#1f6f9c';
        if (!map && !sel) continue;
        const f0 = g.from ?? (axis === 'gx' ? by0 : bx0), f1 = g.to ?? (axis === 'gx' ? by1 : bx1);
        const ln = axis === 'gx' ? `x1="${g.pos}" y1="${f0}" x2="${g.pos}" y2="${f1}"` : `x1="${f0}" y1="${g.pos}" x2="${f1}" y2="${g.pos}"`;
        h += `<line ${ln} stroke="${col}" stroke-width="${sel ? 2.5 : 1.1}" stroke-dasharray="10 5" vector-effect="non-scaling-stroke" opacity=".85"/>`;
        const r = 12 * u, lb = stripPre(g.label); const bx = axis === 'gx' ? g.pos : f0, by = axis === 'gx' ? f0 : g.pos;
        h += `<circle cx="${bx}" cy="${by}" r="${r}" fill="#fff" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/><text x="${bx}" y="${by}" font-size="${(lb.length > 2 ? 9 : 12) * u}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-weight="700" font-family="${font}">${esc(lb)}</text>`;
      }
    };
    gl(v.gx, 'gx'); gl(v.gy, 'gy');
  }
  if (S.draft) {
    if (S.draft.type === 'rect') { const { a, b } = S.draft; h += `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" fill="rgba(242,194,48,.25)" stroke="#b8860b" stroke-width="2" vector-effect="non-scaling-stroke"/>`; }
    if (S.draft.type === 'poly' && S.draft.pts.length) { h += `<polyline points="${S.draft.pts.map(p => p.join(',')).join(' ')}" fill="rgba(242,194,48,.25)" stroke="#b8860b" stroke-width="2" vector-effect="non-scaling-stroke"/>`; S.draft.pts.forEach(q => h += `<circle cx="${q[0]}" cy="${q[1]}" r="${5 * u}" fill="#b8860b"/>`); }
  }
  if (!map) {
    const fixm = S.mode === 'fix';
    let items = S.items.filter(i => i.drawingId === d.id && inRound(i) && onFloor(d, i));
    if (fixm && S.fixOnlyOpen) items = items.filter(i => fixStatus(i) === 'open' || (S.fixItem && S.fixItem.id === i.id));
    const all = !fixm && S.editing && S.editing.drawingId === d.id && !items.find(i => i.id === S.editing.id) ? [...items, S.editing] : items;
    for (const it of all) {
      const act = fixm ? !!(S.fixItem && S.fixItem.id === it.id) : !!(S.editing && S.editing.id === it.id); const r = (act ? 17 : 14) * u;
      // green = 已回復, grey = 不跟進; open records: blue once a 分判 is set, red otherwise
      const st = fixStatus(it), pf = st === 'done' ? '#2f7d4f' : st === 'na' ? '#8a9391' : subsOf(it).length ? '#1f6f9c' : '#d42a1e';
      h += `<circle cx="${it.x}" cy="${it.y}" r="${r}" fill="${pf}" stroke="${act ? '#f2c230' : '#fff'}" stroke-width="${act ? 4 : 2.5}" vector-effect="non-scaling-stroke"/><text x="${it.x}" y="${it.y}" font-size="${(String(it.code ? pinLabel(it, true) : it.no).length > 2 ? 10 : 12.5) * u}" text-anchor="middle" dominant-baseline="central" fill="#fff" font-weight="700" font-family="ui-monospace,Menlo,monospace">${it.code ? pinLabel(it, true) : devOf(it) === (S.settings.dev || 'A') ? it.no : devOf(it) + it.no}</text>`;
    }
  }
  const [tx, ty, deg] = rotT(d);
  // labels stay upright when the drawing is turned
  if (deg) h = `<g transform="translate(${tx} ${ty}) rotate(${deg})">${h.replace(/<text x="([^"]+)" y="([^"]+)"/g, `<text x="$1" y="$2" transform="rotate(${-deg} $1 $2)"`)}</g>`;
  ov.innerHTML = h;
}

// on a plan shared by several floors, only records of the selected floor are shown (and tappable)
function onFloor(d, it) { const v = viewById(d, it.loc && it.loc.viewId); return !v || !v.floors || v.floors.length <= 1 || !it.loc.floor || it.loc.floor === floorFor(v); }
function showFloorOf(it) { const d = S.drawings.find(x => x.id === it.drawingId); const v = d && viewById(d, it.loc && it.loc.viewId); if (v && v.floors && v.floors.length > 1 && it.loc.floor && v.floors.includes(it.loc.floor)) { S.floorSel[v.id] = it.loc.floor; DB.kset('floorSel', S.floorSel); } }
function multiFloorViews(d) { return d ? (d.views || []).filter(v => v.floors && v.floors.length > 1) : []; }
function updateBar() {
  const d = curD();
  $('#curName').textContent = d ? d.name : (S.project.name || '竣工驗收記錄');
  $('#curSub').textContent = d ? [d.no, S.project.name].filter(Boolean).join('　') : '';
  $('#cnt').textContent = roundItems().length;
  $('#btnRound').textContent = shortRound(curRound());
  document.querySelectorAll('#setSeg [data-set]').forEach(b => b.setAttribute('aria-pressed', b.dataset.set === curSet()));
  const ub = unbacked(); $('#btnExport').innerHTML = '導出' + (ub ? `<span class="n" title="未備份">${ub}</span>` : '');
  $('#mInspect').setAttribute('aria-pressed', S.mode === 'inspect'); $('#mMap').setAttribute('aria-pressed', S.mode === 'map');
  const mv = multiFloorViews(d);
  $('#btnFloor').hidden = !mv.length || S.mode === 'map';
  if (mv.length) $('#btnFloor').innerHTML = `樓層 <b>${esc(mv.map(v => floorFor(v)).filter((f, i, a) => a.indexOf(f) === i).join('/'))}</b>`;
  // zones and grids of the bundled plans come with the package; 位置設定 is only offered for drawings imported on the device
  $('#mMap').hidden = !d || d.src === 'bundle';
  document.body.classList.toggle('inspectOnly', $('#mMap').hidden && S.mode === 'inspect');
  if (S.mode === 'map' && (!d || d.src === 'bundle')) { S.mode = 'inspect'; S.draft = null; renderOverlay(); }
  $('#maptools').hidden = S.mode !== 'map' || !d;
  document.querySelectorAll('#maptools [data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
  const poly = S.mode === 'map' && S.tool === 'poly';
  $('#polyDone').hidden = !poly || !S.draft || S.draft.pts.length < 3; $('#polyUndo').hidden = !poly || !S.draft || !S.draft.pts.length;
  $('#empty').hidden = !!d; $('#zoombtns').hidden = !d;
  const hints = { select: '點選區域或軸線可修改；兩指縮放、拖動', rect: '在圖上拖出矩形，框住單位、房間或區域', poly: '逐點點選邊界，完成後按「完成多邊形」', gx: '在每條縱向軸線上點一下（會自動編號）', gy: '在每條橫向軸線上點一下（會自動編號）' };
  const hint = $('#hint');
  hint.textContent = !d ? '' : S.mode === 'map' ? hints[S.tool] : S.mode === 'fix' ? (S.fixItem ? `${itemLabel(S.fixItem)}：${S.fixItem.locText || ''}` : (c => `執修（${roundLabel()}）：未完成 ${c.open}／共 ${c.all}　點選紅點處理`)(fixCounts())) : (S.editing ? `${itemLabel(S.editing)}：${S.editing.locText || '未設定位置'}` : '點選圖上的問題位置 → 拍照');
  hint.hidden = !d;
}

async function showDrawing(id) {
  S.cur = id; S.sel = null; S.draft = null; hires.hidden = true; hiSeq++; const d = curD(); updateBar();
  if (!d) { dwg.removeAttribute('src'); ov.innerHTML = ''; return; }
  try { await ensureBase(d); } catch (e) { busy(); toast('圖紙準備失敗：' + e.message, 5000); return; }
  let c = imgCache.get(d.id);
  if (!c) { c = { url: URL.createObjectURL(d.kind === 'pdf' ? d.base.blob : d.blob) }; imgCache.set(d.id, c); }
  dwg.src = c.url; dwg.style.width = d.w + 'px'; dwg.style.height = d.h + 'px';
  const ok = await new Promise(r => { if (dwg.complete && dwg.naturalWidth) r(true); else { dwg.onload = () => r(true); dwg.onerror = () => r(false); } });
  if (!ok && d.kind === 'pdf' && !d._retried) { d._retried = true; URL.revokeObjectURL(c.url); imgCache.delete(d.id); try { await ensureBase(d, false, true); } catch (e) { toast('圖紙準備失敗：' + e.message, 5000); } return showDrawing(id); }
  const fv = (d.views || []).length > 0 && d.views.length <= 1 ? null : null;
  const sv = S.views[id]; if (sv && sv.k) { S.view = { ...sv }; applyView(); } else fit();
  DB.kset('cur', id);
}
async function drawingImg(d) {
  const c = imgCache.get(d.id); if (c && c.img) return c.img;
  const url = c ? c.url : URL.createObjectURL(d.kind === 'pdf' ? d.base.blob : d.blob);
  const img = await loadImg(url); imgCache.set(d.id, { url, img }); return img;
}

/* ---------------- stage gestures ---------------- */
const ptrs = new Map(); let g = null;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
stage.addEventListener('pointerdown', e => {
  if (!curD()) return;
  stage.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const r = stageRect();
  if (ptrs.size === 1) {
    g = { type: 'one', sx: e.clientX, sy: e.clientY, t: Date.now(), vx: S.view.x, vy: S.view.y, moved: false };
    if (S.mode === 'map' && S.tool === 'rect') { const p = toDwg(e.clientX, e.clientY); g.draw = true; S.draft = { type: 'rect', a: p, b: p }; }
  } else if (ptrs.size === 2) {
    if (g && g.draw) S.draft = null;
    const [a, b] = [...ptrs.values()];
    g = { type: 'pinch', d0: dist(a, b), mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top, k0: S.view.k, x0: S.view.x, y0: S.view.y };
  }
});
stage.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId) || !g) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.type === 'one') {
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (Math.hypot(dx, dy) > 8) g.moved = true;
    if (g.draw) { S.draft.b = toDwg(e.clientX, e.clientY); renderOverlay(); }
    else if (g.moved) { S.view.x = g.vx + dx; S.view.y = g.vy + dy; applyView(); }
  } else if (g.type === 'pinch' && ptrs.size >= 2) {
    const r = stageRect(); const [a, b] = [...ptrs.values()];
    const k = clamp(g.k0 * dist(a, b) / g.d0, 0.03, 12);
    const px = (g.mx - g.x0) / g.k0, py = (g.my - g.y0) / g.k0;
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    S.view = { k, x: mx - px * k, y: my - py * k }; applyView();
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (!g) return;
  if (g.type === 'one' && ptrs.size === 0) {
    if (g.draw) finishRect();
    else if (!g.moved && Date.now() - g.t < 700 && e.type === 'pointerup') onTap(e.clientX, e.clientY);
    g = null;
  } else if (g.type === 'pinch' && ptrs.size < 2) { g = ptrs.size ? { type: 'dead' } : null; }
  else if (g.type === 'dead' && ptrs.size === 0) g = null;
}
stage.addEventListener('pointerup', endPtr); stage.addEventListener('pointercancel', endPtr);
stage.addEventListener('wheel', e => { e.preventDefault(); const r = stageRect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
// page itself never zooms: only the drawing does (iOS ignores user-scalable=no)
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1 && !stage.contains(e.target)) e.preventDefault(); }, { passive: false });


function onTap(cx, cy) {
  const d = curD(); if (!d) return;
  const p = toDwg(cx, cy); const u = 1 / S.view.k;
  if (p.x < 0 || p.y < 0 || p.x > d.w || p.y > d.h) return;
  if (S.mode === 'fix') {
    const hit = S.items.filter(i => i.drawingId === d.id && inRound(i) && (!S.fixOnlyOpen || fixStatus(i) === 'open')).map(i => ({ i, dd: Math.hypot(i.x - p.x, i.y - p.y) })).filter(o => o.dd < 22 * u).sort((a, b) => a.dd - b.dd)[0];
    if (hit) { fixPanel(hit.i); renderOverlay(); updateBar(); return; }
    return toast('執修模式：請點選圖上已有的紅點');
  }
  if (S.mode === 'inspect') {
    const hit = S.items.filter(i => i.drawingId === d.id && inRound(i) && onFloor(d, i)).map(i => ({ i, dd: Math.hypot(i.x - p.x, i.y - p.y) })).filter(o => o.dd < 22 * u).sort((a, b) => a.dd - b.dd)[0];
    if (hit) return openItem(hit.i);
    return newItem(p);
  }
  const v = viewAt(d, p.x, p.y);
  if (S.tool === 'poly') { if (!v && !(S.draft && S.draft.pts.length)) return toast('請在平面圖範圍內點選'); if (!S.draft || S.draft.type !== 'poly') S.draft = { type: 'poly', pts: [] }; S.draft.pts.push([Math.round(p.x), Math.round(p.y)]); renderOverlay(); updateBar(); return; }
  if (S.tool === 'gx' || S.tool === 'gy') {
    if (!v) return toast('請在平面圖範圍內點選');
    const ax = S.tool; v[ax] = v[ax] || [];
    const line = { id: uid(), label: nextLabel(v[ax], ax), pos: Math.round(ax === 'gx' ? p.x : p.y) };
    v[ax].push(line); saveDrawing(d); S.sel = { type: ax, id: line.id }; renderOverlay(); openGrid(d, v, ax, line, true); return;
  }
  if (!v) { S.sel = null; renderOverlay(); return closePanel(); }
  const near = [];
  for (const ax of ['gx', 'gy']) for (const l of v[ax] || []) { const dd = Math.abs((ax === 'gx' ? p.x : p.y) - l.pos); if (dd < 14 * u) near.push({ ax, l, dd }); }
  near.sort((a, b) => a.dd - b.dd);
  if (near[0]) { S.sel = { type: near[0].ax, id: near[0].l.id }; renderOverlay(); return openGrid(d, v, near[0].ax, near[0].l); }
  const z = (v.zones || []).filter(z => inPoly(p.x, p.y, z.pts)).sort((a, b) => area(a.pts) - area(b.pts))[0];
  if (z) { S.sel = { type: 'zone', id: z.id }; renderOverlay(); return openZone(d, v, z); }
  S.sel = null; renderOverlay(); closePanel();
}
function finishRect() {
  const d = curD(); const { a, b } = S.draft; S.draft = null;
  const x1 = Math.round(Math.min(a.x, b.x)), x2 = Math.round(Math.max(a.x, b.x)), y1 = Math.round(Math.min(a.y, b.y)), y2 = Math.round(Math.max(a.y, b.y));
  if ((x2 - x1) * S.view.k < 12 || (y2 - y1) * S.view.k < 12) { renderOverlay(); return; }
  addZone(d, [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
}
function addZone(d, pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const v = viewAt(d, cx, cy); if (!v) { renderOverlay(); return toast('區域要畫在平面圖範圍內'); }
  const inFlat = (v.zones || []).find(z => z.kind === 'flat' && inPoly(cx, cy, z.pts));
  const z = { id: uid(), name: '', kind: inFlat ? 'room' : (v.tower && v.floors.length > 1 ? 'flat' : 'area'), flat: inFlat ? inFlat.name : '', tower: '', floor: '', pts };
  v.zones = v.zones || []; v.zones.push(z); saveDrawing(d); S.sel = { type: 'zone', id: z.id }; renderOverlay(); openZone(d, v, z, true);
}
async function saveDrawing(d) { await DB.put('drawings', d); }

/* ---------------- panels ---------------- */
const panel = $('#panel');
function openPanel(kind, title, body, opts = {}) {
  S.panel = kind;
  panel.innerHTML = `<div class="ph">${opts.badge || ''}<h2>${title}</h2><button class="x" data-a="close" aria-label="關閉">✕</button></div><div class="pb">${body}</div>`;
  panel.hidden = false; document.body.classList.add('pnl'); panel.classList.toggle('compact', !!opts.compact);
  panel.querySelector('[data-a="close"]').onclick = () => closePanel();
}
function closePanel() {
  if (S.panel === 'item') finishItem();
  if (S.panel === 'fix') S.fixItem = null;
  panel.hidden = true; document.body.classList.remove('pnl'); S.panel = null; S.sel = null; freeURLs(); renderOverlay(); updateBar();
}

/* ---- items ---- */
function newItem(p) {
  if (S.editing) finishItem();
  const d = curD(); const loc = resolveLoc(d, p.x, p.y);
  S.editing = { id: uid(), round: curRound().id, dev: S.settings.dev || 'A', by: S.settings.inspector || '', drawingId: d.id, no: nextNo(), x: Math.round(p.x), y: Math.round(p.y), loc, locText: fmtLoc(loc), locEdited: false, photos: [], note: '', created: Date.now(), _new: true };
  renderOverlay(); itemPanel(); updateBar(); ensureVisible(p);
  if (S.settings.autoCam) $('#camInput').click();
}
/* office pass: walk through the records in list order without going back to the list */
function navPos(it) { const L = roundItems().sort(byOrder); const i = L.findIndex(x => x.id === it.id); const left = L.filter(x => !(x.note || '').trim()).length, noSub = L.filter(x => !subsOf(x).length).length; return i < 0 ? '' : `第 ${i + 1}／${L.length} 項　·　未填描述 ${left} 項　·　未指定分判 ${noSub} 項`; }
function stepItem(it, how) {
  const L = roundItems().sort(byOrder); const i = L.findIndex(x => x.id === it.id); if (i < 0) return;
  let nx = null;
  if (how === 'prev') nx = L[i - 1];
  else if (how === 'next') nx = L[i + 1];
  else if (how === 'nextNoSub') nx = [...L.slice(i + 1), ...L.slice(0, i)].find(x => !subsOf(x).length);
  else nx = [...L.slice(i + 1), ...L.slice(0, i)].find(x => !(x.note || '').trim());
  if (!nx) return toast(how === 'prev' ? '已是第一項' : how === 'next' ? '已是最後一項' : how === 'nextNoSub' ? (subsOf(it).length ? '全部記錄都已指定分判' : '只剩這一項未指定分判') : ((it.note || '').trim() ? '全部記錄都已填描述' : '只剩這一項未填描述'));
  panel.querySelectorAll('.nav .btn').forEach(b => b.disabled = true); // the old panel stays up while another drawing loads
  finishItem(); S.editing = nx; showFloorOf(nx);
  const go = () => { itemPanel(); centerOn(nx.x, nx.y, Math.max(S.view.k, 1)); const n = $('#fNote'); if (n && !(nx.note || '').trim()) n.focus(); };
  if (S.cur !== nx.drawingId) showDrawing(nx.drawingId).then(go); else go();
}
function openItem(it) { if (S.editing && S.editing.id !== it.id) finishItem(); S.editing = it; showFloorOf(it); if (S.cur !== it.drawingId) showDrawing(it.drawingId).then(() => { centerOn(it.x, it.y, 1); itemPanel(); }); else { itemPanel(); renderOverlay(); } }
function relocate(it) { if (!it.locEdited) it.locText = fmtLoc(it.loc); }
function itemPanel() {
  freeURLs();
  const it = S.editing; const d = S.drawings.find(x => x.id === it.drawingId); const L = it.loc;
  const v = d ? viewById(d, L.viewId) : null;
  const towers = [...new Set(S.drawings.flatMap(x => (x.views || []).map(v => v.tower)).filter(Boolean))];
  const floors = v && v.floors.length ? v.floors : [];
  const flats = v ? [...new Set((v.zones || []).filter(z => z.kind === 'flat' && (!z.tower || z.tower === L.tower)).map(z => z.name))].sort() : [];
  const roomOpts = [...new Set([...(v ? (v.zones || []).filter(z => z.kind === 'room' && (!L.flat || z.flat === L.flat) && (!z.tower || z.tower === L.tower)).map(z => z.name) : []), ...ROOMS])];
  const sel = (id, opts, val, blank) => `<select id="${id}">${blank !== undefined ? `<option value="">${blank}</option>` : ''}${opts.map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}${val && !opts.includes(val) ? `<option selected>${esc(val)}</option>` : ''}</select>`;
  const photos = it.photos.map((ph, i) => `<div class="ph1"><img src="${burl(ph.out)}" data-a="ed" data-i="${i}" alt="照片 ${i + 1}"><button class="del" data-a="delph" data-i="${i}" aria-label="刪除照片">✕</button><span class="ed">點擊修改標記</span></div>`).join('');
  const after = ((it.fix && it.fix.photos) || []).map((ph, i) => `<div class="ph1" style="outline:2px solid var(--ok)"><img src="${burl(ph.out)}" data-a="edA" data-i="${i}" alt="回復 ${i + 1}"><button class="del" data-a="delA" data-i="${i}" aria-label="刪除照片">✕</button><span class="ed" style="background:var(--ok)">回復 ${i + 1}</span></div>`).join('');
  openPanel('item', esc(v ? v.title : (d ? d.name : '')), `
    <div class="idx">${esc(it.locText || '未設定位置')}</div>
    <div class="grid3">
      <label class="f">座${sel('fTower', towers, L.tower, '—')}</label>
      <label class="f">層${floors.length ? sel('fFloor', floors, L.floor) : `<input id="fFloor" value="${esc(L.floor)}" placeholder="例如 GF">`}</label>
      <label class="f">單位${sel('fFlat', flats, L.flat, '非單位')}</label>
    </div>
    ${L.flat ? `<div class="f-l">房間</div><div class="chips pick" id="fRooms">${roomOpts.map(r => `<button class="chip ${r === L.room ? 'on' : ''}" data-room="${esc(r)}">${esc(r)}</button>`).join('')}</div>`
      : `<label class="f">區域名稱（如 Lift Lobby、平台花園）<input id="fArea" list="areaList" value="${esc(L.area)}"><datalist id="areaList">${S.recentAreas.map(a => `<option value="${esc(a)}">`).join('')}</datalist></label>`}
    ${L.grid ? `<div class="chips"><span class="chip">Grid <b>${esc(L.grid)}</b></span></div>` : ''}
    <div class="photos">${photos}</div>
    <div class="row"><label class="btn p" for="camInput">拍照</label><label class="btn" for="libInput">從相簿加入</label><label class="btn g" for="fixCam" data-a="reply">回復</label></div>
    ${after ? `<div class="f-l">回復照片（完成後）</div><div class="photos">${after}</div>
    <label class="f">回覆文字（可留空）<input id="fxReply" value="${esc((it.fix && it.fix.reply) || '')}" placeholder="例如：已更換門鉸"></label>` : ''}
    <label class="f">問題描述（可回辦公室再填）<textarea id="fNote" rows="3" placeholder="例如：門鉸鬆脫">${esc(it.note)}</textarea></label>
    <div class="f-l">分判（可選多個）</div>
    <div class="chips pick subs">${subsOf(it).map(x => `<button class="chip on" data-rmsub="${esc(x)}">${esc(x)}　✕</button>`).join('') || '<span class="chip">未指定</span>'}</div>
    <label class="f"><select id="fSub"><option value="">＋ 加分判…</option>${allSubs().filter(x => !subsOf(it).includes(x)).map(x => `<option>${esc(x)}</option>`).join('')}<option value="+">＋ 新增分判名稱…</option></select></label>
    <div class="row nav"><button class="btn" data-a="prev">‹ 上一個</button><button class="btn" data-a="next">下一個 ›</button></div>
    <div class="row nav"><button class="btn" data-a="nextEmpty">下一個未填描述</button><button class="btn" data-a="nextNoSub">下一個未指定分判</button></div>
    <div class="note navpos">${navPos(it)}</div>
    <details><summary>手動修改位置文字</summary><label class="f"><textarea id="fLoc" rows="2">${esc(it.locText)}</textarea></label>${it.locEdited ? '<button class="btn" data-a="reloc">按上面選項重新生成</button>' : ''}</details>
    <div class="row"><button class="btn warn" data-a="del">刪除此記錄</button><button class="btn dk" data-a="done">完成</button></div>`,
    { badge: `<span class="no">${itemLabel(it)}</span>` });
  const q = s => panel.querySelector(s);
  panel.querySelectorAll('.ph1 img').forEach(img => { img.onerror = async () => { img.onerror = null; const af = img.dataset.a === 'edA'; const ph = (af ? it.fix.photos : it.photos)[+img.dataset.i]; if (!ph) return; const b = await photoOut(it, ph); if (await canRead(b)) img.src = burl(b); }; });
  const upd = (re) => { relocate(it); q('.idx').textContent = it.locText || '未設定位置'; q('#fLoc').value = it.locText; persistItem(); updateBar(); if (re) itemPanel(); };
  q('#fTower').onchange = e => { L.tower = e.target.value; upd(); };
  q('#fFloor').onchange = e => { L.floor = e.target.value; if (v) { S.floorSel[v.id] = L.floor; DB.kset('floorSel', S.floorSel); } upd(); };
  q('#fFlat').onchange = e => { L.flat = e.target.value; if (!L.flat) L.room = ''; else L.area = ''; upd(true); };
  const ar = q('#fArea'); if (ar) ar.oninput = e => { L.area = e.target.value.trim(); upd(); };
  if (ar) ar.onchange = () => { const a = L.area; if (a) { S.recentAreas = [a, ...S.recentAreas.filter(x => x !== a)].slice(0, 30); DB.kset('recentAreas', S.recentAreas); } };
  q('#fLoc').oninput = e => { it.locText = e.target.value; it.locEdited = true; q('.idx').textContent = it.locText; persistItem(); updateBar(); };
  q('#fNote').oninput = e => { it.note = e.target.value; persistItem(); };
  q('#fSub').onchange = async e => {
    let n = e.target.value; if (!n) return;
    if (n === '+') {
      n = (prompt('新增分判名稱') || '').trim(); if (!n) { e.target.value = ''; return; }
      if (!allSubs().includes(n)) { S.settings.customSubs = [...(S.settings.customSubs || []), n]; await saveKV(); toast(`已加入分判：${n}`); }
    }
    setSubs(it, [...subsOf(it), n]); persistItem(); renderOverlay(); itemPanel();
  };
  const fr = q('#fxReply'); if (fr) fr.oninput = e => { fixOf(it).reply = e.target.value; persistItem(); };
  panel.querySelector('.pb').onclick = async e => {
    const rs = e.target.closest('[data-rmsub]'); if (rs) { setSubs(it, subsOf(it).filter(x => x !== rs.dataset.rmsub)); persistItem(); renderOverlay(); return itemPanel(); }
    const rb = e.target.closest('[data-room]'); if (rb) { L.room = L.room === rb.dataset.room ? '' : rb.dataset.room; upd(true); return; }
    if (e.target.closest('[data-a="reply"]')) { S.fixItem = it; return; }
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'edA') { const i = +e.target.dataset.i; const F = fixOf(it); const ph = F.photos[i]; if (!(await canRead(ph.orig))) await refreshPhotos(it); const r = await openEditor(ph.orig, ph); if (r) { F.photos[i] = { ...ph, ...r }; await persistItem(true); itemPanel(); } }
    if (a === 'delA') { if (e.target.dataset.armed) { const F = fixOf(it); F.photos.splice(+e.target.dataset.i, 1); if (!F.photos.length) { F.status = 'open'; F.done = null; } await persistItem(true); renderOverlay(); itemPanel(); } else { e.target.dataset.armed = 1; e.target.textContent = '刪'; e.target.style.background = 'var(--red)'; } }
    if (a === 'cam') $('#camInput').click();
    if (a === 'lib') $('#libInput').click();
    if (a === 'done') closePanel();
    if (a === 'prev' || a === 'next' || a === 'nextEmpty' || a === 'nextNoSub') stepItem(it, a);
    if (a === 'reloc') { it.locEdited = false; upd(true); }
    if (a === 'ed') { const i = +e.target.dataset.i; const ph = it.photos[i]; if (!(await canRead(ph.orig))) await refreshPhotos(it); const r = await openEditor(ph.orig, ph); if (r) { it.photos[i] = r; await persistItem(true); itemPanel(); } }
    if (a === 'delph') { if (e.target.dataset.armed) { it.photos.splice(+e.target.dataset.i, 1); await persistItem(true); itemPanel(); } else { e.target.dataset.armed = 1; e.target.textContent = '刪'; e.target.style.background = 'var(--red)'; } }
    if (a === 'del') {
      if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = '再按一次確認刪除'; return; }
      S.items = S.items.filter(x => x.id !== it.id); await DB.del('items', it.id); DB.del('kv', 'rc:' + it.id).catch(() => { }); S.editing = null; closePanel(); toast(`已刪除 ${itemLabel(it)}`);
    }
  };
  updateBar();
}
let persistT;
async function persistItem(now) {
  const it = S.editing; if (!it) return;
  if (it._new && !it.photos.length && !it.note.trim() && !(it.fix && it.fix.photos && it.fix.photos.length)) return;
  it.mod = Date.now();
  if (it._new) { delete it._new; S.items.push(it); updateBar(); }
  clearTimeout(persistT);
  const doit = () => saveItem(it).catch(err => toast('儲存失敗：' + err.message, 4000));
  if (now) await doit(); else persistT = setTimeout(doit, 400);
}
function finishItem() { warmLater(); const it = S.editing; if (!it) return; if (!it._new) saveItem(it); S.editing = null; updateBar(); }

async function addPhotoFile(file) {
  if (!file || !S.editing) return;
  const r = await openEditor(file, null); if (!r) return;
  S.editing.photos.push(r); await persistItem(true);
  if (S.panel === 'item') itemPanel(); renderOverlay(); toast(`${itemLabel(S.editing)} 已加入照片`);
}
$('#camInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; addPhotoFile(f); };
$('#libInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; addPhotoFile(f); };

function itemsPanel() {
  freeURLs();
  const d = curD();
  const scoped = (S.listScope === 'cur' && d ? roundItems().filter(i => i.drawingId === d.id) : roundItems());
  const subF = S.listSub || ''; const nNone = scoped.filter(i => !subsOf(i).length).length;
  const list = scoped.filter(i => !subF || (subF === '-' ? !subsOf(i).length : subsOf(i).includes(subF))).slice().sort(byOrder);
  const subOpts = allSubs().map(x => [x, scoped.filter(i => subsOf(i).includes(x)).length]).filter(([, n]) => n);
  const rows = list.map(it => {
    const th = it.photos[0] ? `style="background-image:url('${burl(it.photos[0].out)}')"` : '';
    return `<button class="li" data-id="${it.id}"><span class="th" ${th}><span class="no">${itemLabel(it)}</span></span><span class="t"><b>${esc(it.locText || '（無位置）')}</b><span>${subsOf(it).length ? `<em class="sub">${esc(subText(it))}</em>` : '<em class="sub none">未指定分判</em>'}　${esc(it.note || '未填描述')}　·　${it.photos.length} 張相${fixStatus(it) === 'done' ? '　·　已回復' : ''}${it.by ? '　·　' + esc(it.by) : ''}</span></span></button>`;
  }).join('') || (scoped.length ? '' : '<div class="note">這張圖紙還沒有記錄。在「驗收」模式點選圖上的位置即可開始。</div>');
  openPanel('items', `${esc(roundLabel())}（${list.length}）`, `
    <div class="row"><button class="btn ${S.listScope === 'cur' ? 'dk' : ''}" data-s="cur">此圖紙</button><button class="btn ${S.listScope === 'all' ? 'dk' : ''}" data-s="all">全部圖紙</button></div>
    <label class="f">分判<select id="lSub"><option value="">全部（${scoped.length}）</option><option value="-" ${subF === '-' ? 'selected' : ''}>未指定分判（${nNone}）</option>${subOpts.map(([x, n]) => `<option value="${esc(x)}" ${subF === x ? 'selected' : ''}>${esc(x)}（${n}）</option>`).join('')}</select></label>
    <div class="note">圖上：<b style="color:#d42a1e">紅點</b>＝未指定分判，<b style="color:#1f6f9c">藍點</b>＝已指定分判。</div>
    <div class="list">${rows || '<div class="note">沒有符合的記錄。</div>'}</div>`);
  $('#lSub').onchange = e => { S.listSub = e.target.value; itemsPanel(); };
  panel.querySelector('.pb').onclick = e => {
    const s = e.target.closest('[data-s]'); if (s) { S.listScope = s.dataset.s; return itemsPanel(); }
    const b = e.target.closest('.li'); if (!b) return;
    const it = S.items.find(i => i.id === b.dataset.id);
    if (S.mode === 'fix') { const go = () => { fixPanel(it); centerOn(it.x, it.y, Math.max(S.view.k, 1)); renderOverlay(); updateBar(); }; if (S.cur !== it.drawingId) showDrawing(it.drawingId).then(go); else go(); return; }
    if (S.mode !== 'inspect') setMode('inspect');
    S.editing = it; showFloorOf(it);
    if (S.cur !== it.drawingId) showDrawing(it.drawingId).then(() => { itemPanel(); centerOn(it.x, it.y, 1); });
    else { itemPanel(); centerOn(it.x, it.y, Math.max(S.view.k, 1)); }
  };
}

function floorPanel() {
  const d = curD(); const mv = multiFloorViews(d);
  openPanel('floor', '選擇樓層', mv.map(v => `<div class="f-l">${esc(v.title)}</div><div class="chips pick">${v.floors.map(f => `<button class="chip ${f === floorFor(v) ? 'on' : ''}" data-v="${v.id}" data-f="${esc(f)}">${esc(f)}</button>`).join('')}</div>`).join('') + '<div class="note">之後在這張平面圖上點選的位置會用所選樓層；每個記錄仍可個別修改。</div>');
  panel.querySelector('.pb').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; S.floorSel[b.dataset.v] = b.dataset.f; DB.kset('floorSel', S.floorSel); updateBar(); renderOverlay(); floorPanel(); toast(`樓層：${b.dataset.f}`); };
}

/* ---- drawings ---- */
function drawingsPanel() {
  freeURLs();
  const rows = setDrawings().map(d => {
    const n = S.items.filter(i => i.drawingId === d.id).length;
    const th = d.thumb ? `background-image:url('${burl(d.thumb)}');` : '';
    return `<div class="li ${d.id === S.cur ? 'cur' : ''}" style="grid-template-columns:64px 1fr auto"><span class="th" style="${th}background-color:#fff"></span>
      <span class="t" data-open="${d.id}"><b>${esc(d.name)}</b><span>${esc(d.no || '')}${d.base || d.kind !== 'pdf' ? '' : '　·　未準備'}　·　${n} 記錄</span></span>
      <button class="btn" data-edit="${d.id}" style="min-height:38px;padding:6px 10px">設定</button></div>`;
  }).join('') || '<div class="note">還沒有圖紙。</div>';
  const pending = setDrawings().filter(d => d.kind === 'pdf' && !d.base).length;
  openPanel('drawings', `圖紙 · ${setName()}`, `
    ${pending ? `<button class="btn dk" data-a="prep">預先準備全部圖紙（尚有 ${pending} 張）</button><div class="note">第一次開啟每張 A0 圖紙需要數秒轉換。到地盤前先按一次，現場就可以即開即用（之後離線亦可）。</div>` : ''}
    <div class="list">${rows}</div>
    <button class="btn" data-a="add">另外匯入圖紙（PDF／圖片）</button>`);
  panel.querySelector('.pb').onclick = async e => {
    const o = e.target.closest('[data-open]'); if (o) { await showDrawing(o.dataset.open); closePanel(); fit(); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) return drawingForm(S.drawings.find(d => d.id === ed.dataset.edit));
    if (e.target.dataset.a === 'add') $('#dwgInput').click();
    if (e.target.dataset.a === 'prep') { let i = 0; const list = setDrawings().filter(d => d.kind === 'pdf' && !d.base); for (const d of list) { busy(`正在準備圖紙 ${++i}／${list.length}：${d.name}`); try { await ensureBase(d, true); await makeThumb(d); } catch (err) { console.warn(err); } } busy(); toast('全部圖紙已準備好'); drawingsPanel(); }
  };
}
async function makeThumb(d) {
  if (d.thumb) return; const img = await loadImg(d.kind === 'pdf' ? d.base.blob : d.blob);
  const c = document.createElement('canvas'); c.width = 160; c.height = Math.round(160 * d.h / d.w); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  d.thumb = await canvasBlob(c, 'image/jpeg', 0.7); URL.revokeObjectURL(img.src); await DB.put('drawings', d);
}
function drawingForm(d, isNewFile) {
  const nw = !!isNewFile;
  const views = nw ? [] : d.views || [];
  openPanel('dform', nw ? '匯入圖紙' : '圖紙設定', `
    ${nw ? `<div class="note">檔案：${esc(isNewFile.name)}</div>` : ''}
    <label class="f">圖紙名稱<input id="dName" value="${esc(nw ? isNewFile.name.replace(/\.[^.]+$/, '') : d.name)}"></label>
    <label class="f">圖號（可留空）<input id="dNo" value="${esc(nw ? '' : d.no)}"></label>
    ${nw ? `<div class="grid2"><label class="f">座（如 T3，可留空）<input id="nTower"></label><label class="f">樓層（如 GF 或 5-30 略過 13,14,24）<input id="nFloors"></label></div>` :
      views.map((v, i) => `<div class="sec">${esc(v.title)}</div><div class="grid2"><label class="f">座<input data-vt="${i}" value="${esc(v.tower)}"></label><label class="f">樓層<input data-vf="${i}" value="${esc(floorsToText(v.floors))}"></label></div>`).join('')}
    ${nw ? '<button class="btn p" data-a="imp">匯入</button>' : `<button class="btn dk" data-a="save">儲存</button>
      ${d.kind === 'pdf' ? '<button class="btn" data-a="rebase">重新準備此圖紙（顯示空白時用）</button>' : ''}
      ${d.src === 'bundle' ? '<div class="note">此圖紙隨程式提供。位置設定的修改只存在這部 iPad。</div>' : `<div class="sec">刪除圖紙</div><button class="btn warn" data-a="del">刪除此圖紙及其 ${S.items.filter(i => i.drawingId === d.id).length} 個記錄</button>`}`}`);
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'imp') { const meta = { name: $('#dName').value.trim() || '未命名圖紙', no: $('#dNo').value.trim(), tower: $('#nTower').value.trim().toUpperCase(), floors: parseFloors($('#nFloors').value) }; closePanel(); await importDrawingFile(isNewFile, meta); }
    if (a === 'rebase') { try { await ensureBase(d, false, true); await showDrawing(d.id); toast('已重新準備'); } catch (err) { toast('失敗：' + err.message, 5000); } return; }
    if (a === 'save') {
      d.name = $('#dName').value.trim() || d.name; d.no = $('#dNo').value.trim();
      panel.querySelectorAll('[data-vt]').forEach(i => views[+i.dataset.vt].tower = i.value.trim().toUpperCase());
      panel.querySelectorAll('[data-vf]').forEach(i => views[+i.dataset.vf].floors = parseFloors(i.value));
      await saveDrawing(d); updateBar(); toast('已儲存'); drawingsPanel();
    }
    if (a === 'del') {
      if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = '再按一次確認刪除'; return; }
      for (const it of S.items.filter(i => i.drawingId === d.id)) await DB.del('items', it.id);
      S.items = S.items.filter(i => i.drawingId !== d.id); S.drawings = S.drawings.filter(x => x.id !== d.id); await DB.del('drawings', d.id);
      if (S.cur === d.id) await showDrawing(setDrawings()[0]?.id || null); drawingsPanel(); updateBar();
    }
  };
}
$('#dwgInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) drawingForm(null, f); };

async function importDrawingFile(file, meta) {
  try {
    busy('正在讀取…'); const made = [];
    const mkView = (w, h) => [{ id: uid(), title: meta.name, tower: meta.tower, floors: meta.floors, bbox: [0, 0, w, h], gx: [], gy: [], zones: [] }];
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const fileId = uid(); await DB.put('files', { id: fileId, blob: file, name: file.name });
      const pdf = await getPdf(fileId);
      for (let n = 1; n <= pdf.numPages; n++) {
        const vp = (await pdf.getPage(n)).getViewport({ scale: 1 });
        made.push({ id: uid(), src: 'user', kind: 'pdf', fileId, page: n, name: pdf.numPages > 1 ? `${meta.name} – 第${n}頁` : meta.name, no: meta.no, w: Math.round(vp.width), h: Math.round(vp.height), views: mkView(vp.width, vp.height), created: Date.now() });
      }
    } else {
      const img = await loadImg(file); let w = img.naturalWidth, h = img.naturalHeight;
      const sc = Math.min(1, 6000 / Math.max(w, h), Math.sqrt(15e6 / (w * h)));
      const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      made.push({ id: uid(), src: 'user', kind: 'image', blob: await canvasBlob(c, 'image/png'), name: meta.name, no: meta.no, w: c.width, h: c.height, views: mkView(c.width, c.height), created: Date.now() });
    }
    for (const d of made) { if (curSet() !== 'gbp') d.set = curSet(); await DB.put('drawings', d); S.drawings.push(d); }
    busy(); await showDrawing(made[0].id); toast(`已匯入 ${made.length} 張圖紙`);
  } catch (err) { busy(); toast('匯入失敗：' + err.message, 5000); console.error(err); }
}

/* ---- mapping forms ---- */
function openZone(d, v, z, isNew) {
  const towers = [...new Set(S.drawings.flatMap(x => (x.views || []).map(v => v.tower)).filter(Boolean))];
  openPanel('zone', isNew ? '新區域' : '區域設定', `
    <label class="f">類別<select id="zKind"><option value="flat">單位（FLAT）</option><option value="room">單位內房間</option><option value="area">公共／園景區域</option><option value="tower">座的範圍（如 T2）</option></select></label>
    <label class="f" id="zNameL">名稱<input id="zName" value="${esc(z.name)}"></label>
    <div class="grid2" id="zArea"><label class="f">最相鄰的座<select id="zTower"><option value="">同圖紙（${esc(v.tower || '—')}）</option>${towers.map(t => `<option ${t === z.tower ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="f">層（不同於圖紙才填）<input id="zFloor" value="${esc(z.floor)}" placeholder="${esc(v.floors[0] || '')}"></label></div>
    <div class="row"><button class="btn dk" data-a="ok">儲存</button><button class="btn warn" data-a="del">刪除</button></div>`, { compact: true });
  const kind = $('#zKind'), inp = $('#zName'); kind.value = z.kind;
  const sync = () => { $('#zArea').hidden = kind.value !== 'area';  $('#zNameL').firstChild.textContent = kind.value === 'tower' ? '座名稱' : '名稱'; inp.placeholder = kind.value === 'tower' ? '例如 T2' : kind.value === 'flat' ? '例如 A' : kind.value === 'room' ? '例如 Master Bedroom' : '例如 Lift Lobby、平台花園'; };
  sync(); kind.onchange = sync; if (isNew) setTimeout(() => inp.focus(), 50);
  const save = async () => {
    z.kind = kind.value; z.name = inp.value.trim().replace(/^FLAT\s*/i, '') || '未命名'; z.tower = $('#zTower').value; z.floor = $('#zFloor').value.trim().toUpperCase();
    if (z.kind === 'room') { const cx = z.pts.reduce((s, p) => s + p[0], 0) / z.pts.length, cy = z.pts.reduce((s, p) => s + p[1], 0) / z.pts.length; const f = (v.zones || []).find(q => q.kind === 'flat' && q !== z && inPoly(cx, cy, q.pts)); z.flat = f ? f.name : z.flat; }
    await saveDrawing(d); renderOverlay();
  };
  inp.onkeydown = e => { if (e.key === 'Enter') { save(); closePanel(); } };
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'ok') { await save(); closePanel(); toast('已儲存'); }
    if (a === 'del') { v.zones = v.zones.filter(x => x.id !== z.id); await saveDrawing(d); closePanel(); }
  };
  panel.querySelector('[data-a="close"]').onclick = async () => { await save(); closePanel(); };
}
function openGrid(d, v, ax, l, isNew) {
  openPanel('grid', ax === 'gx' ? '縱向軸線' : '橫向軸線', `
    <label class="f">軸線編號<input id="gLab" value="${esc(l.label)}" autocapitalize="characters"></label>
    <div class="row"><button class="btn dk" data-a="ok">儲存</button><button class="btn warn" data-a="del">刪除軸線</button></div>
    <div class="note">${isNew ? '已自動編號；如不對可直接修改。繼續在下一條軸線上點選即可。' : '要移動位置：刪除後重新點選。'}</div>`, { compact: true });
  const inp = $('#gLab');
  const save = async () => { l.label = inp.value.trim() || l.label; await saveDrawing(d); renderOverlay(); };
  inp.oninput = save;
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'ok') { await save(); closePanel(); }
    if (a === 'del') { v[ax] = v[ax].filter(x => x.id !== l.id); await saveDrawing(d); closePanel(); }
  };
}

/* ---- modes / tools ---- */
function setMode(m) {
  if (S.panel) closePanel();
  S.mode = m; S.draft = null; S.sel = null; updateBar(); renderOverlay();
}
function setTool(t) { S.tool = t; S.draft = t === 'poly' ? { type: 'poly', pts: [] } : null; S.sel = null; if (S.panel && ['zone', 'grid'].includes(S.panel)) closePanel(); updateBar(); renderOverlay(); }
$('#mInspect').onclick = () => setMode('inspect');
$('#mMap').onclick = () => { if (!curD()) return toast('請先開啟圖紙'); setMode('map'); };
$('#maptools').onclick = e => { const t = e.target.closest('[data-tool]'); if (t) setTool(t.dataset.tool); };
$('#polyDone').onclick = () => { const d = curD(); const pts = S.draft.pts; S.draft = { type: 'poly', pts: [] }; updateBar(); addZone(d, pts); };
$('#polyUndo').onclick = () => { S.draft.pts.pop(); renderOverlay(); updateBar(); };
$('#btnDrawings').onclick = () => S.panel === 'drawings' ? closePanel() : drawingsPanel();
$('#btnItems').onclick = () => S.panel === 'items' ? closePanel() : itemsPanel();
$('#btnExport').onclick = () => S.panel === 'export' ? closePanel() : exportPanel();
$('#btnFloor').onclick = () => S.panel === 'floor' ? closePanel() : floorPanel();
$('#btnRound').onclick = () => S.panel === 'round' ? closePanel() : roundPanel();
$('#setSeg').onclick = e => { const b = e.target.closest('[data-set]'); if (b) switchSet(b.dataset.set); };
async function switchSet(k) {
  if (k === curSet()) return;
  if (S.editing) return toast('請先完成或關閉目前的記錄，再切換圖紙');
  const prev = curSet(); S.settings.curBy = { ...S.settings.curBy, [prev]: S.cur };
  S.settings.set = k;
  try { await loadBundle(k); } catch (e) { busy(); S.settings.set = prev; updateBar(); return toast(e.message + '，請連網後再試', 6000); }
  ensureSetRounds(); await saveRounds(); await saveKV();
  closePanel();
  const want = S.settings.curBy[k], L = setDrawings();
  await showDrawing(L.some(d => d.id === want) ? want : L[0]?.id || null);
  renderOverlay(); updateBar(); toast(`已切換到${setName()}圖紙（${roundLabel()}）`);
}
$('#fixLib').onchange = e => { const f = e.target.files[0]; e.target.value = ''; addFixPhoto(f); };
$('#fixCam').onchange = e => { const f = e.target.files[0]; e.target.value = ''; addFixPhoto(f); };
$('#photoRestore').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) restoreFromPhotos(fs); };
$('#zIn').onclick = () => zoomAt(1.6); $('#zOut').onclick = () => zoomAt(1 / 1.6); $('#zFit').onclick = () => fit();
// turn 90° (step 1 clockwise, -1 anticlockwise) around the middle of the visible area, keeping the zoom
function turn(step) {
  const d = curD(); if (!d) return; const A = visibleArea(), r = stageRect(), k = S.view.k; const c = toDwg(r.left + A.w / 2, r.top + 30 + A.h / 2);
  S.rots[d.id] = (rotOf(d) + step + 4) % 4; DB.kset('rots', S.rots); hires.hidden = true; hiBox = null; hiSeq++;
  centerOn(c.x, c.y, k); renderOverlay();
}
$('#zRot').onclick = () => turn(1); $('#zRotL').onclick = () => turn(-1);
// the iPad resizes the page when the camera or keyboard comes and goes: keep the spot in the middle where it was
let rzT;
addEventListener('resize', () => {
  clearTimeout(rzT); rzT = setTimeout(() => {
    const was = stageWas, r = stageRect(); stageWas = { w: r.width, h: r.height }; if (!curD() || !was || !S.view.k) return fit();
    const cx = (was.w / 2 - S.view.x) / S.view.k, cy = (was.h / 2 - S.view.y) / S.view.k;
    S.view = { k: S.view.k, x: r.width / 2 - cx * S.view.k, y: r.height / 2 - cy * S.view.k }; applyView();
  }, 150);
});

/* ---------------- photo markup editor ---------------- */
const E = { tool: 'arrow', color: '#e5251a' };
function drawShape(ctx, s, lw) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const head = () => { const [a, b] = [s.a, s.b]; const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = lw * 4.2; return [[b.x, b.y], [b.x - hl * Math.cos(ang - 0.45), b.y - hl * Math.sin(ang - 0.45)], [b.x - hl * Math.cos(ang + 0.45), b.y - hl * Math.sin(ang + 0.45)], ang, hl]; };
  const path = () => {
    ctx.beginPath();
    if (s.t === 'arrow') { const [, , , ang, hl] = head(); ctx.moveTo(s.a.x, s.a.y); ctx.lineTo(s.b.x - Math.cos(ang) * hl * 0.6, s.b.y - Math.sin(ang) * hl * 0.6); }
    else if (s.t === 'ellipse') ctx.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.max(1, Math.abs(s.b.x - s.a.x) / 2), Math.max(1, Math.abs(s.b.y - s.a.y) / 2), 0, 0, Math.PI * 2);
    else if (s.t === 'rect') ctx.rect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
    else if (s.t === 'pen') s.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  };
  const tri = (fill) => { const [p0, p1, p2] = head(); ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.lineTo(...p2); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  path(); ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = lw + 4; ctx.stroke();
  if (s.t === 'arrow') { ctx.save(); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.45)'; const [p0, p1, p2] = head(); ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.lineTo(...p2); ctx.closePath(); ctx.stroke(); ctx.restore(); }
  path(); ctx.strokeStyle = s.c; ctx.lineWidth = lw; ctx.stroke();
  if (s.t === 'arrow') tri(s.c);
}
function openEditor(src, prev) {
  return new Promise(async resolve => {
    let base;
    try { base = await loadImg(src); } catch (e) { toast(e.message); return resolve(null); }
    const ed = $('#editor'), cv = $('#edCanvas'), ctx = cv.getContext('2d'), wrap = $('#edwrap');
    let w = base.naturalWidth, h = base.naturalHeight; const m = 2200 / Math.max(w, h); if (m < 1) { w = Math.round(w * m); h = Math.round(h * m); }
    cv.width = w; cv.height = h;
    const lw = Math.max(5, Math.round(Math.max(w, h) / 160));
    const shapes = prev ? JSON.parse(JSON.stringify(prev.shapes || [])) : []; let cur = null;
    ed.hidden = false;
    const size = () => { const r = wrap.getBoundingClientRect(); const s = Math.min((r.width - 16) / w, (r.height - 16) / h); cv.style.width = w * s + 'px'; cv.style.height = h * s + 'px'; };
    size(); const onRes = () => size(); addEventListener('resize', onRes);
    const draw = () => { ctx.drawImage(base, 0, 0, w, h); for (const s of shapes) drawShape(ctx, s, lw); if (cur) drawShape(ctx, cur, lw); };
    draw();
    // auto save to Photos: keep a captioned copy ready so the share sheet can open straight from the 完成 tap
    const it0 = S.editing, t0 = prev ? prev.t : Date.now(), phId = prev ? prev.id : uid(); let pv = 0, ready = null, prepT = 0;
    const autoAlb = !prev && it0 && !S.replyShot && S.settings.autoAlbum !== false && (IS_ANDROID || (navigator.canShare && navigator.share));
    const prep = () => { if (!autoAlb) return; const v = ++pv; ready = null; clearTimeout(prepT); prepT = setTimeout(async () => {
      try { const out = await canvasBlob(cv, 'image/jpeg', 0.86); if (v !== pv) return;
        const f = new File([await captioned({ ...it0, photos: [...it0.photos, 0] }, { id: phId, out, t: t0, w, h }, it0.photos.length)], photoName(it0, it0.photos.length), { type: 'image/jpeg' });
        if (v === pv && (IS_ANDROID || navigator.canShare({ files: [f] }))) ready = { v, f }; } catch (e) { } }, 120); };
    prep();
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * w / r.width), y: Math.round((e.clientY - r.top) * h / r.height) }; };
    let pid = null;
    cv.onpointerdown = e => { if (pid !== null) return; pid = e.pointerId; cv.setPointerCapture(pid); const p = pos(e); cur = E.tool === 'pen' ? { t: 'pen', c: E.color, pts: [p] } : { t: E.tool, c: E.color, a: p, b: p }; draw(); };
    cv.onpointermove = e => { if (e.pointerId !== pid || !cur) return; const p = pos(e); if (cur.t === 'pen') cur.pts.push(p); else cur.b = p; draw(); };
    cv.onpointerup = cv.onpointercancel = e => { if (e.pointerId !== pid) return; pid = null; if (cur) { const ok = cur.t === 'pen' ? cur.pts.length > 1 : Math.hypot(cur.b.x - cur.a.x, cur.b.y - cur.a.y) > lw * 2; if (ok) shapes.push(cur); cur = null; draw(); prep(); } };
    const sync = () => ed.querySelectorAll('[data-ed="tool"],[data-ed="color"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.ed === 'tool' ? b.dataset.v === E.tool : b.dataset.v === E.color));
    sync();
    const finish = async ok => {
      removeEventListener('resize', onRes); ed.onclick = null; cv.onpointerdown = cv.onpointermove = cv.onpointerup = null;
      if (!ok) { ed.hidden = true; return resolve(null); }
      busy('儲存照片…');
      let orig = prev ? prev.orig : null;
      if (!orig) { ctx.drawImage(base, 0, 0, w, h); orig = await canvasBlob(cv, 'image/jpeg', 0.88); draw(); }
      const out = await canvasBlob(cv, 'image/jpeg', 0.86);
      busy(); ed.hidden = true;
      const r = { id: phId, orig, out, shapes, w, h, t: t0 };
      if (autoAlb && IS_ANDROID) {
        try { const f = ready && ready.v === pv ? ready.f : new File([await captioned({ ...it0, photos: [...it0.photos, 0] }, { id: phId, out, t: t0, w, h }, it0.photos.length)], photoName(it0, it0.photos.length), { type: 'image/jpeg' });
          saveFile(f, f.name); r.album = Date.now(); } catch (e) { toast('相片未能存入手機，可稍後在「導出 → 存入相簿」補存', 3500); }
      } else if (albumP) albumP.then(async okA => { if (!okA) return toast('未存入相簿，可稍後在「導出 → 存入相簿」補存', 3500); r.album = Date.now(); if (S.items.includes(it0)) await saveItem(it0); updateBar(); });
      else if (autoAlb) toast('相片未能即時存入相簿，可稍後在「導出 → 存入相簿」補存', 3500);
      resolve(r);
    };
    let albumP = null;
    ed.onclick = e => {
      const b = e.target.closest('[data-ed]'); if (!b) return;
      const a = b.dataset.ed;
      if (a === 'tool') E.tool = b.dataset.v; if (a === 'color') E.color = b.dataset.v;
      if (a === 'undo') { shapes.pop(); draw(); prep(); } if (a === 'clear') { shapes.length = 0; draw(); prep(); }
      if (a === 'done' && autoAlb && !IS_ANDROID && ready && ready.v === pv) albumP = navigator.share({ files: [ready.f] }).then(() => true, () => false);
      if (a === 'cancel') finish(false); if (a === 'done') finish(true);
      sync();
    };
  });
}

/* ---------------- export: Word report + backup ---------------- */
function exportPanel() {
  const P = S.project; const ub = unbacked(), ua = unalbum(); const devs = [...new Set(S.items.map(devOf))].sort();
  const last = S.settings.lastBackup ? fmtTime(S.settings.lastBackup) : '從未備份';
  openPanel('export', '導出及備份', `
    <div class="safe ${ub ? 'warn' : 'ok'}"><b>${ub ? `${ub} 項記錄未備份` : '全部記錄已備份'}</b><span>上次備份：${last}　·　未存入相簿：${ua} 張</span></div>
    <div class="row"><button class="btn ${ub ? 'p' : ''}" data-a="bknew">備份新增記錄</button><button class="btn" data-a="repair">檢查及修復相片</button><button class="btn" data-a="album">存入相簿（${ua}）</button></div>
    <button class="btn" data-a="bk">完整備份（全部 ${S.items.length} 項）</button>
    <div class="row"><label class="f" style="flex:2 1 0;min-width:0">按驗收批次備份（整次驗收一個檔案）<select id="bkRound">${S.rounds.filter(r => S.items.some(i => roundOf(i) === r.id)).map(r => { const n = S.items.filter(i => roundOf(i) === r.id).length, t = (S.settings.roundBackup || {})[r.id]; return `<option value="${r.id}" ${r.id === curRound().id ? 'selected' : ''}>${esc(setName(setOfRound(r)) + ' ' + r.name)}（${n} 項）${t ? '　已備份 ' + fmtTime(t) : ''}</option>`; }).join('') || '<option value="">還沒有任何記錄</option>'}</select></label><button class="btn" data-a="bkround" style="align-self:flex-end">備份此批次</button></div>
    <div class="note">備份檔是 ZIP，可用分享選單存到「檔案」、iCloud Drive、Google Drive 或 WhatsApp。ZIP 內的「相片」資料夾在電腦上可直接開啟，每張相底部印有編號、位置、時間及檢查人員。</div>
    <div class="sec">報告（${esc(roundLabel())}，${roundItems().length} 項）</div>
    <label class="f">項目名稱<input id="pName" value="${esc(P.name)}" placeholder="例如：XX 住宅發展項目"></label>
    <div class="grid2"><label class="f">地盤／地址<input id="pSite" value="${esc(P.site)}"></label><label class="f">驗收日期<input id="pDate" type="date" value="${esc(P.date)}"></label></div>
    <label class="f">公司／單位<input id="pCo" value="${esc(P.company)}"></label>
    <label class="f">分判<select id="pSub"><option value="">全部分判</option>${allSubs().filter(x => S.items.some(i => subsOf(i).includes(x))).map(x => `<option ${S.repSub === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}<option value="-" ${S.repSub === '-' ? 'selected' : ''}>未指定分判</option></select></label>
    ${devs.length > 1 ? `<label class="f">報告範圍<select id="pDevs"><option value="">全部（${devs.join('、')}）</option>${devs.map(d => `<option value="${d}">只限 ${d}</option>`).join('')}</select></label>` : ''}
    <label class="f">圖紙截取範圍<select id="pCrop"><option value="s">細（約 7 米闊）</option><option value="m">中（約 11 米闊）</option><option value="l">大（約 17 米闊）</option></select></label>
    <label class="toggle">報告最後附上每張平面圖的位置總圖<input type="checkbox" id="pKey" ${S.settings.keyPlan ? 'checked' : ''}></label>
    <label class="f">報告類型<select id="pKind"><option value="inspect">驗收報告</option><option value="fixdone">回復報告（只限已回復項目，完成前後對照）</option><option value="fixall">回復報告（全部項目，列出是否已回復）</option></select></label>
    <button class="btn p" data-a="preview">預覽報告</button>
    <div class="row"><button class="btn dk" data-a="pdf">導出 PDF</button><button class="btn dk" data-a="docx">導出 Word</button></div>
    <div class="note">預覽後可直接導出 PDF 或 Word。PDF 與預覽版面相同；Word 可再加文字修改。</div>
    <div class="f-l">分批導出 PDF（每組一個檔案，方便派發）</div>
    <div class="row"><button class="btn" data-a="set:sub">按分判</button><button class="btn" data-a="set:area">按區域</button><button class="btn" data-a="set:both">按區域＋分判</button></div>
    <div class="note">區域：Podium（B3–2F）、T1、T2、T3、T5，即各管工負責的範圍。按上面選的報告類型及本機範圍導出；未指定分判的記錄自成一個檔案。</div>
    <div class="sec">合併其他 iPad 的記錄</div>
    <button class="btn" data-a="imp">匯入備份檔（ZIP）</button>
    <label class="btn" for="photoRestore">從相片還原記錄</label>
    <div class="note">本程式存的每張相片都帶有圖紙坐標（相片資料內及底部二維碼）。即使只剩下相片，在這裏一次揀選多張，就可以把記錄放回原來的圖紙位置及驗收批次。</div>
    <div class="note">匯入後所有記錄會在同一張圖上顯示，連同圖上位置、照片標註及檢查人員；同一記錄以較新的版本為準。</div>
    <button class="btn" data-a="renum">整理編號（按樓層、位置）</button>
    <div class="note">全部記錄匯入後按這裏，編號會改為按樓層排列，例如 B1-001、B1-002、B2-001，同一單位或區域的記錄排在一起，就像一個人做了全部記錄。原來的編號會保留在記錄內。之後再匯入或新增記錄，可再按一次重新整理。</div>
    <div class="sec">本機</div>
    <div class="row"><button class="btn" data-a="setup">代號 ${esc(S.settings.dev || '—')}　${esc(S.settings.inspector || '')}</button></div>
    <label class="toggle">點選位置後直接開相機<input type="checkbox" id="sCam" ${S.settings.autoCam ? 'checked' : ''}></label>
    <label class="toggle">${IS_ANDROID ? '拍照後自動存入手機（相簿的「Download」資料夾）' : '拍照後即時存入相簿（分享選單按「儲存影像」）'}<input type="checkbox" id="sAlb" ${S.settings.autoAlbum !== false ? 'checked' : ''}></label>
    <label class="toggle">驗收時顯示單位範圍<input type="checkbox" id="sZone" ${S.settings.showZones ? 'checked' : ''}></label>
    <div class="note" id="stor">記錄存在這部 iPad 的程式資料內。</div>
    <div class="note">版本 ${VERSION}${S.pkgVersion ? '　圖紙包 ' + esc(S.pkgVersion) : ''}</div>`);
  $('#pCrop').value = S.settings.crop; $('#pKind').value = 'inspect';
  const sv = () => { Object.assign(P, { name: $('#pName').value, site: $('#pSite').value, date: $('#pDate').value, company: $('#pCo').value }); S.settings.keyPlan = $('#pKey').checked; S.repSub = $('#pSub').value; S.settings.crop = $('#pCrop').value; S.settings.autoCam = $('#sCam').checked; S.settings.showZones = $('#sZone').checked; S.settings.autoAlbum = $('#sAlb').checked; saveKV(); updateBar(); renderOverlay(); };
  panel.querySelectorAll('input,select').forEach(i => i.onchange = sv);
  (async () => {
    const el = $('#stor'); if (!el) return; let t = el.textContent;
    try { if (navigator.storage && navigator.storage.persisted) t += (await navigator.storage.persisted()) ? '　已設為持久保存。' : '　未獲持久保存，請從主畫面圖示開啟。'; } catch (e) { }
    try { if (navigator.storage && navigator.storage.estimate) { const es = await navigator.storage.estimate(); t += `　已用 ${(es.usage / 1048576).toFixed(0)} MB。`; } } catch (e) { }
    el.textContent = t;
  })();
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a; if (!a) return; sv();
    const od = $('#pDevs') ? $('#pDevs').value : '';
    const kind = $('#pKind').value;
    if (a.startsWith('set:')) return exportPdfSet(a.slice(4), kind, od);
    if (a === 'docx') { if (kind === 'inspect') exportDocx(od); else exportFixDocx(reportItems(kind, od), kind); }
    if (a === 'preview') previewReport(od, kind);
    if (a === 'pdf') { const items = reportItems(kind, od); if (!items.length) return toast(kind === 'fixdone' ? '目前批次還沒有已完成的項目' : '還沒有任何記錄'); busy('正在生成 PDF…'); ovCache.clear(); try { const pr = (x, y) => busy(`正在生成 PDF… ${x}／${y}`); const r = kind === 'inspect' ? await buildReportPages(items, pr) : await buildFixPages(items, pr, kind); ovCache.clear(); await exportPdf(r.pages, kind); if (r.fails.length) reportFails(r.fails); } catch (err) { busy(); toast('PDF 生成失敗：' + err.message, 6000); } }
    if (a === 'bk') exportBackup(false);
    if (a === 'bknew') exportBackup(true);
    if (a === 'bkround') { const id = $('#bkRound').value; if (!id) return toast('還沒有任何記錄'); exportBackup(false, id); }
    if (a === 'repair') repairPhotos();
    if (a === 'album') albumPanel();
    if (a === 'setup') setupPanel();
    if (a === 'imp') $('#jsonInput').click();
    if (a === 'renum') { if (!S.items.length) return toast('還沒有任何記錄'); if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = `再按一次確認整理 ${S.items.length} 項記錄的編號`; return; } await renumberAll(); exportPanel(); }
  };
}
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if ((IS_IOS || IS_ANDROID) && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  if (!IS_IOS && !IS_ANDROID) toast(`已下載：${filename}（在瀏覽器的「下載」可找到）`, 5000);
}
const safeName = s => (s || '').replace(/[\\/:*?"<>|]+/g, '_').trim();

function pinOn(x, px, py, n, r) {
  x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fillStyle = '#d42a1e'; x.fill(); x.lineWidth = Math.max(3, r / 6); x.strokeStyle = '#fff'; x.stroke();
  x.fillStyle = '#fff'; x.font = `bold ${Math.round(r * (String(n).length > 3 ? 0.62 : String(n).length > 2 ? 0.8 : 1))}px Menlo, monospace`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(n), px, py + 1);
}
function cropRect(d, it, asp = 4 / 3) { // same drawing area as the 4:3 setting, in the shape asked for
  const c0 = CROP_W[S.settings.crop] || 320; let cw = Math.sqrt(c0 * c0 * 0.75 * asp), ch = cw / asp;
  if (cw > d.w) { cw = d.w; ch = cw / asp; } if (ch > d.h) { ch = d.h; cw = ch * asp; }
  return { x: clamp(it.x - cw / 2, 0, d.w - cw), y: clamp(it.y - ch / 2, 0, d.h - ch), w: cw, h: ch };
}
async function cropImage(d, it, asp = 4 / 3, outW = 1100) { // vector-sharp
  const R = cropRect(d, it, asp); const c = await renderRegion(d, R.x, R.y, R.w, R.h, outW); const x = c.getContext('2d'); const s = outW / R.w;
  const v = viewById(d, it.loc.viewId);
  for (const z of (v && v.zones || []).filter(z => (it.loc.zoneIds || []).includes(z.id))) {
    x.beginPath(); z.pts.forEach((p, i) => { const a = (p[0] - R.x) * s, b = (p[1] - R.y) * s; i ? x.lineTo(a, b) : x.moveTo(a, b); }); x.closePath();
    x.fillStyle = 'rgba(242,194,48,.16)'; x.fill(); x.strokeStyle = 'rgba(212,42,30,.55)'; x.lineWidth = 4; x.setLineDash([14, 8]); x.stroke(); x.setLineDash([]);
  }
  pinOn(x, (it.x - R.x) * s, (it.y - R.y) * s, pinLabel(it, !multiFloorViews(d).length), 35);
  x.strokeStyle = '#888'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, c.width - 3, c.height - 3);
  return { blob: await canvasBlob(c, 'image/jpeg', 0.88), w: c.width, h: c.height };
}
const ovCache = new Map();
/* report images (overview, crop, report-size photos) are cached per record in the kv store under
   'rc:<item id>', apart from the record itself: saving a record never touches them, they are read
   fresh from storage for every report, never go into backups, and are rebuilt when an input changes */
const RC_V = 3, REP_PX = 1200;
const rcKey = (d, it) => JSON.stringify([RC_V, d.id, d.w, d.h, it.x, it.y, S.settings.crop, it.loc.viewId, it.loc.zoneIds || [], pinLabel(it, !multiFloorViews(d).length)]);
const repKey = ph => `${REP_PX}|${ph.out && ph.out.size}`;
const rcSig = (d, it) => rcKey(d, it) + it.photos.map(ph => ph.id + repKey(ph)).join(',');
const rcDone = new Map(); // item id -> signature already cached (this session)
async function reportImages(d, it) {
  const k = rcKey(d, it); let c = null; try { c = await DB.kget('rc:' + it.id); } catch (e) { }
  if (!c || c.k !== k) c = { k, reps: (c && c.reps) || {} };
  let dirty = false, ovErr = null, crErr = null;
  const lc = lpLayout(d, it).cr, asp = lc.w / lc.h;
  if (!(c.ov && c.ov.blob)) try { c.ov = await overviewImage(d, it, asp); dirty = true; } catch (e) { ovErr = e; }
  if (!(c.cr && c.cr.blob)) try { c.cr = await cropImage(d, it, asp, Math.round(lc.w)); dirty = true; } catch (e) { crErr = e; }
  const reps = await Promise.all(it.photos.map(async ph => {
    const r = c.reps[ph.id]; if (r && r.k === repKey(ph) && r.blob) return r.blob;
    try { const blob = await shrink(ph.out, REP_PX); c.reps[ph.id] = { k: repKey(ph), blob }; dirty = true; return blob; } catch (e) { return null; }
  }));
  const keep = new Set(it.photos.map(ph => ph.id)); for (const id of Object.keys(c.reps)) if (!keep.has(id)) { delete c.reps[id]; dirty = true; }
  if (dirty) try { await DB.kset('rc:' + it.id, c); } catch (e) { console.warn(e); }
  if (!ovErr && !crErr && reps.every(Boolean)) rcDone.set(it.id, rcSig(d, it));
  return { ov: ovErr ? null : c.ov, cr: crErr ? null : c.cr, reps, ovErr, crErr };
}
// build the caches quietly while the app is idle, one record at a time, so the first export is quick too
let warmT = 0, warming = false; const warmFail = new Map();
function warmLater(ms = 4000) { clearTimeout(warmT); warmT = setTimeout(warmStep, ms); }
async function warmStep() {
  if (warming) return; const idle = $('#editor').hidden && $('#busy').hidden && !S.editing && $('#preview')?.hidden !== false;
  if (!idle || document.hidden) return warmLater(5000);
  const it = S.items.find(i => { const d = S.drawings.find(x => x.id === i.drawingId); return d && (warmFail.get(i.id) || 0) < 2 && rcDone.get(i.id) !== rcSig(d, i); });
  if (!it) return;
  warming = true;
  try { const [f] = await freshItems([it]); const d = S.drawings.find(x => x.id === f.drawingId); if (d.kind === 'pdf') await ensureBase(d, true); await reportImages(d, f); }
  catch (e) { console.warn(e); }
  finally { warming = false; }
  // a record whose images can't be built is retried once, then left to the export to report
  const d = S.drawings.find(x => x.id === it.drawingId); if (rcDone.get(it.id) !== rcSig(d, it)) warmFail.set(it.id, (warmFail.get(it.id) || 0) + 1);
  warmLater(800);
}
function overviewBox(d, it) {
  const v = viewById(d, it.loc.viewId); const b = v ? v.bbox : [0, 0, d.w, d.h];
  const pad = 0.02 * Math.max(b[2] - b[0], b[3] - b[1]); const bx = Math.max(0, b[0] - pad), by = Math.max(0, b[1] - pad);
  return { v, bx, by, bw: Math.min(d.w, b[2] + pad) - bx, bh: Math.min(d.h, b[3] + pad) - by };
}
// report Location Plan: one 4:3 frame holding the overview (top-right strip for wide plans, right-hand column for tall ones)
// and the crop in the rest of the frame; the two never overlap
const LP = { W: 1100, H: 825, g: 12 };
function lpLayout(d, it) {
  const { bw, bh } = overviewBox(d, it), a = bw / bh, { W, H, g } = LP;
  if (a >= 1.2) { let oh = H * 0.3, ow = oh * a; if (ow > W * 0.62) { ow = W * 0.62; oh = ow / a; }
    return { ov: { x: W - ow, y: 0, w: ow, h: oh }, cr: { x: 0, y: oh + g, w: W, h: H - oh - g }, tx: { x: 0, y: 0, w: W - ow - g, h: oh } }; }
  let ow = W * 0.3, oh = ow / a; if (oh > H * 0.7) { oh = H * 0.7; ow = oh * a; }
  return { ov: { x: W - ow, y: 0, w: ow, h: oh }, cr: { x: 0, y: 0, w: W - ow - g, h: H }, tx: { x: W - ow, y: oh + g, w: ow, h: H - oh - g } };
}
async function overviewImage(d, it, asp = 4 / 3) { // whole plan view, small, with the crop box highlighted
  const { v, bx, by, bw, bh } = overviewBox(d, it); const R = cropRect(d, it, asp);
  const outW = 900, outH = Math.round(outW * bh / bw), s = outW / bw; const key = d.id + '|' + (v ? v.id : '');
  if (!ovCache.has(key)) ovCache.set(key, await renderRegion(d, bx, by, bw, bh, outW));
  const c = document.createElement('canvas'); c.width = outW; c.height = outH; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, outW, outH); x.drawImage(ovCache.get(key), 0, 0);
  x.fillStyle = 'rgba(255,255,255,.35)'; x.fillRect(0, 0, outW, outH);
  const rx = (R.x - bx) * s, ry = (R.y - by) * s, rw = R.w * s, rh = R.h * s;
  x.fillStyle = 'rgba(242,194,48,.35)'; x.fillRect(rx, ry, rw, rh); x.lineWidth = Math.max(6, outW / 180); x.strokeStyle = '#d42a1e'; x.strokeRect(rx, ry, rw, rh);
  x.strokeStyle = '#888'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, outW - 3, outH - 3);
  return { blob: await canvasBlob(c, 'image/jpeg', 0.85), w: outW, h: outH };
}
async function keyPlanImage(d, v, items) {
  const b = v ? v.bbox : [0, 0, d.w, d.h]; const bw = b[2] - b[0], bh = b[3] - b[1];
  const outW = 2400; const c = await renderRegion(d, b[0], b[1], bw, bh, outW); const x = c.getContext('2d'); const s = outW / bw;
  for (const it of items) pinOn(x, (it.x - b[0]) * s, (it.y - b[1]) * s, pinLabel(it, true), Math.max(16, outW / 90));
  return { blob: await canvasBlob(c, 'image/jpeg', 0.88), w: c.width, h: c.height };
}

async function exportDocx(onlyDev) {
  if (!roundItems().length) return toast('目前批次還沒有記錄');
  if (!window.docx) return toast('報告元件未載入，請連網後重新開啟一次');
  const D = window.docx; const P = S.project;
  try {
    busy('正在生成報告…');
    const items = await freshItems(roundItems().filter(i => inScope(i, onlyDev)).sort(byOrder)); const fails = []; ovCache.clear(); var curLbl = '';
    const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft JhengHei', cs: 'Arial' };
    const T = (text, o = {}) => new D.TextRun({ text: String(text ?? ''), font: o.font || FONT, size: o.size || 18, bold: o.bold, color: o.color });
    const Pg = (runs, o = {}) => new D.Paragraph({ children: Array.isArray(runs) ? runs : [runs], alignment: o.align, spacing: { after: o.after ?? 40, before: o.before ?? 0 }, keepLines: true, keepNext: o.keepNext });
    const SER = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'PMingLiU', cs: 'Times New Roman' };
    const TS = (text, o = {}) => T(text, { ...o, font: SER });
    const border = { style: D.BorderStyle.SINGLE, size: 4, color: '333333' };
    const borders = { top: border, bottom: border, left: border, right: border };
    // A4 landscape 16838 x 11906 twips; margins 600 → 15638 usable
    const usable = 15638; const colPct = [7, 5, 19, 23, 23, 23]; const colTw = colPct.map(p => Math.round(usable * p / 100));
    const imgPx = Math.floor(colTw[3] / 15) - 12, imgH = Math.round(imgPx * 0.75); // location plan and photos share one 4:3 frame
    const shade = fill => ({ type: D.ShadingType.CLEAR, color: 'auto', fill });
    const cell = (children, w, o = {}) => new D.TableCell({ children, width: { size: w, type: D.WidthType.DXA }, columnSpan: o.span, borders, verticalAlign: o.v || D.VerticalAlign.TOP, shading: o.shade ? shade(o.shade) : undefined, margins: { top: o.tight ? 10 : 60, bottom: o.tight ? 10 : 60, left: 80, right: 80 } });
    const fullRow = (children, o = {}) => new D.TableRow({ tableHeader: o.head, cantSplit: true, height: o.h ? { value: o.h, rule: D.HeightRule.EXACT } : undefined, children: [cell(children, usable, { span: 6, shade: REP_GREY.slice(1), tight: true })] });
    const heads = ['Item No.', 'Floor', 'Defect / Outstanding works', 'Location Plan', 'Photo (Before)', 'Photo (After)'];
    const rows = [fullRow([Pg(TS(worksOf(), { bold: true, size: 18 }), { after: 0 })], { head: true }),
      new D.TableRow({ tableHeader: true, cantSplit: true, children: heads.map((h, i) => cell([Pg(TS(h, { bold: true, size: 18 }), { after: 0 })], colTw[i], { tight: true })) })];
    const pic = async (blob, r) => { const [w, h] = fitIn(r, imgPx, imgH); return Pg(new D.ImageRun({ data: await blob.arrayBuffer(), transformation: { width: Math.round(w), height: Math.round(h) } }), { align: D.AlignmentType.CENTER, after: 40 }); };
    const failText = what => Pg(T(`（${what}無法生成）`, { color: 'D42A1E', size: 15 }), { align: D.AlignmentType.CENTER, after: 60 });
    let n = 0;
    for (const it of items) {
      busy(`正在生成報告… ${++n}／${items.length}`);
      curLbl = itemLabel(it);
      const d = S.drawings.find(x => x.id === it.drawingId); if (!d) continue;
      if (d.kind === 'pdf') await ensureBase(d, true);
      const rd = await reportImages(d, it); const reps = rd.reps;
      if (rd.ovErr) fails.push(`${itemLabel(it)} 總圖：${rd.ovErr.message}`);
      const lpParas = [];
      try { if (!rd.cr) throw rd.crErr || new Error('圖紙截取失敗'); lpParas.push(await pic(await locPlanImage(rd, d, it), 4 / 3)); }
      catch (e) { fails.push(`${itemLabel(it)} 圖紙截取：${e.message}`); lpParas.push(failText('圖紙截取')); console.error(e); }
      const phParas = [];
      for (const [i, ph] of it.photos.entries()) {
        try { if (!reps[i]) throw new Error('標記版讀取失敗'); phParas.push(await pic(reps[i], ph.w / ph.h)); }
        catch (e) {
          try { phParas.push(await pic(await shrink(ph.orig, 1400), ph.w / ph.h)); fails.push(`${itemLabel(it)} 照片${i + 1}：標記版讀取失敗，已改用原相`); }
          catch (e2) { fails.push(`${itemLabel(it)} 照片${i + 1}：${e.message}`); phParas.push(failText(`照片${i + 1}`)); console.error(e, e2); }
        }
      }
      if (!it.photos.length) phParas.push(Pg(T('（無照片）', { color: '888888' }), { align: D.AlignmentType.CENTER }));
      const afParas = [];
      for (const [i, ph] of ((it.fix && it.fix.photos) || []).entries()) {
        try { afParas.push(await pic(await shrink(ph.out, 1000), ph.w / ph.h)); } catch (e) { fails.push(`${itemLabel(it)} 回復照片${i + 1}：${e.message}`); }
        afParas.push(Pg(T(fmtTime(ph.t).slice(0, 10), { size: 13, color: '2F7D4F' }), { align: D.AlignmentType.CENTER, after: 60 }));
      }
      if (it.fix && it.fix.reply) afParas.push(Pg([T('Reply: ', { bold: true, size: 15, color: '2F7D4F' }), T(it.fix.reply, { size: 15, color: '2F7D4F' })]));
      const defParas = [];
      for (const [a, b] of [['Location', it.locText || '—'], ['Description', it.note || '—'], ['Action by', subText(it) || '—']]) {
        defParas.push(Pg(TS(a, { bold: true, size: 18 }), { after: 0 }));
        String(b).split('\n').forEach((l, j, A) => defParas.push(Pg(T(l, { size: 18 }), { after: j === A.length - 1 ? 140 : 0 })));
      }
      rows.push(fullRow([Pg(T(''), { after: 0 })], { h: 160 }));
      rows.push(new D.TableRow({
        cantSplit: true, children: [
          cell([Pg(TS(itemLabel(it), { bold: true, size: 22 }))], colTw[0], { shade: REP_ITEM.slice(1) }),
          cell([Pg(TS(floorOfItem(it) || '', { size: 18 }))], colTw[1]),
          cell(defParas, colTw[2]), cell(lpParas, colTw[3]), cell(phParas, colTw[4]), cell(afParas.length ? afParas : [Pg(T(''))], colTw[5]),
        ]
      }));
    }
    // page header: the OP inspection record title block, with the page count
    const hw = [colTw[0], Math.round(usable * 0.765) - colTw[0], 2100]; hw.push(usable - hw[0] - hw[1] - hw[2]);
    const hc = (children, i, o = {}) => cell(children, o.span ? hw[i] + hw[i + 1] : hw[i], { ...o, tight: true });
    const hp = (runs, o = {}) => Pg(runs, { after: 0, ...o });
    const header = new D.Table({ width: { size: usable, type: D.WidthType.DXA }, columnWidths: hw, layout: D.TableLayoutType.FIXED, rows: [
      new D.TableRow({ children: [hc([hp(T(''))], 0, { shade: REP_BLUE.slice(1) }), hc([hp(TS('OP Inspection Records (Defects and Outstanding Works)', { bold: true, size: 30 }))], 1, { shade: REP_BLUE.slice(1) }),
        hc([hp(TS(repTag(), { bold: true, size: 22, color: '1F6FB2' }), { align: D.AlignmentType.RIGHT })], 2, { span: 2, v: D.VerticalAlign.CENTER })] }),
      new D.TableRow({ children: [hc([hp(TS('Project:', { size: 18 }))], 0), hc([hp(TS(REPORT_PROJECT, { size: 18 }))], 1), hc([hp(TS('Inspection Date :', { size: 18 }), { align: D.AlignmentType.RIGHT })], 2), hc([hp(TS(repDate(), { size: 18 }))], 3)] }),
      new D.TableRow({ children: [hc([hp(TS('File Ref.:', { size: 18 }))], 0), hc([hp(TS(fileRefOf(), { size: 18 }))], 1), hc([hp(TS('Page :', { size: 18 }), { align: D.AlignmentType.RIGHT })], 2),
        hc([hp(new D.TextRun({ children: [D.PageNumber.CURRENT, ' of ', D.PageNumber.TOTAL_PAGES], font: SER, size: 18 }))], 3)] }),
    ] });
    const children = [new D.Table({ rows, width: { size: usable, type: D.WidthType.DXA }, columnWidths: colTw, layout: D.TableLayoutType.FIXED })];
    if (S.settings.keyPlan) {
      const avail = { w: Math.floor(usable / 15) - 10, h: Math.floor((11906 - 2400) / 15) - 90 };
      const groups = new Map();
      for (const it of items) { const v0 = viewById(S.drawings.find(q => q.id === it.drawingId) || {}, it.loc.viewId); const key = it.drawingId + '|' + (it.loc.viewId || '') + '|' + (v0 && v0.floors && v0.floors.length > 1 ? it.loc.floor || '' : ''); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(it); }
      for (const [key, its] of groups) {
        const [did, vid, fl] = key.split('|'); const d = S.drawings.find(x => x.id === did); if (!d) continue; const v = viewById(d, vid); const vt = (v ? v.title : d.name) + (fl ? `（${fl}）` : '');
        busy(`正在生成位置總圖：${vt}`);
        let k; try { k = await keyPlanImage(d, v, its); } catch (e) { fails.push(`位置總圖 ${vt}：${e.message}`); continue; } const s = Math.min(avail.w / k.w, avail.h / k.h);
        children.push(new D.Paragraph({ pageBreakBefore: true, children: [TS(`Location Plan: ${vt}`, { bold: true, size: 24 })], spacing: { after: 60 } }));
        children.push(Pg(T(`${d.no || d.name}　${its.map(i => itemLabel(i) + (i.loc.floor ? '(' + i.loc.floor + ')' : '')).join('、')}`, { size: 16, color: '5F6B69' }), { after: 80 }));
        children.push(Pg(new D.ImageRun({ data: await k.blob.arrayBuffer(), transformation: { width: Math.round(k.w * s), height: Math.round(k.h * s) } }), { align: D.AlignmentType.CENTER }));
      }
    }
    const doc = new D.Document({
      creator: '竣工驗收記錄', title: 'OP Inspection Records',
      styles: { default: { document: { run: { font: FONT, size: 18 } } } },
      sections: [{
        properties: { page: { size: { width: 11906, height: 16838, orientation: D.PageOrientation.LANDSCAPE }, margin: { top: 1650, bottom: 600, left: 600, right: 600, header: 400, footer: 300 } } },
        headers: { default: new D.Header({ children: [header] }) },
        children,
      }],
    });
    const blob = await D.Packer.toBlob(doc);
    busy();
    await deliver(blob, `竣工驗收記錄_${safeName(roundLabel())}_${safeName(P.name) || '項目'}_${P.date || today()}.docx`);
    ovCache.clear();
    if (fails.length) reportFails(fails);
  } catch (err) { busy(); console.error(err); toast('報告生成失敗' + (typeof curLbl !== 'undefined' && curLbl ? `（${curLbl}）` : '') + '：' + err.message, 8000); }
}

/* ---------------- device identity, captions, album, backup & merge ---------------- */
const devOf = it => it.dev || S.settings.dev || 'A';
// after 整理編號 a record carries a unified code (e.g. B1-003) that replaces the per-device number
const SUBS = ['承達', '遠東', '偉業', '富盈', '美的', '新宇宙', '思語', '廣林', '新寶', '歐吊', '卓裕', '定安（水）', '定安（消防）', '星滿', '通力', '元大', '洪興', '明記', '鈴木', '創基', '其士', '中海', '俊盈'];
// built-in list + ones added on this device + any that arrived on imported records
// a defect can need several 分判: subs holds them all, sub keeps the first for older app versions
// (if sub no longer matches subs[0], an older app version changed the 分判: trust that)
const subsOf = it => it.subs && it.subs.length && it.subs[0] === (it.sub || '') ? it.subs : it.sub ? [it.sub] : [];
function setSubs(it, list) { const L = [...new Set(list.filter(Boolean))]; it.subs = L; it.sub = L[0] || ''; }
const subText = it => subsOf(it).join('、');
const allSubs = () => [...new Set([...SUBS, ...(S.settings.customSubs || []), ...S.items.flatMap(subsOf)])];
// report scope: device and/or subcontractor ('-' = records without one)
const inScope = (i, od) => (!od || devOf(i) === od) && (!S.repSub || (S.repSub === '-' ? !subsOf(i).length : subsOf(i).includes(S.repSub)));
const itemLabel = it => it.code || `${devOf(it)}-${String(it.no).padStart(3, '0')}`;
const byOrder = (a, b) => (a.ord ?? 1e9) - (b.ord ?? 1e9) || devOf(a).localeCompare(devOf(b)) || a.no - b.no;
// pins have little room: number only, or floor + number where one plan stands for several floors
const pinLabel = (it, short) => { if (!it.code) return devOf(it) + it.no; const n = String(+it.code.split('-').pop()); return short || !(it.loc && it.loc.floor) ? n : `${it.loc.floor}-${n}`; };

/* unified numbering: as if one inspector made every record — grouped by floor, ordered by location */
function floorRank(f) {
  const s = String(f || '').toUpperCase().replace(/\/F$|F$/, '');
  let m = s.match(/^B(\d+)$/); if (m) return -Number(m[1]);
  if (/^(G|GF|LG|UG)$/.test(s)) return 0;
  m = s.match(/(\d+)/); return m ? Number(m[1]) : 999;
}
// a record in a part plan (stairs, details) has no floor of its own: use the floor of the sheet's main plan
function floorOfItem(it) {
  if (it.loc && it.loc.floor) return it.loc.floor;
  const d = S.drawings.find(x => x.id === it.drawingId); if (!d) return '';
  const area = v => (v.bbox[2] - v.bbox[0]) * (v.bbox[3] - v.bbox[1]);
  const main = (d.views || []).filter(v => v.floors && v.floors.length === 1).sort((a, b) => area(b) - area(a))[0];
  return main ? main.floors[0] : '';
}
async function renumberAll() {
  const key = it => { const L = it.loc || {}; return [L.tower || '', floorOfItem(it)].filter(Boolean).join('-') || '其他'; };
  const cmp = (a, b) => { const A = a.loc || {}, B = b.loc || {};
    return floorRank(floorOfItem(a)) - floorRank(floorOfItem(b)) || (A.tower || '').localeCompare(B.tower || '', 'en', { numeric: true })
      || (A.flat || '').localeCompare(B.flat || '', 'en', { numeric: true }) || (A.room || A.area || '').localeCompare(B.room || B.area || '', 'zh-Hant')
      || a.y - b.y || a.x - b.x; };
  const list = roundItems().sort(cmp); const cnt = new Map(); const now = Date.now();
  for (const [i, it] of list.entries()) {
    const k = key(it); const n = (cnt.get(k) || 0) + 1; cnt.set(k, n);
    if (!it.origLabel) it.origLabel = `${devOf(it)}-${String(it.no).padStart(3, '0')}`;
    it.code = `${k}-${String(n).padStart(3, '0')}`; it.ord = i; it.mod = now;
    await saveItem(it);
  }
  renderOverlay(); updateBar(); toast(`已整理 ${list.length} 項記錄的編號（${cnt.size} 個樓層）`, 4000);
}
const fmtTime = t => { const d = new Date(t || Date.now()); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
// a record counts as backed up by a full / new-records backup, or by a backup of its own round
const backedAt = it => Math.max(S.settings.lastBackup || 0, (S.settings.roundBackup || {})[roundOf(it)] || 0);
function unbacked() { return S.items.filter(i => (i.mod || i.created || 0) > backedAt(i)).length; }
function unalbum() { return S.items.reduce((n, i) => n + i.photos.filter(p => !p.album).length + ((i.fix && i.fix.photos) || []).filter(p => !p.album).length, 0); }

async function renderOut(orig, shapes) {
  const img = await loadImg(orig); const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const lw = Math.max(5, Math.round(Math.max(w, h) / 160)); for (const s of shapes || []) drawShape(x, s, lw);
  URL.revokeObjectURL(img.src); return canvasBlob(c, 'image/jpeg', 0.86);
}
/* photo with a caption strip burnt in: readable on its own in the Photos app, WhatsApp or a folder */
async function captioned(it, ph, i, after) {
  const img = await loadImg(await photoOut(it, ph)); const w = img.naturalWidth, h = img.naturalHeight;
  const fs = Math.max(18, Math.round(w / 48)), pad = Math.round(fs * 0.6), lh = Math.round(fs * 1.35);
  const list = after ? ((it.fix && it.fix.photos) || []) : it.photos, cntN = Math.max(list.length, i + 1);
  const d = S.drawings.find(x => x.id === it.drawingId) || {};
  const lines = [`${itemLabel(it)}${after ? '　完成後' : ''}${cntN > 1 ? ` (${i + 1}/${cntN})` : ''}　${it.locText || ''}`,
    `${fmtTime(ph.t)}　${after ? '執修' : '檢查'}：${(after ? it.fix && it.fix.by : it.by) || S.settings.inspector || devOf(it)}　${roundName(roundOf(it))}　${S.project.name || ''}`,
    `坐標：${d.no || it.drawingId}　x ${Math.round(it.x)}　y ${Math.round(it.y)}`];
  const note = after ? (it.fix && it.fix.reply ? '回覆：' + it.fix.reply : '') : it.note;
  if (note) lines.push(note.replace(/\s+/g, ' ').slice(0, 80));
  const qr = qrFor(asciiJSON(photoMeta(it, ph, i, after, false)));
  const cell = qr ? Math.max(3, Math.round(fs / 6)) : 0, qpx = qr ? (qr.getModuleCount() + 8) * cell : 0;
  const stripH = Math.max(pad * 2 + lh * lines.length, qpx + pad);
  const c = document.createElement('canvas'); c.width = w; c.height = h + stripH; const x = c.getContext('2d');
  x.drawImage(img, 0, 0); x.fillStyle = '#1d2629'; x.fillRect(0, h, w, stripH);
  const tw = w - pad * 2 - (qpx ? qpx + pad : 0);
  x.textBaseline = 'top'; lines.forEach((t, k) => { x.fillStyle = k ? '#d6dedb' : '#ffffff'; x.font = `${k ? '' : 'bold '}${k ? Math.round(fs * 0.85) : fs}px -apple-system,"PingFang TC",sans-serif`; x.fillText(t, pad, h + pad + k * lh, tw); });
  if (qr) { const n = qr.getModuleCount(), qx = w - pad - qpx, qy = h + Math.round((stripH - qpx) / 2); x.fillStyle = '#fff'; x.fillRect(qx, qy, qpx, qpx); x.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let cc = 0; cc < n; cc++) if (qr.isDark(r, cc)) x.fillRect(qx + (cc + 4) * cell, qy + (r + 4) * cell, cell, cell); }
  URL.revokeObjectURL(img.src);
  const blob = await canvasBlob(c, 'image/jpeg', 0.9); c.width = c.height = 0;
  try { return new Blob([exifWithDesc(new Uint8Array(await blob.arrayBuffer()), asciiJSON(photoMeta(it, ph, i, after, true)))], { type: 'image/jpeg' }); } catch (e) { return blob; }
}
const photoName = (it, i, after) => safeName(`${itemLabel(it)}_${it.locText || ''}_${after ? '完成' : ''}${i + 1}`).replace(/[\s\u3000]+/g, '_').slice(0, 90) + '.jpg';

/* save captioned photos into the iPad Photos album through the share sheet, in batches */
async function albumPanel() {
  const todo = []; for (const it of S.items.slice().sort(byOrder)) { it.photos.forEach((p, i) => { if (!p.album) todo.push([it, p, i]); }); ((it.fix && it.fix.photos) || []).forEach((p, i) => { if (!p.album) todo.push([it, p, i, true]); }); }
  const N = 20, batches = Math.ceil(todo.length / N);
  openPanel('album', '存入相簿', todo.length ? `
    <div class="note">尚有 <b>${todo.length}</b> 張相未存入相簿。每批 ${N} 張，${IS_ANDROID ? '按下後直接存入手機的「Download」資料夾（第一次請在提示中按「允許」下載多個檔案）' : `按下後在分享選單揀「儲存 ${Math.min(N, todo.length)} 張影像」`}。存入的相片底部印有編號、位置、時間及檢查人員。</div>
    <button class="btn p" id="albGo">存入第 1 批（共 ${batches} 批）</button>`
    : '<div class="note">全部相片已存入相簿。</div>', { compact: true });
  const go = $('#albGo'); if (!go) return;
  go.onclick = async () => {
    const part = todo.slice(0, N);
    if (IS_ANDROID) {
      const bad = []; let ok = 0;
      busy('正在存入…');
      for (const [it, p, i, af] of part) { try { saveFile(await captioned(it, p, i, af), photoName(it, i, af)); p.album = Date.now(); await saveItem(it); ok++; await new Promise(r => setTimeout(r, 250)); } catch (e) { bad.push(`${itemLabel(it)} ${af ? '回復' : '照片'}${i + 1}：${e.message}`); } }
      busy(); toast(`已存入 ${ok} 張`); albumPanel(); updateBar(); if (bad.length) badPhotos(bad);
      return;
    }
    if (!navigator.canShare) return toast('這個瀏覽器不支援存入相簿，請用 iPad Safari');
    try {
      busy('正在準備相片…'); const files = [], done = [], bad = [];
      for (const [it, p, i, af] of part) { try { files.push(new File([await captioned(it, p, i, af)], photoName(it, i, af), { type: 'image/jpeg' })); done.push([it, p]); } catch (e) { bad.push(`${itemLabel(it)} ${af ? '回復' : '照片'}${i + 1}：${e.message}`); } }
      busy();
      if (!files.length) return badPhotos(bad);
      if (!navigator.canShare({ files })) return toast('這部機不能經分享選單存相');
      await navigator.share({ files });
      for (const [it, p] of done) { p.album = Date.now(); await saveItem(it); }
      toast(`已存入 ${done.length} 張`); albumPanel(); updateBar(); if (bad.length) badPhotos(bad);
    } catch (e) { busy(); if (e.name !== 'AbortError') toast('未能存入：' + e.message, 4000); }
  };
}

function badPhotos(bad) {
  openPanel('fails', `${bad.length} 張相片未能讀取`, `<div class="note">其餘相片已處理。請到「導出 → 檢查及修復相片」嘗試修復；修復不到的，可用以前的備份檔或相簿內的相片（「從相片還原記錄」）補回。</div><div class="list">${bad.map(f => `<div class="li" style="display:block">${esc(f)}</div>`).join('')}</div><button class="btn p" data-a="fix">檢查及修復相片</button>`);
  panel.querySelector('[data-a="fix"]').onclick = () => repairPhotos();
}
/* check every stored photo; rebuild a lost copy from the other one (marked-up ↔ original) */
async function repairPhotos() {
  let n = 0, fixed = 0; const lost = [];
  try {
    const recs = await DB.all('items');
    for (const f of recs) {
      let changed = false;
      for (const [k, ph] of allPhotos(f).entries()) {
        busy(`正在檢查相片 ${++n}`);
        const o = await canRead(ph.orig), x = await canRead(ph.out);
        if (o && x) continue;
        const af = k >= (f.photos || []).length, idx = af ? k - f.photos.length : k, lbl = `${itemLabel(f)} ${af ? '回復' : '照片'}${idx + 1}`;
        if (o) { try { ph.out = await renderOut(ph.orig, ph.shapes); changed = true; fixed++; continue; } catch (e) { } }
        if (x) { ph.orig = ph.out; ph.shapes = []; changed = true; fixed++; continue; } // markings are kept, baked into the image
        lost.push(lbl);
      }
      if (changed) { await DB.put('items', f); const it = S.items.find(i => i.id === f.id); if (it) await refreshPhotos(it); }
    }
    busy();
    openPanel('repair', '檢查及修復相片', `<div class="note">檢查了 ${n} 張相片${fixed ? `，修復了 <b>${fixed}</b> 張（用同一張相的另一份副本重建）` : '，沒有需要修復的'}。</div>
      ${lost.length ? `<div class="note"><b>${lost.length} 張</b>的原相及標記版都已失效，未能在程式內修復。可用以下方法補回：<br>① 以前導出的備份檔（ZIP）：「匯入備份檔」會補回相片<br>② 相簿內本程式存過的相片：「從相片還原記錄」會放回原位</div><div class="list">${lost.map(l => `<div class="li" style="display:block">${esc(l)}</div>`).join('')}</div>` : ''}`);
    renderOverlay(); updateBar();
  } catch (e) { busy(); toast('檢查失敗：' + e.message, 6000); }
}
/* ZIP backup: data.json + original photos + captioned photos (viewable without the app) */
function reportFails(fails) {
  openPanel('fails', '報告已生成，但部分圖片有問題', `<div class="note">以下 ${fails.length} 處在報告內以紅字標示。請截圖這個畫面給我，方便查找原因。</div><div class="list">${fails.map(f => `<div class="li" style="display:block">${esc(f)}</div>`).join('')}</div>`);
}
async function exportBackup(onlyNew, roundId) {
  if (!window.JSZip) return toast('備份元件未載入，請連網後重新開啟');
  try {
    const rd = roundId && S.rounds.find(r => r.id === roundId);
    const items = S.items.filter(i => rd ? roundOf(i) === rd.id : !onlyNew || (i.mod || i.created || 0) > backedAt(i)).sort(byOrder);
    if (!items.length) return toast(rd ? '這個批次沒有記錄' : '沒有新的記錄需要備份');
    busy('正在打包…'); const zip = new JSZip(); const out = [];
    let n = 0, tot = items.reduce((s, i) => s + i.photos.length + ((i.fix && i.fix.photos) || []).length, 0);
    for (const it of items) {
      const photos = [];
      for (const [i, p] of it.photos.entries()) {
        busy(`正在打包相片 ${++n}／${tot}`);
        const o = `data/${p.id}.jpg`; zip.file(o, p.orig, { compression: 'STORE' });
        zip.file(`相片/${photoName(it, i)}`, await captioned(it, p, i), { compression: 'STORE' });
        const { orig, out: _o, ...meta } = p; photos.push({ ...meta, orig: o });
      }
      let fix = it.fix;
      if (fix && fix.photos && fix.photos.length) { const fp = [];
        for (const [i, p] of fix.photos.entries()) { busy(`正在打包相片 ${++n}／${tot}`); const o = `data/${p.id}.jpg`; zip.file(o, p.orig, { compression: 'STORE' }); zip.file(`相片/${photoName(it, i, true)}`, await captioned(it, p, i, true), { compression: 'STORE' }); const { orig, out: _o, ...meta } = p; fp.push({ ...meta, orig: o }); }
        fix = { ...fix, photos: fp }; }
      out.push({ ...it, photos, fix });
    }
    const drawings = S.drawings.filter(d => d.src !== 'bundle' || true).map(d => ({ id: d.id, src: d.src, views: d.src === 'user' ? d.views : undefined }));
    zip.file('data.json', JSON.stringify({ app: 'handover-inspect', format: 2, version: VERSION, exported: new Date().toISOString(), dev: S.settings.dev, inspector: S.settings.inspector, onlyNew: !!onlyNew, round: rd ? rd.id : undefined, project: S.project, rounds: rd ? [rd] : S.rounds, items: out, mapping: S.drawings.filter(d => d.src === 'bundle').map(d => ({ id: d.id, views: d.views })) }));
    busy('正在壓縮…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
    busy();
    const stamp = fmtTime().replace(/[-: ]/g, '').slice(0, 12);
    const tag = rd ? `${setName(setOfRound(rd))}_${rd.name}`.replace(/[\\/:*?"<>|\s]+/g, '') : onlyNew ? '新增' : '完整';
    await deliver(blob, `驗收備份_${S.settings.dev || 'A'}_${tag}_${stamp}.zip`);
    if (rd) S.settings.roundBackup = { ...S.settings.roundBackup, [rd.id]: Date.now() }; else S.settings.lastBackup = Date.now();
    await saveKV(); updateBar(); if (S.panel === 'export') exportPanel();
  } catch (err) { busy(); toast('備份失敗：' + err.message, 6000); }
}
/* merge an incoming copy of a record into the local one, field group by field group:
   the side edited later wins; an empty value from a copy without edit times never clears a filled one;
   photos are combined (a lost local photo is replaced by the incoming one) */
async function mergeRecord(ex, inc, conv) {
  const tm = r => r.mod || r.created || 0, incNewer = tm(inc) > tm(ex);
  const empty = (r, g) => g === 'note' ? !(r.note || '').trim() : g === 'sub' ? !subsOf(r).length : g === 'code' ? !r.code
    : g === 'fix' ? !r.fix || ((r.fix.status || 'open') === 'open' && !r.fix.reply && !(r.fix.photos || []).length) : false;
  const keys = { sub: ['sub', 'subs'], code: ['code', 'ord', 'origLabel'], loc: ['drawingId', 'x', 'y', 'loc', 'locText', 'locEdited'] };
  let changed = false; const fm = { ...(ex.fm || {}) };
  for (const g of Object.keys(FG)) {
    if (sigOf(ex, g) === sigOf(inc, g)) continue;
    const fe = ex.fm && ex.fm[g], fi = inc.fm && inc.fm[g];
    let take;
    if (empty(inc, g) && !empty(ex, g) && !fi) take = false;
    else if (empty(ex, g) && !empty(inc, g) && !fe) take = true;
    else take = (fi || tm(inc)) > (fe || tm(ex));
    if (!take) continue;
    if (g === 'fix') { const lp = (ex.fix && ex.fix.photos) || []; ex.fix = { ...inc.fix, photos: lp }; }
    else for (const k of keys[g] || [g]) ex[k] = inc[k];
    if (fi) fm[g] = fi; changed = true;
  }
  // photos: union by id
  const mergeList = async (local, incoming) => {
    for (const p of incoming || []) {
      const l = local.find(q => q.id === p.id);
      if (!l) { const c = await conv(p); if (c) { local.push(c); changed = true; } continue; }
      const lost = !(await canRead(l.out)) && !(await canRead(l.orig));
      const remark = incNewer && JSON.stringify(l.shapes || []) !== JSON.stringify(p.shapes || []);
      if (lost || remark) { const c = await conv(p); if (c) { Object.assign(l, c); changed = true; } }
    }
    local.sort((a, b) => (a.t || 0) - (b.t || 0));
  };
  await mergeList(ex.photos, inc.photos);
  if (inc.fix && inc.fix.photos && inc.fix.photos.length) { fixOf(ex); await mergeList(ex.fix.photos, inc.fix.photos); }
  for (const k of ['by', 'dev', 'no', 'created', 'restored']) if (ex[k] == null && inc[k] != null) { ex[k] = inc[k]; changed = true; }
  if (changed) { ex.fm = fm; ex.mod = Math.max(tm(ex), tm(inc)); }
  return changed;
}
async function importBackup(file) {
  try {
    busy('正在匯入…'); let data, zip = null;
    if (/\.zip$/i.test(file.name) || file.type.includes('zip')) { zip = await JSZip.loadAsync(file); data = JSON.parse(await zip.file('data.json').async('string')); }
    else data = JSON.parse(await file.text());
    if (data.app !== 'handover-inspect') throw new Error('不是本程式的備份檔');
    if (data.project && !S.project.name) S.project = { ...S.project, ...data.project };
    const rmap = {}; for (const r of data.rounds || []) rmap[r.id] = mergeRound(r.id, r.name, r.date, r.set);
    let add = 0, upd = 0, skip = 0, i = 0;
    for (const it of data.items || []) {
      busy(`正在匯入記錄 ${++i}／${data.items.length}`);
      if (!it.dev) it.dev = data.dev || 'X';
      it.round = rmap[it.round] || mergeRound(it.round);
      if (!it.by && data.inspector && it.dev === data.dev) it.by = data.inspector;
      const ex = S.items.find(x => x.id === it.id);
      const conv = async p => { // a photo of the incoming copy, with its image read from the backup
        let orig = typeof p.orig === 'string' && p.orig.startsWith('data:') ? await dataURLToBlob(p.orig) : zip && typeof p.orig === 'string' && zip.file(p.orig) ? await zip.file(p.orig).async('blob') : null;
        if (!orig) return null; orig = new Blob([orig], { type: 'image/jpeg' });
        const out = typeof p.out === 'string' && p.out.startsWith('data:') ? await dataURLToBlob(p.out) : await renderOut(orig, p.shapes);
        const { orig: _o, out: _x, ...meta } = p; return { ...meta, orig, out };
      };
      if (!ex) {
        const photos = (await Promise.all((it.photos || []).map(conv))).filter(Boolean);
        let fix = it.fix; if (fix && fix.photos) fix = { ...fix, photos: (await Promise.all(fix.photos.map(conv))).filter(Boolean) };
        const rec = { ...it, photos, fix }; await saveItem(rec, true); S.items.push(rec); add++; continue;
      }
      if (await mergeRecord(ex, it, conv)) { await saveItem(ex, true); upd++; } else skip++;
    }
    await saveKV(); await saveRounds(); busy(); toast(`匯入完成：新增 ${add}、更新 ${upd}、略過 ${skip}`, 4000);
    await showDrawing(S.cur || S.drawings[0]?.id); closePanel();
  } catch (err) { busy(); toast('匯入失敗：' + err.message, 6000); console.error(err); }
}
$('#jsonInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };

function setupPanel(first) {
  openPanel('setup', first ? '開始前：設定本機' : '本機設定', `
    <div class="note">多部 iPad 同時驗收時，每部機用不同代號（A、B、C…），編號會變成 A-001、B-001，合併時不會撞號。</div>
    <div class="grid2"><label class="f">本機代號<input id="sDev" value="${esc(S.settings.dev || '')}" maxlength="3" autocapitalize="characters" placeholder="A"></label>
    <label class="f">檢查人員<input id="sBy" value="${esc(S.settings.inspector || '')}" placeholder="姓名"></label></div>
    <button class="btn dk" id="sOk">儲存</button>`, { compact: true });
  $('#sOk').onclick = async () => {
    const dev = ($('#sDev').value.trim().toUpperCase() || 'A').replace(/[^A-Z0-9]/g, '') || 'A';
    const clash = S.items.some(i => i.dev && i.dev !== dev && i.dev === S.settings.dev) && false;
    S.settings.dev = dev; S.settings.inspector = $('#sBy').value.trim(); if (!S.project.inspector) S.project.inspector = S.settings.inspector;
    for (const it of S.items) if (!it.dev) { it.dev = dev; await saveItem(it); }
    await saveKV(); closePanel(); updateBar(); renderOverlay(); toast(`本機代號 ${dev}`);
  };
}

/* ---------------- report pages drawn on canvas: preview + PDF ---------------- */
const PG = { W: 842, H: 595, k: 2, M: 28 }; // A4 landscape in pt, 2 px per pt
const RFONT = '-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif';
function wrapLines(x, text, maxW) {
  const out = []; for (const para of String(text || '').split('\n')) {
    let line = ''; for (const ch of para) { if (x.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch; }
    out.push(line);
  } return out;
}
function drawText(x, text, X, Y, maxW, size, o = {}) {
  x.font = `${o.bold ? '700 ' : ''}${size}px ${o.font || RFONT}`; x.fillStyle = o.color || '#1b2224'; x.textBaseline = 'top';
  const lines = wrapLines(x, text, maxW).slice(0, o.max || 99); const lh = size * 1.3;
  lines.forEach((l, i) => { const w = x.measureText(l).width; x.fillText(l, o.center ? X + (maxW - w) / 2 : o.right ? X + maxW - w : X, Y + i * lh); });
  return lines.length * lh;
}
async function drawBlob(x, blob, X, Y, W, H) { const img = await loadImg(blob); x.drawImage(img, X, Y, W, H); if (img.close) img.close(); else URL.revokeObjectURL(img.src); }

// report header, as on the site's OP inspection record forms
const REPORT_PROJECT = 'PROPOSED DEVELOPMENT AT BAILEY STREET & WING KWONG STREET TO KWA WAN, KOWLOON';
const RSERIF = '"Times New Roman",Times,"PingFang TC","Noto Serif TC","PMingLiU",serif';
const REP_BLUE = '#95b3d7', REP_ITEM = '#dce6f1', REP_GREY = '#eeeeee';
const fileRefOf = () => (SETS.find(x => x.id === curSet()) || SETS[0]).fileRef;
const worksOf = () => (SETS.find(x => x.id === curSet()) || SETS[0]).works;
const repDate = () => curRound().date || S.project.date || '';
const repTag = () => roundLabel() + (repLabel ? '　' + repLabel : '');
// the drawing crop with the overview set into its top-right corner: one picture, same size as a photo
async function locPlanImage(rd, d, it) {
  if (!rd.cr) return null;
  const { W, H } = LP, Ly = lpLayout(d, it); const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  const put = async (blob, b) => { const img = await loadImg(blob); x.drawImage(img, b.x, b.y, b.w, b.h); if (img.close) img.close(); else URL.revokeObjectURL(img.src); };
  await put(rd.cr.blob, Ly.cr);
  if (rd.ov) await put(rd.ov.blob, Ly.ov);
  // the spare corner names the sheet and view
  const v = viewById(d, it.loc.viewId), t = Ly.tx;
  if (t.w > 120 && t.h > 60) { x.textBaseline = 'top'; x.fillStyle = '#333'; let ty = t.y + 6;
    for (const [txt, sz, b] of [[d.no || '', 30, true], [v ? v.title : d.name, 26, false]]) { x.font = `${b ? '700 ' : ''}${sz}px ${RFONT}`;
      for (const l of wrapLines(x, txt, t.w - 12).slice(0, 3)) { if (ty + sz > t.y + t.h) break; x.fillText(l, t.x + 6, ty); ty += sz * 1.25; } ty += 6; } }
  return canvasBlob(c, 'image/jpeg', 0.88);
}
const fitIn = (r, W, H) => r > W / H ? [W, W / r] : [H * r, H];

async function buildReportPages(items, progress) {
  items = await freshItems(items);
  const k = PG.k, M = PG.M, UW = PG.W - 2 * M;
  const pct = [7, 5, 19, 23, 23, 23], cw = pct.map(p => UW * p / 100), cx = cw.map((_, i) => M + cw.slice(0, i).reduce((a, b) => a + b, 0));
  const heads = ['Item No.', 'Floor', 'Defect / Outstanding works', 'Location Plan', 'Photo (Before)', 'Photo (After)'];
  const pad = 5, imgW = cw[3] - 2 * pad, imgH = imgW * 0.75, headTop = M + 60, bottom = PG.H - M;
  const pages = []; let c, x, y, fails = [];
  const line = (X0, Y0, X1, Y1) => { x.beginPath(); x.moveTo(X0, Y0); x.lineTo(X1, Y1); x.stroke(); };
  const box = (X, Y, W, H, fill) => { if (fill) { x.fillStyle = fill; x.fillRect(X, Y, W, H); } x.strokeStyle = '#333'; x.lineWidth = 0.6; x.strokeRect(X, Y, W, H); };
  const blankPage = () => { c = document.createElement('canvas'); c.width = PG.W * k; c.height = PG.H * k; x = c.getContext('2d'); x.scale(k, k); x.fillStyle = '#fff'; x.fillRect(0, 0, PG.W, PG.H); pages.push(c); y = headTop; };
  const newPage = () => {
    blankPage();
    box(M, y, UW, 13, REP_GREY); drawText(x, worksOf(), M + 4, y + 2.5, UW, 8.5, { bold: true, font: RSERIF }); y += 13;
    box(M, y, UW, 14); cx.slice(1).forEach(X => line(X, y, X, y + 14));
    heads.forEach((h, i) => drawText(x, h, cx[i] + 4, y + 3, cw[i] - 6, 8.5, { bold: true, font: RSERIF })); y += 14;
  };
  // header block of every page; drawn last, when the page count is known
  const header = (pc, i, n) => {
    x = pc.getContext('2d'); const tw = UW * 0.765, lw = 108, X2 = M + tw, X3 = X2 + lw, Y = M;
    box(M, Y, cw[0], 22, REP_BLUE); box(M + cw[0], Y, tw - cw[0], 22, REP_BLUE); box(X2, Y, UW - tw, 22);
    drawText(x, 'OP Inspection Records (Defects and Outstanding Works)', M + cw[0] + 5, Y + 4, tw - cw[0] - 8, 14, { bold: true, font: RSERIF, max: 1 });
    drawText(x, repTag(), X2 + 4, Y + 6, UW - tw - 8, 10, { bold: true, color: '#1f6fb2', font: RSERIF, max: 1, right: true });
    const rows = [['Project:', REPORT_PROJECT, 'Inspection Date :', repDate()], ['File Ref.:', fileRefOf(), 'Page :', `${i} of ${n}`]];
    rows.forEach((r, j) => { const ry = Y + 22 + j * 14;
      box(M, ry, cw[0], 14); box(M + cw[0], ry, tw - cw[0], 14); box(X2, ry, lw, 14); box(X3, ry, UW - tw - lw, 14);
      drawText(x, r[0], M + 4, ry + 3, cw[0] - 6, 8.5, { font: RSERIF, max: 1 }); drawText(x, r[1], M + cw[0] + 5, ry + 3, tw - cw[0] - 8, 8.5, { font: RSERIF, max: 1 });
      drawText(x, r[2], X2 + 4, ry + 3, lw - 8, 8.5, { font: RSERIF, max: 1, right: true }); drawText(x, r[3], X3 + 4, ry + 3, UW - tw - lw - 8, 8.5, { font: RSERIF, max: 1 }); });
  };
  newPage();
  let n = 0;
  for (const it of items) {
    progress && progress(++n, items.length);
    const d = S.drawings.find(q => q.id === it.drawingId); if (!d) continue;
    const rd = await reportImages(d, it); const reps = rd.reps;
    if (rd.ovErr) fails.push(`${itemLabel(it)} 總圖：${rd.ovErr.message}`);
    if (rd.crErr) fails.push(`${itemLabel(it)} 圖紙截取：${rd.crErr.message}`);
    let lp = null; try { lp = await locPlanImage(rd, d, it); } catch (e) { fails.push(`${itemLabel(it)} 圖紙位置：${e.message}`); }
    const rps = (it.fix && it.fix.photos) || [], np = Math.max(1, it.photos.length, rps.length);
    const reply = it.fix && it.fix.reply ? 'Reply: ' + it.fix.reply : '';
    // text column height, measured with the same fonts
    const L = it.loc || {}; const tW = cw[2] - 2 * pad;
    const parts = [['Location', it.locText || '—'], ['Description', it.note || '—'], ['Action by', subText(it) || '—']];
    x.font = `8.5px ${RFONT}`; const textH = parts.reduce((h, [, v]) => h + 11 + wrapLines(x, v, tW).length * 8.5 * 1.3 + 6, 0);
    let ph = imgH; const avail = bottom - headTop - 27 - 8 - 2 * pad;
    const stackH = h => np * (h + 4) - 4 + (rps.length ? 10 * rps.length : 0) + (reply ? 40 : 0);
    if (stackH(ph) > avail) ph = Math.max(40, (avail - (rps.length ? 10 * rps.length : 0) - (reply ? 40 : 0) - 4 * (np - 1)) / np);
    const rowH = Math.max(imgH, stackH(ph), textH) + 2 * pad;
    if (y + 8 + rowH > bottom) newPage();
    box(M, y, UW, 8, REP_GREY); y += 8;
    const y0 = y; box(cx[0], y0, cw[0], rowH, REP_ITEM); box(M, y0, UW, rowH); cx.slice(1).forEach(X => line(X, y0, X, y0 + rowH));
    drawText(x, itemLabel(it), cx[0] + 4, y0 + pad, cw[0] - 6, 10, { bold: true, font: RSERIF });
    drawText(x, floorOfItem(it) || '', cx[1] + 3, y0 + pad + 1, cw[1] - 5, 8.5, { font: RSERIF });
    let ty = y0 + pad;
    for (const [a, b] of parts) { ty += drawText(x, a, cx[2] + pad, ty, tW, 8.5, { bold: true, font: RSERIF }) + 1; ty += drawText(x, b, cx[2] + pad, ty, tW, 8.5) + 6; }
    const ix = cx[3] + pad;
    if (lp) await drawBlob(x, lp, ix, y0 + pad, imgW, imgH); else drawText(x, '（圖紙截取無法生成）', ix, y0 + pad + 40, imgW, 7, { color: '#d42a1e', center: true });
    const pw = ph / 0.75 > imgW ? imgW : ph / 0.75, phH = pw * 0.75;
    let py = y0 + pad; const px0 = cx[4] + pad;
    if (!it.photos.length) drawText(x, '（無照片）', px0, py + 20, imgW, 8, { color: '#888', center: true });
    for (const [i, p] of it.photos.entries()) {
      const [dw, dh] = fitIn(p.w / p.h, pw, phH), X = px0 + (imgW - dw) / 2, Y = py + (phH - dh) / 2;
      try { if (!reps[i]) throw new Error('標記版讀取失敗'); await drawBlob(x, reps[i], X, Y, dw, dh); }
      catch (e) { try { await drawBlob(x, await shrink(p.orig, 1400), X, Y, dw, dh); fails.push(`${itemLabel(it)} 照片${i + 1}：已改用原相`); } catch (e2) { fails.push(`${itemLabel(it)} 照片${i + 1}：${e.message}`); drawText(x, `（照片${i + 1}無法讀取）`, px0, py + phH / 2, imgW, 7, { color: '#d42a1e', center: true }); } }
      py += phH + 4;
    }
    let ry = y0 + pad; const rx = cx[5] + pad;
    for (const [i, p] of rps.entries()) {
      const [dw, dh] = fitIn(p.w / p.h, pw, phH);
      try { await drawBlob(x, await shrink(p.out, 1000), rx + (imgW - dw) / 2, ry + (phH - dh) / 2, dw, dh); } catch (e) { fails.push(`${itemLabel(it)} 回復照片${i + 1}：${e.message}`); }
      ry += phH + 1; ry += drawText(x, fmtTime(p.t).slice(0, 10), rx, ry, imgW, 6.5, { color: '#2f7d4f', center: true }) + 3;
    }
    if (reply) drawText(x, reply, rx, ry, imgW, 7.5, { color: '#2f7d4f', max: 4 });
    y += rowH;
  }
  if (S.settings.keyPlan) {
    const groups = new Map(); for (const it of items) { const v0 = viewById(S.drawings.find(q => q.id === it.drawingId) || {}, it.loc.viewId); const key = it.drawingId + '|' + (it.loc.viewId || '') + '|' + (v0 && v0.floors && v0.floors.length > 1 ? it.loc.floor || '' : ''); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(it); }
    for (const [key, its] of groups) {
      const [did, vid, fl] = key.split('|'); const d = S.drawings.find(q => q.id === did); if (!d) continue; const v = viewById(d, vid); const vt = (v ? v.title : d.name) + (fl ? `（${fl}）` : '');
      try {
        const kp = await keyPlanImage(d, v, its);
        blankPage();
        y += drawText(x, `Location Plan: ${vt}`, M, y, UW, 12, { bold: true, font: RSERIF }) + 2;
        y += drawText(x, `${d.no || ''}　${its.map(i => itemLabel(i) + (i.loc.floor ? '(' + i.loc.floor + ')' : '')).join('、')}`, M, y, UW, 7.5, { color: '#5f6b69', max: 3 }) + 6;
        const s = Math.min(UW / kp.w, (bottom - y) / kp.h); await drawBlob(x, kp.blob, M + (UW - kp.w * s) / 2, y, kp.w * s, kp.h * s);
      } catch (e) { fails.push(`位置總圖 ${vt}：${e.message}`); }
    }
  }
  const blobs = [];
  for (const [i, pc] of pages.entries()) { header(pc, i + 1, pages.length); blobs.push(await canvasBlob(pc, 'image/jpeg', 0.88)); pc.width = pc.height = 0; }
  return { pages: blobs, fails };
}

let PV = null;
async function previewReport(onlyDev, kind = 'inspect') {
  const items = reportItems(kind, onlyDev);
  if (!items.length) return toast(kind === 'fixdone' ? '目前批次還沒有已完成的項目' : '目前批次還沒有記錄');
  try {
    busy('正在生成預覽…'); ovCache.clear();
    const pr = (a, b) => busy(`正在生成預覽… ${a}／${b}`); const r = kind === 'inspect' ? await buildReportPages(items, pr) : await buildFixPages(items, pr, kind);
    ovCache.clear(); busy();
    PV = { ...r, onlyDev, kind, urls: r.pages.map(b => URL.createObjectURL(b)) };
    const el = $('#preview'); if (!el) { busy(); return toast('程式未完全更新，請關閉並重新開啟程式', 6000); }
    el.querySelector('.pvpages').innerHTML = PV.urls.map((u, i) => `<img src="${u}" alt="第 ${i + 1} 頁">`).join('');
    el.querySelector('.pvinfo').textContent = `共 ${PV.pages.length} 頁　${items.length} 項記錄${PV.fails.length ? `　·　${PV.fails.length} 處圖片有問題` : ''}`;
    el.hidden = false; el.querySelector('.pvpages').scrollTop = 0;
  } catch (e) { busy(); toast('預覽失敗：' + e.message, 6000); console.error(e); }
}
function closePreview() { $('#preview').hidden = true; if (PV) PV.urls.forEach(u => URL.revokeObjectURL(u)); $('#preview .pvpages').innerHTML = ''; const f = PV && PV.fails; PV = null; if (f && f.length) reportFails(f); }
async function pdfBlob(pages) {
  const doc = new jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true });
  for (const [i, b] of pages.entries()) { if (i) doc.addPage('a4', 'landscape'); doc.addImage(new Uint8Array(await b.arrayBuffer()), 'JPEG', 0, 0, PG.W, PG.H, undefined, 'FAST'); }
  return doc.output('blob');
}
// 管工 areas: the podium (B3–2F) and each tower above it
function areaOf(it) {
  const f = floorOfItem(it); if (f && floorRank(f) <= 2) return 'Podium';
  return (it.loc && it.loc.tower) || (f ? '其他' : 'Podium');
}
const AREA_ORDER = ['Podium', 'T1', 'T2', 'T3', 'T5'];
let repLabel = ''; // shown on the first page of each file of a batch export
async function exportPdfSet(by, kind, od) {
  if (!window.jspdf) return toast('PDF 元件未載入，請連網後重新開啟');
  const L = roundItems().filter(i => !od || devOf(i) === od).filter(i => kind !== 'fixdone' || fixStatus(i) === 'done').sort(byOrder);
  if (!L.length) return toast('目前批次還沒有記錄');
  const subsOr = i => subsOf(i).length ? subsOf(i) : ['未指定分判'];
  const keysOf = by === 'sub' ? subsOr : by === 'area' ? i => [areaOf(i)] : i => subsOr(i).map(x => `${areaOf(i)}_${x}`);
  const groups = new Map(); for (const it of L) for (const k of keysOf(it)) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  const subRank = x => { const i = allSubs().indexOf(x); return i < 0 ? 999 : i; }, areaRank = x => { const i = AREA_ORDER.indexOf(x); return i < 0 ? 99 : i; };
  const rank = k => by === 'sub' ? [subRank(k)] : by === 'area' ? [areaRank(k)] : [areaRank(k.split('_')[0]), subRank(k.split('_').slice(1).join('_'))];
  const keys = [...groups.keys()].sort((a, b) => { const A = rank(a), B = rank(b); return A[0] - B[0] || (A[1] || 0) - (B[1] || 0) || a.localeCompare(b); });
  const files = [], fails = []; let g = 0;
  try {
    ovCache.clear();
    for (const k of keys) {
      const its = groups.get(k), name = k.replace('_', '　'); g++;
      const pr = (a, b) => busy(`正在生成 PDF ${g}／${keys.length}：${name}（${a}／${b}）`); pr(0, its.length);
      repLabel = name;
      try { const r = kind === 'inspect' ? await buildReportPages(its, pr) : await buildFixPages(its, pr, kind); fails.push(...r.fails.map(f => `${name}：${f}`));
        files.push(new File([await pdfBlob(r.pages)], `${reportTitle(kind)}_${safeName(roundLabel())}_${safeName(k)}_${its.length}項.pdf`, { type: 'application/pdf' })); }
      catch (e) { fails.push(`${name}：${e.message}`); }
      finally { repLabel = ''; }
    }
    ovCache.clear(); busy();
    if (!files.length) return toast('PDF 生成失敗', 5000);
    if (IS_IOS && navigator.canShare && navigator.share && navigator.canShare({ files })) {
      try { await navigator.share({ files }); } catch (e) { if (e.name !== 'AbortError') toast('分享失敗：' + e.message, 5000); }
    } else if (window.JSZip) {
      busy('正在打包…'); const zip = new JSZip(); for (const f of files) zip.file(f.name, f, { compression: 'STORE' });
      const blob = await zip.generateAsync({ type: 'blob' }); busy();
      await deliver(blob, `${reportTitle(kind)}_${safeName(roundLabel())}_按${by === 'sub' ? '分判' : by === 'area' ? '區域' : '區域及分判'}_${today()}.zip`);
    } else for (const f of files) saveFile(f, f.name);
    toast(`已生成 ${files.length} 個 PDF`, 3500);
    if (fails.length) reportFails(fails);
  } catch (e) { busy(); repLabel = ''; toast('PDF 生成失敗：' + e.message, 6000); }
}
async function exportPdf(pages, kind = 'inspect') {
  if (!window.jspdf) return toast('PDF 元件未載入，請連網後重新開啟');
  busy('正在生成 PDF…');
  try {
    const blob = await pdfBlob(pages); busy();
    await deliver(blob, `${reportTitle(kind)}_${safeName(roundLabel())}_${safeName(S.project.name) || '項目'}_${kind === 'inspect' ? (S.project.date || today()) : today()}.pdf`);
  } catch (e) { busy(); toast('PDF 生成失敗：' + e.message, 6000); }
}
$('#preview')?.addEventListener('click', async e => {
  const a = e.target.closest('[data-pv]'); if (!a) return;
  if (a.dataset.pv === 'close') closePreview();
  if (a.dataset.pv === 'pdf' && PV) exportPdf(PV.pages, PV.kind);
  if (a.dataset.pv === 'docx' && PV) { const d = PV.onlyDev, kd = PV.kind; closePreview(); if (kd === 'inspect') exportDocx(d); else exportFixDocx(reportItems(kd, d), kd); }
});

/* ================= v0.6: 驗收分次 (rounds) ================= */
const R1 = { id: 'r1', name: '第1次驗收', date: '' };
// each drawing set (建築 / 渠務) keeps its own rounds, so records, numbering and reports never mix
const setOfRound = r => r.set || 'gbp';
const setRounds = (k = curSet()) => S.rounds.filter(r => setOfRound(r) === k);
const firstRound = k => k === 'gbp' ? R1 : { id: 'r1-' + k, name: '第1次驗收', date: '', set: k };
function curRound() { const L = setRounds(), id = (S.settings.roundBy || {})[curSet()]; return L.find(r => r.id === id) || L[L.length - 1] || firstRound(curSet()); }
function setCurRound(id) { S.settings.roundBy = { ...S.settings.roundBy, [curSet()]: id }; if (curSet() === 'gbp') S.settings.round = id; }
function ensureSetRounds() {
  if (!S.settings.roundBy) S.settings.roundBy = { gbp: S.settings.round };
  for (const k of SETS.map(x => x.id)) {
    if (!S.rounds.some(r => setOfRound(r) === k)) S.rounds.push(firstRound(k));
    const L = S.rounds.filter(r => setOfRound(r) === k);
    if (!L.some(r => r.id === S.settings.roundBy[k])) S.settings.roundBy[k] = L[L.length - 1].id;
  }
}
const roundLabel = () => (curSet() === 'gbp' ? '' : setName() + ' ') + curRound().name;
const roundOf = it => it.round || 'r1';
const inRound = it => roundOf(it) === curRound().id;
const roundItems = () => S.items.filter(inRound);
const roundName = id => (S.rounds.find(r => r.id === id) || {}).name || '';
async function saveRounds() { await DB.kset('rounds', S.rounds); }
function shortRound(r) { const m = (r.name || '').match(/第\s*(\d+)\s*次/); return m ? `第${m[1]}次` : (r.name || '').slice(0, 6); }
function roundPanel() {
  const rows = setRounds().map(r => {
    const n = S.items.filter(i => roundOf(i) === r.id).length, on = r.id === curRound().id;
    return `<button class="li ${on ? 'cur' : ''}" data-r="${r.id}" style="grid-template-columns:1fr auto"><span class="t"><b>${esc(r.name)}${on ? '　（目前）' : ''}</b><span>${esc(r.date || '')}　${n} 項記錄</span></span><span class="chip">${on ? '使用中' : '切換'}</span></button>`;
  }).join('');
  const nx = setRounds().length + 1;
  openPanel('round', curSet() === 'gbp' ? '驗收批次' : `驗收批次 · ${setName()}`, `
    <div class="note">每一次驗收的記錄分開存放。圖上紅點、記錄清單、編號和報告都只包括目前這一次；以前各次的記錄保留不刪，隨時可以切換回去查看或導出。</div>
    <div class="list">${rows}</div>
    <div class="sec">開始新一次驗收</div>
    <div class="grid2"><label class="f">名稱<input id="rnName" value="第${nx}次驗收"></label><label class="f">日期<input id="rnDate" type="date" value="${today()}"></label></div>
    <button class="btn p" data-a="new">開始新一次驗收</button>
    <div class="sec">修改目前批次名稱</div>
    <div class="grid2"><label class="f">名稱<input id="rcName" value="${esc(curRound().name)}"></label><label class="f">日期<input id="rcDate" type="date" value="${esc(curRound().date || '')}"></label></div>
    <button class="btn" data-a="ren">儲存名稱</button>
    ${setRounds().length > 1 ? `<div class="sec">合併批次</div>
    <div class="note">勾選兩個或以上的批次（例如同事匯入、名稱不同的批次），輸入新名稱後合併成一個批次，之後圖上、記錄清單和報告會一次包括全部記錄。記錄、相片及檢查人員不變；之後再匯入這些批次的備份檔，記錄會自動放入合併後的批次。</div>
    ${setRounds().map(r => `<label class="toggle">${esc(r.name)}${r.date ? '　' + esc(r.date) : ''}（${S.items.filter(i => roundOf(i) === r.id).length} 項）<input type="checkbox" data-m="${r.id}"></label>`).join('')}
    <label class="f">合併後名稱<input id="mgName" placeholder="例如：第1次驗收（全部）"></label>
    <button class="btn" data-a="merge">合併所選批次</button>` : ''}`);
  panel.querySelector('.pb').onclick = async e => {
    const b = e.target.closest('[data-r]');
    if (b) { setCurRound(b.dataset.r); await saveKV(); closePanel(); renderOverlay(); updateBar(); return toast(`已切換到「${roundLabel()}」`); }
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'new') {
      const name = $('#rnName').value.trim() || `第${nx}次驗收`;
      if (setRounds().some(r => r.name === name)) return toast('已有同名的批次');
      const r = { id: uid(), name, date: $('#rnDate').value, set: curSet() }; S.rounds.push(r); setCurRound(r.id);
      await saveRounds(); await saveKV(); closePanel(); renderOverlay(); updateBar(); toast(`已開始「${name}」，編號由 1 開始`, 3500);
    }
    if (a === 'merge') {
      const ids = [...panel.querySelectorAll('[data-m]:checked')].map(x => x.dataset.m); if (ids.length < 2) return toast('請勾選最少兩個批次');
      const name = $('#mgName').value.trim(); if (!name) return toast('請輸入合併後的名稱');
      if (setRounds().some(r => r.name === name && !ids.includes(r.id))) return toast('已有同名的批次');
      const n = S.items.filter(i => ids.includes(roundOf(i))).length;
      if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = `再按一次確認把 ${ids.length} 個批次（${n} 項記錄）合併為「${name}」`; return; }
      // the current round (if ticked) or the first ticked one keeps its id and takes the new name
      const keep = setRounds().find(r => r.id === curRound().id && ids.includes(r.id)) || setRounds().find(r => ids.includes(r.id));
      keep.name = name; setCurRound(keep.id); await mergeRounds(ids.filter(id => id !== keep.id), keep.id); return roundPanel();
    }
    if (a === 'ren') { const r = curRound(); r.name = $('#rcName').value.trim() || r.name; r.date = $('#rcDate').value; if (!S.rounds.includes(r)) S.rounds.push(r); await saveRounds(); updateBar(); toast('已儲存'); roundPanel(); }
  };
}
// merge whole rounds into one; the merged ids are remembered so later backups of them land in the target too
async function mergeRounds(ids, target) {
  busy('正在合併…'); const now = Date.now(), al = { ...S.settings.roundAlias };
  for (const it of S.items) if (ids.includes(roundOf(it))) { it.round = target; it.mod = now; await saveItem(it); }
  for (const id of ids) al[id] = target;
  for (const k of Object.keys(al)) if (ids.includes(al[k])) al[k] = target;
  delete al[target]; S.settings.roundAlias = al;
  S.rounds = S.rounds.filter(r => !ids.includes(r.id));
  await saveRounds(); await saveKV(); busy(); renderOverlay(); updateBar();
  const L = roundItems().map(itemLabel), dup = L.length - new Set(L).size;
  toast(`已合併，「${curRound().name}」共 ${L.length} 項記錄${dup ? `；有 ${dup} 個編號重複，可到「導出 → 整理編號」重新編號` : ''}`, dup ? 6000 : 3500);
}
function mergeRound(id, name, date, set) { // returns the local round id for an incoming round
  id = id || 'r1'; set = set || SETS.map(x => x.id).find(k => id === 'r1-' + k) || 'gbp';
  for (let k = 0, al = S.settings.roundAlias || {}; al[id] && k < 20; k++) id = al[id];
  if (S.rounds.some(r => r.id === id)) return id;
  const same = name && S.rounds.find(r => r.name === name && setOfRound(r) === set); if (same) return same.id;
  S.rounds.push({ id, name: name || (id === 'r1' || id === 'r1-' + set ? R1.name : '匯入批次'), date: date || '', ...(set === 'gbp' ? {} : { set }) }); return id;
}

/* ================= v0.6: 執修 (repair follow-up) ================= */
const FIX_ST = { open: '未回復', done: '已完成', na: '不跟進' };
const fixOf = it => it.fix || (it.fix = { status: 'open', reply: '', photos: [] });
const fixStatus = it => (it.fix && it.fix.status) || 'open';
function fixCounts() { const L = roundItems(); return { all: L.length, open: L.filter(i => fixStatus(i) === 'open').length, done: L.filter(i => fixStatus(i) === 'done').length }; }
async function persistFix(it) { it.mod = Date.now(); await saveItem(it); updateBar(); }
function fixPanel(it) {
  freeURLs(); S.fixItem = it; const F = fixOf(it); const d = S.drawings.find(x => x.id === it.drawingId); const v = d ? viewById(d, it.loc.viewId) : null;
  const before = it.photos.map(ph => `<div class="ph1"><img src="${burl(ph.out)}" alt=""></div>`).join('') || '<div class="note">沒有完成前照片</div>';
  const after = F.photos.map((ph, i) => `<div class="ph1"><img src="${burl(ph.out)}" data-a="ed" data-i="${i}" alt="完成後 ${i + 1}"><button class="del" data-a="delph" data-i="${i}" aria-label="刪除照片">✕</button><span class="ed">點擊修改標記</span></div>`).join('');
  openPanel('fix', esc(v ? v.title : (d ? d.name : '')), `
    <div class="idx">${esc(it.locText || '')}</div>
    ${it.note ? `<div class="note"><b>問題：</b>${esc(it.note)}</div>` : ''}
    <div class="f-l">完成前</div><div class="photos">${before}</div>
    <div class="f-l">完成後</div>${after ? `<div class="photos">${after}</div>` : ''}
    <div class="row"><button class="btn p" data-a="ghost">拍完成照（對位拍攝）</button></div>
    <div class="row"><label class="btn" for="fixCam">系統相機</label><label class="btn" for="fixLib">從相簿加入</label></div>
    <div class="f-l">狀態</div>
    <div class="chips pick">${Object.entries(FIX_ST).map(([k, t]) => `<button class="chip ${F.status === k ? 'on' : ''}" data-st="${k}">${t}</button>`).join('')}</div>
    <label class="f">回覆（可留空）<textarea id="fxReply" rows="2" placeholder="例如：已更換門鉸">${esc(F.reply || '')}</textarea></label>
    ${F.done && F.status === 'done' ? `<div class="note">完成日期：${fmtTime(F.done).slice(0, 10)}${F.by ? '　' + esc(F.by) : ''}</div>` : ''}
    <div class="row"><button class="btn dk" data-a="close2">完成</button></div>`, { badge: `<span class="no" style="background:${F.status === 'done' ? 'var(--ok)' : F.status === 'na' ? '#8a9391' : 'var(--red)'}">${itemLabel(it)}</span>` });
  const q = s => panel.querySelector(s);
  q('#fxReply').oninput = e => { F.reply = e.target.value; clearTimeout(persistT); persistT = setTimeout(() => persistFix(it), 400); };
  panel.querySelector('.pb').onclick = async e => {
    const st = e.target.closest('[data-st]');
    if (st) { F.status = st.dataset.st; if (F.status === 'done' && !F.done) { F.done = Date.now(); F.by = S.settings.inspector || ''; } if (F.status !== 'done') F.done = null; await persistFix(it); renderOverlay(); return fixPanel(it); }
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'close2') closePanel();
    if (a === 'ghost') ghostCam(it);
    if (a === 'ed') { const i = +e.target.dataset.i; const ph = F.photos[i]; if (!(await canRead(ph.orig))) await refreshPhotos(it); const r = await openEditor(ph.orig, ph); if (r) { F.photos[i] = { ...ph, ...r }; await persistFix(it); fixPanel(it); } }
    if (a === 'delph') { if (e.target.dataset.armed) { F.photos.splice(+e.target.dataset.i, 1); await persistFix(it); fixPanel(it); } else { e.target.dataset.armed = 1; e.target.textContent = '刪'; e.target.style.background = 'var(--red)'; } }
  };
}
async function addFixPhoto(file) {
  const it = S.fixItem || S.editing; if (!file || !it) return;
  S.replyShot = true; let r; try { r = await openEditor(file, null); } finally { S.replyShot = false; } if (!r) return;
  const F = fixOf(it); F.photos.push(r);
  if (F.status !== 'done' && F.status !== 'na') { F.status = 'done'; F.done = Date.now(); F.by = S.settings.inspector || ''; }
  if (it._new) await persistItem(true); else await persistFix(it);
  renderOverlay(); if (S.panel === 'fix') fixPanel(it); else if (S.panel === 'item' && S.editing === it) itemPanel();
  if (S.panel !== 'fix') S.fixItem = null; toast(`${itemLabel(it)} 已加入回復照片`, 2500);
}
/* alignment camera: live camera with the before-photo laid over it, so the after-photo is taken from the same spot */
async function ghostCam(it) {
  const before = it.photos[0];
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('這部機不支援對位拍攝，請按「系統相機」', 4000); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false }); }
  catch (e) { toast('未能開啟相機（' + (e.name === 'NotAllowedError' ? '未獲相機權限' : e.message) + '），請按「系統相機」', 5000); return; }
  const g = document.createElement('div'); g.id = 'ghost';
  g.innerHTML = `<video playsinline autoplay muted></video>${before ? `<img alt="" src="${burl(before.out)}">` : ''}
    <div class="gtop"><span>${esc(itemLabel(it))}　${esc(it.locText || '')}</span><button data-g="cancel">取消</button></div>
    <div class="gbot">${before ? '<label class="gsl">完成前照片<input type="range" min="0" max="85" value="40" data-g="op"></label>' : '<span></span>'}
    <button class="gshut" data-g="shot" aria-label="拍攝"></button>${before ? '<button data-g="peek">按住看完成前</button>' : '<span></span>'}</div>`;
  document.body.appendChild(g);
  const vid = g.querySelector('video'), ghost = g.querySelector('img'); vid.srcObject = stream;
  try { await vid.play(); } catch (e) { }
  if (ghost) ghost.style.opacity = 0.4;
  const stop = () => { stream.getTracks().forEach(t => t.stop()); g.remove(); };
  g.addEventListener('input', e => { if (e.target.dataset.g === 'op' && ghost) ghost.style.opacity = e.target.value / 100; });
  const peek = g.querySelector('[data-g="peek"]');
  if (peek) { peek.onpointerdown = () => ghost.style.opacity = 1; peek.onpointerup = peek.onpointerleave = () => ghost.style.opacity = g.querySelector('[data-g="op"]').value / 100; }
  g.addEventListener('click', async e => {
    const a = e.target.dataset.g;
    if (a === 'cancel') stop();
    if (a === 'shot') {
      if (!vid.videoWidth) return toast('相機未就緒');
      const c = document.createElement('canvas'); c.width = vid.videoWidth; c.height = vid.videoHeight; c.getContext('2d').drawImage(vid, 0, 0);
      const b = await canvasBlob(c, 'image/jpeg', 0.9); stop(); addFixPhoto(b);
    }
  });
}

/* ================= v0.6: coordinates carried inside each saved photo ================= */
// ASCII-only JSON so it survives EXIF (ASCII) and QR byte mode on every platform
const asciiJSON = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function photoMeta(it, ph, i, after, full) {
  const d = S.drawings.find(x => x.id === it.drawingId) || {}; const L = it.loc || {};
  const m = { a: 'HI1', i: it.id, dv: devOf(it), n: it.no, c: it.code || '', r: roundOf(it), rn: roundName(roundOf(it)), g: it.drawingId, dn: d.no || '', v: L.viewId || '', x: it.x, y: it.y,
    tw: L.tower || '', f: L.floor || '', fl: L.flat || '', rm: L.room || '', ar: L.area || '', gr: L.grid || '', lt: it.locText || '', b: it.by || '', t: it.created, p: ph.id, pi: i, pt: ph.t, w: ph.w, h: ph.h, k: after ? 'a' : 'b' };
  if (full) Object.assign(m, { note: it.note || '', st: fixStatus(it), rp: (it.fix && it.fix.reply) || '', sh: ph.shapes || [] });
  return m;
}
function exifWithDesc(bytes, desc) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
  const enc = new TextEncoder().encode(desc.slice(0, 60000) + '\0'), n = enc.length;
  const tiff = new Uint8Array(8 + 2 + 12 + 4 + n), dv = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2A, 0x00]); dv.setUint32(4, 8, true); dv.setUint16(8, 1, true);
  dv.setUint16(10, 0x010E, true); dv.setUint16(12, 2, true); dv.setUint32(14, n, true); dv.setUint32(18, 26, true); dv.setUint32(22, 0, true); tiff.set(enc, 26);
  const seg = new Uint8Array(4 + 6 + tiff.length); seg.set([0xFF, 0xE1, (seg.length - 2) >> 8, (seg.length - 2) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]); seg.set(tiff, 10);
  const out = new Uint8Array(bytes.length + seg.length); out.set(bytes.subarray(0, 2)); out.set(seg, 2); out.set(bytes.subarray(2), 2 + seg.length); return out;
}
function readExifDesc(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xFF) {
    const mk = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (mk === 0xDA) break;
    if (mk === 0xE1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10, le = b[t] === 0x49, dv = new DataView(b.buffer, b.byteOffset + t, len - 8);
      const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
      try { const ifd = u32(4), cnt = u16(ifd);
        for (let k = 0; k < cnt; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x010E) { const n = u32(e + 4), off = n > 4 ? u32(e + 8) : e + 8; return new TextDecoder().decode(new Uint8Array(b.buffer, b.byteOffset + t + off, n)).replace(/\0+$/, ''); } }
      } catch (e) { }
    }
    i += 2 + len;
  }
  return null;
}
function qrFor(text) { if (!window.qrcode) return null; try { const q = qrcode(0, 'L'); q.addData(text); q.make(); return q; } catch (e) { return null; } }

/* restore records from saved photos (album, ZIP 相片 folder, WhatsApp copies) */
async function readPhotoMeta(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const desc = readExifDesc(bytes);
  if (desc) { try { const o = JSON.parse(desc); if (o.a === 'HI1') return o; } catch (e) { } }
  if (!window.jsQR) return null;
  const img = await loadImg(file); const W = img.naturalWidth, H = img.naturalHeight;
  const tries = [[0.62, 1], [0.5, 1], [0, 1]];
  for (const [fy, _] of tries) {
    const y0 = Math.floor(H * fy), h = H - y0; const s = Math.min(1, 2600 / W);
    const c = document.createElement('canvas'); c.width = Math.round(W * s); c.height = Math.round(h * s);
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, y0, W, h, 0, 0, c.width, c.height);
    const r = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
    c.width = c.height = 0;
    if (r && r.data) { try { const o = JSON.parse(r.data); if (o.a === 'HI1') { URL.revokeObjectURL(img.src); return o; } } catch (e) { } }
  }
  URL.revokeObjectURL(img.src); return null;
}
async function stripCaption(file, m) {
  const img = await loadImg(file); const W = img.naturalWidth; const Hb = Math.min(img.naturalHeight, Math.round(m.h * W / m.w));
  const c = document.createElement('canvas'); c.width = W; c.height = Hb; c.getContext('2d').drawImage(img, 0, 0, W, Hb, 0, 0, W, Hb);
  URL.revokeObjectURL(img.src); const b = await canvasBlob(c, 'image/jpeg', 0.9); c.width = c.height = 0; return { blob: b, w: W, h: Hb };
}
async function restoreFromPhotos(files) {
  let add = 0, ph = 0, skip = 0, bad = []; const touched = new Set(); let n = 0;
  for (const f of files) {
    busy(`正在讀取相片 ${++n}／${files.length}`);
    let m = null; try { m = await readPhotoMeta(f); } catch (e) { }
    if (!m) { bad.push(f.name || `相片${n}`); continue; }
    const d = S.drawings.find(x => x.id === m.g) || S.drawings.find(x => x.no === m.dn);
    if (!d) { bad.push((f.name || '') + '（圖紙不存在）'); continue; }
    let it = S.items.find(x => x.id === m.i);
    if (!it) {
      const L = resolveLoc(d, m.x, m.y);
      Object.assign(L, { viewId: m.v || L.viewId, tower: m.tw, floor: m.f, flat: m.fl, room: m.rm, area: m.ar, grid: m.gr || L.grid });
      it = { id: m.i, dev: m.dv, by: m.b, no: m.n, drawingId: d.id, x: m.x, y: m.y, loc: L, locText: m.lt || fmtLoc(L), locEdited: !!m.lt, photos: [], note: m.note || '', created: m.t || Date.now(), mod: Date.now(), round: mergeRound(m.r, m.rn, null, setOf(d)), restored: true };
      if (m.c) it.code = m.c;
      if (m.st && m.st !== 'open') it.fix = { status: m.st, reply: m.rp || '', photos: [] };
      S.items.push(it); add++;
    }
    const list = m.k === 'a' ? fixOf(it).photos : it.photos;
    const exP = list.find(p => p.id === m.p);
    if (exP && (await canRead(exP.out) || await canRead(exP.orig))) { skip++; continue; }
    if (exP) list.splice(list.indexOf(exP), 1);
    const body = await stripCaption(f, m);
    list.push({ id: m.p, orig: body.blob, out: body.blob, shapes: [], w: body.w, h: body.h, t: m.pt || Date.now(), album: Date.now(), pi: m.pi });
    list.sort((a, b) => (a.pi ?? 0) - (b.pi ?? 0)); ph++; touched.add(it);
  }
  for (const it of touched) { it.mod = Date.now(); await saveItem(it); }
  await saveRounds(); busy();
  openPanel('restore', '從相片還原', `<div class="note">還原了 ${add} 項記錄、${ph} 張相片${skip ? `；${skip} 張已存在，略過` : ''}。記錄放回原來的圖紙位置及驗收批次。</div>${bad.length ? `<div class="note">以下 ${bad.length} 張相片讀不到位置資料（可能不是本程式存的相，或相片被裁剪／壓縮過）：<br>${bad.map(esc).join('<br>')}</div>` : ''}`);
  renderOverlay(); updateBar();
}

/* ================= v0.6: 執修報告 (before / after side by side) ================= */
const fixStatusText = it => { const F = it.fix || {}; const s = fixStatus(it); return s === 'done' ? `已完成${F.done ? '\n' + fmtTime(F.done).slice(0, 10) : ''}` : FIX_ST[s]; };
function reportItems(kind, onlyDev) {
  let L = roundItems().filter(i => inScope(i, onlyDev));
  if (kind === 'fixdone') L = L.filter(i => fixStatus(i) === 'done');
  return L.sort(byOrder);
}
const reportTitle = kind => kind === 'inspect' ? '竣工驗收記錄' : '執修回復報告';
async function buildFixPages(items, progress, kind) {
  items = await freshItems(items);
  const P = S.project, k = PG.k, M = PG.M, UW = PG.W - 2 * M, title = reportTitle(kind), rn = roundLabel();
  const pct = [5, 13, 18, 23, 23, 11, 7], cw = pct.map(p => UW * p / 100), cx = cw.map((_, i) => M + cw.slice(0, i).reduce((a, b) => a + b, 0));
  const heads = ['編號', '位置', '圖紙位置', '完成前', '完成後', '問題／回覆', '狀態'];
  const pad = 4, dW = cw[2] - 2 * pad, pW = cw[3] - 2 * pad, top0 = M + 14, bottom = PG.H - M - 14, headH = 20;
  const pages = []; let c, x, y; const fails = [];
  const head = () => { drawText(x, `${P.name || ''}　${title}　${rn}`, M, M - 14, UW, 7.5, { color: '#5f6b69' }); };
  const newPage = first => {
    c = document.createElement('canvas'); c.width = PG.W * k; c.height = PG.H * k; x = c.getContext('2d'); x.scale(k, k);
    x.fillStyle = '#fff'; x.fillRect(0, 0, PG.W, PG.H); head(); y = top0;
    if (first) {
      y += drawText(x, title, M, y, UW, 17, { bold: true }) + 6;
      const done = items.filter(i => fixStatus(i) === 'done').length;
      for (const [a, b] of [['項目名稱', P.name], ['地盤／地址', P.site], ['驗收批次', rn], ...(repLabel ? [['報告範圍', repLabel]] : []), ['報告日期', today()], ['公司／單位', P.company], ['項目數量', `${items.length} 項（已完成 ${done} 項）`]]) {
        drawText(x, a, M, y, 80, 9, { color: '#5f6b69' }); drawText(x, b || '', M + 80, y, 500, 9, { bold: true }); y += 13;
      }
      y += 6;
    }
    x.fillStyle = '#1d2629'; x.fillRect(M, y, UW, headH);
    heads.forEach((h, i) => drawText(x, h, cx[i], y + 5, cw[i], 8.5, { bold: true, color: '#fff', center: true }));
    y += headH; pages.push(c);
  };
  const grid = (y0, h) => { x.strokeStyle = '#8a9391'; x.lineWidth = 0.6; x.strokeRect(M, y0, UW, h); cx.slice(1).forEach(X => { x.beginPath(); x.moveTo(X, y0); x.lineTo(X, y0 + h); x.stroke(); }); };
  newPage(true);
  let n = 0;
  for (const it of items) {
    progress && progress(++n, items.length);
    const d = S.drawings.find(q => q.id === it.drawingId); if (!d) continue;
    let ov = null, cr = null;
    try { ov = await overviewImage(d, it); } catch (e) { fails.push(`${itemLabel(it)} 總圖：${e.message}`); }
    try { cr = await cropImage(d, it); } catch (e) { fails.push(`${itemLabel(it)} 圖紙截取：${e.message}`); }
    const ovH = ov ? Math.min(dW * ov.h / ov.w, 45) : 12, ovW = ov ? ovH * ov.w / ov.h : dW, crH = dW * 0.75;
    const bef = it.photos, aft = (it.fix && it.fix.photos) || [], np = Math.max(1, bef.length, aft.length);
    let phH = pW * 0.75; const avail = bottom - top0 - headH - 2 * pad;
    if (np * (phH + 4) > avail) phH = (avail - (np - 1) * 4) / np;
    const rowH = Math.max(ovH + 4 + crH, np * (phH + 4) - 4, 40) + 2 * pad;
    if (y + rowH > bottom) newPage(false);
    const y0 = y; grid(y0, rowH);
    drawText(x, itemLabel(it), cx[0], y0 + rowH / 2 - 10, cw[0], 7.5, { bold: true, color: '#d42a1e', center: true });
    drawText(x, fmtTime(it.created).slice(5, 10), cx[0], y0 + rowH / 2 + 2, cw[0], 6, { color: '#5f6b69', center: true });
    const L = it.loc || {}; const v = viewById(d, L.viewId);
    let ty = y0 + pad + drawText(x, it.locText || '—', cx[1] + pad, y0 + pad, cw[1] - 2 * pad, 8, { bold: true }) + 5;
    for (const [a, b] of [['軸線', L.grid], ['圖紙', [d.no, v ? v.title : ''].filter(Boolean).join(' ')]]) if (b) ty += drawText(x, `${a}：${b}`, cx[1] + pad, ty, cw[1] - 2 * pad, 6.5, { color: '#3a4544' }) + 1;
    const ix = cx[2] + pad;
    if (ov) await drawBlob(x, ov.blob, ix + (dW - ovW) / 2, y0 + pad, ovW, ovH);
    if (cr) await drawBlob(x, cr.blob, ix, y0 + pad + ovH + 4, dW, crH); else drawText(x, '（圖紙截取無法生成）', ix, y0 + pad + ovH + 20, dW, 7, { color: '#d42a1e', center: true });
    for (const [col, list, lab] of [[3, bef, '完成前'], [4, aft, '完成後']]) {
      let py = y0 + pad; const px0 = cx[col] + pad;
      if (!list.length) drawText(x, `（沒有${lab}照片）`, px0, py + 20, pW, 7.5, { color: '#888', center: true });
      for (const [i, ph] of list.entries()) {
        let w = Math.min(pW, phH / 0.75), h = w * 0.75; const r = ph.w / ph.h; let dw = w, dh = h; if (r > w / h) dh = w / r; else dw = h * r;
        try { await drawBlob(x, await shrink(ph.out, 1400), px0 + (pW - dw) / 2, py + (h - dh) / 2, dw, dh); }
        catch (e) { try { await drawBlob(x, await shrink(ph.orig, 1400), px0 + (pW - dw) / 2, py + (h - dh) / 2, dw, dh); } catch (e2) { fails.push(`${itemLabel(it)} ${lab}照片${i + 1}：${e.message}`); drawText(x, '（照片無法讀取）', px0, py + h / 2, pW, 7, { color: '#d42a1e', center: true }); } }
        py += h + 4;
      }
    }
    let qy = y0 + pad; if (it.note) qy += drawText(x, '問題：' + it.note, cx[5] + pad, qy, cw[5] - 2 * pad, 7.5) + 6;
    if (it.fix && it.fix.reply) drawText(x, '回覆：' + it.fix.reply, cx[5] + pad, qy, cw[5] - 2 * pad, 7.5, { color: '#2f7d4f' });
    const s = fixStatus(it); drawText(x, fixStatusText(it), cx[6] + 2, y0 + rowH / 2 - 8, cw[6] - 4, 7.5, { bold: true, center: true, color: s === 'done' ? '#2f7d4f' : s === 'na' ? '#5f6b69' : '#d42a1e' });
    y += rowH;
  }
  const blobs = [];
  for (const [i, pc] of pages.entries()) { const px = pc.getContext('2d'); drawText(px, `第 ${i + 1} 頁，共 ${pages.length} 頁`, M, PG.H - M + 2, UW, 7.5, { color: '#5f6b69', center: true }); blobs.push(await canvasBlob(pc, 'image/jpeg', 0.88)); pc.width = pc.height = 0; }
  return { pages: blobs, fails };
}
async function exportFixDocx(items, kind) {
  items = await freshItems(items);
  if (!items.length) return toast(kind === 'fixdone' ? '目前批次還沒有已完成的項目' : '還沒有任何記錄');
  if (!window.docx) return toast('報告元件未載入，請連網後重新開啟一次');
  const D = window.docx, P = S.project, title = reportTitle(kind), rn = roundLabel();
  try {
    busy('正在生成報告…'); ovCache.clear(); const fails = [];
    const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft JhengHei', cs: 'Arial' };
    const T = (text, o = {}) => new D.TextRun({ text: String(text ?? ''), font: FONT, size: o.size || 18, bold: o.bold, color: o.color, break: o.br });
    const Pg = (runs, o = {}) => new D.Paragraph({ children: Array.isArray(runs) ? runs : [runs], alignment: o.align, spacing: { after: o.after ?? 40 }, keepLines: true });
    const bd = { style: D.BorderStyle.SINGLE, size: 4, color: '8A9391' }, borders = { top: bd, bottom: bd, left: bd, right: bd };
    const usable = 15638, pct = [5, 13, 18, 23, 23, 11, 7], colTw = pct.map(p => Math.round(usable * p / 100));
    const cell = (children, i, o = {}) => new D.TableCell({ children, width: { size: colTw[i], type: D.WidthType.DXA }, borders, verticalAlign: o.v || D.VerticalAlign.TOP, shading: o.shade ? { type: D.ShadingType.CLEAR, color: 'auto', fill: o.shade } : undefined, margins: { top: 60, bottom: 60, left: 70, right: 70 } });
    const heads = ['編號', '位置', '圖紙位置', '完成前', '完成後', '問題／回覆', '狀態'];
    const rows = [new D.TableRow({ tableHeader: true, cantSplit: true, children: heads.map((h, i) => cell([Pg(T(h, { bold: true, color: 'FFFFFF', size: 17 }), { align: D.AlignmentType.CENTER, after: 0 })], i, { shade: '1D2629', v: D.VerticalAlign.CENTER })) })];
    const dPx = Math.floor(colTw[2] / 15) - 10, pPx = Math.floor(colTw[3] / 15) - 10;
    const imgP = async (blob, w, h) => Pg(new D.ImageRun({ data: await blob.arrayBuffer(), transformation: { width: Math.round(w), height: Math.round(h) } }), { align: D.AlignmentType.CENTER, after: 60 });
    let n = 0;
    for (const it of items) {
      busy(`正在生成報告… ${++n}／${items.length}`);
      const d = S.drawings.find(q => q.id === it.drawingId); if (!d) continue; if (d.kind === 'pdf') await ensureBase(d, true);
      const dw = [];
      try { const o = await overviewImage(d, it); const h = Math.min(dPx * o.h / o.w, 70); dw.push(await imgP(o.blob, h * o.w / o.h, h)); } catch (e) { fails.push(`${itemLabel(it)} 總圖：${e.message}`); }
      try { const c = await cropImage(d, it); dw.push(await imgP(c.blob, dPx, dPx * 0.75)); } catch (e) { fails.push(`${itemLabel(it)} 圖紙截取：${e.message}`); }
      const phs = async (list, lab) => { const out = []; for (const [i, ph] of list.entries()) { let w = pPx, h = pPx * 0.75; const r = ph.w / ph.h; if (r > 4 / 3) h = w / r; else w = h * r;
        try { out.push(await imgP(await shrink(ph.out, 1400), w, h)); } catch (e) { try { out.push(await imgP(await shrink(ph.orig, 1400), w, h)); } catch (e2) { fails.push(`${itemLabel(it)} ${lab}照片${i + 1}：${e.message}`); } } }
        return out.length ? out : [Pg(T(`（沒有${lab}照片）`, { color: '888888', size: 15 }), { align: D.AlignmentType.CENTER })]; };
      const s = fixStatus(it), F = it.fix || {};
      const L = it.loc || {}; const v = viewById(d, L.viewId);
      const loc = [Pg(T(it.locText || '—', { bold: true, size: 16 }), { after: 80 })]; for (const [a, b] of [['軸線', L.grid], ['圖紙', [d.no, v ? v.title : ''].filter(Boolean).join(' ')]]) if (b) loc.push(Pg([T(a + '：', { color: '5F6B69', size: 14 }), T(b, { size: 14 })], { after: 20 }));
      const qa = []; if (it.note) qa.push(Pg([T('問題：', { bold: true, size: 15 }), T(it.note, { size: 15 })], { after: 80 })); if (F.reply) qa.push(Pg([T('回覆：', { bold: true, size: 15, color: '2F7D4F' }), T(F.reply, { size: 15, color: '2F7D4F' })]));
      rows.push(new D.TableRow({ cantSplit: true, children: [
        cell([Pg(T(itemLabel(it), { bold: true, size: 15, color: 'D42A1E' }), { align: D.AlignmentType.CENTER }), Pg(T(fmtTime(it.created).slice(5, 10), { size: 12, color: '5F6B69' }), { align: D.AlignmentType.CENTER })], 0, { v: D.VerticalAlign.CENTER }),
        cell(loc, 1), cell(dw.length ? dw : [Pg(T(''))], 2), cell(await phs(it.photos, '完成前'), 3), cell(await phs(F.photos || [], '完成後'), 4),
        cell(qa.length ? qa : [Pg(T(''))], 5),
        cell([Pg(T(FIX_ST[s], { bold: true, size: 15, color: s === 'done' ? '2F7D4F' : s === 'na' ? '5F6B69' : 'D42A1E' }), { align: D.AlignmentType.CENTER }), ...(s === 'done' && F.done ? [Pg(T(fmtTime(F.done).slice(0, 10), { size: 12 }), { align: D.AlignmentType.CENTER })] : [])], 6, { v: D.VerticalAlign.CENTER }),
      ] }));
    }
    const nb = { top: { style: D.BorderStyle.NONE }, bottom: { style: D.BorderStyle.NONE }, left: { style: D.BorderStyle.NONE }, right: { style: D.BorderStyle.NONE } };
    const info = (a, b) => new D.TableRow({ children: [new D.TableCell({ children: [Pg(T(a, { color: '5F6B69' }), { after: 0 })], width: { size: 2000, type: D.WidthType.DXA }, borders: nb }), new D.TableCell({ children: [Pg(T(b || '', { bold: true }), { after: 0 })], width: { size: 6000, type: D.WidthType.DXA }, borders: nb })] });
    const done = items.filter(i => fixStatus(i) === 'done').length;
    const doc = new D.Document({ creator: S.settings.inspector || title, title, styles: { default: { document: { run: { font: FONT, size: 18 } } } },
      sections: [{ properties: { page: { size: { width: 11906, height: 16838, orientation: D.PageOrientation.LANDSCAPE }, margin: { top: 600, bottom: 600, left: 600, right: 600, header: 300, footer: 300 } } },
        headers: { default: new D.Header({ children: [Pg(T(`${P.name || ''}　${title}　${rn}`, { size: 15, color: '5F6B69' }), { align: D.AlignmentType.RIGHT })] }) },
        footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ children: ['第 ', D.PageNumber.CURRENT, ' 頁，共 ', D.PageNumber.TOTAL_PAGES, ' 頁'], font: FONT, size: 15, color: '5F6B69' })] })] }) },
        children: [Pg(T(title, { bold: true, size: 32 }), { after: 120 }),
          new D.Table({ rows: [info('項目名稱', P.name), info('地盤／地址', P.site), info('驗收批次', rn), info('報告日期', today()), info('公司／單位', P.company), info('項目數量', `${items.length} 項（已完成 ${done} 項）`)], width: { size: 8000, type: D.WidthType.DXA }, columnWidths: [2000, 6000] }),
          Pg(T(''), { after: 120 }), new D.Table({ rows, width: { size: usable, type: D.WidthType.DXA }, columnWidths: colTw, layout: D.TableLayoutType.FIXED })] }] });
    const blob = await D.Packer.toBlob(doc); busy(); ovCache.clear();
    await deliver(blob, `${title}_${safeName(rn)}_${safeName(P.name) || '項目'}_${today()}.docx`);
    if (fails.length) reportFails(fails);
  } catch (e) { busy(); console.error(e); toast('報告生成失敗：' + e.message, 8000); }
}

/* ---------------- bundled drawing package ---------------- */
// each set has its own package; a set other than 建築 is first downloaded when it is switched to
async function loadBundle(k = 'gbp') {
  const set = SETS.find(x => x.id === k); let man;
  try { man = await (await fetch(set.mapping, { cache: 'no-cache' })).json(); } catch (e) { if (!S.drawings.some(d => d.src === 'bundle' && setOf(d) === k)) throw new Error(`未能下載${set.name}圖紙`); return; }
  const vkey = k === 'gbp' ? 'pkgVersion' : 'pkgVersion:' + k;
  const have = await DB.kget(vkey); if (k === 'gbp') S.pkgVersion = have;
  if (have === man.version && S.drawings.some(d => d.src === 'bundle' && setOf(d) === k)) return;
  busy(`正在下載${set.name}圖紙包（約 ${set.size}，只需一次）…`);
  const fileInDb = await DB.get('files', man.fileId);
  if (!fileInDb || fileInDb.sha !== man.sha) {
    const res = await fetch(man.file, { cache: 'no-cache' }); if (!res.ok) throw new Error('圖紙包下載失敗');
    await DB.put('files', { id: man.fileId, name: man.file, sha: man.sha, blob: await res.blob() });
    pdfDocs.delete(man.fileId);
  }
  for (const pd of man.drawings) {
    const ex = S.drawings.find(d => d.id === pd.id);
    const rec = { ...pd, src: 'bundle', kind: 'pdf', fileId: man.fileId, created: (k === 'gbp' ? 0 : 1000) + pd.order, ...(k === 'gbp' ? {} : { set: k }) };
    if (ex && ex.base && ex.w === pd.w && fileInDb && fileInDb.sha === man.sha) { rec.base = ex.base; rec.thumb = ex.thumb; }
    await DB.put('drawings', rec);
    const i = S.drawings.findIndex(d => d.id === rec.id); if (i >= 0) S.drawings[i] = rec; else S.drawings.push(rec);
  }
  await DB.kset(vkey, man.version); if (k === 'gbp') S.pkgVersion = man.version;
  S.drawings.sort((a, b) => (a.created || 0) - (b.created || 0));
  if (!S.project.name && man.project) { S.project.name = man.project; await saveKV(); }
  busy();
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    await DB.open();
    for (const k of ['project', 'settings', 'floorSel']) S[k] = { ...S[k], ...(await DB.kget(k) || {}) };
    S.recentAreas = await DB.kget('recentAreas') || [];
    S.views = await DB.kget('views') || {};
    S.rots = await DB.kget('rots') || {};
    S.drawings = (await DB.all('drawings')).filter(d => d.views).sort((a, b) => (a.created || 0) - (b.created || 0));
    S.items = (await DB.all('items')).filter(i => i.loc && 'viewId' in i.loc);
    for (const it of S.items) if (!it.fs) it.fs = sigsOf(it);
    S.rounds = await DB.kget('rounds') || [];
    if (!S.rounds.some(r => r.id === 'r1') && (!S.rounds.length || S.items.some(i => !i.round))) S.rounds.unshift({ ...R1 });
    if (!S.settings.round || !S.rounds.some(r => r.id === S.settings.round)) S.settings.round = setRounds('gbp').slice(-1)[0]?.id || 'r1';
    ensureSetRounds(); await saveRounds();
    try { await loadBundle(); } catch (e) { busy(); toast(e.message + '，請連網後重新開啟', 6000); }
    // other sets refresh only once they have been downloaded
    for (const x of SETS) if (x.id !== 'gbp' && (x.id === curSet() || S.drawings.some(d => setOf(d) === x.id && d.src === 'bundle'))) try { await loadBundle(x.id); } catch (e) { busy(); toast(e.message + '，請連網後重新開啟', 6000); }
    const cur = await DB.kget('cur');
    await showDrawing(setDrawings().some(d => d.id === cur) ? cur : setDrawings()[0]?.id || null);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
    for (const it of S.items) { if (!it.dev && S.settings.dev) it.dev = S.settings.dev; }
    if (!S.settings.dev) setupPanel(true);
    warmLater(15000);
  } catch (err) { console.error(err); busy(); toast('啟動失敗：' + err.message, 8000); }
  updateBar();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // pick up a new version promptly: check on start and whenever the app comes back to the foreground (iPad keeps it suspended)
  const hadSW = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update().catch(() => { });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => { }); });
  }).catch(() => { });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadSW) return;
    if (!S.editing && !S.panel && $('#editor').hidden && $('#busy').hidden) location.reload();
    else toast('已有新版本，完成手上工作後請關閉並重新開啟程式', 6000);
  });
}
boot();
