const { setup } = require('./cap');
(async () => {
  const name = process.argv[2] || 'ipad';
  const S = await setup(name); const p = S.p; // node flow.js <ipad|ipadP|iphone|aphone|atab>
  await S.shot('setup');
  await p.fill('#sDev', 'A'); await p.fill('#sBy', '陳大文'); await S.shot('setup_filled');
  await S.tap('#sOk', 'setup_ok', { wait: 1000 });
  await S.tap('#btnDrawings', 'drawings_btn');
  await S.tap(p.locator('[data-open]', { hasText: '5th–30th' }).first(), 'drawings', { wait: 6500 });
  await S.shot('plan');
  await S.tap('#btnFloor', 'floor_btn');
  await S.tap(p.locator('[data-f="18F"]'), 'floor_pick', { wait: 600 });
  await p.click('#panel .x'); await p.waitForTimeout(500);
  await S.tap('#zIn', 'zoom_in', { wait: 500 }); await S.tap('#zIn', null, { wait: 800 });
  const inner = (fl, fx, fy) => p.evaluate(([fl, fx, fy]) => { const d = curD(); const z = d.views[0].zones.find(z => z.kind === 'flat' && z.name === fl); const xs = z.pts.map(q => q[0]), ys = z.pts.map(q => q[1]); const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); let best = null;
    for (let i = 1; i < 30; i++) for (let j = 1; j < 30; j++) { const x = x0 + (x1 - x0) * i / 30, y = y0 + (y1 - y0) * j / 30; if (!inPoly(x, y, z.pts)) continue; const dd = Math.hypot(x - (x0 + (x1 - x0) * fx), y - (y0 + (y1 - y0) * fy)); if (!best || dd < best.dd) best = { x, y, dd }; }
    return best; }, [fl, fx, fy]);
  const toScr = q => p.evaluate(q => { const r = document.querySelector('#stage').getBoundingClientRect(); return [r.left + S.view.x + S.view.k * q.x, r.top + S.view.y + S.view.k * q.y]; }, q);
  const q1 = await inner('D', 0.5, 0.5); await p.evaluate(q => centerOn(q.x, q.y, 1.1), q1); await p.waitForTimeout(1200);
  const pt = await toScr(q1);
  S.nextPhoto = 'before.jpg';
  await S.tapXY(pt[0], pt[1], 'tap_spot', 2500);
  await S.shot('editor');
  const cb = await p.locator('#edCanvas').boundingBox();
  const C = (fx, fy) => [cb.x + cb.width * fx, cb.y + cb.height * fy];
  await S.drag([C(0.62, 0.78), C(0.45, 0.68)], 'arrow');
  await S.tap('[data-ed="tool"][data-v="ellipse"]', 'ellipse_tool', { wait: 300 });
  await S.drag([C(0.66, 0.16), C(0.86, 0.70)], 'ellipse');
  await S.tap('[data-ed="done"]', 'editor_done', { wait: 2000 });
  await S.shot('item');
  await p.waitForTimeout(1500);
  await S.shot('item_new');
  await p.selectOption('#fFlat', 'D'); await p.waitForTimeout(600); await S.shot('flat_set', { hl: '#fFlat' });
  await S.tap(p.locator('[data-room="Living/Dining"]'), 'room', { wait: 500 });
  await p.locator('#fNote').scrollIntoViewIfNeeded(); await p.fill('#fNote', '客廳牆身裂紋；大門下門鉸鬆脫'); await p.waitForTimeout(300);
  await S.shot('note', { hl: '#fNote' });
  await p.selectOption('#fSub', '承達'); await p.waitForTimeout(600);
  await p.locator('.chips.subs').scrollIntoViewIfNeeded(); await S.shot('sub', { hl: '.chips.subs' });
  await p.locator('[data-a="done"]').scrollIntoViewIfNeeded(); await S.tap('[data-a="done"]', 'item_done', { wait: 800 });
  await S.shot('after_item');
  // two more quick items
  for (const [fl, fx, fy, note, sub] of [['C', 0.4, 0.5, '睡房窗框打膠不足', '偉業'], ['E', 0.5, 0.5, '廚房地台磚空鼓', '']]) {
    const q = await inner(fl, fx, fy); await p.evaluate(q => centerOn(q.x, q.y, 1.1), q); await p.waitForTimeout(900);
    const s2 = await toScr(q); await p.mouse.click(...s2); await p.waitForTimeout(2200); await p.click('[data-ed="done"]'); await p.waitForTimeout(2200);
    await p.selectOption('#fFlat', fl); await p.waitForTimeout(400); await p.click('[data-room="Bedroom 1"]'); await p.waitForTimeout(300);
    await p.fill('#fNote', note); if (sub) await p.selectOption('#fSub', sub); await p.waitForTimeout(400); await p.click('[data-a="done"]'); await p.waitForTimeout(700);
  }
  await p.click('#zFit'); await p.waitForTimeout(800); await p.click('#zIn'); await p.waitForTimeout(400); await p.click('#zIn'); await p.waitForTimeout(400);
  await p.evaluate(q => centerOn(q.x, q.y, 0.6), q1); await p.waitForTimeout(1500);
  await S.shot('pins');
  await S.tap('#btnItems', 'items_btn'); await S.shot('items');
  await S.tap('#btnRound', 'round_btn'); await S.shot('round');
  await p.click('#panel .x'); await p.waitForTimeout(400);
  // reply / 回復 with after photo
  await S.tap('#btnItems', null); await S.tap(p.locator('#panel .li').first(), 'items_open', { wait: 900 });
  S.nextPhoto = 'after.jpg';
  await S.tap('[data-a="reply"]', 'reply_btn', { wait: 2200 });
  await S.shot('reply_editor');
  await S.tap('[data-ed="done"]', null, { wait: 2000 });
  await S.shot('reply_done');
  await p.locator('#fxReply').scrollIntoViewIfNeeded().catch(() => {}); await p.fill('#fxReply', '已修補批盪及更換門鉸').catch(() => {}); await p.waitForTimeout(400);
  await S.shot('reply_text', { hl: '#fxReply' });
  await p.locator('[data-a="done"]').scrollIntoViewIfNeeded(); await p.click('[data-a="done"]'); await p.waitForTimeout(600);
  // export
  await S.tap('#btnExport', 'export_btn'); await S.shot('export');
  await p.fill('#pName', '示範住宅發展項目'); await p.fill('#pCo', '示範建築有限公司'); await p.locator('#pName').dispatchEvent('change');
  await p.locator('[data-a="preview"]').scrollIntoViewIfNeeded(); await S.shot('export_fields', { hl: '[data-a="preview"]' });
  await S.tap('[data-a="preview"]', 'preview_btn', { wait: 6000 }); await S.shot('preview');
  await p.mouse.wheel(0, 700); await p.waitForTimeout(800); await S.shot('preview2');
  await S.tap('[data-pv="close"]', null);
  if (await p.evaluate(() => S.panel !== 'export')) await S.tap('#btnExport', null);
  await p.selectOption('#pKind', 'fixdone'); await p.locator('#pKind').dispatchEvent('change'); await p.waitForTimeout(300);
  await p.locator('[data-a="preview"]').scrollIntoViewIfNeeded(); await S.shot('fix_kind', { hl: '#pKind' });
  await S.tap('[data-a="preview"]', null, { wait: 6000 }); await S.shot('fix_preview');
  await S.tap('[data-pv="close"]', null);
  if (await p.evaluate(() => S.panel !== 'export')) await S.tap('#btnExport', null);
  await p.locator('[data-a="set:sub"]').scrollIntoViewIfNeeded(); await S.shot('batch', { hl: '[data-a="set:sub"]' });
  await p.locator('[data-a="imp"]').scrollIntoViewIfNeeded(); await S.shot('merge', { hl: '[data-a="imp"]' });
  await p.locator('#sAlb').scrollIntoViewIfNeeded(); await S.shot('local', { hl: '#sAlb' });
  await p.locator('[data-a="bknew"]').scrollIntoViewIfNeeded(); await S.shot('backup', { hl: '[data-a="bknew"]' });
  console.log(await p.locator('#panel').innerText());
  S.save(); await S.b.close();
})();
