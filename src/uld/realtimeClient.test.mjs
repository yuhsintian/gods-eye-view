import test from 'node:test';
import assert from 'node:assert/strict';
import { createUldRealtimeClient, uldWebSocketUrl } from './realtimeClient.js';
import { createUldStore } from './store.js';
import { createMockUldRecords } from './mockData.js';

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const record = (revision = 1, patch = {}) => ({
  ...createMockUldRecords()[0],
  revision,
  ...patch,
});
const snapshot = (revision = 100, ulds = [record()], alerts = []) => ({
  schemaVersion: 1,
  streamRevision: revision,
  generatedAt: '2026-10-28T10:00:00Z',
  ulds,
  alerts,
});
const event = (
  revision,
  payload = record(2, { zoneId: 'EXIT-A' }),
  type = 'ULD_UPSERT',
) => ({
  eventId: `event-${revision}`,
  type,
  streamRevision: revision,
  occurredAt: '2026-10-28T10:00:00Z',
  payload,
});
const alert = (revision = 1, status = 'ACTIVE') => ({
  alertId: 'alert-1',
  uldId: 'AKE12345CI',
  type: 'UNAUTHORIZED_MOVEMENT',
  level: 'WARNING',
  title: 'Unauthorized ULD movement',
  message: 'Movement',
  occurredAt: '2026-10-28T10:00:00Z',
  status,
  revision,
});

function fixture(t, options = {}) {
  const sockets = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  class Socket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
    }
    receive(value) {
      this.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(value) }),
      );
    }
    close() {
      this.closed = true;
      this.dispatchEvent(new Event('close'));
    }
  }
  const store = createUldStore();
  const client = createUldRealtimeClient({
    store,
    WebSocketImpl: Socket,
    location: { href: 'http://example.test:4173/dashboard?lang=zh-TW' },
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) =>
        requests.push({
          url,
          init,
          reject,
          answer: (value) => resolve({ ok: true, json: async () => value }),
        }),
      ),
    setTimer: (fn, ms) => {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
    retryMs: 10,
    timeoutMs: 10000,
    ...options,
  });
  t.after(() => {
    client.stop();
    store.destroy();
  });
  client.start();
  const hello = (revision = 100) =>
    sockets.at(-1).receive({ type: 'HELLO', streamRevision: revision });
  const bootstrap = async (value = snapshot()) => {
    hello(value.streamRevision);
    requests.at(-1).answer(value);
    await flush();
  };
  const retry = () => {
    const pending = [...timers.entries()].find(([, task]) => task.ms < 10000);
    assert.ok(pending);
    timers.delete(pending[0]);
    pending[1].fn();
  };
  return { client, store, sockets, requests, timers, hello, bootstrap, retry };
}

test('WS URL uses the document origin, protocol and port, including TLS/IPv6', () => {
  assert.equal(
    uldWebSocketUrl({ href: 'http://host.test:4173/path' }),
    'ws://host.test:4173/ws/uld',
  );
  assert.equal(
    uldWebSocketUrl({ href: 'https://host.test/path' }),
    'wss://host.test/ws/uld',
  );
  assert.equal(
    uldWebSocketUrl({ href: 'https://[::1]:8443/' }),
    'wss://[::1]:8443/ws/uld',
  );
});

test('HELLO precedes REST; buffered newer events close the initial snapshot race', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.getSnapshot().connectionStatus, 'CONNECTING');
  assert.equal(f.requests.length, 0);
  f.hello();
  assert.equal(f.requests.length, 1);
  f.sockets[0].receive(event(101));
  assert.equal(f.store.getSnapshot().records.length, 0);
  f.requests[0].answer(snapshot());
  await flush();
  assert.equal(f.store.getUldById('AKE12345CI').zoneId, 'EXIT-A');
  assert.equal(f.client.getState().streamRevision, 101);
  assert.equal(f.store.getSnapshot().connectionStatus, 'CONNECTED');
});

test('snapshot-covered and stale stream events are ignored; stale record revisions still consume sequence', async (t) => {
  const f = fixture(t);
  f.hello();
  f.sockets[0].receive(event(101));
  f.requests[0].answer(snapshot(101, [record(3)]));
  await flush();
  f.sockets[0].receive(event(100, record(99)));
  f.sockets[0].receive(event(102, record(2, { zoneId: 'STALE' })));
  assert.equal(f.store.getUldById('AKE12345CI').revision, 3);
  assert.equal(f.client.getState().streamRevision, 102);
  assert.equal(f.requests.length, 1);
  f.sockets[0].receive(event(103, record(4, { zoneId: 'LATEST' })));
  assert.equal(f.store.getUldById('AKE12345CI').zoneId, 'LATEST');
});

test('gap detection leaves live state unchanged until REST resync; arrivals during resync replay', async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  f.sockets[0].receive(event(103));
  assert.equal(f.requests.length, 2);
  assert.equal(f.store.getUldById('AKE12345CI').zoneId, 'STORAGE-A');
  assert.equal(f.store.getSnapshot().connectionStatus, 'RECONNECTING');
  f.sockets[0].receive(event(104, record(5, { zoneId: 'AFTER-SNAPSHOT' })));
  f.requests[1].answer(snapshot(103, [record(4, { zoneId: 'EXIT-A' })]));
  await flush();
  assert.equal(f.store.getUldById('AKE12345CI').zoneId, 'AFTER-SNAPSHOT');
  assert.equal(f.client.getState().streamRevision, 104);
});

test('ALERT_UPSERT and full ALERT_RESOLVED payloads update the shared store', async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  f.sockets[0].receive(event(101, alert(), 'ALERT_UPSERT'));
  assert.equal(f.store.getActiveAlerts().length, 1);
  f.sockets[0].receive(event(102, alert(2, 'RESOLVED'), 'ALERT_RESOLVED'));
  assert.equal(f.store.getActiveAlerts().length, 0);
  assert.equal(f.store.getAlertById('alert-1').revision, 2);
});

test('SNAPSHOT_REQUIRED, malformed payloads and unknown events request authoritative resync', async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  f.sockets[0].receive(event(100, {}, 'SNAPSHOT_REQUIRED'));
  assert.equal(f.requests.length, 2);
  f.requests[1].answer(snapshot());
  await flush();
  f.sockets[0].receive(event(101, { uldId: 'invalid' }));
  assert.equal(f.requests.length, 3);
  assert.equal(f.store.getUldById('AKE12345CI').revision, 1);
  f.requests[2].answer(snapshot());
  await flush();
  f.sockets[0].receive(event(101, {}, 'UNKNOWN_EVENT'));
  assert.equal(f.requests.length, 4);
});

test('reconnect fetches a new snapshot and tolerates an in-memory backend restart', async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  f.sockets[0].receive(event(101));
  const old = f.sockets[0];
  old.close();
  assert.equal(f.store.getSnapshot().connectionStatus, 'DISCONNECTED');
  f.retry();
  assert.equal(f.store.getSnapshot().connectionStatus, 'RECONNECTING');
  f.hello(100);
  f.requests[1].answer(snapshot());
  await flush();
  old.receive(event(500, record(500)));
  assert.equal(f.client.getState().streamRevision, 100);
  assert.equal(f.store.getUldById('AKE12345CI').revision, 1);
  assert.equal(f.store.getSnapshot().connectionStatus, 'CONNECTED');
});

test('cleanup aborts HTTP, removes WS listeners, cancels retries and ignores late completions', async (t) => {
  const f = fixture(t);
  f.hello();
  const request = f.requests[0];
  const socket = f.sockets[0];
  f.client.stop();
  assert.equal(request.init.signal.aborted, true);
  assert.equal(socket.closed, true);
  assert.equal(f.timers.size, 0);
  socket.receive(event(101));
  request.answer(snapshot());
  await flush();
  assert.equal(f.store.getSnapshot().records.length, 0);
  assert.equal(f.store.getSnapshot().connectionStatus, 'DISCONNECTED');
});

test('a stale in-flight snapshot cannot overwrite a newer resync after buffer overflow', async (t) => {
  const f = fixture(t, { maxBufferedEvents: 2 });
  f.hello();
  for (const revision of [101, 102, 103])
    f.sockets[0].receive(event(revision, record(revision)));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].init.signal.aborted, true);
  f.requests[1].answer(snapshot(103, [record(103)]));
  await flush();
  f.requests[0].answer(snapshot());
  await flush();
  assert.equal(f.store.getUldById('AKE12345CI').revision, 103);
});

test('HELLO timeout and snapshot failure disconnect and schedule bounded reconnect', async (t) => {
  const f = fixture(t);
  const [id, timeout] = [...f.timers.entries()][0];
  f.timers.delete(id);
  timeout.fn();
  assert.equal(f.store.getSnapshot().connectionStatus, 'DISCONNECTED');
  f.retry();
  f.hello();
  f.requests[0].reject(new Error('offline'));
  await flush();
  assert.equal(f.store.getSnapshot().connectionStatus, 'DISCONNECTED');
  assert.equal(f.sockets.length, 2);
});

test('invalid snapshots cannot partially replace state or claim connected status', async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  f.client.resync();
  f.requests[1].answer(snapshot(100, [record(), record()]));
  await flush();
  assert.equal(f.store.getSnapshot().records.length, 1);
  assert.equal(f.store.getSnapshot().connectionStatus, 'DISCONNECTED');
});
