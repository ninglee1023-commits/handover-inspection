const { chromium, devices } = require('playwright');
const fs = require('fs');
const DIR = __dirname;
const DEV = {
  ipad: { ...devices['iPad Pro 11 landscape'], deviceScaleFactor: 1.5 },
  ipadP: { ...devices['iPad Pro 11'], deviceScaleFactor: 1.5 },
  iphone: { ...devices['iPhone 14 Pro'] },
  aphone: { ...devices['Pixel 7'] },
  atab: { ...devices['Galaxy Tab S4 landscape'], deviceScaleFactor: 1.5 },
};
async function setup(name) {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const cfg = DEV[name];
  const ctx = await b.newContext({ ...cfg, acceptDownloads: true, locale: 'zh-HK', timezoneId: 'Asia/Hong_Kong', permissions: ['camera'] });
  if (name.startsWith('ip')) await ctx.addInitScript(() => { navigator.canShare = () => true; navigator.share = () => new Promise(r => setTimeout(r, 200)); });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('ERR', e.message));
  const out = `${DIR}/shots/${name}`; fs.mkdirSync(out, { recursive: true });
  const man = []; let n = 0;
  const S = {
    p, b,
    async shot(id, extra = {}) { if (extra.hl) { try { extra.hlBox = await p.locator(extra.hl).first().boundingBox(); } catch (e) { } } const f = `${out}/${String(++n).padStart(2, '0')}_${id}.png`; await p.screenshot({ path: f }); man.push({ id, f, ...extra }); return f; },
    async tap(sel, id, opt = {}) {
      const el = typeof sel === 'string' ? p.locator(sel).first() : sel;
      const bb = await el.boundingBox(); const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
      if (id) await S.shot(id, { tap: [x, y], ...opt });
      // a button pushed off-screen (phone top bar) is clicked through the DOM instead
      await el.click({ timeout: 4000 }).catch(() => el.evaluate(e => e.click())); await p.waitForTimeout(opt.wait ?? 700);
    },
    async tapXY(x, y, id, wait = 900) { if (id) await S.shot(id, { tap: [x, y] }); await p.mouse.click(x, y); await p.waitForTimeout(wait); },
    async drag(pts, id) { // draw on canvas
      await p.mouse.move(...pts[0]); await p.mouse.down();
      for (const q of pts.slice(1)) await p.mouse.move(q[0], q[1], { steps: 6 });
      await p.mouse.up(); await p.waitForTimeout(300); if (id) await S.shot(id, { path: pts });
    },
    vp: cfg.viewport,
    save() { fs.writeFileSync(`${out}/manifest.json`, JSON.stringify({ vp: cfg.viewport, dpr: cfg.deviceScaleFactor, shots: man }, null, 1)); },
  };
  p.on('filechooser', async fc => { const f = S.nextPhoto || 'before.jpg'; await fc.setFiles(`${DIR}/${f}`); });
  await p.goto('http://localhost:8123/'); await p.waitForTimeout(4500);
  return S;
}
module.exports = { setup };
