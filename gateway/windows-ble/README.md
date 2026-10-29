# ULD EYE Windows BLE Gateway — Milestone 5

**PENDING PHYSICAL WINDOWS TEST**

M6 補充：本 Gateway 仍只建立 Observation，不推論位置。預設 `WIN-GW-01` Reader
在 Backend 未註冊，維持 M5 last-seen-only 行為。M6 configured Reader 的資料則需經
Backend 兩筆／五秒 Demo evidence policy 才可能確認區域；RSSI 不直接定位。
詳見 [M6 語意邊界](../../docs/ULD-SEMANTICS.md)。

Linux VM 僅完成 synthetic Advertisement／HTTP 測試，未接觸 Windows BLE adapter、
nRF54L15 或實際 firmware。不得把這些測試視為實機掃描成功。

資料流：nRF54L15 advertising → Windows Bleak scanner → HTTP Observation →
VM ULD provider → 既有 `/ws/uld` → realtimeClient → Store → Last Seen。

Observation 只表示「Reader 在該時間看到 Tag」。RSSI 不代表位置、移動、作業狀態、
可用性或告警。本工具不連線 GATT、不寫 firmware、不推論 zone、不產生移動告警。
M5 預設未知 Reader 時，地圖位置保持 `CONFIGURED_DEMO`；M6 經確認後使用的
Reader-zone 代表座標也不是 GPS。單一 BLE Observation 不直接更新座標。

## Windows PowerShell：實機前的完整操作

1. 在有 BLE adapter 的 Windows 10／11 安裝 Python **3.11+**、開啟藍牙，
   確認 nRF54L15 已燒錄並開機。Gateway 在 Windows 本機執行，不在 VMware Ubuntu 內掃描。
   先將整個 `gateway/windows-ble` 資料夾（含 Python 模組、requirements、範例設定與 tests）
   複製到 Windows；不需要在 Windows 啟動前端或複製 node_modules。
   開啟新的 PowerShell，進入此目錄：

   ```powershell
   cd C:\path\to\gods-eye-view\gateway\windows-ble
   py -3 -m venv .venv
   .\.venv\Scripts\python.exe --version
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   $env:PYTHONIOENCODING = "utf-8"
   ```

   直接呼叫 venv 的 Python，不需要修改 PowerShell execution policy。

2. 先確認 Windows 可讀取 VM snapshot：

   ```powershell
   Invoke-RestMethod -Uri 'http://163.18.26.138:4173/api/uld/snapshot'
   ```

   若失敗，先檢查既有 dev server／網路路徑，不要透過停用防火牆處理。

3. **先 scan-only，不先猜 nRF payload：**

   ```powershell
   .\.venv\Scripts\python.exe gateway.py --scan-only
   ```

   每行 JSON 顯示 `name`、`address`、`rssi`、`manufacturer_data`、`service_data`、
   `service_uuids`、`timestamp`。資料 bytes 顯示為 hex。名稱可能在後續 scan response
   才出現，請觀察多筆。可用關閉／開啟 nRF 電源對照找出裝置，確認實際廣播欄位，
   再按 Ctrl+C 結束。MAC 只用於 debug；BLE privacy 可能使地址改變。

4. 複製設定並依**實際掃描資料**填入辨識規則：

   ```powershell
   Copy-Item config.example.json config.json
   notepad config.json
   ```

   `config.example.json` 的名稱是刻意不會命中的 placeholder，不是 nRF firmware 格式。
   `backendUrl` 只在設定中，Python source 沒有固定 VM IP。
   修改 `gatewayId`／`backendUrl`／`tags`，以唯一的實際名稱或穩定 payload 辨識。

5. 確認 Backend Registry 對應：

   | tagId  | ULD        |
   | ------ | ---------- |
   | TAG001 | AKE12345CI |
   | TAG002 | AKE67890CI |
   | TAG003 | PMC92157CI |

   這些都是 Demo mapping，集中於 `server/providers/uld/tagRegistry.js`。
   更換實際 tagId 時，Gateway config 與 Backend Registry 需一致。
   同名但無法區分的兩個 Tag，必須先找出穩定的 payload 差異，不能靠 RSSI 或 MAC 猜測。

6. 啟動 Gateway：

   ```powershell
   .\.venv\Scripts\python.exe gateway.py --config config.json
   ```

   成功會顯示 `POST accepted`、observationId、tagId、uldId、updated、streamRevision。
   `Accepted unmapped tag` 代表 HTTP 成功但 Registry 尚未對應，ULD 不會更新。
   不會每筆 advertisement 都 POST；預設每個 tag 最多約每秒一次。

7. 查看 Backend 開發診斷：

   ```powershell
   $recent = Invoke-RestMethod -Uri 'http://163.18.26.138:4173/api/uld/observations/recent'
   $recent.observations | Select-Object observationId,tagId,readerId,rssi,observedAt,receivedAt,mapped,uldId,updated,reason
   ```

   確認 readerId 為此 Gateway，且 tagId／observedAt 正確。這個 endpoint 只在
   development mode 提供，preview／production mode 回 404。

8. Browser 開啟目前 ULD EYE，等待「已連線」，點「顯示桃園機場示範」，選取對應 ULD。
   確認「最後偵測時間」在**不 reload** 的情況下持續更新，位置、zone、作業狀態與告警不變。
   關閉 nRF 不應在 M5 自動產生 WARNING。按 Ctrl+C 正常停止 Gateway，再確認可以重新啟動。
   Windows 實機測試完成前，狀態保持 **PENDING PHYSICAL WINDOWS TEST**。

若掃描沒有任何資料，先確認 Windows 藍牙、BLE adapter／驅動、nRF 廣播以及是否有其他
程式佔用設備。若只有目標未命中，回 scan-only 檢查實際欄位，而不是修改 RSSI 閾值。
本 CLI 使用單一 `asyncio.run()`；請在獨立 PowerShell 執行，不要嵌入既有 GUI／Notebook event loop。

## 可配置 matching（以下 bytes／UUID 僅為合成範例）

每個 Tag 的 `match` 可以包含以下欄位，**同一個 match 的所有欄位必須全部符合**：

```json
{
  "tagId": "TAG001",
  "match": {
    "deviceName": "ACTUAL_UNIQUE_NAME_FROM_SCAN",
    "manufacturerData": {
      "companyId": "0x1234",
      "offset": 0,
      "hexPrefix": "aabb"
    },
    "serviceData": {
      "serviceUuid": "12345678-1234-5678-1234-567812345678",
      "offset": 1,
      "hexPrefix": "0203"
    }
  }
}
```

只保留實際需要的欄位即可，至少一項，不能空 match。`deviceName` 區分大小寫、精確比對，
不使用 substring。manufacturer 的 companyId 是 scan JSON 的 key；offset 從 Bleak 提供的
payload bytes 起算，不把 company ID 再當成 payload 前綴。service UUID 使用完整 128-bit UUID。
比對不依賴 RSSI。若一筆廣播同時命中不同 tagId，會拒絕發送並要求修正設定，避免錯配。

預設**不含 sequence**。只有 firmware payload 已證實存在 sequence 且 layout 確定後，
才可在 tag 旁加入明確的 bytes decoder，例如：

```json
"sequence": {
  "source": "manufacturerData",
  "companyId": "0x1234",
  "offset": 4,
  "length": 2,
  "byteOrder": "little"
}
```

也支援 `source: "serviceData"` 搭配 `serviceUuid`。length 為 1～6 bytes，
保證可精確送入 JavaScript safe integer；缺少指定 bytes 時拒絕該筆資料。
這只是可配置 decoder，**不表示目前 nRF firmware 已有這種格式**，也不產生 Gateway 計數器假冒 device sequence。

## Observation 與可靠性

```json
{
  "observationId": "obs-unique-gateway-generated-uuid",
  "tagId": "TAG001",
  "readerId": "WIN-GW-01",
  "rssi": -61,
  "observedAt": "2026-10-29T10:00:00.000Z",
  "sourceType": "BLE"
}
```

- observedAt 是 **Gateway 接收廣播時的 UTC 時間**，不是聲稱為 nRF 裝置時鐘。
  Windows 與 VM 時鐘應同步；Backend 不讓較舊／相等時間回退目前 lastSeenAt。
- observationId 使用 UUID。網路失敗重試同一筆時沿用相同 ID，Backend 去重。
- 每個設定的 tag 只保留最新一筆待送資料（最多 128 tags），斷線時新資料會取代舊資料。
  這不是保證送達每筆 observation 的 message queue；關閉程式時丟棄待送資料。
- publishIntervalMs 預設 1000；節流依 monotonic clock，每個 tag 獨立，成功與失敗嘗試都計入。
- httpTimeoutSeconds 預設 5，另有整次請求 deadline。retryInitialMs 預設 1000，
  指數退避至 retryMaxMs（預設 30000），掃描 callback 不等待 HTTP。
- 連線錯誤、timeout、408、5xx、429、無效 ACK 會退避；其他 4xx 明確記錄後丟棄，避免反覆送壞資料。
- Ctrl+C 會取消任務、停止 scanner、關閉 HTTP client。HTTP client 不沿用系統 proxy 設定。
- Backend 去重最近 10,000 個 ID、診斷最近 50 筆，都是有限記憶體；重啟會清空。
  Demo APIs 保留。明確執行 Demo reset 仍會還原示範資料（含初始 lastSeenAt）；之後的新廣播可再更新。

## Linux 可執行的測試（不代表實機驗證）

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Linux（在此目錄）：

```sh
python3 -m venv /tmp/uld-gateway-test
/tmp/uld-gateway-test/bin/python -m pip install -r requirements.txt
/tmp/uld-gateway-test/bin/python -m unittest discover -s tests -v
```

測試使用合成 advertising bytes、模擬 Bleak callback／scanner context 與 HTTPX MockTransport。
涵蓋設定驗證、三種 matching、無假造 sequence、未知／歧義廣播、節流、有限緩衝、HTTP 成敗、
退避、timeout、掃描與 HTTP cleanup。

實作依據：[Bleak scanner API](https://bleak.readthedocs.io/en/stable/api/scanner.html)、
[HTTPX async client](https://www.python-httpx.org/async/)、
[HTTPX timeout](https://www.python-httpx.org/advanced/timeouts/)。
