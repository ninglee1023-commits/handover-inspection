# 竣工驗收記錄 (handover-inspection)

離線 iPad 網頁程式：圖紙上點選位置 → 拍照 → 標記箭頭／圈選 → 自動帶出座／層／房間／Grid → 導出 Word 報告。

- 純靜態網頁，放上 GitHub Pages 即可使用；首次開啟後可離線。
- 資料儲存在 iPad Safari 的 IndexedDB，請「加入主畫面」並定期備份（完整、只限新增記錄，或按驗收批次每次驗收一個 ZIP）。
- 同事的備份匯入後，可在「驗收批次 → 合併批次」勾選多個不同名稱的批次，輸入新名稱合併成一個批次，一次出報告。
- 函式庫：pdf.js 3.11.174、docx 8.5.0（已放在 lib/，不需外部 CDN）。
- 兩套圖紙：頂部「建築｜渠務」切換。建築 GBP（gbp/plans.pdf + gbp/mapping.json）及渠務圖（gbp/drainage.pdf 第 8–14、16–24 頁 + gbp/drainage-mapping.json）各自有圖紙清單、驗收批次、編號和報告。渠務圖包第一次切換時下載（約 36 MB）。
