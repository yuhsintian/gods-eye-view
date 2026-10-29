import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { installUldProvider } from './index.js';
import { createUldStore } from '../../../src/uld/store.js';
import { createUldRealtimeClient } from '../../../src/uld/realtimeClient.js';

async function fixture(t, demoEnabled = true, options = {}) {
  const handlers = [];
  const transports = new Set();
  const httpServer = createServer((req, res) => {
    let index = 0;
    const next = () => {
      if (handlers[index]) handlers[index++](req, res, next);
      else {
        res.statusCode = 404;
        res.end();
      }
    };
    next();
  });
  httpServer.on('connection', (socket) => {
    transports.add(socket);
    socket.on('close', () => transports.delete(socket));
  });
  const service = installUldProvider(
    { httpServer, middlewares: { use: (handler) => handlers.push(handler) } },
    { demoEnabled, ...options },
  );
  t.after(async () => {
    service.close();
    for (const socket of transports) socket.destroy();
    httpServer.closeAllConnections();
    if (httpServer.listening)
      await new Promise((resolve) => httpServer.close(resolve));
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  return {
    ...service,
    server: {
      httpServer,
      middlewares: { use: (handler) => handlers.push(handler) },
    },
    httpServer,
    url,
    get: () => fetch(`${url}/api/uld/snapshot`),
    post: (path) => fetch(`${url}/api/uld/demo/${path}`, { method: 'POST' }),
    observe: (body) =>
      fetch(`${url}/api/uld/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('ULD test timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('GET snapshot uses existing record contracts and exposes independent global stream revision', async (t) => {
  const f = await fixture(t);
  const response = await f.get();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.streamRevision, 100);
  assert.equal(body.ulds.length, 3);
  assert.equal(body.ulds[0].revision, 1);
  assert.equal(body.ulds[0].positionSource, 'CONFIGURED_DEMO');
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
  assert.deepEqual(body.alerts, []);
});

test('WS HELLO and terminal-style demo POSTs emit ordered ULD/alert/resolution events', async (t) => {
  const f = await fixture(t);
  const frames = [];
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/uld');
  t.after(() => ws.terminate());
  ws.on('message', (data) => frames.push(JSON.parse(String(data))));
  await until(() => frames.length === 1);
  assert.equal(frames[0].type, 'HELLO');
  assert.equal(frames[0].streamRevision, 100);
  const move = await f.post('unauthorized-movement');
  assert.equal(move.headers.get('x-uld-demo'), 'DEVELOPMENT-ONLY');
  assert.equal((await move.json()).developmentOnly, true);
  await until(() => frames.length === 3);
  assert.deepEqual(
    frames.slice(1).map((e) => e.type),
    ['ULD_UPSERT', 'ALERT_UPSERT'],
  );
  assert.equal(frames[1].payload.zoneId, 'EXIT-A');
  assert.equal(frames[1].payload.revision, 2);
  assert.equal(frames[1].streamRevision, 101);
  assert.equal(frames[2].streamRevision, 102);
  await f.post('unauthorized-movement');
  assert.equal(
    (await (await f.get()).json()).streamRevision,
    102,
    'idempotent demo emits no duplicates',
  );
  await f.post('reset');
  await until(() => frames.length === 7);
  assert.equal(frames.at(-1).type, 'ALERT_RESOLVED');
  assert.equal(frames.at(-1).payload.status, 'RESOLVED');
  assert.deepEqual(
    frames.slice(1).map((e) => e.streamRevision),
    [101, 102, 103, 104, 105, 106],
  );
  const body = await (await f.get()).json();
  assert.equal(body.ulds[0].zoneId, 'STORAGE-A');
  assert.equal(body.ulds[0].alertLevel, 'NORMAL');
  assert.equal(body.streamRevision, 106);
});

test('demo writes are disabled outside development and cross-origin writes are rejected', async (t) => {
  const f = await fixture(t, false);
  assert.equal((await f.post('reset')).status, 403);
  assert.equal((await f.get()).status, 200);
  const other = await fixture(t);
  assert.equal(
    (
      await fetch(`${other.url}/api/uld/demo/reset`, {
        method: 'POST',
        headers: { Origin: 'https://foreign.test' },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${other.url}/api/uld/demo/reset`)).status, 405);
});

test('real WebSocket and REST populate the empty frontend Store and update without any frontend scenario', async (t) => {
  const f = await fixture(t);
  const store = createUldStore();
  const client = createUldRealtimeClient({
    store,
    location: { href: f.url },
    WebSocketImpl: globalThis.WebSocket,
  });
  t.after(() => {
    client.stop();
    store.destroy();
  });
  client.start();
  await until(() => store.getSnapshot().connectionStatus === 'CONNECTED');
  assert.equal(store.getSnapshot().records.length, 3);
  await f.post('unauthorized-movement');
  await until(() => store.getActiveAlerts().length === 1);
  assert.equal(store.getUldById('AKE12345CI').zoneId, 'EXIT-A');
  await f.post('reset');
  await until(() => store.getActiveAlerts().length === 0);
  assert.equal(store.getUldById('AKE12345CI').alertLevel, 'NORMAL');
  client.stop();
  assert.equal(store.getSnapshot().connectionStatus, 'DISCONNECTED');
});

test('real reconnect resynchronizes after backend restart on the same origin', async (t) => {
  const f = await fixture(t);
  const store = createUldStore();
  const client = createUldRealtimeClient({
    store,
    location: { href: f.url },
    WebSocketImpl: globalThis.WebSocket,
    retryMs: 10,
  });
  t.after(() => {
    client.stop();
    store.destroy();
  });
  client.start();
  await until(() => store.getSnapshot().connectionStatus === 'CONNECTED');
  await f.post('unauthorized-movement');
  await until(() => store.getActiveAlerts().length === 1);
  f.close();
  const restarted = installUldProvider(f.server, { demoEnabled: true });
  t.after(() => restarted.close());
  await until(
    () =>
      store.getSnapshot().connectionStatus === 'CONNECTED' &&
      store.getUldById('AKE12345CI')?.revision === 1,
  );
  assert.equal(store.getActiveAlerts().length, 0);
  assert.equal(store.getUldById('AKE12345CI').zoneId, 'STORAGE-A');
});

test('provider cleanup preserves unrelated upgrade listeners and closes sockets', async (t) => {
  const f = await fixture(t);
  const unrelated = () => {};
  f.httpServer.on('upgrade', unrelated);
  f.close();
  assert.deepEqual(f.httpServer.listeners('upgrade'), [unrelated]);
  f.httpServer.removeListener('upgrade', unrelated);
});

const observation = (overrides = {}) => ({
  observationId: 'obs-http-1',
  tagId: 'TAG001',
  readerId: 'WIN-GW-01',
  rssi: -61,
  observedAt: '2026-10-29T10:00:00Z',
  sourceType: 'BLE',
  ...overrides,
});

test('Observation POST -> existing WS -> realtimeClient -> Store, with snapshot and demos still working', async (t) => {
  const f = await fixture(t);
  const frames = [];
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/uld');
  ws.on('message', (data) => frames.push(JSON.parse(String(data))));
  t.after(() => ws.terminate());
  const store = createUldStore();
  const client = createUldRealtimeClient({
    store,
    location: { href: f.url },
    WebSocketImpl: globalThis.WebSocket,
  });
  t.after(() => {
    client.stop();
    store.destroy();
  });
  client.start();
  await until(
    () =>
      store.getSnapshot().connectionStatus === 'CONNECTED' &&
      frames.length === 1,
  );
  const before = store.getUldById('AKE12345CI');
  const response = await f.observe(observation());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.uldId, 'AKE12345CI');
  assert.equal(result.streamRevision, 101);
  await until(
    () =>
      store.getUldById('AKE12345CI').lastSeenAt ===
        '2026-10-29T10:00:00.000Z' && frames.length === 2,
  );
  assert.equal(frames[1].type, 'ULD_UPSERT');
  assert.deepEqual(
    {
      ...store.getUldById('AKE12345CI'),
      lastSeenAt: before.lastSeenAt,
      revision: before.revision,
    },
    before,
  );
  assert.equal(
    (await (await f.get()).json()).ulds[0].lastSeenAt,
    '2026-10-29T10:00:00.000Z',
  );
  assert.equal((await (await f.observe(observation())).json()).duplicate, true);
  assert.equal(
    (
      await (
        await f.observe(
          observation({
            observationId: 'old-http',
            observedAt: '2026-10-29T09:00:00Z',
          }),
        )
      ).json()
    ).updated,
    false,
  );
  assert.equal((await (await f.get()).json()).streamRevision, 101);
  assert.equal((await f.post('unauthorized-movement')).status, 200);
  await until(() => store.getActiveAlerts().length === 1);
  assert.equal((await f.post('reset')).status, 200);
  await until(
    () =>
      store.getActiveAlerts().length === 0 &&
      store.getUldById('AKE12345CI').zoneId === 'STORAGE-A',
  );
  assert.equal(store.getUldById('AKE12345CI').operationalStatus, 'AVAILABLE');
});

test('unknown tags and invalid observations have bounded HTTP responses without changing snapshot', async (t) => {
  const f = await fixture(t);
  const initial = await (await f.get()).json();
  const unknown = await f.observe(observation({ tagId: 'UNKNOWN' }));
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).mapped, false);
  for (const override of [
    { observedAt: '2026-02-30T10:00:00Z' },
    { observedAt: 'not-iso' },
    { rssi: 127 },
    { rssi: '-61' },
    { tagId: '' },
    { tagId: null },
    { readerId: '' },
    { observationId: '' },
    { sourceType: 'GPS' },
    { sequence: -1 },
  ])
    assert.equal(
      (await f.observe(observation(override))).status,
      400,
      JSON.stringify(override),
    );
  assert.equal(
    (await f.observe({ observations: [observation()] })).status,
    400,
    'single Observation endpoint',
  );
  const after = await (await f.get()).json();
  assert.deepEqual(after.ulds, initial.ulds);
  assert.equal(after.streamRevision, initial.streamRevision);
  const recent = await (
    await fetch(`${f.url}/api/uld/observations/recent`)
  ).json();
  assert.equal(recent.developmentOnly, true);
  assert.equal(recent.observations.length, 1);
  assert.equal(recent.observations[0].tagId, 'UNKNOWN');
});

test('Observation HTTP admission: JSON/method/size/origin limits and development-only diagnostics', async (t) => {
  const f = await fixture(t);
  const endpoint = `${f.url}/api/uld/observations`;
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal(
    (await fetch(endpoint, { method: 'POST', body: '{}' })).status,
    415,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(17000) }),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://foreign.test',
        },
        body: JSON.stringify(observation()),
      })
    ).status,
    403,
  );
  const preview = await fixture(t, false);
  assert.equal(
    (await fetch(`${preview.url}/api/uld/observations/recent`)).status,
    404,
  );
  assert.equal(
    (await preview.observe(observation())).status,
    200,
    'normal ingest is not a debug endpoint',
  );
});

test('Observation body deadline returns 408 and never changes ULD state', async (t) => {
  const f = await fixture(t, true, { observationTimeoutMs: 30 });
  const status = await new Promise((resolve, reject) => {
    const req = request(
      `${f.url}/api/uld/observations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '100',
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
        req.destroy();
      },
    );
    req.on('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.write('{');
  });
  assert.equal(status, 408);
  assert.equal((await (await f.get()).json()).streamRevision, 100);
});

test('provider shutdown aborts incomplete Observation bodies without publishing events', async (t) => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(
      `${f.url}/api/uld/observations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '100',
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
        req.destroy();
      },
    );
    req.on('error', reject);
    req.write('{');
    setTimeout(() => f.close(), 30);
  });
  assert.equal(status, 503);
  assert.equal(f.backend.snapshot().streamRevision, 100);
});

const dispatchPayload = {
  uldId: 'AKE12345CI',
  taskId: 'TASK-CI152-01',
  flight: 'CI152',
  destination: 'KIX',
};
async function postDispatch(f, action, body) {
  return fetch(`${f.url}/api/uld/demo/context/dispatch/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('HTTP scenarios A/B: evidence -> location -> canonical Movement -> context/rules -> sequenced ULD/Alert WS', async (t) => {
  const f = await fixture(t),
    frames = [];
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/ws/uld');
  ws.on('message', (data) => frames.push(JSON.parse(String(data))));
  t.after(() => ws.terminate());
  await until(() => frames.length === 1);
  let serial = 0;
  const send = async (readerId) => {
    const response = await f.observe(
      observation({
        observationId: `semantic-http-${++serial}`,
        readerId,
        observedAt: new Date(
          Date.parse('2026-11-01T00:00:00Z') + serial * 1000,
        ).toISOString(),
      }),
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const diagnostics = async () =>
    (await fetch(`${f.url}/api/uld/events/recent`)).json();
  await send('TPE-STORAGE-GW-01');
  assert.equal((await diagnostics()).inferredLocations.length, 0);
  await send('TPE-STORAGE-GW-01');
  assert.equal((await diagnostics()).inferredLocations[0].zoneId, 'STORAGE-A');
  await send('TPE-EXIT-GW-01');
  assert.equal((await (await f.get()).json()).ulds[0].zoneId, 'STORAGE-A');
  await send('TPE-EXIT-GW-01');
  await until(() => frames.some((event) => event.type === 'ALERT_UPSERT'));
  const scenarioA = await diagnostics();
  const movementA = scenarioA.events.find(
    (event) => event.eventType === 'MOVED',
  );
  assert.ok(movementA);
  assert.equal(movementA.evidenceObservationIds.length, 4);
  const decisionA = scenarioA.ruleDecisions.find(
    (decision) => decision.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT',
  );
  assert.equal(decisionA.reasonCode, 'NO_ACTIVE_DISPATCH_CONTEXT');
  assert.equal(decisionA.relatedEventId, movementA.eventId);
  const snapshotA = await (await f.get()).json();
  assert.equal(snapshotA.ulds[0].zoneId, 'EXIT-A');
  assert.equal(snapshotA.ulds[0].positionSource, 'READER_ZONE_INFERENCE');
  assert.equal(snapshotA.ulds[0].alertLevel, 'WARNING');
  assert.ok(
    frames.some(
      (event) =>
        event.type === 'ULD_UPSERT' && event.payload.zoneId === 'EXIT-A',
    ),
  );
  const beforeReset = snapshotA.streamRevision;
  await f.post('reset');
  await until(() => frames.some((event) => event.type === 'ALERT_RESOLVED'));
  const afterReset = await diagnostics();
  for (const key of [
    'events',
    'evidence',
    'inferredLocations',
    'ruleDecisions',
    'dispatchContexts',
  ])
    assert.deepEqual(afterReset[key], []);
  assert.ok((await (await f.get()).json()).streamRevision > beforeReset);

  const alertCount = frames.filter(
    (event) => event.type === 'ALERT_UPSERT',
  ).length;
  await send('TPE-STORAGE-GW-01');
  await send('TPE-STORAGE-GW-01');
  const activation = await postDispatch(f, 'activate', dispatchPayload);
  assert.equal(activation.status, 200);
  assert.equal(activation.headers.get('x-uld-demo'), 'DEVELOPMENT-ONLY');
  assert.equal(
    (await activation.json()).dispatchContext.requiredUldType,
    'AKE',
  );
  await send('TPE-EXIT-GW-01');
  await send('TPE-EXIT-GW-01');
  const snapshotB = await (await f.get()).json();
  await until(() => frames.at(-1).streamRevision === snapshotB.streamRevision);
  const scenarioB = await diagnostics();
  const movementB = scenarioB.events.find(
    (event) => event.eventType === 'MOVED',
  );
  for (const key of [
    'eventType',
    'fromStationId',
    'fromZoneId',
    'toStationId',
    'toZoneId',
    'source',
  ])
    assert.equal(movementB[key], movementA[key]);
  const decisionB = scenarioB.ruleDecisions.find(
    (decision) => decision.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT',
  );
  assert.equal(decisionB.matched, false);
  assert.equal(decisionB.reasonCode, 'ACTIVE_DISPATCH_CONTEXT');
  assert.equal(snapshotB.ulds[0].zoneId, 'EXIT-A');
  assert.equal(snapshotB.ulds[0].alertLevel, 'NORMAL');
  assert.ok(snapshotB.alerts.every((alert) => alert.status === 'RESOLVED'));
  assert.equal(
    frames.filter((event) => event.type === 'ALERT_UPSERT').length,
    alertCount,
  );
  frames
    .slice(1)
    .forEach((event, i) => assert.equal(event.streamRevision, 101 + i));
});

test('context APIs validate separately from observations, clear contexts and stay development-only', async (t) => {
  const f = await fixture(t);
  const before = await (await f.get()).json();
  assert.equal(
    (
      await postDispatch(f, 'activate', {
        ...dispatchPayload,
        uldId: 'UNKNOWN',
      })
    ).status,
    400,
  );
  assert.equal(
    (await postDispatch(f, 'activate', { ...dispatchPayload, taskId: '' }))
      .status,
    400,
  );
  assert.equal(
    (await postDispatch(f, 'activate', dispatchPayload)).status,
    200,
  );
  const after = await (await f.get()).json();
  assert.deepEqual(
    after.ulds,
    before.ulds,
    'context is not a silent ULD assignment mutation',
  );
  assert.equal(after.streamRevision, before.streamRevision);
  const clear = await postDispatch(f, 'clear', {
    uldId: dispatchPayload.uldId,
  });
  assert.equal((await clear.json()).dispatchContext.active, false);
  const diagnostic = await (
    await fetch(`${f.url}/api/uld/events/recent`)
  ).json();
  assert.deepEqual(diagnostic.dispatchContexts, []);
  assert.equal(
    (await fetch(`${f.url}/api/uld/demo/context/dispatch/activate`)).status,
    405,
  );
  assert.equal(
    (
      await fetch(`${f.url}/api/uld/demo/context/dispatch/activate`, {
        method: 'POST',
        body: '{}',
      })
    ).status,
    415,
  );
  const preview = await fixture(t, false);
  assert.equal(
    (await fetch(`${preview.url}/api/uld/events/recent`)).status,
    404,
  );
  assert.equal(
    (await postDispatch(preview, 'activate', dispatchPayload)).status,
    403,
  );
  assert.equal(
    (await postDispatch(preview, 'clear', { uldId: dispatchPayload.uldId }))
      .status,
    403,
  );
});

test('M7 public operations projection: task, filtered canonical events and auditable decisions without diagnostics', async (t) => {
  const f = await fixture(t);
  const read = async (suffix = '') => {
    const response = await fetch(
      `${f.url}/api/uld/operations?uldId=AKE12345CI${suffix}`,
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await read();
  assert.deepEqual(initial.task, {
    uldId: 'AKE12345CI',
    taskId: 'TASK-CI152-01',
    flight: 'CI152',
    destination: 'KIX',
    requiredUldType: 'AKE',
    requiredQuantity: 1,
    status: 'INACTIVE',
  });
  assert.deepEqual(initial.events, []);
  assert.equal(initial.presentation.dataSource, 'DEMO_OBSERVATION');
  let time = Date.now() - 100;
  for (const reader of [
    'TPE-STORAGE-GW-01',
    'TPE-STORAGE-GW-01',
    'TPE-EXIT-GW-01',
    'TPE-EXIT-GW-01',
  ]) {
    const result = await f.observe({
      observationId: `public-${++time}`,
      tagId: 'TAG001',
      readerId: reader,
      rssi: -61,
      observedAt: new Date(time).toISOString(),
      sourceType: 'BLE',
    });
    assert.equal(result.status, 200);
  }
  const model = await read();
  assert.ok(model.streamRevision > initial.streamRevision);
  assert.ok(model.uldRevision > initial.uldRevision);
  assert.equal(model.events[0].eventType, 'MOVED');
  assert.ok(model.events.every((event) => event.uldId === 'AKE12345CI'));
  const decision = model.events[0].decisions.find(
    (item) => item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT',
  );
  assert.equal(decision.reasonCode, 'NO_ACTIVE_DISPATCH_CONTEXT');
  assert.equal(decision.matched, true);
  assert.deepEqual(decision.alert, {
    type: 'UNAUTHORIZED_MOVEMENT',
    level: 'WARNING',
  });
  assert.equal('facts' in decision, false);
  for (const key of [
    'evidence',
    'policy',
    'dispatchContexts',
    'inferredLocations',
    'ruleDecisions',
  ])
    assert.equal(key in model, false);
  assert.equal('rssi' in model.events[1], false);
  const events = await (
    await fetch(`${f.url}/api/uld/events?uldId=AKE12345CI&limit=2`)
  ).json();
  assert.equal(events.events.length, 2);
  assert.deepEqual(
    Object.keys(events).sort(),
    ['schemaVersion', 'uldId', 'streamRevision', 'events'].sort(),
  );
  const unrelated = await (
    await fetch(`${f.url}/api/uld/events?uldId=AKE67890CI`)
  ).json();
  assert.deepEqual(unrelated.events, []);
  for (const query of [
    '',
    '?uldId=AKE12345CI&limit=0',
    '?uldId=AKE12345CI&limit=21',
    '?uldId=AKE12345CI&limit=no',
    '?uldId=AKE12345CI&limit=1.5',
  ])
    assert.equal((await fetch(`${f.url}/api/uld/events${query}`)).status, 400);
  assert.equal(
    (await fetch(`${f.url}/api/uld/events?uldId=unknown`)).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${f.url}/api/uld/events?uldId=AKE12345CI`, {
        method: 'POST',
      })
    ).status,
    405,
  );
  await f.post('reset');
  assert.deepEqual((await read()).events, []);
  assert.equal((await read()).task.status, 'INACTIVE');
});

test('M7 public reads work in preview while context/demo writes and diagnostics remain gated', async (t) => {
  const f = await fixture(t, false);
  for (const path of ['events', 'operations']) {
    const response = await fetch(`${f.url}/api/uld/${path}?uldId=AKE12345CI`);
    assert.equal(response.status, 200);
    const value = await response.json();
    if (path === 'operations')
      assert.equal(value.presentation.demoEnabled, false);
  }
  assert.equal((await fetch(`${f.url}/api/uld/events/recent`)).status, 404);
  assert.equal((await f.post('context/dispatch/activate')).status, 403);
});

test('M7 real HTTP orchestration + existing WS Store: normal, warning, repeated unique IDs, context and reset', async (t) => {
  const { createOperationsApi } =
    await import('../../../src/uld/operationsApi.js');
  const { createOperationsDemo } =
    await import('../../../src/uld/operationsDemo.js');
  const f = await fixture(t);
  const store = createUldStore();
  const realtime = createUldRealtimeClient({
    store,
    location: { href: f.url },
    WebSocketImpl: globalThis.WebSocket,
  });
  const observationIds = [],
    calls = [],
    steps = [];
  const api = createOperationsApi({
    fetchImpl: (path, init) => {
      calls.push(path);
      if (path === '/api/uld/observations')
        observationIds.push(JSON.parse(init.body).observationId);
      return fetch(f.url + path, init);
    },
  });
  const refresh = async () =>
    store.replaceOperations(await api.read('AKE12345CI'));
  const demo = createOperationsDemo({
    api,
    store,
    refresh,
    pollMs: 5,
    onStep: (step) => steps.push(step),
  });
  t.after(() => {
    demo.destroy();
    realtime.stop();
    store.destroy();
  });
  realtime.start();
  await until(() => store.getSnapshot().connectionStatus === 'CONNECTED');
  for (const mode of ['UNAUTHORIZED', 'NORMAL', 'UNAUTHORIZED', 'NORMAL']) {
    const model = await demo.run(mode);
    assert.equal(model.task.status, mode === 'NORMAL' ? 'ACTIVE' : 'INACTIVE');
    const moved = model.events.filter((event) => event.eventType === 'MOVED');
    assert.equal(moved.length, 1);
    assert.equal(
      moved[0].decisions.find(
        (item) => item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT',
      ).matched,
      mode === 'UNAUTHORIZED',
    );
    assert.equal(store.getUldById('AKE12345CI').zoneId, 'EXIT-A');
    assert.equal(
      store.getUldById('AKE12345CI').alertLevel,
      mode === 'NORMAL' ? 'NORMAL' : 'WARNING',
    );
    assert.equal(store.getActiveAlerts().length, mode === 'NORMAL' ? 0 : 1);
  }
  assert.equal(observationIds.length, 16);
  assert.equal(new Set(observationIds).size, 16);
  assert.ok(steps.includes('DISPATCH_ACTIVE'));
  assert.ok(steps.includes('COMPLETED_NORMAL'));
  assert.ok(steps.includes('COMPLETED_WARNING'));
  assert.ok(calls.includes('/api/uld/demo/context/dispatch/activate'));
  assert.equal(calls.includes('/api/uld/demo/unauthorized-movement'), false);
  assert.equal(
    calls.some((path) => path.includes('/recent')),
    false,
  );
  await api.clear('AKE12345CI');
  await refresh();
  assert.equal(
    store.getOperationsByUldId('AKE12345CI').task.status,
    'INACTIVE',
  );
  await demo.reset();
  assert.equal(store.getUldById('AKE12345CI').zoneId, 'STORAGE-A');
  assert.equal(store.getActiveAlerts().length, 0);
  assert.deepEqual(store.getOperationsByUldId('AKE12345CI').events, []);
  // Existing direct demo remains available as a fallback, independently of M7.
  await f.post('unauthorized-movement');
  await until(() => store.getActiveAlerts().length === 1);
  await demo.reset();
  assert.equal(store.getActiveAlerts().length, 0);
});
