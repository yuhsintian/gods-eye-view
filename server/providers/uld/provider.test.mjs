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
