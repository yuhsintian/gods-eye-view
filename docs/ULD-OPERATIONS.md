# ULD EYE Operations Workflow (M7)

M7 is a presentation/operator layer over M6, not a new semantic engine.
**PENDING PHYSICAL WINDOWS TEST**: Windows + nRF54L15 BLE has not been validated.
All new one-click demos use **synthetic HTTP Observations**, never LIVE BLE/GPS.

## Browser operation (1366 × 768)

1. Start `npm run dev -- --host 0.0.0.0` and open ULD EYE with `?lang=zh-TW`.
2. Wait for 已連線. Click 顯示桃園機場示範.
3. Left ULD 作業任務 targets AKE12345CI. Expand TASK-CI152-01 to see CI152,
   KIX, AKE, quantity 1, status and activate/clear actions. The Backend owns context;
   it does not implicitly assign flight/status fields on the ULD record.
4. Click 異常移動示範: reset → two STORAGE observations → confirmed STORAGE-A →
   two EXIT observations → MOVED → NO_ACTIVE_DISPATCH_CONTEXT → WARNING.
5. Click 正常派遣示範: reset → confirmed STORAGE-A → activate CI152 dispatch →
   confirmed EXIT-A → same MOVED → ACTIVE_DISPATCH_CONTEXT → no Unauthorized Alert.
6. The right panel switches to 事件時間軸 with the Backend reason in Chinese and
   its English reasonCode. 詳細資訊 returns to the ten existing record fields.
   Selecting another ULD filters its timeline. Click an Alert to select/focus it.
7. 重設示範 restores configured initial ULDs, resolves alerts, clears context and
   canonical events without reload. Revisions remain monotonic. The closed legacy
   direct demo backup remains available for development, explicitly separate from
   the inferred operations workflow.

## Read contracts

- `GET /api/uld/events?uldId=AKE12345CI&limit=15`: schemaVersion 1, uldId,
  streamRevision, newest-first canonical events. Limit 1–20; invalid query 400,
  unknown ULD 404. Only whitelisted canonical fields, evidence observation IDs and
  related rule explanations are returned. No RSSI/raw evidence store/internal facts.
- `GET /api/uld/operations?uldId=AKE12345CI&limit=15`: same events plus uldRevision,
  task (INACTIVE/ACTIVE and existing dispatch context), presentation metadata.
  Quantity 1 is a demo task requirement, not a fleet-wide task assignment service.
- Both reads work in development and preview. Existing context/demo writes remain
  DEVELOPMENT ONLY; no UI dependency on `/events/recent` diagnostics.
- The same ULD Store caches read projections. A same-origin read client refreshes
  on selection, WS record changes, reconnect, and every 2 seconds while connected.
  This catches canonical OBSERVED/context changes that do not increment the ULD
  stream. WS protocol and authoritative record/Alert path are unchanged.
- Reconnect replaces event projections; eventId-keyed DOM never appends duplicates.
  UI shows at most 15 events for selected ULD, retained events are in-memory M6 data.

## Demo orchestration and boundaries

`src/uld/operationsDemo.js` calls only existing Backend APIs. Each synthetic
Observation gets a cryptographically unique observationId; no device sequence is
invented. All observations retain M5's sourceType BLE contract, but presentation
explicitly labels them DEMO OBSERVATION. They are synthetic inputs to the BLE
Observation software path, not evidence of a physical radio reception.

The orchestrator waits for Backend LOCATED, context, MOVED, rule decision, snapshot
Alert state and existing WS Store convergence, with timeout/cancellation. Poll
intervals are retries of state predicates, not blind sleeps. UI disable/error/progress
state prevents overlapping actions within the new operations controls. Legacy
backup/external clients can still change Backend state; demos are not transactional.

Configured initial coordinates remain CONFIGURED_DEMO until confirmed inference.
Reader→zone inference uses M6's demo policy (two same-reader observations within
five seconds). No RSSI position, GPS, AI inference, new transport or business rule
is introduced. Movement may leave operationalStatus AVAILABLE as M6 deliberately
keeps connectivity, location, assignment and operational status separate.

## QA

```sh
node scripts/qa-uld-operations.mjs --url http://localhost:4173
```

Requires Puppeteer Chrome/system dependencies; optional `PUPPETEER_EXECUTABLE_PATH`.
Runs actual Browser controls at 1366×768, activate/clear, both scenarios twice,
unique IDs, selected filtering, reconnect, reset, stable Cesium entity, no reload,
readability and rail bounds. Screenshots: OS temp `uld-m7-normal.png` and
`uld-m7-unauthorized.png`. This is synthetic software QA, **not physical BLE QA**.
