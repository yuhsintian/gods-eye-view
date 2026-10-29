# ULD EYE M6：Observation 不等於 Operational Fact

**PENDING PHYSICAL WINDOWS TEST**。本階段全部 QA 使用合成 HTTP Observation，
未宣稱 Windows 或 nRF54L15 的實機 BLE 已驗證。

```text
Observation -> Tag Registry -> ULD
                    Reader Registry -> Station / OperationalZone
             -> bounded Evidence -> Location Inference -> LOCATED / MOVED
             -> Dispatch Context + ULD Type + Serviceability -> pure Rules
             -> RuleDecision / Alert command -> existing ULD Store (Backend)
             -> ULD_UPSERT / ALERT_UPSERT -> existing WebSocket -> UI Store / panels
```

`semantic/model.js` 集中列出 Tag、ULD、ULDType、Reader、Station、OperationalZone、
DispatchContext、Observation、MovementEvent 與 Alert 的關係。沒有 graph database、
RDF、AI／LLM 異常推論。Rules 是 deterministic、auditable functions。

## 推論政策與限制

- Reader 的位置是 configured zone 代表座標。Demo Readers：
  `TPE-STORAGE-GW-01` → TPE／STORAGE-A；`TPE-EXIT-GW-01` → TPE／EXIT-A；
  `TPE-STAGING-GW-01` → TPE／STAGING-A。這不是 GPS、精確座標定位或航空業正式標準。
- 集中政策 `semantic/policy.js`：同一 ULD、同一 Reader／Zone，最近 **5 秒內至少 2 個不同 observationId**，
  才確認 location。衝突／未知 Reader evidence 會中斷候選連續性；不同 Readers 的單筆不能湊成確認。
  時窗按 `observedAt` 計算；門檻與來源是明確 Demo policy，不是物理真值保證。
- RSSI 只存為 evidence／diagnostics，不用 RSSI threshold 換區，也不做 triangulation。
- 未知 Reader 的已知 Tag 仍可更新 lastSeenAt，留下 OBSERVED／evidence，但不能定位或移動。
  M5 的 `WIN-GW-01` 預設屬未知 Reader，保持 M5 last-seen-only 行為。
- 遲到 evidence 可記錄，但不以比目前 Last Seen／已確認位置更舊的資料重寫 semantic location。
  Gateway／VM 時鐘仍應同步。本 API 不驗證物理來源真實性，沒有新增 Authentication。
- **初始 Mock zone 不算 confirmed previous zone**。必須先確認 STORAGE，再確認 EXIT，才是 MOVED。
  每次轉換需要前一次確認之後的新 evidence；同 zone 重複讀取不建立新的 Movement。
- ULD positionSource 為 `READER_ZONE_INFERENCE`，UI 顯示「讀取器區域推論」。座標仍是 configured
  Reader／Zone 的代表點。location、operationalStatus、serviceability、assignment 是不同維度；
  本階段不因 location 自動改 operationalStatus、flight、destination 或 serviceability。

## 事件與容量

Canonical `eventType` 集中定義為 `OBSERVED`、`LOCATED`、`MOVED`；Canonical eventId
與 WebSocket transport eventId／streamRevision 是不同概念。每個 MOVED 包含前後 station／zone、
occurredAt、`OBSERVATION_INFERENCE` 與前後確認所用的 evidenceObservationIds。
未知 Tag 仍依 M5 回 mapped:false，不產生 ULD semantic fact。

Evidence 每 ULD 保留 32 筆，canonical events 與 rule decisions 各保留 250 筆，全部為記憶體。
Observation ID 的 M5 去重窗口仍是最近 10,000 筆。沒有 durable replay 或資料庫。
Semantic facts 不新增 WS 類型，UI 仍僅接既有 ULD／Alert records。

## Context 與規則

Dispatch Context 獨立於 Observation，含 active、taskId、flight、destination、requiredUldType。
Activate API 若未提供 requiredUldType，使用該 ULD 的 type。此 context 不會偷偷修改 ULD assignment fields。

| Rule                       | 條件／reasonCode                                                  | 決策                                   |
| -------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| RULE_UNAUTHORIZED_MOVEMENT | 已確認 STORAGE-A→EXIT-A，無任務／NO_ACTIVE_DISPATCH_CONTEXT       | WARNING Alert                          |
| RULE_UNAUTHORIZED_MOVEMENT | active、相同 ULD、type 相容、SERVICEABLE／ACTIVE_DISPATCH_CONTEXT | matched:false，不建立 Alert            |
| RULE_UNAUTHORIZED_MOVEMENT | type 不符／DISPATCH_ULD_TYPE_MISMATCH                             | 無有效派遣，WARNING                    |
| RULE_UNAUTHORIZED_MOVEMENT | 非 SERVICEABLE／ULD_NOT_SERVICEABLE                               | 無有效派遣，WARNING                    |
| RULE_UNSERVICEABLE         | 已知 UNSERVICEABLE 且有派遣或 Movement／UNSERVICEABLE_ULD         | 獨立 UNSERVICEABLE WARNING             |
| RULE_DWELL_WARNING         | station dwell >= 60 個 24 小時日                                  | DWELL_WARNING command                  |
| RULE_LOST_CANDIDATE        | station dwell >= 180 個 24 小時日                                 | LOST_CANDIDATE command，不宣稱實際遺失 |

每個 decision 含 ruleId、matched、reasonCode、evaluatedAt、relatedUldId、relatedEventId，
以及當次 dispatch/type/serviceability facts。未授權與不可使用可能同時命中，兩個維度分別解釋。
Alert ID 依 type／ULD 穩定更新，避免每筆移動無限制增加 Alert。
不自動解除先前已啟用的告警；Demo reset 會以 RESOLVED 事件解除。

Dwell rules 是可呼叫 pure function，需明確傳 stationEnteredAt 與 now，不把 Last Seen 當 station entry。
180 日時兩個門檻均命中。沒有 background scheduler，也沒有維修流程。

## 開發 API

- `POST /api/uld/observations`：M5 contract 不變，單筆、相同去重／時間保護；已知 Reader 的 evidence 才可能確認位置。
- `GET /api/uld/events/recent`：events、ruleDecisions、inferredLocations、evidence、dispatchContexts、policy。
- `POST /api/uld/demo/context/dispatch/activate`：JSON `{uldId, taskId, flight, destination, requiredUldType?}`。
- `POST /api/uld/demo/context/dispatch/clear`：JSON `{uldId}`。

新增 diagnostics 只在 development 提供，preview／production mode 回 404；context 寫入是
**DEMO / DEVELOPMENT ONLY**，非開發模式回 403。沿用原本 same-site gate、JSON body cap／deadline。

## 合成 Scenario A / B

先 reset，送兩筆 STORAGE Reader，再送兩筆 EXIT Reader，每一組 observedAt 相距一秒。
每筆 observationId 必須不同，sourceType 保持 BLE；這些是**合成資料，不是實機證明**。
Reader context 不從 Observation 的其他任意欄位取得，Dispatch 只能由獨立 context API 建立。

Scenario A 不啟用任務：同一 MOVED → NO_ACTIVE_DISPATCH_CONTEXT → WARNING。

Scenario B reset 後先確認 STORAGE，呼叫：

```sh
curl -X POST http://localhost:4173/api/uld/demo/context/dispatch/activate \
  -H 'Content-Type: application/json' \
  -d '{"uldId":"AKE12345CI","taskId":"TASK-CI152-01","flight":"CI152","destination":"KIX"}'
```

再確認 EXIT：相同 route 的 MOVED → ACTIVE_DISPATCH_CONTEXT → no unauthorized Alert。
這是相同感知結果依不同業務語意得到不同可追溯決策，沒有生成式 AI 猜測。

完整自動驗收（需要 dev server、Chrome 與 curl）：

驗收時請停止其他 Gateway／示範操作，避免同時修改同一 ULD。

```sh
node scripts/qa-uld-semantic.mjs --url http://localhost:4173
```

腳本用 terminal curl 送 Observation、在 1366×768 Chromium 驗證 A/B、Marker／Detail／Alert、
位置來源、無 reload、reset 與 streamRevision 單調遞增。截圖在系統暫存目錄
`uld-m6-scenario-a.png`／`uld-m6-scenario-b.png`。
可用 PUPPETEER_EXECUTABLE_PATH 指定 Chrome；QA 跳過遠端字型下載，使用本機 fallback 字型。

## Reset 與舊 Demo

`POST /api/uld/demo/reset` 還原 ULD fixture，解除所有啟用 Alert，清除 semantic locations、
evidence、canonical events、rule decisions、dispatch contexts。ULD／Alert revisions 與 WS streamRevision
繼續遞增，不重設全域序號。M5 Observation recent／dedupe 保留；新一輪需用新 observationId。

M3 `demo/unauthorized-movement` 仍是直接示範備援，並非感知推論。使用它會使當前 inferred locations／
evidence 失效，不捏造 canonical MOVED；再用 fresh observations 重新確認。完整 M6 展示請使用本頁
Observation A/B 流程。切換示範建議先 reset。所有模型在 server 重啟後清空。
