# 使用教學影片

`../tutorial.mp4`：1920×1080，約 5 分 40 秒，粵語旁白＋字幕。內容：

1. 安裝（加入主畫面）— iOS Safari 與 Android Chrome 的步驟
2. 設定本機代號 → 選擇圖紙及樓層 → 點選位置拍照 → 標記 → 填寫座／層／單位／房間／分判
3. 記錄清單、驗收批次、執修回復
4. 導出報告（驗收報告、回復報告、分批 PDF）、備份及合併
5. 平板與手機的分別（側邊面板 vs 底部面板、標記工具排列）
6. iOS 與 Android 的分別（存入相簿、分享／下載）

畫面全部由真實程式在模擬裝置上截取（iPad Pro 11 橫／直、iPhone 14 Pro、Pixel 7、Galaxy Tab S4）。

## 程式更新後重新製作

需要 Node + Playwright、Python 3 + Pillow、ffmpeg、`pip install edge-tts`（需連網）。

```sh
cd tutorial/src
python3 -m http.server 8123 --directory ../.. &      # 本程式
python3 mkphoto.py                                   # 示範相片 before.jpg / after.jpg
for d in ipad ipadP iphone aphone atab; do node flow.js $d; done   # 截圖 → shots/
python3 tts_all.py                                   # 旁白 → audio/（VOICE=zh-TW-HsiaoChenNeural 可改普通話）
mkdir -p fonts  # 放入 Noto Sans CJK TC：fonts/tc-Regular.otf、fonts/tc-Bold.otf
python3 render.py build/tutorial.mp4                 # 或 python3 render.py still 10@4 預覽單格
```

旁白文字及每句配合的畫面在 `script.py`。
