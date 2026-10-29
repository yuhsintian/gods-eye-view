# ULD development transport

`GET /api/uld/snapshot` and `/ws/uld` share one process-local mock authority.
Records use the existing ULD/Alert contracts and `CONFIGURED_DEMO` positions.
The provider accepts BLE sightings from the separate Windows Gateway; acquisition
itself remains outside this process. This is not a rule engine, authentication
or a production service.

The snapshot is `{schemaVersion:1, streamRevision, generatedAt, ulds, alerts}`.
Record `revision` is per entity; `streamRevision` starts at 100 and increases
for every published ULD/Alert event. Snapshot reads and event publication are
synchronous, so a snapshot never exposes a partially sequenced transaction.

The socket first sends `{type:'HELLO', schemaVersion:1, streamRevision}`.
Data frames contain `eventId`, `type`, `streamRevision`, `occurredAt`, `payload`.
`ULD_UPSERT` carries a complete ULD; `ALERT_UPSERT` and `ALERT_RESOLVED` carry
complete alerts. `SNAPSHOT_REQUIRED` is a control frame and does not consume an
extra data sequence number. Slow peers are asked to resync and disconnected.

The client connects WS **before** REST, buffers during the snapshot request,
discards frames covered by the snapshot, and replays consecutive newer frames.
Duplicates are ignored. Gaps, invalid frames and explicit resync controls cause
a fresh snapshot; no missing state is guessed. Buffer overflow invalidates the
in-flight HTTP request. Connection/request generations prevent late responses
from replacing newer state. Reconnect always performs a fresh handshake and
snapshot; a restarted in-memory backend can restart both revision domains.
Only authoritative snapshots replace/reset records; ordinary live upserts
continue rejecting stale record revisions.

## DEMO / DEVELOPMENT ONLY

Only Vite development mode enables these fixed POST actions:

```sh
curl -X POST http://localhost:4173/api/uld/demo/unauthorized-movement
curl -X POST http://localhost:4173/api/uld/demo/reset
```

Preview and `--mode production` reject demo writes with 403. The browser demo
buttons call these APIs; they do not generate or change model data locally.
No durable event replay or database is provided. A page/backend restart is
recovered by snapshot replacement, not event history. A proxy must forward
WebSocket upgrade requests if this is served through a proxy.

## BLE Observation ingestion (Milestone 5)

`POST /api/uld/observations` accepts one JSON object:

```json
{
  "observationId": "obs-unique-uuid",
  "tagId": "TAG001",
  "readerId": "WIN-GW-01",
  "rssi": -61,
  "observedAt": "2026-10-29T10:00:00.000Z",
  "sourceType": "BLE"
}
```

`sequence` is optional and must come from actual firmware bytes, never a Gateway
counter. IDs are non-empty text (max 200 characters); RSSI is an integer from
-127 to 20 dBm (127/unavailable is rejected). Timestamps require a valid calendar
date, time and timezone (`Z` or ±HH:mm), with optional fractional seconds;
calendar overflow, timezone-less local times and leap seconds are rejected.
Times are normalized to UTC milliseconds. Sequence must be a non-negative JS
safe integer. Only a single object is supported, not a batch wrapper.

Known tags use `tagRegistry.js` (DEMO mappings, centrally replaceable). A strictly
newer instant updates **only** ULD `lastSeenAt` and record `revision`. The existing
Store subscription emits one `ULD_UPSERT`, incrementing `streamRevision` once.
No position, zone, business state, flight, destination, serviceability or alert
changes are inferred. Position source remains `CONFIGURED_DEMO`.

Response: `{accepted, observationId, tagId, mapped, uldId?, updated, duplicate,
streamRevision}`. Unknown tags return 200 with `mapped:false` and no ULD mutation.
Duplicate IDs return 200 with `duplicate:true`, `updated:false`, and no new event.
Older/equal times are accepted and recorded but do not update ULD state.
Reusing an ID with another payload still returns the first accepted identity.

The process retains the last 10,000 IDs (FIFO) and 50 diagnostic sightings.
Dedupe is not durable; after eviction, timestamp protection still rejects stale
state updates. `GET /api/uld/observations/recent` exposes diagnostics only in
development; preview/production mode returns 404. No new authentication or CORS
policy was introduced: the existing same-site gate allows native Gateway/tool
requests and refuses cross-site browser requests. Normal Observation ingestion
is available in preview as well; Demo writes remain development-only.

HTTP requests require application/json, are capped at 16 KiB and have a five-second
body deadline. Invalid observations/JSON return 400, size overflow 413, wrong
content type 415, wrong method 405, timeout 408. Provider cleanup cancels pending
request reads. The Dashboard still receives all updates through the M4 socket;
it has no BLE-specific transport or new panel.

Existing explicit Demo reset restores fixture data including initial lastSeenAt.
It does not clear the dedupe window; a subsequent fresh sighting updates normally.
See [Windows PowerShell setup and physical acceptance checklist](../../../gateway/windows-ble/README.md).

UI readability tokens and narrowly scoped brand/layer overrides live in
`src/ui/styles/uld-eye.css`. Other original panels retain their typography.

## Browser acceptance

With the development server running, execute:

```sh
node scripts/qa-uld-realtime.mjs --url http://localhost:4173
```

The Puppeteer check uses a 1366×768 viewport and actual terminal `curl` POSTs.
It verifies selection/focus, live marker/detail/alert updates, reset, reconnect,
socket cleanup and unchanged page/resource identity. Screenshots are written to
the operating system temporary directory. Set `PUPPETEER_EXECUTABLE_PATH` if
Chrome is installed outside Puppeteer's default location.

For M5 run `node scripts/qa-uld-observations.mjs --url http://localhost:4173`.
It sends explicitly synthetic `QA-MANUAL-NO-HARDWARE` observations with terminal
curl, checks Last Seen in the real Browser without a reload or position/business
state mutation, verifies dedupe/old times/unknown tags, and exercises both Demo
APIs afterward. This is not physical BLE validation. Both QA scripts skip remote
font downloads; installed fallback fonts supply CJK text for readability checks.
