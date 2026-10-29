import test from 'node:test';
import assert from 'node:assert/strict';
import { createUldStore, ULD_CONNECTION_STATUSES } from './store.js';
import { createMockUldRecords } from './mockData.js';
import * as Cesium from 'cesium';
import { createUldRenderer } from '../layers/uld/rendering.js';
import { createUldSource } from '../layers/uld/source.js';

test('authoritative same-revision snapshots repaint markers without replacing Cesium resources', async () => {
  const record = createMockUldRecords()[0],
    store = createUldStore([record]);
  const dataSources = new Cesium.DataSourceCollection();
  const renderer = createUldRenderer(
    { dataSources, scene: { requestRender() {} } },
    createUldSource(store),
  );
  await Promise.resolve();
  const source = dataSources.get(0),
    entity = source.entities.getById(`uld:${record.uldId}`),
    point = entity.point;
  store.replaceSnapshot({
    ulds: [{ ...record, alertLevel: 'CRITICAL' }],
    alerts: [],
  });
  assert.equal(point.color.getValue().toCssColorString(), 'rgb(255,83,100)');
  assert.equal(dataSources.get(0), source);
  assert.equal(entity.point, point);
  renderer.destroy();
  store.destroy();
});

test('connection enums publish through the same store and stop after cleanup', () => {
  const store = createUldStore();
  const states = [];
  const off = store.subscribe((snapshot) =>
    states.push(snapshot.connectionStatus),
  );
  for (const status of ULD_CONNECTION_STATUSES)
    store.setConnectionStatus(status);
  assert.equal(states.at(-1), 'RECONNECTING');
  assert.throws(() => store.setConnectionStatus('UNKNOWN'), TypeError);
  off();
  store.destroy();
  assert.equal(store.getSnapshot().connectionStatus, 'DISCONNECTED');
  assert.equal(store.setConnectionStatus('CONNECTED'), false);
});

test('snapshot replacement is atomic, clears absent records and retains valid selection', () => {
  const records = createMockUldRecords();
  const store = createUldStore(records);
  store.selectUld(records[0].uldId);
  assert.throws(
    () => store.replaceSnapshot({ ulds: [records[0], records[0]], alerts: [] }),
    /Duplicate/,
  );
  assert.equal(store.getSnapshot().records.length, 3);
  store.replaceSnapshot({ ulds: [records[0]], alerts: [] });
  assert.equal(store.getSnapshot().records.length, 1);
  assert.equal(store.getSnapshot().selectedUldId, records[0].uldId);
  assert.equal(store.getUldById(records[1].uldId), null);
  store.replaceSnapshot({ ulds: [], alerts: [] });
  assert.equal(store.getSnapshot().selectedUldId, null);
  store.destroy();
});

test('snapshot does not weaken stale record protection on subsequent live events', () => {
  const record = createMockUldRecords()[0];
  const store = createUldStore();
  store.replaceSnapshot({ ulds: [{ ...record, revision: 10 }], alerts: [] });
  assert.equal(
    store.upsertUld({ ...record, revision: 9, zoneId: 'STALE' }),
    false,
  );
  assert.equal(store.getUldById(record.uldId).zoneId, 'STORAGE-A');
  store.destroy();
});
