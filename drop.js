'use strict';
/* ================= v0.10.21: 傳送碼 (hand a backup to another device through the cloud) =================
   The sender's backup ZIP (a round, or a 回復包) is built in memory only and uploaded to Firestore under a
   6-digit code: drops/{code} (uid, name, label, by, size, n, ready, got, expireAt) and drops/{code}/chunks/{i}
   (data = up to 900 KB of the ZIP, expireAt). The other device types the code, or scans its QR code inside the
   app, downloads the chunks and imports them exactly like a ZIP file. Any number of devices may receive it until
   it expires (24 h) or the sender presses 結束傳送. Nothing is saved as a file on either device.
   Cleaning up: the rules refuse to serve an expired code; a TTL policy on the drops and chunks collection groups
   (field expireAt) deletes it in the cloud, and the sending device also deletes its own expired codes on start. */
const DROP_CH = 900000, DROP_TTL = 24 * 3600e3, DROP_MAX = 300 * 1048576;
const dropRef = (code, ...p) => LV.fb.doc(LV.db, 'drops', code, ...p);
const dropLink = code => location.origin + location.pathname + '?drop=' + code;
const dropFmt = code => code.slice(0, 3) + ' ' + code.slice(3);
const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
const DR = { unsub: null, scan: null };

// run fn over 0..n-1, k at a time
async function dropPool(n, k, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(k, n) }, async () => { while (i < n) await fn(i++); })); }

async function dropSend(blob, name, label) {
  if (!LIVE_CFG) return toast('未設定在線伺服器（Firebase）');
  if (blob.size > DROP_MAX) return toast(`檔案太大（${mb(blob.size)}），請改用「備份此批次」再經 AirDrop／雲端硬碟傳送`, 7000);
  try {
    busy('正在連接伺服器…'); await liveInit(); const F = LV.fb;
    const n = Math.max(1, Math.ceil(blob.size / DROP_CH)), exp = Date.now() + DROP_TTL, expireAt = F.Timestamp.fromMillis(exp);
    let code = '';
    for (let t = 0; t < 8 && !code; t++) {
      const c = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
      try { await F.setDoc(dropRef(c), { uid: LV.uid, name, label, by: S.settings.inspector || '', size: blob.size, n, ready: false, got: 0, created: Date.now(), expireAt }); code = c; }
      catch (e) { if (e.code !== 'permission-denied') throw e; } // taken: try another code
    }
    if (!code) throw new Error('未能取得傳送碼，請再試');
    S.settings.drops = [...(S.settings.drops || []).filter(d => d.exp > Date.now()), { code, n, exp, name, label }]; await saveKV();
    let done = 0;
    await dropPool(n, 3, async i => {
      const part = new Uint8Array(await blob.slice(i * DROP_CH, (i + 1) * DROP_CH).arrayBuffer());
      await F.setDoc(dropRef(code, 'chunks', String(i)), { data: F.Bytes.fromUint8Array(part), expireAt });
      busy(`正在上載 ${++done}／${n}（共 ${mb(blob.size)}）`);
    });
    await F.updateDoc(dropRef(code), { ready: true });
    busy(); dropPanel(code); return true;
  } catch (e) { busy(); toast('傳送失敗：' + e.message, 6000); console.error(e); }
}

function dropPanel(code) {
  const d = (S.settings.drops || []).find(x => x.code === code); if (!d) return;
  const qr = qrFor(dropLink(code));
  openPanel('drop', '傳送碼', `
    <div class="note">${esc(d.label)}</div>
    <div style="text-align:center;font-size:44px;font-weight:700;letter-spacing:4px;font-variant-numeric:tabular-nums">${dropFmt(code)}</div>
    ${qr ? `<div style="text-align:center"><img src="${qr.createDataURL(5, 8)}" alt="傳送碼二維碼" style="width:200px;image-rendering:pixelated"></div>` : ''}
    <div class="safe ok"><b id="dropGot">等待對方接收…</b><span>有效至 ${fmtTime(d.exp)}，期間可以讓多部機接收</span></div>
    <div class="note">對方在程式內按「導出 → 接收傳送碼」，輸入上面 6 位數字，或按「掃描二維碼」掃這個畫面。iPad／iPhone 主畫面的程式請用程式內的掃描，不要用相機 App 掃（會在 Safari 開啟，記錄不會進入主畫面的程式）。</div>
    <div class="row"><button class="btn" data-a="share">分享連結</button><button class="btn warn" data-a="end">結束傳送（從雲端刪除）</button></div>`);
  if (DR.unsub) DR.unsub();
  DR.unsub = LV.fb.onSnapshot(dropRef(code), s => {
    if (S.panel !== 'drop') { DR.unsub && DR.unsub(); DR.unsub = null; return; }
    const g = s.exists() ? s.data().got || 0 : 0, el = $('#dropGot'); if (el) el.textContent = g ? `已有 ${g} 部機接收` : '等待對方接收…';
  }, () => { });
  panel.querySelector('.pb').onclick = async e => {
    const a = e.target.dataset.a;
    if (a === 'share') { const url = dropLink(code); if (navigator.share) { try { await navigator.share({ title: `傳送碼 ${dropFmt(code)}`, text: `${d.label}\n傳送碼：${code}`, url }); } catch (x) { } } else { try { await navigator.clipboard.writeText(url); toast('已複製連結'); } catch (x) { } } }
    if (a === 'end') { if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = '再按一次確認結束（之後不能再接收）'; return; } await dropEnd(d); closePanel(); toast('已結束傳送，雲端的檔案已刪除'); }
  };
}

async function dropEnd(d, quiet) {
  try {
    if (!quiet) busy('正在刪除…'); await liveInit(); const F = LV.fb;
    await dropPool(d.n, 4, i => F.deleteDoc(dropRef(d.code, 'chunks', String(i))).catch(() => { }));
    await F.deleteDoc(dropRef(d.code)).catch(() => { });
  } catch (e) { console.error(e); }
  if (!quiet) busy(); S.settings.drops = (S.settings.drops || []).filter(x => x.code !== d.code); await saveKV();
}

function dropRecvPanel() {
  openPanel('droprecv', '接收傳送碼', `
    <label class="f">傳送碼（6 位數字）<input id="dropCode" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="例如 123 456" style="font-size:24px;letter-spacing:3px"></label>
    <button class="btn p" data-a="get">接收</button>
    <button class="btn" data-a="scan">掃描二維碼</button>
    <div class="note">收到後即時匯入這部機，與「匯入備份檔」相同：同一記錄以較新的版本為準，回復包會自動對回原本的項目。不會在手機另存檔案。</div>`, { compact: true });
  const inp = $('#dropCode'); inp.focus();
  inp.onkeydown = e => { if (e.key === 'Enter') dropReceive(inp.value); };
  panel.querySelector('.pb').onclick = e => { const a = e.target.dataset.a; if (a === 'get') dropReceive(inp.value); if (a === 'scan') dropScan(); };
}

async function dropReceive(text) {
  const m = String(text || '').match(/drop=(\d{6})/) || String(text || '').replace(/\s/g, '').match(/^(\d{6})$/);
  if (!m) return toast('請輸入 6 位數字的傳送碼');
  const code = m[1];
  try {
    busy('正在連接伺服器…'); await liveInit(); const F = LV.fb;
    let h; try { const s = await F.getDoc(dropRef(code)); h = s.exists() ? s.data() : null; } catch (e) { if (e.code !== 'permission-denied') throw e; }
    if (!h) throw new Error('傳送碼不正確或已過期');
    if (!h.ready) throw new Error('對方仍在上載，請稍後再試');
    const parts = new Array(h.n); let done = 0;
    await dropPool(h.n, 3, async i => {
      const s = await F.getDoc(dropRef(code, 'chunks', String(i)));
      if (!s.exists()) throw new Error('檔案不完整，請對方重新傳送');
      parts[i] = s.data().data.toUint8Array(); busy(`正在下載 ${++done}／${h.n}（共 ${mb(h.size)}）`);
    });
    const blob = new Blob(parts, { type: 'application/zip' });
    if (blob.size !== h.size) throw new Error('檔案不完整，請對方重新傳送');
    F.updateDoc(dropRef(code), { got: F.increment(1) }).catch(() => { });
    await importBackup(new File([blob], h.name || 'drop.zip', { type: 'application/zip' }));
  } catch (e) { busy(); toast('接收失敗：' + e.message, 6000); console.error(e); }
}

/* the camera, inside the app (so a home-screen app on iPad keeps the records): jsQR on the video frames */
async function dropScan() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.jsQR) return toast('這部機不能在程式內掃描，請輸入 6 位數字');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch (e) { return toast('未能開啟相機：' + (e.name === 'NotAllowedError' ? '請在設定允許使用相機' : e.message), 5000); }
  openPanel('dropscan', '掃描傳送碼', `<video id="dropVid" playsinline muted autoplay style="width:100%;border-radius:8px;background:#000"></video><div class="note">把對方畫面上的二維碼放在框內。</div><button class="btn" data-a="type">改為輸入數字</button>`, { compact: true });
  const v = $('#dropVid'); v.srcObject = stream; v.play().catch(() => { });
  const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
  const stop = () => { stream.getTracks().forEach(t => t.stop()); c.width = c.height = 0; };
  panel.querySelector('.pb').onclick = e => { if (e.target.dataset.a === 'type') { stop(); dropRecvPanel(); } };
  const tick = () => {
    if (S.panel !== 'dropscan' || !v.isConnected) return stop();
    if (v.readyState >= 2 && v.videoWidth) {
      const k = Math.min(1, 800 / Math.max(v.videoWidth, v.videoHeight)); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
      x.drawImage(v, 0, 0, c.width, c.height);
      const r = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
      if (r && /drop=\d{6}/.test(r.data)) { stop(); closePanel(); return dropReceive(r.data); }
    }
    setTimeout(tick, 200);
  };
  tick();
}

/* ---- start: a ?drop= link receives; this device's expired codes are deleted ---- */
async function dropBoot() {
  const m = location.search.match(/[?&]drop=(\d{6})/);
  if (m) { history.replaceState(null, '', location.pathname); if (LIVE_CFG) await dropReceive(m[1]); }
  const old = (S.settings.drops || []).filter(d => d.exp <= Date.now());
  if (old.length && navigator.onLine) liveInit().then(async () => { for (const d of old) await dropEnd(d, true); }).catch(() => { });
}
