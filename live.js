'use strict';
/* ================= v0.10: 在線回復 (live replies) =================
   A final defect list (one round) is published to Firebase and locked there: only its publisher (管理員, the
   device that published it) can still add, delete or change records, and those edits reach everyone live. Anyone with the link loads the list onto their iPad / phone and answers it point by point;
   each reply photo uploads as soon as it is taken and every device that holds the list sees it straight away.
   Firestore only (no Cloud Storage): each photo is one document of at most ~900 KB, so the free plan is enough.
   Cloud layout, under live/{id}:
     (doc)            name, date, set, project, owner (uid), ownerName, n, locked
     items/{itemId}   the locked record, without photos' images
     photos/{photoId} kind 'b' (before, from the publisher) or 'a' (reply, with the uid of whoever took it), data = JPEG bytes, w, h, t, by
     replies/{itemId}_{uid}  one per person and record: item, uid, by, reply, mod, photos: { photoId: { t, w, h, by, v } }
   Every device signs in anonymously, so each person is told apart by the uid of their browser even without a login:
   the rules let people change or remove only their own replies (the publisher may remove anyone's).
   Local state: round.live = { id, owner, from, gone: [ids deleted here, waiting to be deleted in the cloud] };
   it.liveDirty = the publisher changed the record, waiting to go up; a before photo has up once uploaded; a reply photo has up = version uploaded (0 = waiting),
   remote = 1 while its image is still to be downloaded, uid = who took it; fix.mine = my reply text, fix.texts = the
   others' { uid: { by, text } }, fix.reply / status / done / by are summed up from all of them (liveSum);
   fix.dirty = my reply waiting to go up, fix.del = [{ id, uid }] reply photos removed here, waiting to be removed in the cloud. */
// the Firebase web app config (public by design; access is governed by firebase/firestore.rules)
const LIVE_CFG = { apiKey: 'AIzaSyBZDMchl3D7B3Yo7x-5iNdMgkWizo_S3DY', authDomain: 'handover-inspection.firebaseapp.com', projectId: 'handover-inspection',
  storageBucket: 'handover-inspection.firebasestorage.app', messagingSenderId: '33558693068', appId: '1:33558693068:web:d3cb0e5168f95f66efee69' };
const FB_V = '10.14.1';
const LV = { fb: null, db: null, uid: '', init: null, subs: new Map(), rep: new Map(), flushing: false, again: false, down: false, err: '' };
// this browser's anonymous uid, remembered so replies made before the first connection are still mine
const myUid = () => LV.uid || S.settings.liveUid || '';
const liveOf = r => (r && r.live) || null;
const liveRoundOf = it => { const r = it && S.rounds.find(x => x.id === roundOf(it)); return liveOf(r) ? r : null; };
const liveIn = it => !!liveRoundOf(it);
// the record can't be changed here: a live list someone else published
const liveLocked = it => { const r = liveRoundOf(it); return !!r && !r.live.owner; };
const liveAdmin = (r = curRound()) => !!(liveOf(r) && r.live.owner);
const liveLink = id => location.origin + location.pathname + '?live=' + id;
const lref = (id, ...p) => LV.fb.doc(LV.db, 'live', id, ...p);
const lcol = (id, c) => LV.fb.collection(LV.db, 'live', id, c);

function liveInit() {
  if (LV.init) return LV.init;
  LV.init = (async () => {
    if (!LIVE_CFG) throw new Error('未設定在線伺服器（Firebase）');
    const u = m => `https://www.gstatic.com/firebasejs/${FB_V}/firebase-${m}.js`;
    const [app, auth, fs] = await Promise.all([import(u('app')), import(u('auth')), import(u('firestore'))]);
    const a = app.initializeApp(LIVE_CFG), au = auth.getAuth(a);
    await au.authStateReady(); if (!au.currentUser) await auth.signInAnonymously(au);
    LV.fb = fs; LV.db = fs.getFirestore(a); LV.uid = au.currentUser.uid;
    if (S.settings.liveUid !== LV.uid) { S.settings.liveUid = LV.uid; await saveKV(); }
  })();
  LV.init.catch(() => { LV.init = null; }); // offline: try again next time
  return LV.init;
}

// a JPEG small enough for one Firestore document (1 MiB)
async function livePhotoBytes(blob) {
  for (const [max, q] of [[1600, 0.8], [1400, 0.72], [1200, 0.65], [1000, 0.6]]) {
    const img = await loadImg(blob); const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); if (img.close) img.close(); else URL.revokeObjectURL(img.src);
    const b = await canvasBlob(c, 'image/jpeg', q); const w = c.width, h = c.height; c.width = c.height = 0;
    if (b && b.size < 900000) return { bytes: new Uint8Array(await b.arrayBuffer()), w, h };
  }
  throw new Error('相片太大，未能上載');
}
const liveRec = it => JSON.parse(JSON.stringify({ id: it.id, code: it.code, no: it.no, dev: devOf(it), by: it.by, ord: it.ord, origLabel: it.origLabel,
  note: it.note || '', sub: it.sub, subs: it.subs, drawingId: it.drawingId, pf: it.pf, x: it.x, y: it.y, loc: it.loc, locText: it.locText,
  locEdited: it.locEdited, created: it.created, photos: it.photos.map(p => ({ id: p.id, t: p.t || 0, v: p.up || 0 })) }));

/* ---- 發佈密碼: only a device that has given it may publish. The password never leaves the device: its hash
   is written to admins/{uid}, which the rules accept only when pubkeys/{hash} exists (set up in the console) ---- */
async function livePubKey(pw) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('handover-inspection|' + pw));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function liveAuthorise(pw) {
  await LV.fb.setDoc(LV.fb.doc(LV.db, 'admins', LV.uid), { key: await livePubKey(pw), name: S.settings.inspector || '', at: Date.now() });
  S.settings.livePubOk = true; await saveKV();
}

/* ---- publish: upload the round, then lock it ---- */
async function livePublish(rd, pw) {
  const items = S.items.filter(i => roundOf(i) === rd.id).sort(byOrder);
  if (!items.length) return toast('這個批次沒有記錄');
  try {
    busy('正在連接伺服器…'); await liveInit(); const F = LV.fb;
    if (pw) try { await liveAuthorise(pw); } catch (e) { if (e.code === 'permission-denied') { busy(); return toast('發佈密碼不正確', 4000); } throw e; }
    const id = (uid() + uid()).replace(/[^a-z0-9]/g, '');
    try { await F.setDoc(lref(id), { name: rd.name, date: rd.date || '', set: setOfRound(rd), project: S.project.name || '', owner: LV.uid, ownerName: S.settings.inspector || '', created: Date.now(), n: items.length, locked: false }); }
    catch (e) { if (e.code !== 'permission-denied') throw e; S.settings.livePubOk = false; await saveKV(); busy(); if (S.panel === 'round') roundPanel(); return toast('這部機未獲准發佈，請輸入發佈密碼', 5000); }
    const tot = items.reduce((s, i) => s + i.photos.length, 0); let n = 0;
    for (const it of items) for (const p of it.photos) {
      busy(`正在上載完成前相片 ${++n}／${tot}`);
      const b = await livePhotoBytes(await photoOut(it, p));
      await F.setDoc(lref(id, 'photos', p.id), { kind: 'b', item: it.id, data: F.Bytes.fromUint8Array(b.bytes), w: b.w, h: b.h, t: p.t || 0 });
      p.up = Date.now();
    }
    busy('正在上載記錄…');
    for (let i = 0; i < items.length; i += 400) { const wb = F.writeBatch(LV.db); for (const it of items.slice(i, i + 400)) wb.set(lref(id, 'items', it.id), liveRec(it)); await wb.commit(); }
    await F.updateDoc(lref(id), { locked: true });
    rd.live = { id, owner: true, from: S.settings.inspector || '', at: Date.now() }; await saveRounds();
    // replies already on this iPad (e.g. from reply packs) go up as well
    for (const it of items) { if (hasReply(it)) { const X = it.fix; X.dirty = 1; X.mine = X.reply || ''; for (const p of X.photos || []) Object.assign(p, { up: 0, uid: LV.uid, by: p.by || X.by || S.settings.inspector || '' }); } await saveItem(it, true); }
    busy(); liveWatch(rd); liveFlush(); updateBar(); if (S.panel === 'round') roundPanel();
    toast(`已發佈並鎖定「${rd.name}」（${items.length} 項），可以把連結發出`, 4500);
  } catch (e) { busy(); toast('發佈失敗：' + e.message, 6000); console.error(e); }
}

/* ---- join: load a published list from its link (or code) ---- */
async function liveJoin(code) {
  const m = String(code || '').match(/live=([a-z0-9]+)/i), id = m ? m[1] : String(code || '').trim();
  if (!/^[a-z0-9]{12,}$/i.test(id)) return toast('連結不正確');
  const have = S.rounds.find(r => liveOf(r) && r.live.id === id);
  if (have) { if (setOfRound(have) !== curSet()) await switchSet(setOfRound(have)); setCurRound(have.id); await saveKV(); closePanel(); renderOverlay(); updateBar(); return toast(`已切換到在線批次「${have.name}」`); }
  try {
    busy('正在連接伺服器…'); await liveInit(); const F = LV.fb;
    const hd = await F.getDoc(lref(id)); if (!hd.exists()) throw new Error('找不到這個在線批次');
    const h = hd.data(); if (!h.locked) throw new Error('發佈人還在上載這個批次，請稍後再試');
    const set = h.set || 'gbp';
    if (set !== 'gbp' && !S.drawings.some(d => setOf(d) === set && d.src === 'bundle')) await loadBundle(set);
    busy('正在下載記錄…');
    const qs = await F.getDocs(lcol(id, 'items'));
    let name = h.name || '在線批次'; const base = name;
    for (let n = 2; S.rounds.some(x => x.name === name && setOfRound(x) === set); n++) name = `${base}（${n}）`;
    const rd = { id: uid(), name, date: h.date || '', ...(set === 'gbp' ? {} : { set }), live: { id, owner: h.owner === LV.uid, from: h.ownerName || '', at: Date.now() } };
    S.rounds.push(rd);
    for (const ds of qs.docs) {
      const c = ds.data(); toFrame(c);
      const { photos, ...rec } = c, ex = S.items.find(x => x.id === c.id);
      // the same record already here (from a backup): it now belongs to the list, as published
      if (ex) { Object.assign(ex, rec, { round: rd.id }); await saveItem(ex, true); continue; }
      const it = { ...rec, round: rd.id, photos: (photos || []).map(p => ({ id: p.id, t: p.t || 0, shapes: [], remote: 1, up: p.v || 0 })), fix: null, mod: Date.now() };
      await saveItem(it, true); S.items.push(it);
    }
    if (S.project.name === '' && h.project) S.project.name = h.project;
    if (curSet() !== set) { S.settings.set = set; ensureSetRounds(); }
    setCurRound(rd.id); await saveRounds(); await saveKV(); busy(); closePanel();
    const L = setDrawings(); if (!L.some(d => d.id === S.cur)) await showDrawing(L[0]?.id || null);
    renderOverlay(); updateBar(); liveWatch(rd); liveDownload();
    toast(`已載入「${rd.name}」${qs.size} 項${h.ownerName ? `（${h.ownerName} 發佈）` : ''}；按頂部「篩選」可只顯示自己的分判或分區`, 6000);
  } catch (e) { busy(); toast('加入失敗：' + e.message, 6000); console.error(e); }
}

/* ---- replies from the cloud, live ---- */
function liveWatch(rd) {
  const id = rd.live.id; if (LV.subs.has(id) || !LV.fb) return;
  LV.subs.set(id, LV.fb.onSnapshot(lcol(id, 'replies'), snap => {
    const R = LV.rep.get(id) || new Map(), hit = new Set(); LV.rep.set(id, R);
    for (const ch of snap.docChanges()) {
      const d = ch.doc.data(); if (!d.item || !d.uid) continue;
      const m = R.get(d.item) || new Map(); R.set(d.item, m);
      if (ch.type === 'removed') m.delete(d.uid); else m.set(d.uid, d); hit.add(d.item);
    }
    for (const iid of hit) liveApply(rd, iid);
    if (S.panel === 'round') roundPanel();
  }, err => { console.warn(err); LV.subs.delete(id); setTimeout(() => liveWatch(rd), 30000); }));
  if (!rd.live.owner) LV.fb.onSnapshot(lcol(id, 'items'), snap => {
    for (const ch of snap.docChanges()) liveRecord(rd, ch.type === 'removed' ? null : ch.doc.data(), ch.doc.id);
  }, err => console.warn(err));
}
/* the publisher changed, added or deleted a record */
const LIVE_KEYS = ['code', 'no', 'dev', 'by', 'ord', 'origLabel', 'note', 'sub', 'subs', 'drawingId', 'pf', 'x', 'y', 'loc', 'locText', 'locEdited', 'created'];
async function liveRecord(rd, c, id) {
  const ex = S.items.find(i => i.id === id);
  if (!c) {
    if (!ex || roundOf(ex) !== rd.id) return;
    if (S.editing === ex) closePanel();
    S.items = S.items.filter(i => i !== ex); await DB.del('items', id); renderOverlay(); updateBar(); return;
  }
  toFrame(c);
  if (ex && roundOf(ex) === rd.id && JSON.stringify(liveRec(ex)) === JSON.stringify(c)) return;
  const it = ex || { id, round: rd.id, photos: [], fix: null };
  for (const k of LIVE_KEYS) { if (c[k] === undefined) delete it[k]; else it[k] = c[k]; }
  it.round = rd.id; it.mod = Date.now();
  const have = new Map(it.photos.map(p => [p.id, p]));
  // a before photo marked again by the publisher comes with a newer version: fetch it again
  it.photos = (c.photos || []).map(p => { const h = have.get(p.id); return h && (h.up || 0) === (p.v || 0) ? h : { id: p.id, t: p.t || 0, shapes: [], remote: 1, up: p.v || 0 }; });
  await saveItem(it, true); if (!ex) S.items.push(it);
  renderOverlay(); updateBar(); if (S.panel === 'item' && S.editing === it) itemPanel();
  liveDownload();
}
async function liveApply(rd, id) {
  const it = S.items.find(i => i.id === id && roundOf(i) === rd.id); if (!it) return;
  const docs = [...(((LV.rep.get(rd.live.id) || new Map()).get(id)) || new Map()).values()];
  const F = fixOf(it), me = myUid(), del = (F.del || []).map(d => d.id);
  const sig = () => JSON.stringify([F.photos.map(p => [p.id, p.up, p.remote]), F.texts, F.mine, F.reply, F.status]), was = sig();
  const cp = {}; for (const d of docs) for (const [pid, m] of Object.entries(d.photos || {})) cp[pid] = { ...m, uid: d.uid };
  for (const [pid, m] of Object.entries(cp)) {
    if (del.includes(pid)) continue;
    const l = F.photos.find(p => p.id === pid);
    if (!l) F.photos.push({ id: pid, t: m.t || 0, w: m.w, h: m.h, by: m.by || '', uid: m.uid, shapes: [], remote: 1, up: m.v || 1 });
    else if (l.up && m.v && m.v > l.up) Object.assign(l, { remote: 1, up: m.v, shapes: [] }); // marked again on another device
  }
  // uploaded before but gone from the cloud: removed on another device
  F.photos = F.photos.filter(p => !p.up || cp[p.id]);
  F.photos.sort((a, b) => (a.t || 0) - (b.t || 0));
  // the others' texts; mine stays as typed here while it waits to go up
  const T = {}; for (const d of docs) if ((d.reply || '').trim() && d.uid !== me) T[d.uid] = { by: d.by || '', text: d.reply };
  F.texts = T; if (!F.dirty) { const m = docs.find(d => d.uid === me); F.mine = m ? m.reply || '' : F.mine || ''; }
  liveSum(it); if (sig() === was) return;
  await saveItem(it, true); renderOverlay(); updateBar();
  if (S.panel === 'item' && S.editing === it) itemPanel();
  liveDownload();
}

/* ---- photos still to fetch (before photos of a joined list, replies from others) ---- */
async function liveDownload() {
  if (LV.down || !LV.fb) return; LV.down = true;
  try {
    for (;;) {
      const need = S.items.filter(liveIn).flatMap(i => allPhotos(i).filter(p => p.remote).map(p => [i, p]));
      if (!need.length) break;
      need.sort(([a], [b]) => subOk(b) - subOk(a) || (b === S.editing) - (a === S.editing));
      const [it, p] = need[0]; const s = await LV.fb.getDoc(lref(liveRoundOf(it).live.id, 'photos', p.id));
      if (s.exists()) { const d = s.data(), blob = new Blob([d.data.toUint8Array()], { type: 'image/jpeg' }); Object.assign(p, { orig: blob, out: blob, w: d.w, h: d.h }); }
      else p.missing = 1;
      delete p.remote; await saveItem(it, true); updateBar();
      if (S.panel === 'item' && S.editing === it) itemPanel();
    }
  } catch (e) { console.warn(e); LV.err = e.message; LV.down = false; updateBar(); return void setTimeout(liveDownload, 20000); }
  LV.down = false; updateBar();
}

/* ---- replies made here go up ---- */
function liveTouched(it) { if (!liveIn(it)) return; fixOf(it).dirty = 1; liveSum(it); liveSoon(); }
/* one record's reply, summed up from everyone's: the text (named when several people wrote), done once any photo is in */
function liveSum(it) {
  const F = fixOf(it), parts = [];
  if ((F.mine || '').trim()) parts.push([S.settings.inspector || '', F.mine.trim()]);
  for (const t of Object.values(F.texts || {})) parts.push([t.by, t.text.trim()]);
  F.reply = parts.length > 1 ? parts.map(([b, t]) => (b ? b + '：' : '') + t).join('；') : parts.length ? parts[0][1] : '';
  F.status = F.photos.length ? 'done' : 'open'; F.done = F.photos.length ? Math.max(...F.photos.map(p => p.t || 0)) : 0;
  F.by = [...new Set(F.photos.map(p => p.by).filter(Boolean))].join('、');
}
// a reply photo this device may change or remove: its own (the publisher may also remove anyone's)
const liveMinePhoto = ph => !ph.uid || ph.uid === myUid();
function liveDelPhoto(it, i) { const F = fixOf(it), [ph] = F.photos.splice(i, 1); if (ph.up) F.del = [...(F.del || []), { id: ph.id, uid: ph.uid || myUid() }]; liveTouched(it); }
function liveSoon() { clearTimeout(LV.t); LV.t = setTimeout(liveFlush, 800); }
// the publisher edited / deleted a record of the list
function liveEdited(it) { if (!liveIn(it) || !liveRoundOf(it).live.owner) return; it.liveDirty = 1; liveSoon(); }
async function liveRemoved(it) { const r = liveRoundOf(it); if (!r || !r.live.owner) return; r.live.gone = [...(r.live.gone || []), it.id]; await saveRounds(); liveSoon(); }
const liveReplyWaiting = i => i.fix && (i.fix.dirty || (i.fix.del || []).length || i.fix.photos.some(p => !p.up && !p.remote));
const livePending = () => S.items.filter(i => liveIn(i) && (i.liveDirty || liveReplyWaiting(i))).length + S.rounds.reduce((n, r) => n + ((liveOf(r) && r.live.gone) || []).length, 0);
async function liveFlush() {
  if (LV.flushing) { LV.again = true; return; } LV.flushing = true;
  try {
    if (!livePending()) return;
    await liveInit(); const F = LV.fb;
    // the publisher's changes to the records: new or re-marked before photos first, then the records in batches
    const recs = S.items.filter(i => i.liveDirty && liveIn(i) && liveRoundOf(i).live.owner);
    for (const it of recs) { const id = liveRoundOf(it).live.id;
      for (const p of it.photos.filter(p => !p.up && !p.remote)) {
        const b = await livePhotoBytes(await photoOut(it, p));
        await F.setDoc(lref(id, 'photos', p.id), { kind: 'b', item: it.id, data: F.Bytes.fromUint8Array(b.bytes), w: b.w, h: b.h, t: p.t || 0 }); p.up = Date.now();
      } }
    for (let i = 0; i < recs.length; i += 400) {
      const part = recs.slice(i, i + 400), wb = F.writeBatch(LV.db);
      for (const it of part) wb.set(lref(liveRoundOf(it).live.id, 'items', it.id), liveRec(it));
      await wb.commit(); for (const it of part) { delete it.liveDirty; await saveItem(it, true); }
    }
    for (const r of S.rounds.filter(r => liveOf(r) && r.live.owner && (r.live.gone || []).length)) {
      for (const iid of [...r.live.gone]) { await F.deleteDoc(lref(r.live.id, 'items', iid)); r.live.gone = r.live.gone.filter(x => x !== iid); }
      await saveRounds();
    }
    for (const it of S.items.filter(i => liveIn(i) && i.fix)) {
      const X = it.fix, id = liveRoundOf(it).live.id, me = LV.uid, P = {}; if (!liveReplyWaiting(it)) continue;
      for (const p of X.photos.filter(p => !p.up && !p.remote)) {
        if (!p.uid) p.uid = me;
        if (p.uid !== me) { p.up = Date.now(); continue; } // someone else's photo can't be sent again from here
        const b = await livePhotoBytes(await photoOut(it, p)), v = Date.now(), by = p.by || S.settings.inspector || '';
        await F.setDoc(lref(id, 'photos', p.id), { kind: 'a', item: it.id, uid: me, data: F.Bytes.fromUint8Array(b.bytes), w: b.w, h: b.h, t: p.t || 0, by });
        P[p.id] = { t: p.t || 0, w: b.w, h: b.h, by, v }; p._v = v;
      }
      // removed photos: from my own reply, or (the publisher) from someone else's
      const del = [...(X.del || [])], theirs = del.filter(d => d.uid && d.uid !== me);
      for (const d of del) if (!theirs.includes(d)) P[d.id] = F.deleteField();
      if (X.dirty || Object.keys(P).length) await F.setDoc(lref(id, 'replies', it.id + '_' + me), { item: it.id, uid: me, by: S.settings.inspector || '', reply: X.mine || '', mod: Date.now(), photos: P }, { merge: true });
      for (const d of theirs) await F.setDoc(lref(id, 'replies', it.id + '_' + d.uid), { photos: { [d.id]: F.deleteField() } }, { merge: true });
      for (const d of del) await F.deleteDoc(lref(id, 'photos', d.id)).catch(() => { });
      for (const p of X.photos) if (p._v) { p.up = p._v; delete p._v; }
      X.del = (X.del || []).filter(d => !del.includes(d)); if (!X.del.length) delete X.del;
      delete X.dirty; await saveItem(it, true); updateBar();
      if (S.panel === 'item' && S.editing === it) itemPanel();
    }
    LV.err = '';
  } catch (e) { console.warn(e); LV.err = e.message; setTimeout(liveFlush, 30000); }
  finally { LV.flushing = false; updateBar(); if (LV.again) { LV.again = false; liveFlush(); } }
}

/* ---- top bar: ↑ waiting to upload, ↓ downloading ---- */
function liveBadge() {
  if (!liveOf(curRound())) return '';
  const up = livePending(), dn = roundItems().reduce((n, i) => n + allPhotos(i).filter(p => p.remote).length, 0);
  return ` <span class="n live${up ? ' wait' : ''}" title="${up ? `${up} 項回復等待上載${LV.err ? '：' + esc(LV.err) : ''}` : '在線'}">${up ? '↑' + up : dn ? '↓' + dn : '在線'}</span>`;
}

/* ---- a record of a locked list: read only, replies only ---- */
function livePanel() {
  freeURLs();
  const it = S.editing, rd = liveRoundOf(it), d = S.drawings.find(x => x.id === it.drawingId), v = d ? viewById(d, it.loc.viewId) : null, F = fixOf(it);
  const pic = (ph, a, i) => ph.out ? `<img src="${burl(ph.out)}" data-a="${a}" data-i="${i}" alt="">` : `<span class="ed" style="position:static;display:block;padding:40% 8px 0;text-align:center">${ph.missing ? '相片未能下載' : '相片下載中…'}</span>`;
  const before = it.photos.map((ph, i) => `<div class="ph1">${pic(ph, '', i)}<span class="ed">完成前 ${i + 1}</span></div>`).join('');
  // only your own reply photos can be marked again or removed (the publisher may remove anyone's)
  const after = F.photos.map((ph, i) => { const own = liveMinePhoto(ph);
    return `<div class="ph1" style="outline:2px solid var(--ok)">${pic(ph, own ? 'edA' : '', i)}${own || rd.live.owner ? `<button class="del" data-a="delA" data-i="${i}" aria-label="刪除照片">✕</button>` : ''}<span class="ed" style="background:${ph.up || ph.remote ? 'var(--ok)' : '#c77700'}">${ph.up || ph.remote ? '已上載' : '等待上載'}・${own ? '我' : esc(ph.by || '其他人')}</span></div>`; }).join('');
  const others = Object.values(F.texts || {}).map(t => `<div class="note" style="color:inherit"><b>${esc(t.by || '其他人')}</b>：${esc(t.text)}</div>`).join('');
  const L = roundItems().filter(subOk).sort(byOrder), pos = L.findIndex(x => x.id === it.id), nd = L.filter(x => fixStatus(x) === 'done').length;
  openPanel('item', esc(v ? v.title : (d ? d.name : '')), `
    <div class="note">🔒 「${esc(rd.name)}」是已鎖定的最終清單：記錄不能修改，只可加回復照片及回覆文字；每人只可改或刪自己的回復。回復即時上載，所有人同步看到。</div>
    <div class="idx">${esc(it.locText || '未設定位置')}</div>
    <div class="f-l">問題描述</div><div class="note" style="font-size:15px;color:inherit">${esc(it.note || '（未填描述）')}</div>
    <div class="chips">${subsOf(it).map(x => `<span class="chip on">${esc(x)}</span>`).join('') || '<span class="chip">未指定分判</span>'}</div>
    ${before ? `<div class="photos">${before}</div>` : ''}
    <div class="row"><label class="btn g" for="fixCam" data-a="reply">拍回復照片</label><label class="btn" for="fixLib" data-a="reply">從相簿加入回復</label></div>
    ${after ? `<div class="f-l">回復照片（完成後）</div><div class="photos">${after}</div>` : ''}
    ${others ? `<div class="f-l">其他人的回覆</div>${others}` : ''}
    <label class="f">我的回覆文字（${esc(S.settings.inspector || '未設定名字')}，可留空）<input id="fxReply" value="${esc(F.mine || '')}" placeholder="例如：已更換門鉸"></label>
    <div class="row nav"><button class="btn" data-a="prev">‹ 上一個</button><button class="btn" data-a="next">下一個 ›</button></div>
    <div class="note navpos">${pos < 0 ? '' : `第 ${pos + 1}／${L.length} 項　·　已回復 ${nd} 項　·　未回復 ${L.length - nd} 項`}</div>
    <button class="btn dk" data-a="done">完成</button>`, { badge: `<span class="no">${itemLabel(it)}</span>` });
  const q = s => panel.querySelector(s);
  q('#fxReply').oninput = e => { F.mine = e.target.value; liveTouched(it); persistItem(); };
  panel.querySelector('.pb').onclick = async e => {
    if (e.target.closest('[data-a="reply"]')) { S.fixItem = it; return; }
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'edA') { const i = +e.target.dataset.i, ph = F.photos[i]; if (!liveMinePhoto(ph)) return; if (!(await canRead(ph.orig))) await refreshPhotos(it); const r = await openEditor(ph.orig, ph); if (r) { F.photos[i] = { ...ph, ...r, up: 0 }; await persistItem(true); liveTouched(it); itemPanel(); } }
    if (a === 'delA') {
      if (!e.target.dataset.armed) { e.target.dataset.armed = 1; e.target.textContent = '刪'; e.target.style.background = 'var(--red)'; return; }
      liveDelPhoto(it, +e.target.dataset.i);
      await persistItem(true); renderOverlay(); itemPanel();
    }
    if (a === 'prev' || a === 'next') stepItem(it, a);
    if (a === 'done') closePanel();
  };
  updateBar();
}
$('#fixLib').onchange = e => { const f = e.target.files[0]; e.target.value = ''; addFixPhoto(f); };

/* ---- 驗收批次 panel: publish, share, join ---- */
function liveSection() {
  const r = curRound(), L = liveOf(r), n = roundItems().length;
  let h = '<div class="sec">在線回復</div>';
  if (!LIVE_CFG) return h + '<div class="note">未設定在線伺服器（Firebase）。設定方法見 README「在線回復」。</div>';
  if (L) {
    const url = liveLink(L.id), done = roundItems().filter(i => fixStatus(i) === 'done').length, up = livePending();
    const qr = qrFor(url);
    h += `<div class="safe ok"><b>🔒 已鎖定，在線中${L.owner ? '（由本機發佈）' : L.from ? `（${esc(L.from)} 發佈）` : ''}</b><span>${done}／${n} 項已回復　·　${up ? `${up} 項回復等待上載${LV.err ? '（' + esc(LV.err) + '）' : ''}` : '全部回復已上載'}</span></div>
      ${L.owner ? '<div class="note">你是這張清單的發佈人（管理員）：在這部機可以照常修改描述、分判、位置、編號，加點或刪點，改動即時同步給所有人；其他人只可以回復，而且只可改或刪自己的回復（你可以刪任何人的回復照片）。</div>' + liveWho(L) : ''}
      <div class="note">把連結發給分判或同事，用 iPad／手機開啟就會載入這張清單（不用安裝，但請在一般分頁開啟，不要用無痕瀏覽）。逐點按「拍回復照片」，相片即時上載，所有人包括你都會即時看到綠點。</div>
      <label class="f">連結<input readonly value="${esc(url)}" onfocus="this.select()"></label>
      <div class="row"><button class="btn p" data-a="liveShare">分享連結</button><button class="btn" data-a="liveCopy">複製連結</button></div>
      ${qr ? `<div style="text-align:center"><img src="${qr.createDataURL(4, 8)}" alt="連結二維碼" style="width:180px;image-rendering:pixelated"></div>` : ''}`;
  } else if (n) {
    h += `<div class="note">把目前批次（${esc(r.name)}，${n} 項）上載並鎖定成最終清單。鎖定後其他人都不能再加點、刪點，或改描述、分判、編號、位置，只可加回復照片及回覆文字；只有你（發佈人）在這部機可以繼續修改。建議先「導出 → 整理編號」再發佈。</div>
      ${S.settings.livePubOk ? '' : '<label class="f">發佈密碼（每部機只需輸入一次）<input id="livePw" type="password" autocomplete="off"></label>'}
      <button class="btn p" data-a="livePub">發佈並鎖定此批次</button>`;
  }
  return h + `<div class="f-l">加入別人發出的在線清單</div><div class="row"><label class="f" style="flex:2 1 0;min-width:0"><input id="liveCode" placeholder="貼上連結"></label><button class="btn" data-a="liveJoin" style="align-self:flex-end">加入</button></div>`;
}
/* who has replied to the list: each browser is one uid (even without a login), shown with the name it gave */
function liveWho(L) {
  const P = new Map();
  for (const m of (LV.rep.get(L.id) || new Map()).values()) for (const d of m.values()) {
    const p = P.get(d.uid) || { by: d.by || '', n: 0, ph: 0, last: 0 }; P.set(d.uid, p);
    p.n++; p.ph += Object.keys(d.photos || {}).length; if ((d.mod || 0) >= p.last) { p.last = d.mod || 0; p.by = d.by || p.by; }
  }
  if (!P.size) return '<div class="note">還沒有人回復。</div>';
  const rows = [...P].sort((a, b) => b[1].last - a[1].last).map(([u, p]) => `<div class="li" style="display:block"><b>${esc(p.by || '未填名字')}</b>${u === myUid() ? '（本機）' : ''}　<span style="font-family:var(--mono);font-size:12px;color:var(--muted)">ID ${esc(u.slice(0, 6))}</span><br><span style="font-size:13px;color:var(--muted)">${p.n} 項回復　·　${p.ph} 張相　·　最後 ${fmtTime(p.last)}</span></div>`).join('');
  return `<div class="f-l">回復人員（${P.size} 人；ID 代表一部機的瀏覽器，同名不同 ID 即不同機）</div><div class="list">${rows}</div>`;
}
async function liveAction(a, b) {
  const L = liveOf(curRound());
  if (a === 'livePub') {
    const pw = $('#livePw') ? $('#livePw').value : ''; if ($('#livePw') && !pw) return toast('請輸入發佈密碼');
    if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = `再按一次確認：上載並永久鎖定「${curRound().name}」（${roundItems().length} 項）`; return; }
    return livePublish(curRound(), pw);
  }
  if (a === 'liveJoin') return liveJoin($('#liveCode').value);
  if (!L) return;
  const url = liveLink(L.id);
  if (a === 'liveShare' && navigator.share) { try { await navigator.share({ title: `${curRound().name} 在線回復`, url }); } catch (e) { } return; }
  try { await navigator.clipboard.writeText(url); toast('已複製連結'); } catch (e) { toast('未能複製，請長按連結自行複製'); }
}

/* ---- start: a ?live= link joins its list; lists already here reconnect ---- */
async function liveBoot() {
  addEventListener('online', liveKick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) liveKick(); });
  const m = location.search.match(/[?&]live=([a-z0-9]+)/i);
  if (m) { history.replaceState(null, '', location.pathname); if (LIVE_CFG) await liveJoin(m[1]); else toast('這個版本未設定在線伺服器', 5000); }
  liveKick();
}
function liveKick() {
  const rs = S.rounds.filter(liveOf); if (!rs.length || !LIVE_CFG) return;
  liveInit().then(() => { rs.forEach(liveWatch); liveFlush(); liveDownload(); }).catch(e => { LV.err = e.message; updateBar(); });
}
