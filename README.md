# 竣工驗收記錄 (handover-inspection)

iPad 竣工驗收程式：在 GBP 平面圖上點選位置 → 拍照 → 加箭頭／圈選 → 自動帶出 座-層-單位-房間 及 Grid → 導出 Word 報告（A4 橫向，可另存 PDF）。

- 網址：https://ninglee1023-commits.github.io/handover-inspection/
- 圖紙：`gbp/plans.pdf`（GBP 13th Amd 平面圖頁 P3-8、13-20，向量原檔，放大保持清晰）
- 位置設定：`gbp/mapping.json`（GBP 軸線文字＋售樓說明書單位範圍生成）
- 資料存在 iPad Safari 的 IndexedDB，請「加入主畫面」並定期導出備份。
- 函式庫：pdf.js 3.11.174、docx 8.5.0（已放在 lib/）。
