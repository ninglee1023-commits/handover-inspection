'use strict';
/* 竣工驗收記錄 — offline iPad PWA
   Data lives in IndexedDB on the device: drawings (image + zones + grid lines) and items (pin + photos + text). */
const VERSION = '0.1.0';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/* ---------------- storage ---------------- */
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('handover-inspect', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('drawings', { keyPath: 'id' }); d.createObjectStore('items', { keyPath: 'id' }); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  st(n, m = 'readonly') { return this.db.transaction(n, m).objectStore(n); },
  all(n) { return rq(this.st(n).getAll()); },
  put(n, v) { return rq(this.st(n, 'readwrite').put(v)); },
  del(n, k) { return rq(this.st(n, 'readwrite').delete(k)); },
  kget(k) { return rq(this.st('kv').get(k)); },
  kset(k, v) { return rq(this.st('kv', 'readwrite').put(v, k)); },
};

const S = {
  project: { name: '', site: '', date: today(), inspector: '', company: '' },
  settings: { autoCam: true, showZones: true, gridOrder: 'YX', cropFrac: 0.2, keyPlan: true },
  drawings: [], items: [], cur: null, mode: 'inspect', tool: 'select',
  view: { x: 0, y: 0, k: 1 }, img: null, editing: null, draft: null, sel: null, panel: null, listScope: 'cur',
};
const imgCache = new Map(); // drawingId -> {url, img}

/* ---------------- UI helpers ---------------- */
let toastT;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
function busy(msg) { $('#busy').hidden = !msg; if (msg) $('#busyMsg').textContent = msg; }
const blobURLs = [];
function burl(b) { const u = URL.createObjectURL(b); blobURLs.push(u); return u; }
function freeURLs() { while (blobURLs.length) URL.revokeObjectURL(blobURLs.pop()); }
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('圖片無法讀取')); i.src = typeof src === 'string' ? src : URL.createObjectURL(src); }); }
const canvasBlob = (c, type = 'image/jpeg', q = 0.86) => new Promise(r => c.toBlob(r, type, q));
const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();
function curD() { return S.drawings.find(d => d.id === S.cur) || null; }
async function saveKV() { await DB.kset('project', S.project); await DB.kset('settings', S.settings); await DB.kset('cur', S.cur); }

/* ---------------- geometry / location ---------------- */
function inPoly(x, y, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
function area(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); }
function centroid(pts) { let x = 0, y = 0; pts.forEach(p => { x += p[0]; y += p[1]; }); return [x / pts.length, y / pts.length]; }
function zoneAt(d, x, y) { const hits = (d.zones || []).filter(z => inPoly(x, y, z.pts)); hits.sort((a, b) => area(a.pts) - area(b.pts)); return hits[0] || null; }
function span(lines, v) {
  if (!lines || !lines.length) return '';
  const s = [...lines].sort((a, b) => a.pos - b.pos);
  if (v < s[0].pos) return `${s[0].label}外`;
  for (let i = 0; i < s.length - 1; i++) if (v >= s[i].pos && v <= s[i + 1].pos) return `${s[i].label}-${s[i + 1].label}`;
  return `${s[s.length - 1].label}外`;
}
function resolveLoc(d, x, y) {
  const z = zoneAt(d, x, y);
  const gx = span(d.gx, x), gy = span(d.gy, y);
  let grid = '';
  if (gx || gy) {
    const parts = (d.gridOrder || S.settings.gridOrder) === 'XY' ? [gx, gy] : [gy, gx];
    grid = 'Grid ' + parts.filter(Boolean).join('/');
  }
  return { block: (z && z.block) || d.block || '', floor: (z && z.floor) || d.floor || '', zone: z ? z.name : '', zoneId: z ? z.id : '', grid };
}
function fmtLoc(l) { const a = [l.block, l.floor, l.zone].filter(Boolean).join(' / '); return [a, l.grid].filter(Boolean).join('　'); }
function nextNo() { return S.items.reduce((m, i) => Math.max(m, i.no || 0), 0) + 1; }
function nextLabel(lines, axis) {
  if (!lines.length) return axis === 'gx' ? '1' : 'A';
  const last = [...lines].sort((a, b) => a.pos - b.pos).pop().label;
  if (/^\d+$/.test(last)) return String(+last + 1);
  if (/^[A-Z]$/i.test(last)) { let c = last.toUpperCase().charCodeAt(0) + 1; if (c === 73) c++; /* skip I */ return String.fromCharCode(Math.min(c, 90)); }
  return last + "'";
}

/* ---------------- view / rendering ---------------- */
const stage = $('#stage'), board = $('#board'), dwg = $('#dwg'), ov = $('#ov');
let raf = 0;
function applyView() { board.style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.k})`; if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderOverlay(); }); }
const sheetMQ = matchMedia('(max-width:700px), (orientation:portrait) and (max-width:1100px)');
function panelOpen() { return !$('#panel').hidden; }
function stageRect() { return stage.getBoundingClientRect(); }
function toDwg(cx, cy) { const r = stageRect(); return { x: (cx - r.left - S.view.x) / S.view.k, y: (cy - r.top - S.view.y) / S.view.k }; }
function fit() {
  const d = curD(); if (!d) return;
  const top = 60, r = stageRect(), panelW = (panelOpen() && !sheetMQ.matches) ? 400 : 0, panelH = (panelOpen() && sheetMQ.matches) ? r.height * 0.55 : 0;
  const W = r.width - panelW, H = r.height - top - panelH;
  const k = Math.min(W / d.w, H / d.h) * 0.94;
  S.view = { k, x: (W - d.w * k) / 2, y: top + (H - d.h * k) / 2 };
  applyView();
}
function zoomAt(f, cx, cy) {
  const r = stageRect(); cx ??= r.width / 2; cy ??= r.height / 2;
  const k = clamp(S.view.k * f, 0.03, 8); const px = (cx - S.view.x) / S.view.k, py = (cy - S.view.y) / S.view.k;
  S.view = { k, x: cx - px * k, y: cy - py * k }; applyView();
}
function centerOn(x, y, k) {
  const r = stageRect(); const panelW = (panelOpen() && !sheetMQ.matches) ? 400 : 0;
  const h = (panelOpen() && sheetMQ.matches) ? r.height * 0.42 : r.height;
  k = k || Math.max(S.view.k, 0.5);
  S.view = { k, x: (r.width - panelW) / 2 - x * k, y: 30 + h / 2 - y * k }; applyView();
}

function ensureVisible(p) {
  const r = stageRect(); const sx = S.view.x + p.x * S.view.k, sy = S.view.y + p.y * S.view.k;
  const maxX = r.width - ((panelOpen() && !sheetMQ.matches) ? 400 : 0) - 30, maxY = r.height - ((panelOpen() && sheetMQ.matches) ? r.height * 0.55 : 0) - 30;
  if (sx < 30 || sy < 70 || sx > maxX || sy > maxY) centerOn(p.x, p.y, S.view.k);
}
function renderOverlay() {
  const d = curD(); if (!d) { ov.innerHTML = ''; return; }
  const k = S.view.k, u = 1 / k; // u = one screen pixel in drawing units
  ov.setAttribute('width', d.w); ov.setAttribute('height', d.h); ov.setAttribute('viewBox', `0 0 ${d.w} ${d.h}`);
  const map = S.mode === 'map';
  let h = '';
  // zones
  if (map || S.settings.showZones) for (const z of d.zones || []) {
    const sel = S.sel && S.sel.type === 'zone' && S.sel.id === z.id;
    const ed = S.editing && S.editing.loc && S.editing.loc.zoneId === z.id;
    const pts = z.pts.map(p => p.join(',')).join(' ');
    const fillA = sel ? 0.22 : ed ? 0.16 : map ? 0.1 : 0.05;
    h += `<polygon points="${pts}" fill="rgba(212,42,30,${fillA})" stroke="rgba(212,42,30,${map ? 0.85 : 0.35})" stroke-width="${sel ? 3 : 1.5}" vector-effect="non-scaling-stroke" ${map ? '' : 'stroke-dasharray="6 4"'}/>`;
    if (map || sel || ed) { const cx = Math.min(...z.pts.map(p => p[0])) + 8 * u, cy = Math.min(...z.pts.map(p => p[1])) + 16 * u; h += `<text x="${cx}" y="${cy}" font-size="${13 * u}" text-anchor="start" dominant-baseline="middle" fill="#9c1c12" stroke="#fff" stroke-width="${3 * u}" paint-order="stroke" font-family="-apple-system,PingFang TC,sans-serif" font-weight="600">${esc(z.name)}</text>`; }
  }
  // grid lines
  const gl = (lines, axis) => {
    for (const g of lines || []) {
      const sel = S.sel && S.sel.type === axis && S.sel.id === g.id;
      const col = sel ? '#d42a1e' : '#1f6f9c';
      if (axis === 'gx') h += `<line x1="${g.pos}" y1="0" x2="${g.pos}" y2="${d.h}" stroke="${col}" stroke-width="${sel ? 2.5 : 1.2}" stroke-dasharray="10 5" vector-effect="non-scaling-stroke" opacity="${map ? .9 : .45}"/>`;
      else h += `<line x1="0" y1="${g.pos}" x2="${d.w}" y2="${g.pos}" stroke="${col}" stroke-width="${sel ? 2.5 : 1.2}" stroke-dasharray="10 5" vector-effect="non-scaling-stroke" opacity="${map ? .9 : .45}"/>`;
      if (map || sel) {
        const r = 13 * u; const tl = toDwg(stageRect().left + 0, stageRect().top + 66);
        const bx = axis === 'gx' ? g.pos : clamp(tl.x + r * 1.6, r, d.w - r), by = axis === 'gx' ? clamp(tl.y + r * 1.4, r, d.h - r) : g.pos;
        h += `<circle cx="${bx}" cy="${by}" r="${r}" fill="#fff" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/><text x="${bx}" y="${by}" font-size="${13 * u}" text-anchor="middle" dominant-baseline="central" fill="${col}" font-weight="700" font-family="-apple-system,sans-serif">${esc(g.label)}</text>`;
      }
    }
  };
  gl(d.gx, 'gx'); gl(d.gy, 'gy');
  // draft shapes in mapping mode
  if (S.draft) {
    if (S.draft.type === 'rect') { const { a, b } = S.draft; h += `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" fill="rgba(242,194,48,.25)" stroke="#b8860b" stroke-width="2" vector-effect="non-scaling-stroke"/>`; }
    if (S.draft.type === 'poly' && S.draft.pts.length) { const p = S.draft.pts.map(p => p.join(',')).join(' '); h += `<polyline points="${p}" fill="rgba(242,194,48,.25)" stroke="#b8860b" stroke-width="2" vector-effect="non-scaling-stroke"/>`; S.draft.pts.forEach(q => h += `<circle cx="${q[0]}" cy="${q[1]}" r="${5 * u}" fill="#b8860b"/>`); }
  }
  // pins
  if (!map) {
    const items = S.items.filter(i => i.drawingId === d.id);
    const all = S.editing && S.editing.drawingId === d.id && !items.find(i => i.id === S.editing.id) ? [...items, S.editing] : items;
    for (const it of all) {
      const act = S.editing && S.editing.id === it.id; const r = (act ? 17 : 14) * u;
      h += `<g><circle cx="${it.x}" cy="${it.y}" r="${r}" fill="${act ? '#d42a1e' : '#d42a1e'}" stroke="${act ? '#f2c230' : '#fff'}" stroke-width="${act ? 4 : 2.5}" vector-effect="non-scaling-stroke"/>`
        + `<text x="${it.x}" y="${it.y}" font-size="${(it.no > 99 ? 10 : 12.5) * u}" text-anchor="middle" dominant-baseline="central" fill="#fff" font-weight="700" font-family="ui-monospace,Menlo,monospace">${it.no}</text></g>`;
    }
  }
  ov.innerHTML = h;
}

function updateBar() {
  const d = curD();
  $('#curName').textContent = d ? d.name : (S.project.name || '竣工驗收記錄');
  $('#curSub').textContent = d ? [d.block, d.floor, d.no].filter(Boolean).join(' · ') + (S.project.name ? '　' + S.project.name : '') : '';
  $('#cnt').textContent = S.items.length;
  $('#mInspect').setAttribute('aria-pressed', S.mode === 'inspect'); $('#mMap').setAttribute('aria-pressed', S.mode === 'map');
  $('#maptools').hidden = S.mode !== 'map' || !d;
  document.querySelectorAll('#maptools [data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
  const poly = S.mode === 'map' && S.tool === 'poly';
  $('#polyDone').hidden = !poly || !S.draft || S.draft.pts.length < 3; $('#polyUndo').hidden = !poly || !S.draft || !S.draft.pts.length;
  $('#empty').hidden = !!d; $('#zoombtns').hidden = !d;
  const hint = $('#hint');
  const hints = {
    select: '點選區域或軸線可修改；兩指縮放、拖動',
    rect: '在圖上拖出矩形，框住一個房間或區域',
    poly: '逐點點選區域邊界，完成後按「完成多邊形」',
    gx: '在每條縱向軸線上點一下（會自動編號 1、2、3…）',
    gy: '在每條橫向軸線上點一下（會自動編號 A、B、C…）',
  };
  hint.textContent = !d ? '' : S.mode === 'map' ? hints[S.tool] : (S.editing ? `記錄 #${S.editing.no}：${S.editing.locText || '未設定位置'}` : '點選圖上的問題位置 → 拍照');
  hint.hidden = !d;
}

async function showDrawing(id) {
  S.cur = id; S.sel = null; S.draft = null; const d = curD(); updateBar();
  if (!d) { dwg.removeAttribute('src'); ov.innerHTML = ''; return; }
  let c = imgCache.get(d.id);
  if (!c) { const url = URL.createObjectURL(d.blob); c = { url }; imgCache.set(d.id, c); }
  dwg.src = c.url; dwg.width = d.w; dwg.height = d.h; dwg.style.width = d.w + 'px'; dwg.style.height = d.h + 'px';
  await new Promise(r => { if (dwg.complete && dwg.naturalWidth) r(); else { dwg.onload = r; dwg.onerror = r; } });
  fit(); DB.kset('cur', id);
}
async function drawingImg(d) { const c = imgCache.get(d.id); if (c && c.img) return c.img; const img = await loadImg(c ? c.url : URL.createObjectURL(d.blob)); imgCache.set(d.id, { url: img.src, img }); return img; }

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
    const k = clamp(g.k0 * dist(a, b) / g.d0, 0.03, 8);
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
stage.addEventListener('wheel', e => { e.preventDefault(); const r = stageRect(); if (e.ctrlKey || Math.abs(e.deltaY) > 0) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());

function onTap(cx, cy) {
  const d = curD(); if (!d) return;
  const p = toDwg(cx, cy); const u = 1 / S.view.k;
  if (p.x < 0 || p.y < 0 || p.x > d.w || p.y > d.h) return;
  if (S.mode === 'inspect') {
    const hit = S.items.filter(i => i.drawingId === d.id).map(i => ({ i, dd: Math.hypot(i.x - p.x, i.y - p.y) })).filter(o => o.dd < 22 * u).sort((a, b) => a.dd - b.dd)[0];
    if (hit) return openItem(hit.i);
    return newItem(p);
  }
  // mapping
  if (S.tool === 'poly') { if (!S.draft || S.draft.type !== 'poly') S.draft = { type: 'poly', pts: [] }; S.draft.pts.push([Math.round(p.x), Math.round(p.y)]); renderOverlay(); updateBar(); return; }
  if (S.tool === 'gx' || S.tool === 'gy') {
    const ax = S.tool; d[ax] = d[ax] || [];
    const line = { id: uid(), label: nextLabel(d[ax], ax), pos: Math.round(ax === 'gx' ? p.x : p.y) };
    d[ax].push(line); saveDrawing(d); S.sel = { type: ax, id: line.id }; renderOverlay(); openGrid(d, ax, line, true); return;
  }
  // select
  const near = [];
  for (const ax of ['gx', 'gy']) for (const l of d[ax] || []) { const dd = Math.abs((ax === 'gx' ? p.x : p.y) - l.pos); if (dd < 16 * u) near.push({ ax, l, dd }); }
  near.sort((a, b) => a.dd - b.dd);
  if (near[0]) { S.sel = { type: near[0].ax, id: near[0].l.id }; renderOverlay(); return openGrid(d, near[0].ax, near[0].l); }
  const z = zoneAt(d, p.x, p.y);
  if (z) { S.sel = { type: 'zone', id: z.id }; renderOverlay(); return openZone(d, z); }
  S.sel = null; renderOverlay(); closePanel();
}
function finishRect() {
  const d = curD(); const { a, b } = S.draft; S.draft = null;
  const x1 = Math.round(Math.min(a.x, b.x)), x2 = Math.round(Math.max(a.x, b.x)), y1 = Math.round(Math.min(a.y, b.y)), y2 = Math.round(Math.max(a.y, b.y));
  if ((x2 - x1) * S.view.k < 12 || (y2 - y1) * S.view.k < 12) { renderOverlay(); return; }
  addZone(d, [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
}
function addZone(d, pts) {
  const z = { id: uid(), name: '', kind: 'room', block: '', floor: '', pts };
  d.zones = d.zones || []; d.zones.push(z); saveDrawing(d); S.sel = { type: 'zone', id: z.id }; renderOverlay(); openZone(d, z, true);
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
  S.editing = { id: uid(), drawingId: d.id, no: nextNo(), x: Math.round(p.x), y: Math.round(p.y), loc, locText: fmtLoc(loc), photos: [], note: '', created: Date.now(), _new: true };
  renderOverlay(); itemPanel(); updateBar(); ensureVisible(p);
  if (S.settings.autoCam) $('#camInput').click();
}
function openItem(it) { if (S.editing && S.editing.id !== it.id) finishItem(); S.editing = it; if (S.cur !== it.drawingId) showDrawing(it.drawingId).then(() => { centerOn(it.x, it.y); itemPanel(); }); else { itemPanel(); renderOverlay(); updateBar(); } }
function itemPanel() {
  freeURLs();
  const it = S.editing; const d = S.drawings.find(x => x.id === it.drawingId);
  const L = it.loc || {};
  const chips = [['座', L.block], ['層', L.floor], ['區域', L.zone], ['軸線', L.grid]].filter(c => c[1]).map(c => `<span class="chip">${c[0]} <b>${esc(c[1])}</b></span>`).join('') || '<span class="chip">此處未設定區域／軸線</span>';
  const photos = it.photos.map((ph, i) => `<div class="ph1"><img src="${burl(ph.out)}" data-a="ed" data-i="${i}" alt="照片 ${i + 1}"><button class="del" data-a="delph" data-i="${i}" aria-label="刪除照片">✕</button><span class="ed">點擊修改標記</span></div>`).join('');
  openPanel('item', esc(d ? d.name : ''), `
    <div class="chips">${chips}</div>
    <label class="f">位置描述（自動帶出，可修改）<textarea id="fLoc" rows="2">${esc(it.locText)}</textarea></label>
    <div class="photos">${photos}</div>
    <div class="row"><button class="btn p" data-a="cam">拍照</button><button class="btn" data-a="lib">從相簿加入</button></div>
    <label class="f">問題描述（可回辦公室再填）<textarea id="fNote" rows="3" placeholder="例如：插座面板未安裝">${esc(it.note)}</textarea></label>
    <div class="row"><button class="btn warn" data-a="del">刪除此記錄</button><button class="btn dk" data-a="done">完成</button></div>`,
    { badge: `<span class="no">#${it.no}</span>` });
  updateBar();
  panel.querySelector('#fLoc').oninput = e => { it.locText = e.target.value; persistItem(); updateBar(); };
  panel.querySelector('#fNote').oninput = e => { it.note = e.target.value; persistItem(); };
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'cam') $('#camInput').click();
    if (a === 'lib') $('#libInput').click();
    if (a === 'done') closePanel();
    if (a === 'ed') { const i = +e.target.dataset.i; const ph = it.photos[i]; const r = await openEditor(ph.orig, ph); if (r) { it.photos[i] = r; await persistItem(true); itemPanel(); } }
    if (a === 'delph') { if (e.target.dataset.armed) { it.photos.splice(+e.target.dataset.i, 1); await persistItem(true); itemPanel(); } else { e.target.dataset.armed = 1; e.target.textContent = '刪'; e.target.style.background = 'var(--red)'; } }
    if (a === 'del') {
      if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = '再按一次確認刪除'; return; }
      S.items = S.items.filter(x => x.id !== it.id); await DB.del('items', it.id); S.editing = null; closePanel(); toast(`已刪除 #${it.no}`);
    }
  };
}
let persistT;
async function persistItem(now) {
  const it = S.editing; if (!it) return;
  if (it._new && !it.photos.length && !it.note.trim()) return;
  if (it._new) { delete it._new; S.items.push(it); updateBar(); }
  clearTimeout(persistT);
  const doit = () => DB.put('items', it).catch(err => toast('儲存失敗：' + err.message, 4000));
  if (now) await doit(); else persistT = setTimeout(doit, 400);
}
function finishItem() { const it = S.editing; if (!it) return; if (!it._new) DB.put('items', it); S.editing = null; }

async function addPhotoFile(file) {
  if (!file || !S.editing) return;
  const r = await openEditor(file, null);
  if (!r) return;
  S.editing.photos.push(r); await persistItem(true);
  if (S.panel === 'item') itemPanel(); renderOverlay(); toast(`#${S.editing.no} 已加入照片`);
}
$('#camInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; addPhotoFile(f); };
$('#libInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; addPhotoFile(f); };

function itemsPanel() {
  freeURLs();
  const d = curD();
  const list = (S.listScope === 'cur' && d ? S.items.filter(i => i.drawingId === d.id) : S.items).slice().sort((a, b) => a.no - b.no);
  const rows = list.map(it => {
    const dn = S.drawings.find(x => x.id === it.drawingId);
    const th = it.photos[0] ? `style="background-image:url('${burl(it.photos[0].out)}')"` : '';
    return `<button class="li" data-id="${it.id}"><span class="th" ${th}><span class="no">#${it.no}</span></span><span class="t"><b>${esc(it.locText || '（無位置）')}</b><span>${esc(it.note || '未填描述')}　·　${it.photos.length} 張相${S.listScope === 'all' && dn ? '　·　' + esc(dn.name) : ''}</span></span></button>`;
  }).join('') || '<div class="note">此圖紙還沒有記錄。回到「驗收」模式，點選圖上的位置即可開始。</div>';
  openPanel('items', `驗收記錄（${list.length}）`, `
    <div class="row"><button class="btn ${S.listScope === 'cur' ? 'dk' : ''}" data-s="cur">此圖紙</button><button class="btn ${S.listScope === 'all' ? 'dk' : ''}" data-s="all">全部圖紙</button></div>
    <div class="list">${rows}</div>`);
  panel.querySelector('.pb').onclick = e => {
    const s = e.target.closest('[data-s]'); if (s) { S.listScope = s.dataset.s; return itemsPanel(); }
    const b = e.target.closest('.li'); if (!b) return;
    const it = S.items.find(i => i.id === b.dataset.id);
    if (S.mode !== 'inspect') setMode('inspect');
    S.editing = it;
    if (S.cur !== it.drawingId) showDrawing(it.drawingId).then(() => { itemPanel(); centerOn(it.x, it.y, 0.6); });
    else { itemPanel(); centerOn(it.x, it.y, Math.max(S.view.k, 0.6)); }
  };
}

/* ---- drawings ---- */
function drawingsPanel() {
  freeURLs();
  const rows = S.drawings.map(d => {
    const n = S.items.filter(i => i.drawingId === d.id).length;
    return `<div class="li ${d.id === S.cur ? 'cur' : ''}" style="grid-template-columns:64px 1fr auto"><span class="th" style="background-image:url('${imgCache.get(d.id)?.url || burl(d.blob)}');background-color:#fff"></span>
      <span class="t" data-open="${d.id}"><b>${esc(d.name)}</b><span>${esc([d.block, d.floor, d.no].filter(Boolean).join(' · ') || '未填座／層')}　·　${(d.zones || []).length} 區域 · ${(d.gx || []).length + (d.gy || []).length} 軸線 · ${n} 記錄</span></span>
      <button class="btn" data-edit="${d.id}" style="min-height:38px;padding:6px 10px">設定</button></div>`;
  }).join('') || '<div class="note">還沒有圖紙。</div>';
  openPanel('drawings', '圖紙', `
    <div class="list">${rows}</div>
    <button class="btn p" data-a="add">匯入圖紙（PDF／圖片）</button>
    <div class="note">PDF 每一頁會成為一張圖紙。匯入後到「位置設定」框出房間／區域及軸線，之後驗收時點選便會自動帶出位置。</div>`);
  panel.querySelector('.pb').onclick = e => {
    const o = e.target.closest('[data-open]'); if (o) { showDrawing(o.dataset.open).then(() => { closePanel(); fit(); }); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) return drawingForm(S.drawings.find(d => d.id === ed.dataset.edit));
    if (e.target.dataset.a === 'add') $('#dwgInput').click();
  };
}
function drawingForm(d, isNewFile) {
  const nw = !!isNewFile;
  openPanel('dform', nw ? '匯入圖紙' : '圖紙設定', `
    ${nw ? `<div class="note">檔案：${esc(isNewFile.name)}</div>` : ''}
    <label class="f">圖紙名稱<input id="dName" value="${esc(nw ? isNewFile.name.replace(/\.[^.]+$/, '') : d.name)}"></label>
    <div class="grid2"><label class="f">座／Block<input id="dBlock" value="${esc(nw ? '' : d.block)}" placeholder="例如：第1座"></label>
    <label class="f">層／Floor<input id="dFloor" value="${esc(nw ? '' : d.floor)}" placeholder="例如：3樓"></label></div>
    <label class="f">圖號（可留空）<input id="dNo" value="${esc(nw ? '' : d.no)}"></label>
    <label class="f">軸線寫法<select id="dGO"><option value="YX">Grid A-B/1-2（橫線字母在前）</option><option value="XY">Grid 1-2/A-B（縱線數字在前）</option></select></label>
    ${nw ? '<button class="btn p" data-a="imp">匯入</button>' : `<div class="row"><button class="btn dk" data-a="save">儲存</button></div>
      <div class="sec">刪除圖紙</div><button class="btn warn" data-a="del">刪除此圖紙及其 ${S.items.filter(i => i.drawingId === d.id).length} 個記錄</button>`}`);
  panel.querySelector('#dGO').value = nw ? S.settings.gridOrder : (d.gridOrder || S.settings.gridOrder);
  const vals = () => ({ name: $('#dName').value.trim() || '未命名圖紙', block: $('#dBlock').value.trim(), floor: $('#dFloor').value.trim(), no: $('#dNo').value.trim(), gridOrder: $('#dGO').value });
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'imp') { const v = vals(); closePanel(); await importDrawingFile(isNewFile, v); }
    if (a === 'save') { Object.assign(d, vals()); await saveDrawing(d); updateBar(); toast('已儲存'); drawingsPanel(); }
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
    const pages = [];
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      busy('正在讀取 PDF…');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        busy(`正在轉換第 ${n}／${pdf.numPages} 頁…`);
        const page = await pdf.getPage(n); const v1 = page.getViewport({ scale: 1 });
        const sc = Math.min(4096 / Math.max(v1.width, v1.height), Math.sqrt(15e6 / (v1.width * v1.height)));
        const vp = page.getViewport({ scale: sc });
        const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        pages.push({ blob: await canvasBlob(c, 'image/png'), w: c.width, h: c.height });
        c.width = c.height = 0; page.cleanup();
      }
    } else {
      busy('正在讀取圖片…');
      const img = await loadImg(file); let w = img.naturalWidth, h = img.naturalHeight;
      const sc = Math.min(1, 4096 / Math.max(w, h), Math.sqrt(15e6 / (w * h)));
      const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      pages.push({ blob: await canvasBlob(c, 'image/png'), w: c.width, h: c.height });
    }
    let first = null;
    for (let i = 0; i < pages.length; i++) {
      const d = { id: uid(), ...meta, name: pages.length > 1 ? `${meta.name} – 第${i + 1}頁` : meta.name, ...pages[i], zones: [], gx: [], gy: [], created: Date.now() };
      await DB.put('drawings', d); S.drawings.push(d); first = first || d;
    }
    busy(); await showDrawing(first.id); toast(`已匯入 ${pages.length} 張圖紙`);
    setMode('map'); setTool('rect');
  } catch (err) { busy(); toast('匯入失敗：' + err.message, 5000); console.error(err); }
}

/* ---- mapping forms ---- */
function openZone(d, z, isNew) {
  openPanel('zone', isNew ? '新區域' : '區域設定', `
    <label class="f">房間／區域名稱<input id="zName" value="${esc(z.name)}" placeholder="例如：主人房、平台花園、B1 停車場"></label>
    <div class="grid2"><label class="f">座（不同於圖紙才填）<input id="zBlock" value="${esc(z.block)}" placeholder="${esc(d.block || '')}"></label>
    <label class="f">層（不同於圖紙才填）<input id="zFloor" value="${esc(z.floor)}" placeholder="${esc(d.floor || '')}"></label></div>
    <div class="row"><button class="btn dk" data-a="ok">儲存</button><button class="btn warn" data-a="del">刪除區域</button></div>
    <div class="note">園景圖可以把「座」或「層」留空，只寫區域名稱，例如「中央庭園」。範圍重疊時，點選位置會取最小的那個區域。</div>`, { compact: true });
  const inp = $('#zName'); if (isNew) setTimeout(() => inp.focus(), 50);
  const save = async () => { z.name = inp.value.trim() || '未命名區域'; z.block = $('#zBlock').value.trim(); z.floor = $('#zFloor').value.trim(); await saveDrawing(d); renderOverlay(); };
  inp.onkeydown = e => { if (e.key === 'Enter') { save(); closePanel(); } };
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'ok') { await save(); closePanel(); toast('區域已儲存'); }
    if (a === 'del') { d.zones = d.zones.filter(x => x.id !== z.id); await saveDrawing(d); closePanel(); }
  };
  panel.querySelector('[data-a="close"]').onclick = async () => { if (!z.name) z.name = inp.value.trim() || '未命名區域'; await save(); closePanel(); };
}
function openGrid(d, ax, l, isNew) {
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
    if (a === 'del') { d[ax] = d[ax].filter(x => x.id !== l.id); await saveDrawing(d); closePanel(); }
  };
}

/* ---- modes / tools ---- */
function setMode(m) {
  if (S.panel === 'item') closePanel();
  S.mode = m; S.draft = null; S.sel = null; if (m === 'map' && !S.tool) S.tool = 'select';
  if (S.panel && ['zone', 'grid'].includes(S.panel)) closePanel();
  updateBar(); renderOverlay();
}
function setTool(t) { S.tool = t; S.draft = t === 'poly' ? { type: 'poly', pts: [] } : null; S.sel = null; if (S.panel && ['zone', 'grid'].includes(S.panel)) closePanel(); updateBar(); renderOverlay(); }
$('#mInspect').onclick = () => setMode('inspect');
$('#mMap').onclick = () => { if (!curD()) return toast('請先匯入圖紙'); setMode('map'); };
$('#maptools').onclick = e => { const t = e.target.closest('[data-tool]'); if (t) setTool(t.dataset.tool); };
$('#polyDone').onclick = () => { const d = curD(); const pts = S.draft.pts; S.draft = { type: 'poly', pts: [] }; updateBar(); addZone(d, pts); };
$('#polyUndo').onclick = () => { S.draft.pts.pop(); renderOverlay(); updateBar(); };
$('#btnDrawings').onclick = () => S.panel === 'drawings' ? closePanel() : drawingsPanel();
$('#btnItems').onclick = () => S.panel === 'items' ? closePanel() : itemsPanel();
$('#btnExport').onclick = () => S.panel === 'export' ? closePanel() : exportPanel();
$('#zIn').onclick = () => zoomAt(1.5); $('#zOut').onclick = () => zoomAt(1 / 1.5); $('#zFit').onclick = () => fit();
let rzT; addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(fit, 150); });

/* ---------------- photo markup editor ---------------- */
const E = { tool: 'arrow', color: '#e5251a' };
function drawShape(ctx, s, lw) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    if (s.t === 'arrow') {
      const [a, b] = [s.a, s.b]; const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = lw * 4.2;
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x - Math.cos(ang) * hl * 0.6, b.y - Math.sin(ang) * hl * 0.6);
      ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - hl * Math.cos(ang - 0.45), b.y - hl * Math.sin(ang - 0.45));
      ctx.lineTo(b.x - hl * Math.cos(ang + 0.45), b.y - hl * Math.sin(ang + 0.45)); ctx.closePath();
    } else if (s.t === 'ellipse') { ctx.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.max(1, Math.abs(s.b.x - s.a.x) / 2), Math.max(1, Math.abs(s.b.y - s.a.y) / 2), 0, 0, Math.PI * 2); }
    else if (s.t === 'rect') { ctx.rect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y)); }
    else if (s.t === 'pen') { s.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); }
  };
  path(); ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = lw + 4; ctx.stroke();
  if (s.t === 'arrow') { ctx.fillStyle = 'rgba(0,0,0,.45)'; }
  path(); ctx.strokeStyle = s.c; ctx.lineWidth = lw; ctx.stroke();
  if (s.t === 'arrow') { // solid head
    const [a, b] = [s.a, s.b]; const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = lw * 4.2;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - hl * Math.cos(ang - 0.45), b.y - hl * Math.sin(ang - 0.45)); ctx.lineTo(b.x - hl * Math.cos(ang + 0.45), b.y - hl * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fillStyle = s.c; ctx.fill();
  }
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
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * w / r.width), y: Math.round((e.clientY - r.top) * h / r.height) }; };
    let pid = null;
    cv.onpointerdown = e => { if (pid !== null) return; pid = e.pointerId; cv.setPointerCapture(pid); const p = pos(e); cur = E.tool === 'pen' ? { t: 'pen', c: E.color, pts: [p] } : { t: E.tool, c: E.color, a: p, b: p }; draw(); };
    cv.onpointermove = e => { if (e.pointerId !== pid || !cur) return; const p = pos(e); if (cur.t === 'pen') cur.pts.push(p); else cur.b = p; draw(); };
    cv.onpointerup = cv.onpointercancel = e => { if (e.pointerId !== pid) return; pid = null; if (cur) { const ok = cur.t === 'pen' ? cur.pts.length > 1 : Math.hypot(cur.b.x - cur.a.x, cur.b.y - cur.a.y) > lw * 2; if (ok) shapes.push(cur); cur = null; draw(); } };
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
      resolve({ id: prev ? prev.id : uid(), orig, out, shapes, w, h, t: prev ? prev.t : Date.now() });
    };
    ed.onclick = e => {
      const b = e.target.closest('[data-ed]'); if (!b) return;
      const a = b.dataset.ed;
      if (a === 'tool') E.tool = b.dataset.v; if (a === 'color') E.color = b.dataset.v;
      if (a === 'undo') { shapes.pop(); draw(); } if (a === 'clear') { shapes.length = 0; draw(); }
      if (a === 'cancel') finish(false); if (a === 'done') finish(true);
      sync();
    };
  });
}

/* ---------------- export: Word report + backup ---------------- */
function exportPanel() {
  const P = S.project;
  openPanel('export', '導出報告', `
    <label class="f">項目名稱<input id="pName" value="${esc(P.name)}" placeholder="例如：XX 住宅發展項目"></label>
    <label class="f">地盤／地址<input id="pSite" value="${esc(P.site)}"></label>
    <div class="grid2"><label class="f">驗收日期<input id="pDate" type="date" value="${esc(P.date)}"></label>
    <label class="f">檢查人員<input id="pBy" value="${esc(P.inspector)}"></label></div>
    <label class="f">公司／單位<input id="pCo" value="${esc(P.company)}"></label>
    <label class="toggle">報告附上每張圖紙的位置總圖<input type="checkbox" id="pKey" ${S.settings.keyPlan ? 'checked' : ''}></label>
    <label class="f">報告內圖紙截取範圍<select id="pCrop"><option value="0.12">細（放大）</option><option value="0.2">中</option><option value="0.32">大（看到更多周邊）</option></select></label>
    <button class="btn p" data-a="docx">導出 Word 報告（${S.items.length} 項）</button>
    <div class="sec">設定</div>
    <label class="toggle">點選位置後直接開相機<input type="checkbox" id="sCam" ${S.settings.autoCam ? 'checked' : ''}></label>
    <label class="toggle">驗收時顯示區域範圍<input type="checkbox" id="sZone" ${S.settings.showZones ? 'checked' : ''}></label>
    <div class="sec">備份／轉移到另一部機</div>
    <div class="row"><button class="btn" data-a="bk">導出全部（含照片）</button><button class="btn" data-a="bkmap">只導出圖紙及位置設定</button></div>
    <button class="btn" data-a="imp">匯入備份檔</button>
    <div class="note" id="stor">資料只存在這部 iPad 的瀏覽器內。請把此網頁「加入主畫面」使用，並每日導出備份。</div>
    <div class="note">版本 ${VERSION}</div>`);
  $('#pCrop').value = String(S.settings.cropFrac);
  const sv = () => { Object.assign(P, { name: $('#pName').value, site: $('#pSite').value, date: $('#pDate').value, inspector: $('#pBy').value, company: $('#pCo').value }); S.settings.keyPlan = $('#pKey').checked; S.settings.cropFrac = +$('#pCrop').value; S.settings.autoCam = $('#sCam').checked; S.settings.showZones = $('#sZone').checked; saveKV(); updateBar(); renderOverlay(); };
  panel.querySelectorAll('input,select').forEach(i => i.onchange = sv);
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(es => { const el = $('#stor'); if (el) el.textContent += `　已用 ${(es.usage / 1048576).toFixed(0)} MB。`; });
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a; if (!a) return; sv();
    if (a === 'docx') exportDocx();
    if (a === 'bk') exportBackup(true);
    if (a === 'bkmap') exportBackup(false);
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

async function cropImage(d, it, outW = 760, outH = 570) {
  const img = await drawingImg(d);
  const frac = S.settings.cropFrac;
  let ch = Math.max(d.w, d.h) * frac, cw = ch * outW / outH;
  if (cw > d.w) { cw = d.w; ch = cw * outH / outW; } if (ch > d.h) { ch = d.h; cw = ch * outW / outH; }
  const sx = clamp(it.x - cw / 2, 0, d.w - cw), sy = clamp(it.y - ch / 2, 0, d.h - ch);
  const c = document.createElement('canvas'); c.width = outW; c.height = outH; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, outW, outH); x.drawImage(img, sx, sy, cw, ch, 0, 0, outW, outH);
  const s = outW / cw, T = p => [(p[0] - sx) * s, (p[1] - sy) * s];
  const z = d.zones && d.zones.find(z => z.id === (it.loc && it.loc.zoneId));
  if (z) { x.beginPath(); z.pts.forEach((p, i) => { const [a, b] = T(p); i ? x.lineTo(a, b) : x.moveTo(a, b); }); x.closePath(); x.fillStyle = 'rgba(242,194,48,.18)'; x.fill(); x.strokeStyle = 'rgba(212,42,30,.7)'; x.lineWidth = 3; x.setLineDash([10, 6]); x.stroke(); x.setLineDash([]); }
  const [px, py] = T([it.x, it.y]);
  x.beginPath(); x.arc(px, py, 40, 0, Math.PI * 2); x.fillStyle = '#d42a1e'; x.fill(); x.lineWidth = 6; x.strokeStyle = '#fff'; x.stroke();
  x.fillStyle = '#fff'; x.font = 'bold 38px Menlo, monospace'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(it.no), px, py + 1);
  x.strokeStyle = '#999'; x.lineWidth = 2; x.strokeRect(1, 1, outW - 2, outH - 2);
  return canvasBlob(c, 'image/jpeg', 0.9);
}
async function keyPlanImage(d, items) {
  const img = await drawingImg(d); const sc = Math.min(1, 2200 / Math.max(d.w, d.h));
  const c = document.createElement('canvas'); c.width = Math.round(d.w * sc); c.height = Math.round(d.h * sc); const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
  const r = Math.max(18, c.width / 70);
  for (const it of items) { const px = it.x * sc, py = it.y * sc; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fillStyle = '#d42a1e'; x.fill(); x.lineWidth = r / 5; x.strokeStyle = '#fff'; x.stroke(); x.fillStyle = '#fff'; x.font = `bold ${r * 1.05}px Menlo, monospace`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(it.no), px, py + 1); }
  return { blob: await canvasBlob(c, 'image/jpeg', 0.88), w: c.width, h: c.height };
}

async function exportDocx() {
  if (!S.items.length) return toast('還沒有任何記錄');
  if (!window.docx) return toast('報告元件未載入，請連網後重新開啟一次');
  const D = window.docx; const P = S.project;
  try {
    busy('正在生成報告…');
    const items = S.items.slice().sort((a, b) => a.no - b.no);
    const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft JhengHei', cs: 'Arial' };
    const T = (text, o = {}) => new D.TextRun({ text: String(text ?? ''), font: FONT, size: o.size || 18, bold: o.bold, color: o.color });
    const Pg = (runs, o = {}) => new D.Paragraph({ children: Array.isArray(runs) ? runs : [runs], alignment: o.align, spacing: { after: o.after ?? 40, before: o.before ?? 0 }, keepLines: true });
    const border = { style: D.BorderStyle.SINGLE, size: 4, color: '8A9391' };
    const borders = { top: border, bottom: border, left: border, right: border };
    // landscape A4: 16838 x 11906 twips, 680 margins -> 15478 usable
    const colPct = [5, 20, 17, 27, 21, 10]; const usable = 15478; const colTw = colPct.map(p => Math.round(usable * p / 100));
    const pxOf = tw => Math.floor(tw / 15) - 14;
    const cell = (children, i, o = {}) => new D.TableCell({ children, width: { size: colTw[i], type: D.WidthType.DXA }, borders, verticalAlign: o.v || D.VerticalAlign.TOP, shading: o.shade ? { type: D.ShadingType.CLEAR, color: 'auto', fill: o.shade } : undefined, margins: { top: 80, bottom: 80, left: 90, right: 90 } });
    const heads = ['編號', '圖紙位置', '位置', '現場照片', '問題描述', '備註／跟進'];
    const rows = [new D.TableRow({ tableHeader: true, cantSplit: true, children: heads.map((h, i) => cell([Pg(T(h, { bold: true, color: 'FFFFFF', size: 18 }), { align: D.AlignmentType.CENTER, after: 0 })], i, { shade: '1D2629', v: D.VerticalAlign.CENTER })) })];
    let n = 0;
    for (const it of items) {
      busy(`正在生成報告… ${++n}／${items.length}`);
      const d = S.drawings.find(x => x.id === it.drawingId); if (!d) continue;
      const cw = pxOf(colTw[1]); const crop = await cropImage(d, it);
      const cropRun = new D.ImageRun({ data: await crop.arrayBuffer(), transformation: { width: cw, height: Math.round(cw * 0.75) } });
      const pw = pxOf(colTw[3]);
      const phParas = [];
      for (const ph of it.photos) {
        let wpx = pw, hpx = Math.round(pw * ph.h / ph.w); if (hpx > 240) { hpx = 240; wpx = Math.round(240 * ph.w / ph.h); }
        phParas.push(Pg(new D.ImageRun({ data: await ph.out.arrayBuffer(), transformation: { width: wpx, height: hpx } }), { after: 60, align: D.AlignmentType.CENTER }));
      }
      if (!phParas.length) phParas.push(Pg(T('（無照片）', { color: '888888' })));
      const L = it.loc || {};
      const locParas = [Pg(T(it.locText || '—', { bold: true, size: 19 }), { after: 80 })];
      [['座', L.block], ['層', L.floor], ['房間／區域', L.zone], ['軸線', L.grid], ['圖紙', [d.name, d.no].filter(Boolean).join(' ')]].forEach(([k, v]) => { if (v) locParas.push(Pg([T(k + '：', { color: '5F6B69', size: 16 }), T(v, { size: 16 })], { after: 20 })); });
      const noteParas = (it.note || '').split('\n').map(l => Pg(T(l, { size: 18 })));
      rows.push(new D.TableRow({
        cantSplit: true, children: [
          cell([Pg(T(it.no, { bold: true, size: 22, color: 'D42A1E' }), { align: D.AlignmentType.CENTER })], 0, { v: D.VerticalAlign.CENTER }),
          cell([Pg(cropRun, { align: D.AlignmentType.CENTER, after: 0 })], 1),
          cell(locParas, 2), cell(phParas, 3), cell(noteParas.length ? noteParas : [Pg(T(''))], 4), cell([Pg(T(''))], 5),
        ]
      }));
    }
    const infoRow = (k, v) => new D.TableRow({ children: [new D.TableCell({ children: [Pg(T(k, { color: '5F6B69' }), { after: 0 })], width: { size: 2200, type: D.WidthType.DXA }, borders: { top: { style: D.BorderStyle.NONE }, bottom: { style: D.BorderStyle.NONE }, left: { style: D.BorderStyle.NONE }, right: { style: D.BorderStyle.NONE } } }), new D.TableCell({ children: [Pg(T(v || '', { bold: true }), { after: 0 })], width: { size: 5500, type: D.WidthType.DXA }, borders: { top: { style: D.BorderStyle.NONE }, bottom: { style: D.BorderStyle.NONE }, left: { style: D.BorderStyle.NONE }, right: { style: D.BorderStyle.NONE } } })] });
    const children = [
      Pg(T('竣工驗收記錄', { bold: true, size: 32 }), { after: 120 }),
      new D.Table({ rows: [infoRow('項目名稱', P.name), infoRow('地盤／地址', P.site), infoRow('驗收日期', P.date), infoRow('檢查人員', [P.inspector, P.company].filter(Boolean).join('　')), infoRow('記錄數量', `${items.length} 項`)], width: { size: 7700, type: D.WidthType.DXA }, columnWidths: [2200, 5500] }),
      Pg(T(''), { after: 120 }),
      new D.Table({ rows, width: { size: usable, type: D.WidthType.DXA }, columnWidths: colTw, layout: D.TableLayoutType.FIXED }),
    ];
    if (S.settings.keyPlan) {
      const avail = { w: Math.floor(usable / 15) - 10, h: Math.floor((11906 - 1360) / 15) - 90 };
      for (const d of S.drawings) {
        const its = items.filter(i => i.drawingId === d.id); if (!its.length) continue;
        busy(`正在生成位置總圖：${d.name}`);
        const k = await keyPlanImage(d, its); const s = Math.min(avail.w / k.w, avail.h / k.h);
        children.push(new D.Paragraph({ pageBreakBefore: true, children: [T(`位置總圖：${d.name}`, { bold: true, size: 24 })], spacing: { after: 60 } }));
        children.push(Pg(T(`${[d.block, d.floor, d.no].filter(Boolean).join(' · ')}　記錄：${its.map(i => '#' + i.no).join('、')}`, { size: 16, color: '5F6B69' }), { after: 80 }));
        children.push(Pg(new D.ImageRun({ data: await k.blob.arrayBuffer(), transformation: { width: Math.round(k.w * s), height: Math.round(k.h * s) } }), { align: D.AlignmentType.CENTER }));
      }
    }
    const doc = new D.Document({
      creator: P.inspector || '竣工驗收記錄', title: '竣工驗收記錄',
      styles: { default: { document: { run: { font: FONT, size: 18 } } } },
      sections: [{
        properties: { page: { size: { width: 11906, height: 16838, orientation: D.PageOrientation.LANDSCAPE }, margin: { top: 680, bottom: 680, left: 680, right: 680, header: 340, footer: 340 } } },
        headers: { default: new D.Header({ children: [Pg([T(`${P.name || ''}　竣工驗收記錄　${P.date || ''}`, { size: 15, color: '5F6B69' })], { align: D.AlignmentType.RIGHT })] }) },
        footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ children: ['第 ', D.PageNumber.CURRENT, ' 頁，共 ', D.PageNumber.TOTAL_PAGES, ' 頁'], font: FONT, size: 15, color: '5F6B69' })] })] }) },
        children,
      }],
    });
    const blob = await D.Packer.toBlob(doc);
    busy();
    await deliver(blob, `竣工驗收記錄_${safeName(P.name) || '項目'}_${P.date || today()}.docx`);
  } catch (err) { busy(); console.error(err); toast('報告生成失敗：' + err.message, 6000); }
}

async function exportBackup(withItems) {
  try {
    busy('正在打包…');
    const drawings = [];
    for (const d of S.drawings) { const { blob, ...rest } = d; drawings.push({ ...rest, image: await blobToDataURL(blob) }); }
    const items = [];
    if (withItems) for (const it of S.items) { const photos = []; for (const p of it.photos) photos.push({ ...p, orig: await blobToDataURL(p.orig), out: await blobToDataURL(p.out) }); items.push({ ...it, photos }); }
    const data = { app: 'handover-inspect', version: VERSION, exported: new Date().toISOString(), project: S.project, settings: S.settings, drawings, items };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    busy();
    await deliver(blob, `${withItems ? '驗收備份' : '圖紙位置設定'}_${safeName(S.project.name) || '項目'}_${today()}.json`);
  } catch (err) { busy(); toast('導出失敗：' + err.message, 5000); }
}
$('#jsonInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    busy('正在匯入…');
    const data = JSON.parse(await f.text());
    if (data.app !== 'handover-inspect') throw new Error('不是本程式的備份檔');
    if (data.project && !S.project.name) S.project = { ...S.project, ...data.project };
    let nd = 0, ni = 0;
    for (const d of data.drawings || []) { const { image, ...rest } = d; const rec = { ...rest, blob: await dataURLToBlob(image) }; await DB.put('drawings', rec); const i = S.drawings.findIndex(x => x.id === rec.id); if (i >= 0) { S.drawings[i] = rec; imgCache.delete(rec.id); } else S.drawings.push(rec); nd++; }
    for (const it of data.items || []) { const photos = []; for (const p of it.photos) photos.push({ ...p, orig: await dataURLToBlob(p.orig), out: await dataURLToBlob(p.out) }); const rec = { ...it, photos }; await DB.put('items', rec); const i = S.items.findIndex(x => x.id === rec.id); if (i >= 0) S.items[i] = rec; else S.items.push(rec); ni++; }
    await saveKV(); busy(); toast(`已匯入 ${nd} 張圖紙、${ni} 個記錄`);
    if (!curD() && S.drawings[0]) await showDrawing(S.drawings[0].id); else await showDrawing(S.cur);
    closePanel();
  } catch (err) { busy(); toast('匯入失敗：' + err.message, 5000); }
};

/* ---------------- demo drawing (first run only) ---------------- */
async function seedDemo() {
  const W = 3200, H = 2200, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  const GX = [400, 1000, 1600, 2200, 2800], GY = [400, 900, 1400, 1900], LX = ['1', '2', '3', '4', '5'], LY = ['A', 'B', 'C', 'D'];
  x.strokeStyle = '#8aa'; x.lineWidth = 2; x.setLineDash([30, 10, 6, 10]);
  GX.forEach(v => { x.beginPath(); x.moveTo(v, 150); x.lineTo(v, 2050); x.stroke(); }); GY.forEach(v => { x.beginPath(); x.moveTo(150, v); x.lineTo(3050, v); x.stroke(); });
  x.setLineDash([]); x.font = '600 44px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
  const bub = (cx, cy, t) => { x.beginPath(); x.arc(cx, cy, 42, 0, 7); x.fillStyle = '#fff'; x.fill(); x.lineWidth = 3; x.strokeStyle = '#345'; x.stroke(); x.fillStyle = '#234'; x.fillText(t, cx, cy + 2); };
  GX.forEach((v, i) => bub(v, 100, LX[i])); GY.forEach((v, i) => bub(100, v, LY[i]));
  x.strokeStyle = '#111'; x.lineWidth = 22; x.strokeRect(400, 400, 2400, 1500);
  x.lineWidth = 12; const wall = (a, b, c2, d) => { x.beginPath(); x.moveTo(a, b); x.lineTo(c2, d); x.stroke(); };
  wall(1600, 400, 1600, 1400); wall(1600, 1000, 2800, 1000); wall(2200, 1000, 2200, 1400); wall(400, 1400, 1300, 1400); wall(1450, 1400, 2800, 1400); wall(1000, 1400, 1000, 1900);
  x.fillStyle = '#fff'; [[1600, 1180, 1600, 1300], [1850, 1000, 1990, 1000], [2400, 1400, 2520, 1400], [1000, 1560, 1000, 1680]].forEach(([a, b, c2, d]) => { x.save(); x.strokeStyle = '#fff'; x.lineWidth = 16; wall(a, b, c2, d); x.restore(); });
  x.fillStyle = '#333'; x.font = '600 56px "PingFang TC","Microsoft JhengHei",sans-serif';
  const rooms = [['客廳／飯廳', 400, 400, 1600, 1400], ['主人房', 1600, 400, 2800, 1000], ['睡房 2', 1600, 1000, 2200, 1400], ['浴室', 2200, 1000, 2800, 1400], ['廚房', 400, 1400, 1000, 1900], ['走廊', 1000, 1400, 2800, 1900]];
  rooms.forEach(r => x.fillText(r[0], (r[1] + r[3]) / 2, (r[2] + r[4]) / 2));
  x.strokeStyle = '#222'; x.lineWidth = 3; x.strokeRect(2300, 1980, 860, 190); x.font = '600 34px sans-serif'; x.textAlign = 'left';
  x.fillText('示例圖紙 DEMO-A-301', 2330, 2040); x.font = '28px sans-serif'; x.fillText('第1座 3樓 標準層平面圖（僅供試用）', 2330, 2110);
  const blob = await canvasBlob(c, 'image/png');
  const d = { id: 'demo', name: '示例：第1座 3樓 平面圖', block: '第1座', floor: '3樓', no: 'DEMO-A-301', gridOrder: 'YX', blob, w: W, h: H, created: Date.now(),
    zones: rooms.map((r, i) => ({ id: 'dz' + i, name: r[0], kind: 'room', block: '', floor: '', pts: [[r[1], r[2]], [r[3], r[2]], [r[3], r[4]], [r[1], r[4]]] })),
    gx: GX.map((v, i) => ({ id: 'gx' + i, label: LX[i], pos: v })), gy: GY.map((v, i) => ({ id: 'gy' + i, label: LY[i], pos: v })) };
  await DB.put('drawings', d);
  // sample photo
  const pc = document.createElement('canvas'); pc.width = 1600; pc.height = 1200; const p = pc.getContext('2d');
  const gr = p.createLinearGradient(0, 0, 1600, 1200); gr.addColorStop(0, '#d9d4c9'); gr.addColorStop(1, '#bdb6a8'); p.fillStyle = gr; p.fillRect(0, 0, 1600, 1200);
  p.fillStyle = '#9b9384'; p.fillRect(0, 980, 1600, 220); p.fillStyle = '#5c5a55'; p.fillRect(690, 520, 220, 160); p.fillStyle = '#2b2a28'; p.fillRect(720, 550, 160, 100);
  p.strokeStyle = '#d33'; p.lineWidth = 6; p.beginPath(); p.moveTo(800, 600); p.lineTo(760, 640); p.stroke();
  p.fillStyle = 'rgba(0,0,0,.5)'; p.font = '600 44px sans-serif'; p.fillText('示例照片', 40, 80);
  const orig = await canvasBlob(pc, 'image/jpeg', 0.85);
  const shapes = [{ t: 'ellipse', c: '#e5251a', a: { x: 620, y: 450 }, b: { x: 980, y: 750 } }, { t: 'arrow', c: '#e5251a', a: { x: 1250, y: 300 }, b: { x: 960, y: 520 } }];
  shapes.forEach(s => drawShape(p, s, 10));
  const out = await canvasBlob(pc, 'image/jpeg', 0.85);
  const loc = resolveLoc(d, 2000, 700);
  await DB.put('items', { id: 'demo1', drawingId: 'demo', no: 1, x: 2000, y: 700, loc, locText: fmtLoc(loc), photos: [{ id: 'dp1', orig, out, shapes, w: 1600, h: 1200, t: Date.now() }], note: '示例：插座面板未安裝，底盒外露', created: Date.now() });
  S.project.name = S.project.name || '示例項目';
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    await DB.open();
    if (!(await DB.kget('seeded'))) { await seedDemo(); await DB.kset('seeded', true); await DB.kset('cur', 'demo'); await DB.kset('project', S.project); }
    S.project = { ...S.project, ...(await DB.kget('project') || {}) };
    S.settings = { ...S.settings, ...(await DB.kget('settings') || {}) };
    S.drawings = (await DB.all('drawings')).sort((a, b) => (a.created || 0) - (b.created || 0));
    S.items = await DB.all('items');
    const cur = await DB.kget('cur');
    await showDrawing(S.drawings.find(d => d.id === cur) ? cur : S.drawings[0]?.id || null);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  } catch (err) { console.error(err); toast('啟動失敗：' + err.message, 8000); }
  updateBar();
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
boot();
