'use strict';
/* 竣工驗收記錄 — offline iPad PWA
   Bundled GBP plans (vector PDF) + location mapping; items (pin + photos + text) live in IndexedDB on the device. */
const VERSION = '0.4.0';
const $ = s => document.querySelector(s);
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
  all(n) { return rq(this.st(n).getAll()); },
  get(n, k) { return rq(this.st(n).get(k)); },
  put(n, v) { return rq(this.st(n, 'readwrite').put(v)); },
  del(n, k) { return rq(this.st(n, 'readwrite').delete(k)); },
  kget(k) { return rq(this.st('kv').get(k)); },
  kset(k, v) { return rq(this.st('kv', 'readwrite').put(v, k)); },
};

const S = {
  project: { name: '', site: '', date: today(), inspector: '', company: '' },
  settings: { autoCam: true, showZones: true, crop: 'm', keyPlan: true },
  floorSel: {}, recentAreas: [],
  drawings: [], items: [], cur: null, mode: 'inspect', tool: 'select',
  view: { x: 0, y: 0, k: 1 }, editing: null, draft: null, sel: null, panel: null, listScope: 'cur',
};
const imgCache = new Map(); // drawingId -> {url, img}

/* ---------------- UI helpers ---------------- */
let toastT;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
function busy(msg) { $('#busy').hidden = !msg; if (msg) $('#busyMsg').textContent = msg; }
const blobURLs = [];
function burl(b) { const u = URL.createObjectURL(b); blobURLs.push(u); return u; }
function freeURLs() { while (blobURLs.length) URL.revokeObjectURL(blobURLs.pop()); }
function loadImg(src) {
  return new Promise((res, rej) => {
    if (!src) return rej(new Error('圖片資料不存在'));
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = async () => { // fallback decoder (helps with very large images on iPad)
      if (typeof src !== 'string' && window.createImageBitmap) { try { const b = await createImageBitmap(src); b.naturalWidth = b.width; b.naturalHeight = b.height; return res(b); } catch (e) { } }
      rej(new Error(typeof src === 'string' ? '圖片無法讀取' : `圖片無法讀取（${src.type || '未知格式'}，${Math.round((src.size || 0) / 1024)} KB）`));
    };
    i.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  });
}
const canvasBlob = (c, type = 'image/jpeg', q = 0.86) => new Promise(r => c.toBlob(r, type, q));
async function shrink(blob, max) { const img = await loadImg(blob); const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)); if (k >= 1) { URL.revokeObjectURL(img.src); return blob; } const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src); return canvasBlob(c, 'image/jpeg', 0.8); }
const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();
function curD() { return S.drawings.find(d => d.id === S.cur) || null; }
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
function nextNo() { const d = S.settings.dev || 'A'; return S.items.filter(i => devOf(i) === d).reduce((m, i) => Math.max(m, i.no || 0), 0) + 1; }
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
function applyView() {
  board.style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})`;
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderOverlay(); });
  clearTimeout(hiT); hiT = setTimeout(renderHires, 220);
}
function stageRect() { return stage.getBoundingClientRect(); }
function toDwg(cx, cy) { const r = stageRect(); return { x: (cx - r.left - S.view.x) / S.view.k, y: (cy - r.top - S.view.y) / S.view.k }; }
function visibleArea() {
  const r = stageRect(); const pw = (panelOpen() && !sheetMQ.matches) ? 400 : 0, ph = (panelOpen() && sheetMQ.matches) ? r.height * 0.55 : 0;
  return { w: r.width - pw, h: r.height - ph, top: 60 };
}
function fitBox(b) {
  const A = visibleArea(); const W = A.w, H = A.h - A.top; const bw = b[2] - b[0], bh = b[3] - b[1];
  const k = Math.min(W / bw, H / bh) * 0.94; S.view = { k, x: (W - bw * k) / 2 - b[0] * k, y: A.top + (H - bh * k) / 2 - b[1] * k }; applyView();
}
function fit() { const d = curD(); if (d) fitBox([0, 0, d.w, d.h]); }
function zoomAt(f, cx, cy) {
  const r = stageRect(); cx ??= r.width / 2; cy ??= r.height / 2;
  const k = clamp(S.view.k * f, 0.03, 12); const px = (cx - S.view.x) / S.view.k, py = (cy - S.view.y) / S.view.k;
  S.view = { k, x: cx - px * k, y: cy - py * k }; applyView();
}
function centerOn(x, y, k) { const A = visibleArea(); k = k || S.view.k; S.view = { k, x: A.w / 2 - x * k, y: 30 + A.h / 2 - y * k }; applyView(); }
function ensureVisible(p) {
  const A = visibleArea(); const sx = S.view.x + p.x * S.view.k, sy = S.view.y + p.y * S.view.k;
  if (sx < 30 || sy < 70 || sx > A.w - 30 || sy > A.h - 30) centerOn(p.x, p.y);
}

/* sharp rendering of the visible area once zoomed past the base image resolution */
let hiTask = null, hiSeq = 0;
async function renderHires() {
  const d = curD(); if (!d || d.kind !== 'pdf' || !d.base) { hires.hidden = true; return; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2); const s = S.view.k * dpr;
  if (s <= d.base.scale * 1.15) { hires.hidden = true; return; }
  const r = stageRect();
  let x0 = Math.max(0, -S.view.x / S.view.k), y0 = Math.max(0, -S.view.y / S.view.k);
  let x1 = Math.min(d.w, (r.width - S.view.x) / S.view.k), y1 = Math.min(d.h, (r.height - S.view.y) / S.view.k);
  if (x1 <= x0 || y1 <= y0) return;
  let sc = s; const maxPx = 5e6; if ((x1 - x0) * (y1 - y0) * sc * sc > maxPx) sc = Math.sqrt(maxPx / ((x1 - x0) * (y1 - y0)));
  const seq = ++hiSeq;
  try {
    if (hiTask) { hiTask.cancel(); hiTask = null; }
    const page = await (await getPdf(d.fileId)).getPage(d.page);
    if (seq !== hiSeq) return;
    const c = document.createElement('canvas'); c.width = Math.ceil((x1 - x0) * sc); c.height = Math.ceil((y1 - y0) * sc);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    hiTask = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: sc, offsetX: -x0 * sc, offsetY: -y0 * sc }) });
    await hiTask.promise; hiTask = null;
    if (seq !== hiSeq || S.cur !== d.id) return;
    hires.width = c.width; hires.height = c.height; hires.getContext('2d').drawImage(c, 0, 0); c.width = c.height = 0;
    Object.assign(hires.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' }); hires.hidden = false;
  } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.warn(e); }
}

function renderOverlay() {
  const d = curD(); if (!d) { ov.innerHTML = ''; return; }
  const k = S.view.k, u = 1 / k;
  ov.setAttribute('width', d.w); ov.setAttribute('height', d.h); ov.setAttribute('viewBox', `0 0 ${d.w} ${d.h}`);
  ov.style.width = d.w + 'px'; ov.style.height = d.h + 'px';
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
    const items = S.items.filter(i => i.drawingId === d.id);
    const all = S.editing && S.editing.drawingId === d.id && !items.find(i => i.id === S.editing.id) ? [...items, S.editing] : items;
    for (const it of all) {
      const act = S.editing && S.editing.id === it.id; const r = (act ? 17 : 14) * u;
      h += `<circle cx="${it.x}" cy="${it.y}" r="${r}" fill="#d42a1e" stroke="${act ? '#f2c230' : '#fff'}" stroke-width="${act ? 4 : 2.5}" vector-effect="non-scaling-stroke"/><text x="${it.x}" y="${it.y}" font-size="${(it.no > 99 ? 10 : 12.5) * u}" text-anchor="middle" dominant-baseline="central" fill="#fff" font-weight="700" font-family="ui-monospace,Menlo,monospace">${devOf(it) === (S.settings.dev || 'A') ? it.no : devOf(it) + it.no}</text>`;
    }
  }
  ov.innerHTML = h;
}

function multiFloorViews(d) { return d ? (d.views || []).filter(v => v.floors && v.floors.length > 1) : []; }
function updateBar() {
  const d = curD();
  $('#curName').textContent = d ? d.name : (S.project.name || '竣工驗收記錄');
  $('#curSub').textContent = d ? [d.no, S.project.name].filter(Boolean).join('　') : '';
  $('#cnt').textContent = S.items.length;
  const ub = unbacked(); $('#btnExport').innerHTML = '導出' + (ub ? `<span class="n" title="未備份">${ub}</span>` : '');
  $('#mInspect').setAttribute('aria-pressed', S.mode === 'inspect'); $('#mMap').setAttribute('aria-pressed', S.mode === 'map');
  const mv = multiFloorViews(d);
  $('#btnFloor').hidden = !mv.length || S.mode !== 'inspect';
  if (mv.length) $('#btnFloor').innerHTML = `樓層 <b>${esc(mv.map(v => floorFor(v)).filter((f, i, a) => a.indexOf(f) === i).join('/'))}</b>`;
  $('#maptools').hidden = S.mode !== 'map' || !d;
  document.querySelectorAll('#maptools [data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
  const poly = S.mode === 'map' && S.tool === 'poly';
  $('#polyDone').hidden = !poly || !S.draft || S.draft.pts.length < 3; $('#polyUndo').hidden = !poly || !S.draft || !S.draft.pts.length;
  $('#empty').hidden = !!d; $('#zoombtns').hidden = !d;
  const hints = { select: '點選區域或軸線可修改；兩指縮放、拖動', rect: '在圖上拖出矩形，框住單位、房間或區域', poly: '逐點點選邊界，完成後按「完成多邊形」', gx: '在每條縱向軸線上點一下（會自動編號）', gy: '在每條橫向軸線上點一下（會自動編號）' };
  const hint = $('#hint');
  hint.textContent = !d ? '' : S.mode === 'map' ? hints[S.tool] : (S.editing ? `${itemLabel(S.editing)}：${S.editing.locText || '未設定位置'}` : '點選圖上的問題位置 → 拍照');
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
  fit(); DB.kset('cur', id);
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
  if (S.mode === 'inspect') {
    const hit = S.items.filter(i => i.drawingId === d.id).map(i => ({ i, dd: Math.hypot(i.x - p.x, i.y - p.y) })).filter(o => o.dd < 22 * u).sort((a, b) => a.dd - b.dd)[0];
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
  panel.hidden = true; document.body.classList.remove('pnl'); S.panel = null; S.sel = null; freeURLs(); renderOverlay(); updateBar();
}

/* ---- items ---- */
function newItem(p) {
  if (S.editing) finishItem();
  const d = curD(); const loc = resolveLoc(d, p.x, p.y);
  S.editing = { id: uid(), dev: S.settings.dev || 'A', by: S.settings.inspector || '', drawingId: d.id, no: nextNo(), x: Math.round(p.x), y: Math.round(p.y), loc, locText: fmtLoc(loc), locEdited: false, photos: [], note: '', created: Date.now(), _new: true };
  renderOverlay(); itemPanel(); updateBar(); ensureVisible(p);
  if (S.settings.autoCam) $('#camInput').click();
}
function openItem(it) { if (S.editing && S.editing.id !== it.id) finishItem(); S.editing = it; if (S.cur !== it.drawingId) showDrawing(it.drawingId).then(() => { centerOn(it.x, it.y, 1); itemPanel(); }); else { itemPanel(); renderOverlay(); } }
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
    <div class="row"><label class="btn p" for="camInput">拍照</label><label class="btn" for="libInput">從相簿加入</label></div>
    <label class="f">問題描述（可回辦公室再填）<textarea id="fNote" rows="3" placeholder="例如：門鉸鬆脫">${esc(it.note)}</textarea></label>
    <details><summary>手動修改位置文字</summary><label class="f"><textarea id="fLoc" rows="2">${esc(it.locText)}</textarea></label>${it.locEdited ? '<button class="btn" data-a="reloc">按上面選項重新生成</button>' : ''}</details>
    <div class="row"><button class="btn warn" data-a="del">刪除此記錄</button><button class="btn dk" data-a="done">完成</button></div>`,
    { badge: `<span class="no">${itemLabel(it)}</span>` });
  const q = s => panel.querySelector(s);
  const upd = (re) => { relocate(it); q('.idx').textContent = it.locText || '未設定位置'; q('#fLoc').value = it.locText; persistItem(); updateBar(); if (re) itemPanel(); };
  q('#fTower').onchange = e => { L.tower = e.target.value; upd(); };
  q('#fFloor').onchange = e => { L.floor = e.target.value; if (v) { S.floorSel[v.id] = L.floor; DB.kset('floorSel', S.floorSel); } upd(); };
  q('#fFlat').onchange = e => { L.flat = e.target.value; if (!L.flat) L.room = ''; else L.area = ''; upd(true); };
  const ar = q('#fArea'); if (ar) ar.oninput = e => { L.area = e.target.value.trim(); upd(); };
  if (ar) ar.onchange = () => { const a = L.area; if (a) { S.recentAreas = [a, ...S.recentAreas.filter(x => x !== a)].slice(0, 30); DB.kset('recentAreas', S.recentAreas); } };
  q('#fLoc').oninput = e => { it.locText = e.target.value; it.locEdited = true; q('.idx').textContent = it.locText; persistItem(); updateBar(); };
  q('#fNote').oninput = e => { it.note = e.target.value; persistItem(); };
  panel.querySelector('.pb').onclick = async e => {
    const rb = e.target.closest('[data-room]'); if (rb) { L.room = L.room === rb.dataset.room ? '' : rb.dataset.room; upd(true); return; }
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'cam') $('#camInput').click();
    if (a === 'lib') $('#libInput').click();
    if (a === 'done') closePanel();
    if (a === 'reloc') { it.locEdited = false; upd(true); }
    if (a === 'ed') { const i = +e.target.dataset.i; const ph = it.photos[i]; const r = await openEditor(ph.orig, ph); if (r) { it.photos[i] = r; await persistItem(true); itemPanel(); } }
    if (a === 'delph') { if (e.target.dataset.armed) { it.photos.splice(+e.target.dataset.i, 1); await persistItem(true); itemPanel(); } else { e.target.dataset.armed = 1; e.target.textContent = '刪'; e.target.style.background = 'var(--red)'; } }
    if (a === 'del') {
      if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = '再按一次確認刪除'; return; }
      S.items = S.items.filter(x => x.id !== it.id); await DB.del('items', it.id); S.editing = null; closePanel(); toast(`已刪除 ${itemLabel(it)}`);
    }
  };
  updateBar();
}
let persistT;
async function persistItem(now) {
  const it = S.editing; if (!it) return;
  if (it._new && !it.photos.length && !it.note.trim()) return;
  it.mod = Date.now();
  if (it._new) { delete it._new; S.items.push(it); updateBar(); }
  clearTimeout(persistT);
  const doit = () => DB.put('items', it).catch(err => toast('儲存失敗：' + err.message, 4000));
  if (now) await doit(); else persistT = setTimeout(doit, 400);
}
function finishItem() { const it = S.editing; if (!it) return; if (!it._new) DB.put('items', it); S.editing = null; updateBar(); }

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
  const list = (S.listScope === 'cur' && d ? S.items.filter(i => i.drawingId === d.id) : S.items).slice().sort(byOrder);
  const rows = list.map(it => {
    const th = it.photos[0] ? `style="background-image:url('${burl(it.photos[0].out)}')"` : '';
    return `<button class="li" data-id="${it.id}"><span class="th" ${th}><span class="no">${itemLabel(it)}</span></span><span class="t"><b>${esc(it.locText || '（無位置）')}</b><span>${esc(it.note || '未填描述')}　·　${it.photos.length} 張相${it.by ? '　·　' + esc(it.by) : ''}</span></span></button>`;
  }).join('') || '<div class="note">這張圖紙還沒有記錄。在「驗收」模式點選圖上的位置即可開始。</div>';
  openPanel('items', `驗收記錄（${list.length}）`, `
    <div class="row"><button class="btn ${S.listScope === 'cur' ? 'dk' : ''}" data-s="cur">此圖紙</button><button class="btn ${S.listScope === 'all' ? 'dk' : ''}" data-s="all">全部圖紙</button></div>
    <div class="list">${rows}</div>`);
  panel.querySelector('.pb').onclick = e => {
    const s = e.target.closest('[data-s]'); if (s) { S.listScope = s.dataset.s; return itemsPanel(); }
    const b = e.target.closest('.li'); if (!b) return;
    const it = S.items.find(i => i.id === b.dataset.id);
    if (S.mode !== 'inspect') setMode('inspect');
    S.editing = it;
    if (S.cur !== it.drawingId) showDrawing(it.drawingId).then(() => { itemPanel(); centerOn(it.x, it.y, 1); });
    else { itemPanel(); centerOn(it.x, it.y, Math.max(S.view.k, 1)); }
  };
}

function floorPanel() {
  const d = curD(); const mv = multiFloorViews(d);
  openPanel('floor', '選擇樓層', mv.map(v => `<div class="f-l">${esc(v.title)}</div><div class="chips pick">${v.floors.map(f => `<button class="chip ${f === floorFor(v) ? 'on' : ''}" data-v="${v.id}" data-f="${esc(f)}">${esc(f)}</button>`).join('')}</div>`).join('') + '<div class="note">之後在這張平面圖上點選的位置會用所選樓層；每個記錄仍可個別修改。</div>');
  panel.querySelector('.pb').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; S.floorSel[b.dataset.v] = b.dataset.f; DB.kset('floorSel', S.floorSel); updateBar(); floorPanel(); toast(`樓層：${b.dataset.f}`); };
}

/* ---- drawings ---- */
function drawingsPanel() {
  freeURLs();
  const rows = S.drawings.map(d => {
    const n = S.items.filter(i => i.drawingId === d.id).length;
    const th = d.thumb ? `background-image:url('${burl(d.thumb)}');` : '';
    return `<div class="li ${d.id === S.cur ? 'cur' : ''}" style="grid-template-columns:64px 1fr auto"><span class="th" style="${th}background-color:#fff"></span>
      <span class="t" data-open="${d.id}"><b>${esc(d.name)}</b><span>${esc(d.no || '')}${d.base || d.kind !== 'pdf' ? '' : '　·　未準備'}　·　${n} 記錄</span></span>
      <button class="btn" data-edit="${d.id}" style="min-height:38px;padding:6px 10px">設定</button></div>`;
  }).join('') || '<div class="note">還沒有圖紙。</div>';
  const pending = S.drawings.filter(d => d.kind === 'pdf' && !d.base).length;
  openPanel('drawings', '圖紙', `
    ${pending ? `<button class="btn dk" data-a="prep">預先準備全部圖紙（尚有 ${pending} 張）</button><div class="note">第一次開啟每張 A0 圖紙需要數秒轉換。到地盤前先按一次，現場就可以即開即用（之後離線亦可）。</div>` : ''}
    <div class="list">${rows}</div>
    <button class="btn" data-a="add">另外匯入圖紙（PDF／圖片）</button>`);
  panel.querySelector('.pb').onclick = async e => {
    const o = e.target.closest('[data-open]'); if (o) { await showDrawing(o.dataset.open); closePanel(); fit(); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) return drawingForm(S.drawings.find(d => d.id === ed.dataset.edit));
    if (e.target.dataset.a === 'add') $('#dwgInput').click();
    if (e.target.dataset.a === 'prep') { let i = 0; const list = S.drawings.filter(d => d.kind === 'pdf' && !d.base); for (const d of list) { busy(`正在準備圖紙 ${++i}／${list.length}：${d.name}`); try { await ensureBase(d, true); await makeThumb(d); } catch (err) { console.warn(err); } } busy(); toast('全部圖紙已準備好'); drawingsPanel(); }
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
      if (S.cur === d.id) await showDrawing(S.drawings[0]?.id || null); drawingsPanel(); updateBar();
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
    for (const d of made) { await DB.put('drawings', d); S.drawings.push(d); }
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
$('#zIn').onclick = () => zoomAt(1.6); $('#zOut').onclick = () => zoomAt(1 / 1.6); $('#zFit').onclick = () => fit();
let rzT; addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(fit, 150); });

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
    const it0 = S.editing, t0 = prev ? prev.t : Date.now(); let pv = 0, ready = null, prepT = 0;
    const autoAlb = !prev && it0 && S.settings.autoAlbum !== false && navigator.canShare && navigator.share;
    const prep = () => { if (!autoAlb) return; const v = ++pv; ready = null; clearTimeout(prepT); prepT = setTimeout(async () => {
      try { const out = await canvasBlob(cv, 'image/jpeg', 0.86); if (v !== pv) return;
        const f = new File([await captioned({ ...it0, photos: [...it0.photos, 0] }, { out, t: t0 }, it0.photos.length)], photoName(it0, it0.photos.length), { type: 'image/jpeg' });
        if (v === pv && navigator.canShare({ files: [f] })) ready = { v, f }; } catch (e) { } }, 120); };
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
      const r = { id: prev ? prev.id : uid(), orig, out, shapes, w, h, t: t0 };
      if (albumP) albumP.then(async okA => { if (!okA) return toast('未存入相簿，可稍後在「導出 → 存入相簿」補存', 3500); r.album = Date.now(); if (S.items.includes(it0)) await DB.put('items', it0); updateBar(); });
      else if (autoAlb) toast('相片未能即時存入相簿，可稍後在「導出 → 存入相簿」補存', 3500);
      resolve(r);
    };
    let albumP = null;
    ed.onclick = e => {
      const b = e.target.closest('[data-ed]'); if (!b) return;
      const a = b.dataset.ed;
      if (a === 'tool') E.tool = b.dataset.v; if (a === 'color') E.color = b.dataset.v;
      if (a === 'undo') { shapes.pop(); draw(); prep(); } if (a === 'clear') { shapes.length = 0; draw(); prep(); }
      if (a === 'done' && autoAlb && ready && ready.v === pv) albumP = navigator.share({ files: [ready.f] }).then(() => true, () => false);
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
    <div class="row"><button class="btn ${ub ? 'p' : ''}" data-a="bknew">備份新增記錄</button><button class="btn" data-a="album">存入相簿（${ua}）</button></div>
    <button class="btn" data-a="bk">完整備份（全部 ${S.items.length} 項）</button>
    <div class="note">備份檔是 ZIP，可用分享選單存到「檔案」、iCloud Drive、Google Drive 或 WhatsApp。ZIP 內的「相片」資料夾在電腦上可直接開啟，每張相底部印有編號、位置、時間及檢查人員。</div>
    <div class="sec">報告</div>
    <label class="f">項目名稱<input id="pName" value="${esc(P.name)}" placeholder="例如：XX 住宅發展項目"></label>
    <div class="grid2"><label class="f">地盤／地址<input id="pSite" value="${esc(P.site)}"></label><label class="f">驗收日期<input id="pDate" type="date" value="${esc(P.date)}"></label></div>
    <label class="f">公司／單位<input id="pCo" value="${esc(P.company)}"></label>
    ${devs.length > 1 ? `<label class="f">報告範圍<select id="pDevs"><option value="">全部（${devs.join('、')}）</option>${devs.map(d => `<option value="${d}">只限 ${d}</option>`).join('')}</select></label>` : ''}
    <label class="f">圖紙截取範圍<select id="pCrop"><option value="s">細（約 7 米闊）</option><option value="m">中（約 11 米闊）</option><option value="l">大（約 17 米闊）</option></select></label>
    <label class="toggle">報告最後附上每張平面圖的位置總圖<input type="checkbox" id="pKey" ${S.settings.keyPlan ? 'checked' : ''}></label>
    <button class="btn p" data-a="preview">預覽報告</button>
    <div class="row"><button class="btn dk" data-a="pdf">導出 PDF</button><button class="btn dk" data-a="docx">導出 Word</button></div>
    <div class="note">預覽後可直接導出 PDF 或 Word。PDF 與預覽版面相同；Word 可再加文字修改。</div>
    <div class="sec">合併其他 iPad 的記錄</div>
    <button class="btn" data-a="imp">匯入備份檔（ZIP）</button>
    <div class="note">匯入後所有記錄會在同一張圖上顯示，保留原來的編號（如 B-012）及檢查人員；同一記錄以較新的版本為準。</div>
    <div class="sec">本機</div>
    <div class="row"><button class="btn" data-a="setup">代號 ${esc(S.settings.dev || '—')}　${esc(S.settings.inspector || '')}</button></div>
    <label class="toggle">點選位置後直接開相機<input type="checkbox" id="sCam" ${S.settings.autoCam ? 'checked' : ''}></label>
    <label class="toggle">拍照後即時存入相簿（分享選單按「儲存影像」）<input type="checkbox" id="sAlb" ${S.settings.autoAlbum !== false ? 'checked' : ''}></label>
    <label class="toggle">驗收時顯示單位範圍<input type="checkbox" id="sZone" ${S.settings.showZones ? 'checked' : ''}></label>
    <div class="note" id="stor">記錄存在這部 iPad 的程式資料內。</div>
    <div class="note">版本 ${VERSION}${S.pkgVersion ? '　圖紙包 ' + esc(S.pkgVersion) : ''}</div>`);
  $('#pCrop').value = S.settings.crop;
  const sv = () => { Object.assign(P, { name: $('#pName').value, site: $('#pSite').value, date: $('#pDate').value, company: $('#pCo').value }); S.settings.keyPlan = $('#pKey').checked; S.settings.crop = $('#pCrop').value; S.settings.autoCam = $('#sCam').checked; S.settings.showZones = $('#sZone').checked; S.settings.autoAlbum = $('#sAlb').checked; saveKV(); updateBar(); renderOverlay(); };
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
    if (a === 'docx') exportDocx(od);
    if (a === 'preview') previewReport(od);
    if (a === 'pdf') { const items = S.items.filter(i => !od || devOf(i) === od).sort(byOrder); if (!items.length) return toast('還沒有任何記錄'); busy('正在生成 PDF…'); ovCache.clear(); try { const r = await buildReportPages(items, (x, y) => busy(`正在生成 PDF… ${x}／${y}`)); ovCache.clear(); await exportPdf(r.pages); if (r.fails.length) reportFails(r.fails); } catch (err) { busy(); toast('PDF 生成失敗：' + err.message, 6000); } }
    if (a === 'bk') exportBackup(false);
    if (a === 'bknew') exportBackup(true);
    if (a === 'album') albumPanel();
    if (a === 'setup') setupPanel();
    if (a === 'imp') $('#jsonInput').click();
  };
}
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
const safeName = s => (s || '').replace(/[\\/:*?"<>|]+/g, '_').trim();

function pinOn(x, px, py, n, r) {
  x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fillStyle = '#d42a1e'; x.fill(); x.lineWidth = Math.max(3, r / 6); x.strokeStyle = '#fff'; x.stroke();
  x.fillStyle = '#fff'; x.font = `bold ${Math.round(r * (String(n).length > 3 ? 0.62 : String(n).length > 2 ? 0.8 : 1))}px Menlo, monospace`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(n), px, py + 1);
}
function cropRect(d, it) {
  let cw = CROP_W[S.settings.crop] || 320, ch = cw * 0.75;
  if (cw > d.w) { cw = d.w; ch = cw * 0.75; } if (ch > d.h) { ch = d.h; cw = ch / 0.75; }
  return { x: clamp(it.x - cw / 2, 0, d.w - cw), y: clamp(it.y - ch / 2, 0, d.h - ch), w: cw, h: ch };
}
async function cropImage(d, it) { // 4:3, vector-sharp
  const R = cropRect(d, it); const outW = 1400; const c = await renderRegion(d, R.x, R.y, R.w, R.h, outW); const x = c.getContext('2d'); const s = outW / R.w;
  const v = viewById(d, it.loc.viewId);
  for (const z of (v && v.zones || []).filter(z => (it.loc.zoneIds || []).includes(z.id))) {
    x.beginPath(); z.pts.forEach((p, i) => { const a = (p[0] - R.x) * s, b = (p[1] - R.y) * s; i ? x.lineTo(a, b) : x.moveTo(a, b); }); x.closePath();
    x.fillStyle = 'rgba(242,194,48,.16)'; x.fill(); x.strokeStyle = 'rgba(212,42,30,.55)'; x.lineWidth = 4; x.setLineDash([14, 8]); x.stroke(); x.setLineDash([]);
  }
  pinOn(x, (it.x - R.x) * s, (it.y - R.y) * s, devOf(it) + it.no, 44);
  x.strokeStyle = '#888'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, c.width - 3, c.height - 3);
  return { blob: await canvasBlob(c, 'image/jpeg', 0.88), w: c.width, h: c.height };
}
const ovCache = new Map();
async function overviewImage(d, it) { // whole plan view, small, with the crop box highlighted
  const v = viewById(d, it.loc.viewId); const b = v ? v.bbox : [0, 0, d.w, d.h]; const R = cropRect(d, it);
  const pad = 0.02 * Math.max(b[2] - b[0], b[3] - b[1]); const bx = Math.max(0, b[0] - pad), by = Math.max(0, b[1] - pad), bw = Math.min(d.w, b[2] + pad) - bx, bh = Math.min(d.h, b[3] + pad) - by;
  const outW = 1400, outH = Math.round(outW * bh / bw), s = outW / bw; const key = d.id + '|' + (v ? v.id : '');
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
  for (const it of items) pinOn(x, (it.x - b[0]) * s, (it.y - b[1]) * s, devOf(it) + it.no, Math.max(16, outW / 90));
  return { blob: await canvasBlob(c, 'image/jpeg', 0.88), w: c.width, h: c.height };
}

async function exportDocx(onlyDev) {
  if (!S.items.length) return toast('還沒有任何記錄');
  if (!window.docx) return toast('報告元件未載入，請連網後重新開啟一次');
  const D = window.docx; const P = S.project;
  try {
    busy('正在生成報告…');
    const items = S.items.filter(i => !onlyDev || devOf(i) === onlyDev).sort(byOrder); const fails = []; ovCache.clear(); var curLbl = '';
    const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft JhengHei', cs: 'Arial' };
    const T = (text, o = {}) => new D.TextRun({ text: String(text ?? ''), font: FONT, size: o.size || 18, bold: o.bold, color: o.color });
    const Pg = (runs, o = {}) => new D.Paragraph({ children: Array.isArray(runs) ? runs : [runs], alignment: o.align, spacing: { after: o.after ?? 40, before: o.before ?? 0 }, keepLines: true, keepNext: o.keepNext });
    const border = { style: D.BorderStyle.SINGLE, size: 4, color: '8A9391' };
    const borders = { top: border, bottom: border, left: border, right: border };
    // A4 landscape 16838 x 11906 twips; margins 600 → 15638 usable
    const usable = 15638; const colPct = [4, 14, 26, 26, 19, 11]; const colTw = colPct.map(p => Math.round(usable * p / 100));
    const imgPx = Math.floor(colTw[2] / 15) - 12; // drawing crop and photo share one width → same 4:3 size
    const cell = (children, i, o = {}) => new D.TableCell({ children, width: { size: colTw[i], type: D.WidthType.DXA }, borders, verticalAlign: o.v || D.VerticalAlign.TOP, shading: o.shade ? { type: D.ShadingType.CLEAR, color: 'auto', fill: o.shade } : undefined, margins: { top: 70, bottom: 70, left: 80, right: 80 } });
    const heads = ['編號', '位置', '圖紙位置（總圖／截取）', '現場照片', '問題描述', '跟進'];
    const rows = [new D.TableRow({ tableHeader: true, cantSplit: true, children: heads.map((h, i) => cell([Pg(T(h, { bold: true, color: 'FFFFFF', size: 17 }), { align: D.AlignmentType.CENTER, after: 0 })], i, { shade: '1D2629', v: D.VerticalAlign.CENTER })) })];
    let n = 0;
    for (const it of items) {
      busy(`正在生成報告… ${++n}／${items.length}`);
      curLbl = itemLabel(it);
      const d = S.drawings.find(x => x.id === it.drawingId); if (!d) continue;
      if (d.kind === 'pdf') await ensureBase(d, true);
      const failText = what => Pg(T(`（${what}無法生成）`, { color: 'D42A1E', size: 15 }), { align: D.AlignmentType.CENTER, after: 60 });
      let ovH = 95; const dwgParas = [];
      try { const ovw = await overviewImage(d, it); ovH = Math.min(Math.round(imgPx * ovw.h / ovw.w), 95); const ovW = Math.round(ovH * ovw.w / ovw.h);
        dwgParas.push(Pg(new D.ImageRun({ data: await ovw.blob.arrayBuffer(), transformation: { width: ovW, height: ovH } }), { align: D.AlignmentType.CENTER, after: 60 }));
      } catch (e) { fails.push(`${itemLabel(it)} 總圖：${e.message}`); dwgParas.push(failText('總圖')); console.error(e); }
      try { const cr = await cropImage(d, it);
        dwgParas.push(Pg(new D.ImageRun({ data: await cr.blob.arrayBuffer(), transformation: { width: imgPx, height: Math.round(imgPx * 0.75) } }), { align: D.AlignmentType.CENTER, after: 0 }));
      } catch (e) { fails.push(`${itemLabel(it)} 圖紙截取：${e.message}`); dwgParas.push(failText('圖紙截取')); console.error(e); }
      const phParas = [];
      for (const [i, ph] of it.photos.entries()) {
        let wpx = imgPx, hpx = Math.round(imgPx * 0.75); // 4:3 frame; portrait photos fit inside it
        if (Math.abs(ph.w / ph.h - 4 / 3) > 0.02) { if (ph.w / ph.h > 4 / 3) hpx = Math.round(imgPx * ph.h / ph.w); else { wpx = Math.round(hpx * ph.w / ph.h); } }
        try { phParas.push(Pg(new D.ImageRun({ data: await (await shrink(ph.out, 1400)).arrayBuffer(), transformation: { width: wpx, height: hpx } }), { after: 60, align: D.AlignmentType.CENTER })); }
        catch (e) {
          try { phParas.push(Pg(new D.ImageRun({ data: await (await shrink(ph.orig, 1400)).arrayBuffer(), transformation: { width: wpx, height: hpx } }), { after: 60, align: D.AlignmentType.CENTER })); fails.push(`${itemLabel(it)} 照片${i + 1}：標記版讀取失敗，已改用原相`); }
          catch (e2) { fails.push(`${itemLabel(it)} 照片${i + 1}：${e.message}`); phParas.push(failText(`照片${i + 1}`)); console.error(e, e2); }
        }
      }
      if (it.photos.length) phParas.unshift(Pg(T(''), { after: Math.round(ovH * 15) + 60 })); // push first photo down so it lines up with the crop
      if (!it.photos.length) phParas.push(Pg(T('（無照片）', { color: '888888' })));
      const L = it.loc || {}; const v = viewById(d, L.viewId);
      const locParas = [Pg(T(it.locText || '—', { bold: true, size: 18 }), { after: 100 })];
      [['座', L.tower], ['層', L.floor], ['單位', L.flat ? 'FLAT ' + L.flat : ''], ['房間／區域', L.room || L.area], ['軸線', L.grid], ['圖紙', [d.no, v ? v.title : d.name].filter(Boolean).join(' ')]].forEach(([k, val]) => { if (val) locParas.push(Pg([T(k + '：', { color: '5F6B69', size: 15 }), T(val, { size: 15 })], { after: 20 })); });
      const noteParas = (it.note || '').split('\n').map(l => Pg(T(l, { size: 18 })));
      rows.push(new D.TableRow({
        cantSplit: true, children: [
          cell([Pg(T(itemLabel(it), { bold: true, size: 16, color: 'D42A1E' }), { align: D.AlignmentType.CENTER }), Pg(T(it.by || '', { size: 13, color: '5F6B69' }), { align: D.AlignmentType.CENTER }), Pg(T(fmtTime(it.created).slice(5, 10), { size: 13, color: '5F6B69' }), { align: D.AlignmentType.CENTER })], 0, { v: D.VerticalAlign.CENTER }),
          cell(locParas, 1), cell(dwgParas, 2), cell(phParas, 3), cell(noteParas.length ? noteParas : [Pg(T(''))], 4), cell([Pg(T(''))], 5),
        ]
      }));
    }
    const nb = { top: { style: D.BorderStyle.NONE }, bottom: { style: D.BorderStyle.NONE }, left: { style: D.BorderStyle.NONE }, right: { style: D.BorderStyle.NONE } };
    const infoRow = (k, v) => new D.TableRow({ children: [new D.TableCell({ children: [Pg(T(k, { color: '5F6B69' }), { after: 0 })], width: { size: 2000, type: D.WidthType.DXA }, borders: nb }), new D.TableCell({ children: [Pg(T(v || '', { bold: true }), { after: 0 })], width: { size: 6000, type: D.WidthType.DXA }, borders: nb })] });
    const children = [
      Pg(T('竣工驗收記錄', { bold: true, size: 32 }), { after: 120 }),
      new D.Table({ rows: [infoRow('項目名稱', P.name), infoRow('地盤／地址', P.site), infoRow('驗收日期', P.date), infoRow('檢查人員', [P.inspector, P.company].filter(Boolean).join('　')), infoRow('記錄數量', `${items.length} 項`)], width: { size: 8000, type: D.WidthType.DXA }, columnWidths: [2000, 6000] }),
      Pg(T(''), { after: 120 }),
      new D.Table({ rows, width: { size: usable, type: D.WidthType.DXA }, columnWidths: colTw, layout: D.TableLayoutType.FIXED }),
    ];
    if (S.settings.keyPlan) {
      const avail = { w: Math.floor(usable / 15) - 10, h: Math.floor((11906 - 1300) / 15) - 90 };
      const groups = new Map();
      for (const it of items) { const key = it.drawingId + '|' + (it.loc.viewId || ''); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(it); }
      for (const [key, its] of groups) {
        const [did, vid] = key.split('|'); const d = S.drawings.find(x => x.id === did); if (!d) continue; const v = viewById(d, vid);
        busy(`正在生成位置總圖：${v ? v.title : d.name}`);
        let k; try { k = await keyPlanImage(d, v, its); } catch (e) { fails.push(`位置總圖 ${v ? v.title : d.name}：${e.message}`); continue; } const s = Math.min(avail.w / k.w, avail.h / k.h);
        children.push(new D.Paragraph({ pageBreakBefore: true, children: [T(`位置總圖：${v ? v.title : d.name}`, { bold: true, size: 24 })], spacing: { after: 60 } }));
        children.push(Pg(T(`${d.no || d.name}　記錄：${its.map(i => itemLabel(i) + (i.loc.floor ? '(' + i.loc.floor + ')' : '')).join('、')}`, { size: 16, color: '5F6B69' }), { after: 80 }));
        children.push(Pg(new D.ImageRun({ data: await k.blob.arrayBuffer(), transformation: { width: Math.round(k.w * s), height: Math.round(k.h * s) } }), { align: D.AlignmentType.CENTER }));
      }
    }
    const doc = new D.Document({
      creator: P.inspector || '竣工驗收記錄', title: '竣工驗收記錄',
      styles: { default: { document: { run: { font: FONT, size: 18 } } } },
      sections: [{
        properties: { page: { size: { width: 11906, height: 16838, orientation: D.PageOrientation.LANDSCAPE }, margin: { top: 600, bottom: 600, left: 600, right: 600, header: 300, footer: 300 } } },
        headers: { default: new D.Header({ children: [Pg([T(`${P.name || ''}　竣工驗收記錄　${P.date || ''}`, { size: 15, color: '5F6B69' })], { align: D.AlignmentType.RIGHT })] }) },
        footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ children: ['第 ', D.PageNumber.CURRENT, ' 頁，共 ', D.PageNumber.TOTAL_PAGES, ' 頁'], font: FONT, size: 15, color: '5F6B69' })] })] }) },
        children,
      }],
    });
    const blob = await D.Packer.toBlob(doc);
    busy();
    await deliver(blob, `竣工驗收記錄_${safeName(P.name) || '項目'}_${P.date || today()}.docx`);
    ovCache.clear();
    if (fails.length) reportFails(fails);
  } catch (err) { busy(); console.error(err); toast('報告生成失敗' + (typeof curLbl !== 'undefined' && curLbl ? `（${curLbl}）` : '') + '：' + err.message, 8000); }
}

/* ---------------- device identity, captions, album, backup & merge ---------------- */
const devOf = it => it.dev || S.settings.dev || 'A';
const itemLabel = it => `${devOf(it)}-${String(it.no).padStart(3, '0')}`;
const byOrder = (a, b) => devOf(a).localeCompare(devOf(b)) || a.no - b.no;
const fmtTime = t => { const d = new Date(t || Date.now()); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
function unbacked() { const t = S.settings.lastBackup || 0; return S.items.filter(i => (i.mod || i.created || 0) > t).length; }
function unalbum() { return S.items.reduce((n, i) => n + i.photos.filter(p => !p.album).length, 0); }

async function renderOut(orig, shapes) {
  const img = await loadImg(orig); const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const lw = Math.max(5, Math.round(Math.max(w, h) / 160)); for (const s of shapes || []) drawShape(x, s, lw);
  URL.revokeObjectURL(img.src); return canvasBlob(c, 'image/jpeg', 0.86);
}
/* photo with a caption strip burnt in: readable on its own in the Photos app, WhatsApp or a folder */
async function captioned(it, ph, i) {
  const img = await loadImg(ph.out); const w = img.naturalWidth, h = img.naturalHeight;
  const fs = Math.max(18, Math.round(w / 48)), pad = Math.round(fs * 0.6), lh = Math.round(fs * 1.35);
  const lines = [`${itemLabel(it)}${it.photos.length > 1 ? ` (${i + 1}/${it.photos.length})` : ''}　${it.locText || ''}`,
    `${fmtTime(ph.t)}　檢查：${it.by || S.settings.inspector || devOf(it)}　${S.project.name || ''}`];
  if (it.note) lines.push(it.note.replace(/\s+/g, ' ').slice(0, 80));
  const c = document.createElement('canvas'); c.width = w; c.height = h + pad * 2 + lh * lines.length; const x = c.getContext('2d');
  x.drawImage(img, 0, 0); x.fillStyle = '#1d2629'; x.fillRect(0, h, w, c.height - h);
  x.textBaseline = 'top'; lines.forEach((t, k) => { x.fillStyle = k ? '#d6dedb' : '#ffffff'; x.font = `${k ? '' : 'bold '}${k ? Math.round(fs * 0.85) : fs}px -apple-system,"PingFang TC",sans-serif`; x.fillText(t, pad, h + pad + k * lh, w - pad * 2); });
  URL.revokeObjectURL(img.src);
  return canvasBlob(c, 'image/jpeg', 0.86);
}
const photoName = (it, i) => safeName(`${itemLabel(it)}_${it.locText || ''}_${i + 1}`).replace(/[\s\u3000]+/g, '_').slice(0, 90) + '.jpg';

/* save captioned photos into the iPad Photos album through the share sheet, in batches */
async function albumPanel() {
  const todo = []; for (const it of S.items.slice().sort(byOrder)) it.photos.forEach((p, i) => { if (!p.album) todo.push([it, p, i]); });
  const N = 20, batches = Math.ceil(todo.length / N);
  openPanel('album', '存入相簿', todo.length ? `
    <div class="note">尚有 <b>${todo.length}</b> 張相未存入相簿。每批 ${N} 張，按下後在分享選單揀「儲存 ${Math.min(N, todo.length)} 張影像」。存入的相片底部印有編號、位置、時間及檢查人員。</div>
    <button class="btn p" id="albGo">存入第 1 批（共 ${batches} 批）</button>`
    : '<div class="note">全部相片已存入相簿。</div>', { compact: true });
  const go = $('#albGo'); if (!go) return;
  go.onclick = async () => {
    const part = todo.slice(0, N);
    if (!navigator.canShare) return toast('這個瀏覽器不支援存入相簿，請用 iPad Safari');
    try {
      busy('正在準備相片…'); const files = [];
      for (const [it, p, i] of part) files.push(new File([await captioned(it, p, i)], photoName(it, i), { type: 'image/jpeg' }));
      busy();
      if (!navigator.canShare({ files })) return toast('這部機不能經分享選單存相');
      await navigator.share({ files });
      for (const [it, p] of part) { p.album = Date.now(); await DB.put('items', it); }
      toast(`已存入 ${part.length} 張`); albumPanel(); updateBar();
    } catch (e) { busy(); if (e.name !== 'AbortError') toast('未能存入：' + e.message, 4000); }
  };
}

/* ZIP backup: data.json + original photos + captioned photos (viewable without the app) */
function reportFails(fails) {
  openPanel('fails', '報告已生成，但部分圖片有問題', `<div class="note">以下 ${fails.length} 處在報告內以紅字標示。請截圖這個畫面給我，方便查找原因。</div><div class="list">${fails.map(f => `<div class="li" style="display:block">${esc(f)}</div>`).join('')}</div>`);
}
async function exportBackup(onlyNew) {
  if (!window.JSZip) return toast('備份元件未載入，請連網後重新開啟');
  try {
    const since = onlyNew ? (S.settings.lastBackup || 0) : 0;
    const items = S.items.filter(i => (i.mod || i.created || 0) > since).sort(byOrder);
    if (!items.length) return toast('沒有新的記錄需要備份');
    busy('正在打包…'); const zip = new JSZip(); const out = [];
    let n = 0, tot = items.reduce((s, i) => s + i.photos.length, 0);
    for (const it of items) {
      const photos = [];
      for (const [i, p] of it.photos.entries()) {
        busy(`正在打包相片 ${++n}／${tot}`);
        const o = `data/${p.id}.jpg`; zip.file(o, p.orig, { compression: 'STORE' });
        zip.file(`相片/${photoName(it, i)}`, await captioned(it, p, i), { compression: 'STORE' });
        const { orig, out: _o, ...meta } = p; photos.push({ ...meta, orig: o });
      }
      out.push({ ...it, photos });
    }
    const drawings = S.drawings.filter(d => d.src !== 'bundle' || true).map(d => ({ id: d.id, src: d.src, views: d.src === 'user' ? d.views : undefined }));
    zip.file('data.json', JSON.stringify({ app: 'handover-inspect', format: 2, version: VERSION, exported: new Date().toISOString(), dev: S.settings.dev, inspector: S.settings.inspector, onlyNew: !!onlyNew, project: S.project, items: out, mapping: S.drawings.filter(d => d.src === 'bundle').map(d => ({ id: d.id, views: d.views })) }));
    busy('正在壓縮…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
    busy();
    const stamp = fmtTime().replace(/[-: ]/g, '').slice(0, 12);
    await deliver(blob, `驗收備份_${S.settings.dev || 'A'}_${onlyNew ? '新增' : '完整'}_${stamp}.zip`);
    S.settings.lastBackup = Date.now(); await saveKV(); updateBar(); if (S.panel === 'export') exportPanel();
  } catch (err) { busy(); toast('備份失敗：' + err.message, 6000); }
}
async function importBackup(file) {
  try {
    busy('正在匯入…'); let data, zip = null;
    if (/\.zip$/i.test(file.name) || file.type.includes('zip')) { zip = await JSZip.loadAsync(file); data = JSON.parse(await zip.file('data.json').async('string')); }
    else data = JSON.parse(await file.text());
    if (data.app !== 'handover-inspect') throw new Error('不是本程式的備份檔');
    if (data.project && !S.project.name) S.project = { ...S.project, ...data.project };
    let add = 0, upd = 0, skip = 0, i = 0;
    for (const it of data.items || []) {
      busy(`正在匯入記錄 ${++i}／${data.items.length}`);
      if (!it.dev) it.dev = data.dev || 'X';
      if (!it.by && data.inspector && it.dev === data.dev) it.by = data.inspector;
      const ex = S.items.find(x => x.id === it.id);
      if (ex && (ex.mod || ex.created || 0) >= (it.mod || it.created || 0)) { skip++; continue; }
      const photos = [];
      for (const p of it.photos) {
        let orig = typeof p.orig === 'string' && p.orig.startsWith('data:') ? await dataURLToBlob(p.orig) : zip ? await zip.file(p.orig).async('blob') : null;
        if (!orig) continue; orig = new Blob([orig], { type: 'image/jpeg' });
        const out = typeof p.out === 'string' && p.out.startsWith('data:') ? await dataURLToBlob(p.out) : await renderOut(orig, p.shapes);
        photos.push({ ...p, orig, out });
      }
      const rec = { ...it, photos }; await DB.put('items', rec);
      if (ex) { Object.assign(ex, rec); upd++; } else { S.items.push(rec); add++; }
    }
    await saveKV(); busy(); toast(`匯入完成：新增 ${add}、更新 ${upd}、略過 ${skip}`, 4000);
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
    for (const it of S.items) if (!it.dev) { it.dev = dev; await DB.put('items', it); }
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
  x.font = `${o.bold ? '700 ' : ''}${size}px ${RFONT}`; x.fillStyle = o.color || '#1b2224'; x.textBaseline = 'top';
  const lines = wrapLines(x, text, maxW).slice(0, o.max || 99); const lh = size * 1.3;
  lines.forEach((l, i) => { const w = x.measureText(l).width; x.fillText(l, o.center ? X + (maxW - w) / 2 : X, Y + i * lh); });
  return lines.length * lh;
}
async function drawBlob(x, blob, X, Y, W, H) { const img = await loadImg(blob); x.drawImage(img, X, Y, W, H); if (img.close) img.close(); else URL.revokeObjectURL(img.src); }

async function buildReportPages(items, progress) {
  const P = S.project, k = PG.k, M = PG.M, UW = PG.W - 2 * M;
  const pct = [4, 14, 26, 26, 19, 11], cw = pct.map(p => UW * p / 100), cx = cw.map((_, i) => M + cw.slice(0, i).reduce((a, b) => a + b, 0));
  const heads = ['編號', '位置', '圖紙位置（總圖／截取）', '現場照片', '問題描述', '跟進'];
  const pad = 5, imgW = cw[2] - 2 * pad, cropH = imgW * 0.75, top0 = M + 14, bottom = PG.H - M - 14, headH = 20;
  const pages = []; let c, x, y, fails = [];
  const newPage = first => {
    c = document.createElement('canvas'); c.width = PG.W * k; c.height = PG.H * k; x = c.getContext('2d'); x.scale(k, k);
    x.fillStyle = '#fff'; x.fillRect(0, 0, PG.W, PG.H);
    drawText(x, `${P.name || ''}　竣工驗收記錄　${P.date || ''}`, M, M - 14, UW, 7.5, { color: '#5f6b69', center: false });
    y = top0;
    if (first) {
      y += drawText(x, '竣工驗收記錄', M, y, UW, 17, { bold: true }) + 6;
      for (const [a, b] of [['項目名稱', P.name], ['地盤／地址', P.site], ['驗收日期', P.date], ['公司／單位', P.company], ['記錄數量', `${items.length} 項`]]) {
        drawText(x, a, M, y, 80, 9, { color: '#5f6b69' }); drawText(x, b || '', M + 80, y, 400, 9, { bold: true }); y += 13;
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
    const ovH = ov ? Math.min(imgW * ov.h / ov.w, 60) : 14, ovW = ov ? ovH * ov.w / ov.h : imgW;
    const np = it.photos.length;
    let phH = cropH; const avail = bottom - top0 - headH - 2 * pad;
    const need = () => Math.max(ovH + 4 + cropH, ovH + 4 + Math.max(1, np) * (phH + 4) - 4);
    if (need() > avail) phH = Math.max(40, (avail - ovH - 4 - (np - 1) * 4) / np);
    const rowH = need() + 2 * pad;
    if (y + rowH > bottom) newPage(false);
    const y0 = y; grid(y0, rowH);
    drawText(x, itemLabel(it), cx[0], y0 + rowH / 2 - 16, cw[0], 7.5, { bold: true, color: '#d42a1e', center: true });
    drawText(x, it.by || '', cx[0], y0 + rowH / 2 - 4, cw[0], 6, { color: '#5f6b69', center: true });
    drawText(x, fmtTime(it.created).slice(5, 10), cx[0], y0 + rowH / 2 + 5, cw[0], 6, { color: '#5f6b69', center: true });
    const L = it.loc || {}; const v = viewById(d, L.viewId);
    let ty = y0 + pad + drawText(x, it.locText || '—', cx[1] + pad, y0 + pad, cw[1] - 2 * pad, 8.5, { bold: true }) + 6;
    for (const [a, b] of [['座', L.tower], ['層', L.floor], ['單位', L.flat ? 'FLAT ' + L.flat : ''], ['房間／區域', L.room || L.area], ['軸線', L.grid], ['圖紙', [d.no, v ? v.title : d.name].filter(Boolean).join(' ')]])
      if (b) ty += drawText(x, `${a}：${b}`, cx[1] + pad, ty, cw[1] - 2 * pad, 7, { color: '#3a4544' }) + 1;
    const ix = cx[2] + pad;
    if (ov) { await drawBlob(x, ov.blob, ix + (imgW - ovW) / 2, y0 + pad, ovW, ovH); } else drawText(x, '（總圖無法生成）', ix, y0 + pad, imgW, 7, { color: '#d42a1e', center: true });
    if (cr) await drawBlob(x, cr.blob, ix, y0 + pad + ovH + 4, imgW, cropH); else drawText(x, '（圖紙截取無法生成）', ix, y0 + pad + ovH + 30, imgW, 7, { color: '#d42a1e', center: true });
    let py = y0 + pad + ovH + 4; const px0 = cx[3] + pad;
    if (!np) drawText(x, '（無照片）', px0, py + 20, imgW, 8, { color: '#888', center: true });
    for (const [i, ph] of it.photos.entries()) {
      let w = phH / 0.75, h = phH; if (w > imgW) { w = imgW; h = imgW * 0.75; }
      const r = ph.w / ph.h; let dw = w, dh = h; if (r > w / h) dh = w / r; else dw = h * r;
      try { await drawBlob(x, await shrink(ph.out, 1400), px0 + (imgW - dw) / 2, py + (h - dh) / 2, dw, dh); }
      catch (e) { try { await drawBlob(x, await shrink(ph.orig, 1400), px0 + (imgW - dw) / 2, py + (h - dh) / 2, dw, dh); fails.push(`${itemLabel(it)} 照片${i + 1}：已改用原相`); } catch (e2) { fails.push(`${itemLabel(it)} 照片${i + 1}：${e.message}`); drawText(x, `（照片${i + 1}無法讀取）`, px0, py + h / 2, imgW, 7, { color: '#d42a1e', center: true }); } }
      py += h + 4;
    }
    drawText(x, it.note || '', cx[4] + pad, y0 + pad, cw[4] - 2 * pad, 8.5);
    y += rowH;
  }
  if (S.settings.keyPlan) {
    const groups = new Map(); for (const it of items) { const key = it.drawingId + '|' + (it.loc.viewId || ''); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(it); }
    for (const [key, its] of groups) {
      const [did, vid] = key.split('|'); const d = S.drawings.find(q => q.id === did); if (!d) continue; const v = viewById(d, vid);
      try {
        const kp = await keyPlanImage(d, v, its);
        newPageRaw(); y = top0;
        y += drawText(x, `位置總圖：${v ? v.title : d.name}`, M, y, UW, 12, { bold: true }) + 2;
        y += drawText(x, `${d.no || ''}　記錄：${its.map(i => itemLabel(i) + (i.loc.floor ? '(' + i.loc.floor + ')' : '')).join('、')}`, M, y, UW, 7.5, { color: '#5f6b69', max: 3 }) + 6;
        const s = Math.min(UW / kp.w, (bottom - y) / kp.h); await drawBlob(x, kp.blob, M + (UW - kp.w * s) / 2, y, kp.w * s, kp.h * s);
      } catch (e) { fails.push(`位置總圖 ${v ? v.title : d.name}：${e.message}`); }
    }
  }
  function newPageRaw() { c = document.createElement('canvas'); c.width = PG.W * k; c.height = PG.H * k; x = c.getContext('2d'); x.scale(k, k); x.fillStyle = '#fff'; x.fillRect(0, 0, PG.W, PG.H); drawText(x, `${P.name || ''}　竣工驗收記錄　${P.date || ''}`, M, M - 14, UW, 7.5, { color: '#5f6b69' }); pages.push(c); }
  const blobs = [];
  for (const [i, pc] of pages.entries()) {
    const px = pc.getContext('2d'); drawText(px, `第 ${i + 1} 頁，共 ${pages.length} 頁`, M, PG.H - M + 2, UW, 7.5, { color: '#5f6b69', center: true });
    blobs.push(await canvasBlob(pc, 'image/jpeg', 0.88)); pc.width = pc.height = 0;
  }
  return { pages: blobs, fails };
}

let PV = null;
async function previewReport(onlyDev) {
  const items = S.items.filter(i => !onlyDev || devOf(i) === onlyDev).sort(byOrder);
  if (!items.length) return toast('還沒有任何記錄');
  try {
    busy('正在生成預覽…'); ovCache.clear();
    const r = await buildReportPages(items, (a, b) => busy(`正在生成預覽… ${a}／${b}`));
    ovCache.clear(); busy();
    PV = { ...r, onlyDev, urls: r.pages.map(b => URL.createObjectURL(b)) };
    const el = $('#preview');
    el.querySelector('.pvpages').innerHTML = PV.urls.map((u, i) => `<img src="${u}" alt="第 ${i + 1} 頁">`).join('');
    el.querySelector('.pvinfo').textContent = `共 ${PV.pages.length} 頁　${items.length} 項記錄${PV.fails.length ? `　·　${PV.fails.length} 處圖片有問題` : ''}`;
    el.hidden = false; el.querySelector('.pvpages').scrollTop = 0;
  } catch (e) { busy(); toast('預覽失敗：' + e.message, 6000); console.error(e); }
}
function closePreview() { $('#preview').hidden = true; if (PV) PV.urls.forEach(u => URL.revokeObjectURL(u)); $('#preview .pvpages').innerHTML = ''; const f = PV && PV.fails; PV = null; if (f && f.length) reportFails(f); }
async function exportPdf(pages) {
  if (!window.jspdf) return toast('PDF 元件未載入，請連網後重新開啟');
  busy('正在生成 PDF…');
  try {
    const doc = new jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true });
    for (const [i, b] of pages.entries()) { if (i) doc.addPage('a4', 'landscape'); doc.addImage(new Uint8Array(await b.arrayBuffer()), 'JPEG', 0, 0, PG.W, PG.H, undefined, 'FAST'); }
    const blob = doc.output('blob'); busy();
    await deliver(blob, `竣工驗收記錄_${safeName(S.project.name) || '項目'}_${S.project.date || today()}.pdf`);
  } catch (e) { busy(); toast('PDF 生成失敗：' + e.message, 6000); }
}
$('#preview').addEventListener('click', async e => {
  const a = e.target.closest('[data-pv]'); if (!a) return;
  if (a.dataset.pv === 'close') closePreview();
  if (a.dataset.pv === 'pdf' && PV) exportPdf(PV.pages);
  if (a.dataset.pv === 'docx' && PV) { const d = PV.onlyDev; closePreview(); exportDocx(d); }
});

/* ---------------- bundled drawing package ---------------- */
async function loadBundle() {
  let man;
  try { man = await (await fetch('gbp/mapping.json', { cache: 'no-cache' })).json(); } catch (e) { return; }
  const have = await DB.kget('pkgVersion'); S.pkgVersion = have;
  if (have === man.version && S.drawings.some(d => d.src === 'bundle')) return;
  busy('正在下載圖紙包（約 20 MB，只需一次）…');
  const fileInDb = await DB.get('files', man.fileId);
  if (!fileInDb || fileInDb.sha !== man.sha) {
    const res = await fetch(man.file, { cache: 'no-cache' }); if (!res.ok) throw new Error('圖紙包下載失敗');
    await DB.put('files', { id: man.fileId, name: man.file, sha: man.sha, blob: await res.blob() });
    pdfDocs.delete(man.fileId);
  }
  for (const pd of man.drawings) {
    const ex = S.drawings.find(d => d.id === pd.id);
    const rec = { ...pd, src: 'bundle', kind: 'pdf', fileId: man.fileId, created: pd.order };
    if (ex && ex.base && ex.w === pd.w && fileInDb && fileInDb.sha === man.sha) { rec.base = ex.base; rec.thumb = ex.thumb; }
    await DB.put('drawings', rec);
    const i = S.drawings.findIndex(d => d.id === rec.id); if (i >= 0) S.drawings[i] = rec; else S.drawings.push(rec);
  }
  await DB.kset('pkgVersion', man.version); S.pkgVersion = man.version;
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
    S.drawings = (await DB.all('drawings')).filter(d => d.views).sort((a, b) => (a.created || 0) - (b.created || 0));
    S.items = (await DB.all('items')).filter(i => i.loc && 'viewId' in i.loc);
    try { await loadBundle(); } catch (e) { busy(); toast(e.message + '，請連網後重新開啟', 6000); }
    const cur = await DB.kget('cur');
    await showDrawing(S.drawings.find(d => d.id === cur) ? cur : S.drawings[0]?.id || null);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
    for (const it of S.items) { if (!it.dev && S.settings.dev) it.dev = S.settings.dev; }
    if (!S.settings.dev) setupPanel(true);
  } catch (err) { console.error(err); busy(); toast('啟動失敗：' + err.message, 8000); }
  updateBar();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
boot();
