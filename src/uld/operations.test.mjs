import test from 'node:test';
import assert from 'node:assert/strict';
import { createUldStore } from './store.js';
import { createMockUldRecords } from './mockData.js';
import { createOperationsClient } from './operationsClient.js';
import { createOperationsApi } from './operationsApi.js';
import { createOperationsDemo } from './operationsDemo.js';
import {
  normalizeOperationsProjection,
  ULD_DEMO_TARGET as uid,
} from './operationsProjection.js';
import { mountUldOperationsPanel } from '../ui/uldOperationsPanel.js';
import { mountUldTimeline } from '../ui/uldTimeline.js';
import { presentCanonicalEvent } from '../ui/uldOperationsPresentation.js';
import { setLocale } from '../i18n/index.js';

const event = (i, uldId = uid) => ({
  eventId: `canonical:${i}`,
  eventType: 'OBSERVED',
  uldId,
  occurredAt: '2026-10-29T08:00:00Z',
  readerId: 'TPE-STORAGE-GW-01',
  zoneId: 'STORAGE-A',
  evidenceObservationIds: [`obs:${i}`],
  decisions: [],
});
const projection = (patch = {}) => ({
  schemaVersion: 1,
  uldId: uid,
  uldRevision: 1,
  streamRevision: 100,
  task: {
    uldId: uid,
    taskId: 'TASK-CI152-01',
    flight: 'CI152',
    destination: 'KIX',
    requiredUldType: 'AKE',
    requiredQuantity: 1,
    status: 'INACTIVE',
  },
  events: [],
  presentation: {
    dataSource: 'DEMO_OBSERVATION',
    locationMode: 'READER_ZONE_INFERENCE',
    rulesEnabled: true,
    demoEnabled: true,
  },
  ...patch,
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// A small DOM fixture for these components, not evidence of browser layout.
function node(doc) {
  return {
    ownerDocument: doc,
    children: [],
    dataset: {},
    attributes: {},
    textContent: '',
    hidden: false,
    disabled: false,
    listeners: new Map(),
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    appendChild(child) {
      child.remove();
      child.parent = this;
      this.children.push(child);
    },
    append(...children) {
      children.forEach((child) => this.appendChild(child));
    },
    replaceChildren(...children) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.append(...children);
    },
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter(
          (child) => child !== this,
        );
      this.parent = null;
    },
    insertBefore(child, before) {
      child.remove();
      child.parent = this;
      const i = this.children.indexOf(before);
      this.children.splice(i < 0 ? this.children.length : i, 0, child);
    },
    addEventListener(k, fn) {
      this.listeners.set(k, fn);
    },
    removeEventListener(k) {
      this.listeners.delete(k);
    },
    click() {
      if (!this.disabled) return this.listeners.get('click')?.();
    },
  };
}
function dom(names) {
  const doc = { createElement: () => node(doc) };
  const elements = Object.fromEntries(names.map((name) => [name, node(doc)]));
  const container = node(doc);
  container.querySelector = (selector) => elements[selector.slice(1, -1)];
  return { container, elements };
}
function setup(t) {
  const store = createUldStore(createMockUldRecords());
  store.setConnectionStatus('CONNECTED');
  t.after(() => store.destroy());
  return store;
}

test('operations Store cache preserves backend context, validates identities and bounds immutable timeline', (t) => {
  const store = setup(t);
  store.replaceOperations(
    projection({ events: Array.from({ length: 20 }, (_, i) => event(i)) }),
  );
  assert.equal(store.getOperationsByUldId(uid).events.length, 15);
  assert.equal(Object.isFrozen(store.getOperationsByUldId(uid).task), true);
  assert.throws(() =>
    normalizeOperationsProjection(projection({ events: [event(1), event(1)] })),
  );
  assert.throws(() =>
    normalizeOperationsProjection(
      projection({ events: [event(1, 'AKE67890CI')] }),
    ),
  );
  store.upsertUld({ ...store.getUldById(uid), revision: 2 });
  assert.equal(
    store.replaceOperations(projection()),
    false,
    'old projection cannot override newer WS record',
  );
  store.replaceSnapshot({ ulds: createMockUldRecords(), alerts: [] });
  assert.equal(
    store.getOperationsByUldId(uid),
    null,
    'reconnect snapshot invalidates old context',
  );
});

test('task UI activates and clears through injected Backend actions; only read projection changes displayed state', async (t) => {
  setLocale('zh-TW');
  t.after(() => setLocale('en'));
  const store = setup(t);
  store.replaceOperations(projection());
  const names = [
    'task-id',
    'task-fields',
    'task-status',
    'progress',
    'connection',
    'error',
    'activate',
    'clear',
    'normal',
    'unauthorized',
    'reset',
  ];
  const { container, elements } = dom(
    names.map((name) => `data-uld-ops-${name}`),
  );
  const el = (name) => elements[`data-uld-ops-${name}`];
  let activateCalls = 0,
    clearCalls = 0;
  const view = mountUldOperationsPanel({
    container,
    store,
    onActivate: async (task) => {
      activateCalls++;
      assert.equal(task.taskId, 'TASK-CI152-01');
      assert.equal(el('task-status').textContent, '未啟用 INACTIVE');
      store.replaceOperations(
        projection({ task: { ...task, status: 'ACTIVE' } }),
      );
    },
    onClear: async () => {
      clearCalls++;
      store.replaceOperations(projection());
    },
    onNormal() {},
    onUnauthorized() {},
    onReset() {},
  });
  t.after(() => view.destroy());
  assert.equal(el('task-fields').children.length, 10);
  assert.equal(el('clear').disabled, true);
  await el('activate').click();
  assert.equal(activateCalls, 1);
  assert.equal(el('task-status').textContent, '執行中 ACTIVE');
  assert.equal(el('activate').disabled, true);
  await el('clear').click();
  assert.equal(clearCalls, 1);
  assert.equal(el('task-status').textContent, '未啟用 INACTIVE');
  store.setConnectionStatus('RECONNECTING');
  assert.equal(el('normal').disabled, true);
  assert.equal(el('connection').textContent, '重新連線中');
  view.destroy();
  assert.equal(el('activate').listeners.size, 0);
});

test('timeline filters selected ULD, bounds DOM, preserves event identity on refresh/reconnect and presents backend reason', (t) => {
  setLocale('zh-TW');
  t.after(() => setLocale('en'));
  const store = setup(t);
  store.selectUld(uid);
  const { container, elements } = dom([
    'data-uld-timeline-list',
    'data-uld-timeline-empty',
    'data-uld-timeline-selected',
  ]);
  const list = elements['data-uld-timeline-list'];
  const view = mountUldTimeline({ container, store });
  t.after(() => view.destroy());
  const model = projection({
    events: Array.from({ length: 20 }, (_, i) => event(i)),
  });
  store.replaceOperations(model);
  assert.equal(list.children.length, 15);
  const first = list.children[0];
  store.replaceOperations(model);
  store.setConnectionStatus('RECONNECTING');
  store.setConnectionStatus('CONNECTED');
  store.replaceOperations(model);
  assert.equal(list.children.length, 15);
  assert.equal(list.children[0], first);
  store.selectUld('AKE67890CI');
  assert.equal(list.children.length, 0);
  store.selectUld(uid);
  assert.equal(list.children.length, 15);
  const decisionEvent = {
    ...event(99),
    eventType: 'MOVED',
    fromZoneId: 'STORAGE-A',
    toZoneId: 'EXIT-A',
    decisions: [
      {
        ruleId: 'RULE_UNAUTHORIZED_MOVEMENT',
        relatedUldId: uid,
        relatedEventId: 'canonical:99',
        reasonCode: 'NO_ACTIVE_DISPATCH_CONTEXT',
        matched: true,
        alert: { type: 'UNAUTHORIZED_MOVEMENT', level: 'WARNING' },
      },
    ],
  };
  const presentation = presentCanonicalEvent(decisionEvent);
  assert.equal(presentation.type, '已移動 MOVED');
  assert.equal(presentation.location, 'STORAGE-A → EXIT-A');
  assert.equal(presentation.decisions[0].reason, '無有效派遣任務');
  assert.equal(presentation.decisions[0].code, 'NO_ACTIVE_DISPATCH_CONTEXT');
  store.replaceOperations(projection({ events: [decisionEvent] }));
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children.at(-1).dataset.alertLevel, 'WARNING');
});

test('operations refresh polls context with unchanged stream, fences stale responses, survives reconnect and aborts cleanup', async (t) => {
  const store = setup(t),
    requests = [],
    timers = new Map();
  let timerId = 0;
  const client = createOperationsClient({
    store,
    api: {
      read: (uldId, signal) =>
        new Promise((resolve) => requests.push({ uldId, signal, resolve })),
    },
    setTimer: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
  });
  t.after(() => client.stop());
  client.start();
  const a = client.refresh();
  const b = client.refresh();
  assert.equal(requests.length, 1, 'action refresh waits for in-flight poll');
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve(projection());
  await a;
  await flush();
  assert.equal(requests.length, 2);
  requests[1].resolve(
    projection({ task: { ...projection().task, status: 'ACTIVE' } }),
  );
  await b;
  assert.equal(store.getOperationsByUldId(uid).task.status, 'ACTIVE');
  const pending = client.refresh();
  store.setConnectionStatus('RECONNECTING');
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve(projection());
  await pending;
  assert.equal(store.getOperationsByUldId(uid).task.status, 'ACTIVE');
  store.setConnectionStatus('CONNECTED');
  assert.equal(timers.size, 1);
  const last = client.refresh();
  client.stop();
  assert.equal(requests[3].signal.aborted, true);
  assert.equal(timers.size, 0);
  requests[3].resolve(projection());
  await last;
  assert.equal(store.getOperationsByUldId(uid).task.status, 'ACTIVE');
});

test('operations API cancels failed/timeout requests and demo cleanup aborts a pending scenario without local mutation', async (t) => {
  const api = createOperationsApi({
    timeoutMs: 5,
    fetchImpl: (_path, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      ),
  });
  await assert.rejects(api.read(uid), { name: 'AbortError' });
  const store = setup(t);
  const before = store.getSnapshot().records;
  let signal;
  const demo = createOperationsDemo({
    store,
    api: {
      reset: (value) => {
        signal = value;
        return new Promise((_resolve, reject) =>
          value.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        );
      },
    },
  });
  const run = demo.run('NORMAL');
  demo.destroy();
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.deepEqual(store.getSnapshot().records, before);
  await assert.rejects(demo.run('NORMAL'), /unavailable/);
});
