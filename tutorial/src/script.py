# Each scene: chapter title + beats. A beat = one narration line + what is on screen.
# Screen: ('dev', [slots]) where slot = (device, [shot ids], label) ; or ('card', name)
D = {'ipad': 'iPad（橫放）', 'atab': 'Android 平板（橫放）', 'ipadP': 'iPad（直放）', 'iphone': 'iPhone', 'aphone': 'Android 手機'}
def one(dev, *ids): return ('dev', [(dev, list(ids), None)])
def many(*slots): return ('dev', [(d, list(ids), D[d]) for d, ids in slots])
SCENES = [
 ('', [
   ('歡迎使用「竣工驗收記錄」。這段影片會示範如何在圖紙上記錄問題、拍照標記、填寫資料，以及導出報告。', ('card', 'title')),
   ('最後亦會講解 iPad、iPhone、Android 手機和平板在操作上的分別。', ('card', 'title')),
 ]),
 ('安裝：加入主畫面', [
   ('第一步，把程式加入主畫面。iPad 和 iPhone 請用 Safari 開啟網址，按「分享」按鈕，再選「加入主畫面」。', ('card', 'install')),
   ('Android 手機或平板請用 Chrome 開啟，按右上角三點選單，選「安裝應用程式」或「加到主畫面」。', ('card', 'install')),
   ('以後都從主畫面圖示開啟，資料才會長期保存，到地盤亦可以離線使用。iPhone 請不要用無痕瀏覽，否則關閉分頁後資料會消失。', ('card', 'install')),
 ]),
 ('設定本機', [
   ('第一次開啟時，只需要輸入檢查人員的名字，然後按「儲存」。', one('ipad', 'setup', 'setup_filled')),
   ('記錄編號會以名字開頭，例如「陳大文-001」。多部機的記錄合併後，亦分得出是誰做的。', one('ipad', 'setup_ok')),
 ]),
 ('建築及渠務圖紙', [
   ('頂部的「建築｜渠務」可以切換兩套圖紙。兩套圖紙各自有圖紙清單、驗收批次、編號和報告。', one('ipad', 'set_switch')),
   ('第一次切換到渠務時，需要下載大約三十六 MB 的圖紙，請在有網絡的地方先切換一次，到地盤就可以離線使用。', one('ipad', 'drain_btn', 'drainage')),
 ]),
 ('選擇圖紙及樓層', [
   ('按左上角「圖紙」，選擇要驗收的平面圖。', one('ipad', 'drawings_btn', 'drawings')),
   ('標準層圖紙可以按「樓層」，選擇實際驗收的樓層。', one('ipad', 'floor_btn', 'floor_pick')),
   ('兩隻手指開合可以放大縮小，單指拖動可以移動圖紙。右下角有放大、縮小和全圖按鈕，兩個旋轉按鈕可以順時針或逆時針轉九十度，轉動時會保持原來的放大比例。', one('ipad', 'rotate', 'zoom_in')),
 ]),
 ('點選位置及拍照', [
   ('在「驗收」模式下，直接點選圖上的問題位置，程式會自動開啟相機。', one('ipad', 'tap_spot')),
   ('拍照後會進入標記畫面。', one('ipad', 'editor')),
   ('可以用箭頭、圈選、方框或手繪標示問題，下面可以轉換顏色、撤銷或清除標記。', one('ipad', 'arrow', 'ellipse_tool', 'ellipse')),
   ('完成後按右上角紅色的「完成」。', one('ipad', 'editor_done')),
 ]),
 ('填寫記錄資料', [
   ('程式會按點選的位置，自動帶出座數、樓層、單位、房間和軸線。', one('ipad', 'item_new')),
   ('房間如有需要可以改選，再輸入問題描述；問題描述亦可以回到辦公室才填寫。', one('ipad', 'room', 'note')),
   ('然後選擇負責的分判，一項記錄可以選多個分判。最後按「完成」。', one('ipad', 'sub', 'item_done')),
 ]),
 ('記錄清單', [
   ('已記錄的位置會在圖上顯示編號：紅點代表未指定分判，藍點代表已指定分判。', one('ipad', 'pins')),
   ('按「記錄」可以查看清單，並按分判篩選；點選任何一項，就會跳回圖上該位置。', one('ipad', 'items_btn', 'items')),
   ('按「第1次」可以管理驗收批次。複驗時開始新一次驗收，編號重新由一開始，以前的記錄會保留。', one('ipad', 'round_btn', 'round')),
 ]),
 ('執修回復', [
   ('分判完成執修後，打開該項記錄，按綠色的「回復」按鈕，拍攝完成後的照片。', one('ipad', 'items_open', 'reply_btn', 'reply_editor')),
   ('可以再填寫回覆文字，例如「已更換門鉸」。已回復的項目在圖上會變成綠點。', one('ipad', 'reply_done', 'reply_text')),
 ]),
 ('導出報告', [
   ('按「導出」，填寫項目名稱和公司，然後按「預覽報告」。', one('ipad', 'export_btn', 'export', 'export_fields')),
   ('報告採用 OP Inspection Records 格式，每項列出編號、樓層、位置、問題描述、負責分判、位置圖，以及完成前後的照片。預覽後可以導出 PDF 或 Word。', one('ipad', 'preview_btn', 'preview', 'preview2')),
   ('報告類型選「回復報告」，就會列出完成前後的照片對照。', one('ipad', 'fix_kind', 'fix_preview')),
   ('亦可以按分判或按區域分批導出 PDF，方便派發給各分判。', one('ipad', 'batch')),
 ]),
 ('備份及合併', [
   ('所有資料只儲存在這部機內。請每日按「備份新增記錄」，把 ZIP 備份檔存到「檔案」、雲端硬碟或 WhatsApp。', one('ipad', 'backup')),
   ('亦可以按驗收批次備份，每次驗收就是一個獨立的 ZIP 檔，方便交給同事。', one('ipad', 'backup_round')),
   ('同事的備份檔可以在這裏匯入。即使只剩下照片，亦可以用「從相片還原記錄」，把記錄放回圖上原來的位置。', one('ipad', 'merge')),
 ]),
 ('合併驗收批次', [
   ('匯入同事的備份後，每個批次會自成一個「名字-批次名稱」的批次，不會自動合併；圖上同事的記錄會顯示名字的第一個字。', one('ipad', 'round_new', 'round2')),
   ('看過之後，在「驗收批次」最下方的「合併批次」，勾選兩個或以上的批次，輸入合併後的名稱，再按「合併所選批次」，就可以一次出齊全部記錄的報告。', one('ipad', 'round_merge')),
 ]),
 ('平板與手機的分別', [
   ('接下來講解不同裝置的分別。平板橫放時，資料面板在右邊，左邊的圖紙仍然可見。iPad 和 Android 平板的畫面相同。', many(('ipad', ['item_new']), ('atab', ['item_new']))),
   ('手機，或者平板直放時，面板會在畫面下方彈出，大約佔一半高度。', many(('ipadP', ['item_new']), ('iphone', ['item_new']), ('aphone', ['item_new']))),
   ('面板內容較長，請在面板內向上掃動，才看到問題描述、分判和「完成」按鈕。', many(('iphone', ['item_new', 'note', 'sub']), ('aphone', ['item_new', 'note', 'sub']))),
   ('手機的標記畫面，工具會排成兩行，「完成」按鈕在工具列下方。', many(('ipad', ['editor']), ('iphone', ['editor']))),
 ]),
 ('iOS 與 Android 的分別', [
   ('拍照後存入相簿的方式不同。在 iPad 和 iPhone，按「完成」後會彈出分享選單，請選「儲存影像」，照片就會存入「相片」。', ('card', 'album')),
   ('Android 沒有這個選單，照片會自動下載到「Download」資料夾，在相簿 App 就可以找到。', ('card', 'album')),
   ('在「導出」的本機設定可以看到這個選項；如有漏存，可以按「存入相簿」補存。', many(('ipad', ['local']), ('atab', ['local']))),
   ('導出 PDF、Word 或備份時，iOS 和 Android 都會打開分享選單，可以存到檔案、雲端或傳送到 WhatsApp；在電腦上則會直接下載。', ('card', 'share')),
 ]),
 ('總結', [
   ('最後請記住三件事：從主畫面圖示開啟程式；每部機輸入自己的名字；每日完工前備份。多謝收看。', ('card', 'end')),
 ]),
]
