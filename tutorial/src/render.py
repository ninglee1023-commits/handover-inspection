import json, subprocess, sys, math, wave, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from script import SCENES, D
W, H, FPS = 1920, 1080, 25
GAP = 0.45            # silence after each line
XF = 0.3              # crossfade seconds
BG = (22, 29, 32); PANEL = (29, 38, 41); FG = (232, 238, 236); MUTED = (150, 166, 163); RED = (212, 42, 30); HL = (242, 194, 48); OK = (63, 166, 106); BLUE = (31, 111, 156)
FB, FR = 'fonts/tc-Bold.otf', 'fonts/tc-Regular.otf'
_fc = {}
def F(sz, b=False):
    k = (sz, b)
    if k not in _fc: _fc[k] = ImageFont.truetype(FB if b else FR, sz)
    return _fc[k]
MAN = {d: json.load(open(f'shots/{d}/manifest.json')) for d in D}
def shot(dev, sid):
    m = MAN[dev]
    for s in m['shots']:
        if s['id'] == sid: return s, m
    raise KeyError((dev, sid))

def rrect(dr, box, r, **kw): dr.rounded_rectangle(box, r, **kw)
def wrap(text, font, maxw, dr):
    import re
    toks = re.findall(r'[A-Za-z0-9\-\.]+|.', text)   # keep latin words whole
    lines, cur = [], ''
    for tk in toks:
        if dr.textlength(cur + tk, font=font) > maxw and cur.strip():
            if tk in '，。、；：」）！？': cur += tk; lines.append(cur); cur = ''; continue
            lines.append(cur); cur = tk.lstrip()
        else: cur += tk
    if cur: lines.append(cur)
    return lines

TOP, SUB_Y = 96, 912   # main area between
def chrome(img, chap_no, chap, say):
    dr = ImageDraw.Draw(img)
    if chap:
        rrect(dr, (48, 26, 48 + 64, 26 + 50), 12, fill=RED)
        dr.text((80, 51), f'{chap_no:02d}', font=F(28, True), fill='white', anchor='mm')
        dr.text((132, 51), chap, font=F(34, True), fill=FG, anchor='lm')
        dr.text((W - 48, 51), '竣工驗收記錄・使用教學', font=F(24), fill=MUTED, anchor='rm')
    if say:
        f = F(38, True); lines = wrap(say, f, W - 260, dr)
        lh = 54; h = lh * len(lines) + 34; y0 = 1080 - 30 - h
        rrect(dr, (100, y0, W - 100, y0 + h), 18, fill=(10, 14, 16))
        for i, l in enumerate(lines): dr.text((W // 2, y0 + 17 + lh * i + lh // 2), l, font=f, fill='white', anchor='mm')
    return img

def framed(dev, sid, maxw, maxh, label=None, t_frac=None):
    """device bezel + screenshot, plus tap ripple / highlight. returns RGBA image"""
    s, m = shot(dev, sid)
    im = Image.open(s['f']).convert('RGB')
    phone = m['vp']['width'] < 600
    bez = 14 if phone else 18
    lab_h = 52 if label else 0
    k = min((maxw - 2 * bez) / im.width, (maxh - 2 * bez - lab_h) / im.height)
    sw, sh = int(im.width * k), int(im.height * k)
    im = im.resize((sw, sh), Image.LANCZOS)
    dr = ImageDraw.Draw(im, 'RGBA'); css = k * m['dpr']
    if s.get('hlBox'):
        b = s['hlBox']; pad = 6
        box = (b['x'] * css - pad, b['y'] * css - pad, (b['x'] + b['width']) * css + pad, (b['y'] + b['height']) * css + pad)
        a = 255 if t_frac is None else int(160 + 95 * (0.5 + 0.5 * math.sin(t_frac * 12)))
        dr.rounded_rectangle(box, 10, outline=HL + (a,), width=5)
    if s.get('tap') and t_frac is not None and t_frac > 0.45:
        x, y = s['tap'][0] * css, s['tap'][1] * css
        p = min(1, (t_frac - 0.45) / 0.4)
        r0 = 16 + 10 * p
        dr.ellipse((x - r0, y - r0, x + r0, y + r0), fill=(212, 42, 30, 150), outline=(255, 255, 255, 230), width=3)
        r1 = 18 + 40 * p
        dr.ellipse((x - r1, y - r1, x + r1, y + r1), outline=(212, 42, 30, int(230 * (1 - p))), width=4)
    fw, fh = sw + 2 * bez, sh + 2 * bez
    out = Image.new('RGBA', (fw, fh + lab_h), (0, 0, 0, 0))
    od = ImageDraw.Draw(out)
    rad = 44 if phone else 30
    od.rounded_rectangle((0, 0, fw - 1, fh - 1), rad, fill=(8, 10, 11), outline=(70, 84, 86), width=2)
    mask = Image.new('L', (sw, sh), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), rad - bez + 4, fill=255)
    out.paste(im, (bez, bez), mask)
    if label:
        od.text((fw // 2, fh + 30), label, font=F(28, True), fill=FG, anchor='mm')
    return out

def screen_frame(slots, idx_list, t_fracs, say_area_h):
    """compose device slots into main area"""
    img = Image.new('RGB', (W, H), BG)
    n = len(slots); top = TOP + 6; avail_h = SUB_Y - top - (0 if n == 1 else 0)
    gap = 40; avail_w = W - 120
    ims = []
    for (dev, ids, label), i, tf in zip(slots, idx_list, t_fracs):
        ims.append(framed(dev, ids[i], (avail_w - gap * (n - 1)) / n if n > 1 else avail_w, avail_h, label, tf))
    # if slots are narrow (phones), they may not use full width; center the group
    tot = sum(x.width for x in ims) + gap * (n - 1)
    x = (W - tot) // 2
    for im in ims:
        y = top + (avail_h - im.height) // 2
        img.paste(im, (x, y), im); x += im.width + gap
    return img

def card(name):
    img = Image.new('RGB', (W, H), BG); dr = ImageDraw.Draw(img)
    def box(x0, y0, x1, y1, title, color, lines, sub=None):
        rrect(dr, (x0, y0, x1, y1), 24, fill=PANEL, outline=(52, 64, 63), width=2)
        rrect(dr, (x0, y0, x1, y0 + 86), 24, fill=color); dr.rectangle((x0, y0 + 60, x1, y0 + 86), fill=color)
        dr.text(((x0 + x1) // 2, y0 + 43), title, font=F(36, True), fill='white', anchor='mm')
        y = y0 + 120
        for i, l in enumerate(lines):
            if isinstance(l, tuple): num, txt = l
            else: num, txt = None, l
            x = x0 + 40
            if num:
                dr.ellipse((x, y, x + 46, y + 46), fill=color); dr.text((x + 23, y + 23), str(num), font=F(26, True), fill='white', anchor='mm'); x += 66
            for j, ln in enumerate(wrap(txt, F(32), x1 - x - 36, dr)):
                dr.text((x, y + 4 + j * 46), ln, font=F(32), fill=FG); 
            y += 46 * len(wrap(txt, F(32), x1 - x - 36, dr)) + 28
        if sub:
            for j, ln in enumerate(wrap(sub, F(27), x1 - x0 - 80, dr)): dr.text((x0 + 40, y1 - 40 - 40 * (len(wrap(sub, F(27), x1 - x0 - 80, dr)) - 1 - j)), ln, font=F(27), fill=MUTED, anchor='ls')
    if name == 'title':
        ic = Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../icon-512.png')).convert('RGBA').resize((200, 200))
        img.paste(ic, (W // 2 - 100, 170), ic)
        dr.text((W // 2, 470), '竣工驗收記錄', font=F(96, True), fill=FG, anchor='mm')
        dr.text((W // 2, 570), '使用教學', font=F(52), fill=MUTED, anchor='mm')
        tags = ['iPad', 'iPhone', 'Android 手機', 'Android 平板']
        fs = F(32, True); ws = [dr.textlength(t, font=fs) + 60 for t in tags]; x = (W - sum(ws) - 20 * 3) // 2
        for t, w in zip(tags, ws):
            rrect(dr, (x, 650, x + w, 714), 32, outline=RED, width=3); dr.text((x + w / 2, 682), t, font=fs, fill=FG, anchor='mm'); x += w + 20
    if name == 'install':
        box(100, 130, 930, 860, 'iPad／iPhone（Safari）', (60, 70, 74), [(1, '用 Safari 開啟程式網址'), (2, '按「分享」按鈕（方框加向上箭咀）'), (3, '選「加入主畫面」→「加入」'), (4, '以後從主畫面圖示開啟')], '⚠ 不要用無痕瀏覽（例如由 WhatsApp 直接開啟的連結），關閉分頁後資料會消失')
        box(990, 130, 1820, 860, 'Android 手機／平板（Chrome）', (47, 125, 79), [(1, '用 Chrome 開啟程式網址'), (2, '按右上角三點選單'), (3, '選「安裝應用程式」或「加到主畫面」'), (4, '以後從主畫面圖示開啟')], '第一次開啟需要連網；之後到地盤可離線使用')
    if name == 'album':
        box(100, 130, 930, 860, 'iPad／iPhone', (60, 70, 74), [(1, '拍照、標記後按「完成」'), (2, '自動彈出分享選單'), (3, '選「儲存影像」'), (4, '照片存入「相片」App')], '照片底部印有編號、位置、時間及檢查人員')
        box(990, 130, 1820, 860, 'Android 手機／平板', (47, 125, 79), [(1, '拍照、標記後按「完成」'), (2, '不會彈出分享選單'), (3, '照片自動下載到「Download」資料夾'), (4, '在相簿 App 的「Download」可找到')], '漏存的照片：導出 → 存入相簿')
    if name == 'share':
        cols = [('iPad／iPhone', (60, 70, 74), ['打開分享選單', '存到「檔案」／iCloud Drive', '或傳送到 WhatsApp、電郵']),
                ('Android', (47, 125, 79), ['打開分享選單', '存到 Google Drive／檔案', '或傳送到 WhatsApp、電郵']),
                ('電腦', BLUE, ['直接下載', '在瀏覽器的「下載」找到檔案', '適合在辦公室整理報告'])]
        x = 100; w = (W - 200 - 2 * 40) // 3
        for t, c, ls in cols: box(x, 200, x + w, 820, t, c, ls); x += w + 40
        dr.text((W // 2, 140), '導出 PDF／Word／備份 ZIP 時', font=F(40, True), fill=FG, anchor='mm')
    if name == 'end':
        dr.text((W // 2, 190), '記住三件事', font=F(64, True), fill=FG, anchor='mm')
        items = [('從主畫面圖示開啟', '資料長期保存，可離線使用'), ('每部機設定不同代號', 'A、B、C… 合併時不會撞號'), ('每日完工前備份', '導出 → 備份新增記錄')]
        y = 300
        for i, (a, b) in enumerate(items):
            rrect(dr, (360, y, W - 360, y + 150), 24, fill=PANEL, outline=(52, 64, 63), width=2)
            dr.ellipse((400, y + 40, 470, y + 110), fill=RED); dr.text((435, y + 75), str(i + 1), font=F(40, True), fill='white', anchor='mm')
            dr.text((510, y + 52), a, font=F(44, True), fill=FG, anchor='lm'); dr.text((510, y + 108), b, font=F(30), fill=MUTED, anchor='lm')
            y += 180
    return img

def build(out_path, only=None, still=None):
    idx = json.load(open('audio/index.json'))
    beats = []; ci = 0
    for si, (title, bl) in enumerate(SCENES):
        if title: ci += 1
        for bi, (say, scr) in enumerate(bl):
            a = next(x for x in idx if x['s'] == si and x['b'] == bi)
            beats.append(dict(chap_no=ci, chap=title, say=say, scr=scr, audio=a['f'], dur=a['dur'] + GAP + (0.6 if bi == len(bl) - 1 else 0)))
    if only is not None: beats = [beats[i] for i in only]
    os.makedirs('build', exist_ok=True)
    total = 0.5 + sum(b['dur'] for b in beats)
    if still is None:
        with wave.open('build/voice.wav', 'wb') as wo:
            wo.setnchannels(1); wo.setsampwidth(2); wo.setframerate(24000)
            wo.writeframes(b'\0' * 2 * int(24000 * 0.5))
            for b in beats:
                raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', b['audio'], '-f', 's16le', '-ac', '1', '-ar', '24000', '-'])
                n = int(24000 * b['dur']); raw = raw[:n * 2] + b'\0' * max(0, n * 2 - len(raw))
                wo.writeframes(raw)
        ff = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-i', 'build/voice.wav',
                               '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', out_path], stdin=subprocess.PIPE)
    cache = {}
    def frame_for(b, t):
        kind, spec = b['scr']
        if kind == 'card':
            key = ('card', spec, b['say'])
            if key not in cache: cache.clear(); cache[key] = chrome(card(spec), b['chap_no'], b['chap'], b['say'])
            return cache[key], ('card', spec)
        slots = spec; ns = max(len(ids) for _, ids, _ in slots)
        seg = b['dur'] / ns; i = min(ns - 1, int(t / seg)); tf = (t - i * seg) / seg
        idxs = [min(i, len(ids) - 1) for _, ids, _ in slots]
        vkey = tuple(d + ':' + ids[j] for (d, ids, _), j in zip(slots, idxs))
        anim = any(shot(d, ids[j])[0].get('tap') or shot(d, ids[j])[0].get('hlBox') for (d, ids, _), j in zip(slots, idxs))
        if anim: return chrome(screen_frame(slots, idxs, [tf] * len(slots), 0), b['chap_no'], b['chap'], b['say']), vkey
        key = (vkey, b['say'])
        if key not in cache: cache.clear(); cache[key] = chrome(screen_frame(slots, idxs, [None] * len(slots), 0), b['chap_no'], b['chap'], b['say'])
        return cache[key], vkey
    if still is not None:
        bi, t = still; im, _ = frame_for(beats[bi], t); im.save(out_path); return
    first, lastkey = frame_for(beats[0], 0); last = first
    for _ in range(int(0.5 * FPS)): ff.stdin.write(first.tobytes())
    fade_from, fade_n, nx = None, int(XF * FPS), 0
    for bi, b in enumerate(beats):
        for f in range(int(round(b['dur'] * FPS))):
            cur, key = frame_for(b, f / FPS)
            if key != lastkey: fade_from, nx = last, 0
            lastkey = key; last = cur
            if fade_from is not None and nx < fade_n:
                nx += 1; ff.stdin.write(Image.blend(fade_from, cur, nx / fade_n).tobytes())
            else: ff.stdin.write(cur.tobytes())
        sys.stdout.write(f'\rbeat {bi + 1}/{len(beats)}'); sys.stdout.flush()
    ff.stdin.close(); ff.wait(); print('\ndone', total)
if __name__ == '__main__':
    if sys.argv[1] == 'still':
        for a in sys.argv[2:]:
            bi, t = a.split('@'); build(f'build/still_{bi}_{t}.png', None, (int(bi), float(t)))
    else:
        only = [int(x) for x in sys.argv[2].split(',')] if len(sys.argv) > 2 else None
        build(sys.argv[1], only)
