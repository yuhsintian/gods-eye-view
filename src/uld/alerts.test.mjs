import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  normalizeUldAlert,
  ULD_ALERT_TYPES,
  ULD_ALERT_STATUSES,
} from './alerts.js';
import { createUldStore } from './store.js';
import {
  createUldDemoScenario,
  DEMO_MOVEMENT_ALERT_ID,
} from './demoScenario.js';
import { createMockUldRecords, createUldSource } from '../layers/uld/source.js';
import { createUldRenderer } from '../layers/uld/rendering.js';

const makeAlert = (patch = {}) => ({
  alertId: 'alert-1',
  uldId: 'AKE12345CI',
  type: 'UNAUTHORIZED_MOVEMENT',
  level: 'WARNING',
  title: 'Unauthorized ULD movement',
  message: 'ULD left STORAGE-A without a valid dispatch.',
  occurredAt: '2026-10-28T18:00:00+08:00',
  status: 'ACTIVE',
  revision: 1,
  fromZoneId: 'STORAGE-A',
  toZoneId: 'EXIT-A',
  ...patch,
});
function fixture() {
  const initial = createMockUldRecords();
  const store = createUldStore(initial);
  const scenario = createUldDemoScenario({
    store,
    initialRecords: initial,
    now: () => new Date('2026-10-28T10:00:00.000Z'),
  });
  return { initial, store, scenario };
}

test('alert contract validates enums, time, revision and immutable records', () => {
  const alert = normalizeUldAlert(makeAlert());
  assert.equal(alert.occurredAt, '2026-10-28T10:00:00.000Z');
  assert.ok(Object.isFrozen(alert));
  for (const type of ULD_ALERT_TYPES)
    assert.equal(normalizeUldAlert(makeAlert({ type })).type, type);
  for (const status of ULD_ALERT_STATUSES)
    assert.equal(normalizeUldAlert(makeAlert({ status })).status, status);
  for (const patch of [
    { alertId: '' },
    { uldId: '' },
    { type: 'UNKNOWN' },
    { level: 'UNKNOWN' },
    { status: 'UNKNOWN' },
    { occurredAt: 'invalid' },
    { revision: -1 },
    { revision: 1.2 },
    { title: '' },
    { message: '' },
    { toZoneId: '' },
  ])
    assert.throws(() => normalizeUldAlert(makeAlert(patch)), TypeError);
});

test('upsertAlert shares snapshots and associates alerts with their ULD; stale revisions cannot overwrite', () => {
  const { store } = fixture();
  const events = [];
  const changes = [];
  const off = store.subscribe((snapshot, change) => {
    events.push(snapshot);
    changes.push(change);
  });
  assert.equal(
    store.upsertAlert(
      makeAlert({ alertId: ' alert-1 ', uldId: ' AKE12345CI ' }),
    ),
    true,
  );
  assert.equal(changes.at(-1).alertId, 'alert-1');
  const alert = store.getAlertById('alert-1');
  assert.equal(store.getUldById(alert.uldId).uldType, 'AKE');
  assert.equal(events.at(-1).alerts[0], alert);
  assert.ok(Object.isFrozen(events.at(-1).alerts));
  assert.equal(store.getAlertById('missing'), null);
  const uld = store.getUldById('AKE12345CI');
  assert.equal(
    store.upsertUld({ ...uld, uldId: ' AKE12345CI ', revision: 2 }),
    true,
  );
  assert.equal(changes.at(-1).uldId, 'AKE12345CI');
  assert.equal(
    store.upsertAlert(makeAlert({ revision: 2, level: 'CRITICAL' })),
    true,
  );
  assert.equal(store.upsertAlert(makeAlert()), false);
  assert.equal(store.upsertAlert(makeAlert({ revision: 2 })), false);
  assert.equal(store.getAlertById('alert-1').level, 'CRITICAL');
  off();
  store.destroy();
});

test('getActiveAlerts includes acknowledged ongoing alerts and excludes resolved alerts', () => {
  const { store } = fixture();
  for (const [index, status] of ULD_ALERT_STATUSES.entries())
    store.upsertAlert(makeAlert({ alertId: `alert-${index}`, status }));
  assert.deepEqual(
    store.getActiveAlerts().map((a) => a.status),
    ['ACTIVE', 'ACKNOWLEDGED'],
  );
  assert.ok(Object.isFrozen(store.getActiveAlerts()));
  store.destroy();
});

test('resolveAlert advances revision and stale events cannot reactivate a resolved alert', () => {
  const { store } = fixture();
  store.upsertAlert(makeAlert());
  assert.equal(store.resolveAlert('alert-1', { revision: 1 }), false);
  assert.equal(store.resolveAlert('alert-1'), true);
  assert.equal(store.getAlertById('alert-1').status, 'RESOLVED');
  assert.equal(store.getAlertById('alert-1').revision, 2);
  assert.equal(store.getActiveAlerts().length, 0);
  assert.equal(store.upsertAlert(makeAlert()), false);
  assert.equal(store.resolveAlert('missing'), false);
  assert.equal(store.resolveAlert('alert-1'), false);
  store.destroy();
  assert.equal(store.upsertAlert(makeAlert({ revision: 3 })), false);
});

test('orphan alerts, duplicate IDs and alert identity reassignment are rejected', () => {
  const { store } = fixture();
  assert.throws(
    () => store.upsertAlert(makeAlert({ uldId: 'missing' })),
    /Unknown alert ULD/,
  );
  assert.equal(store.getActiveAlerts().length, 0);
  store.upsertAlert(makeAlert());
  assert.throws(
    () => store.upsertAlert(makeAlert({ uldId: 'AKE67890CI', revision: 2 })),
    /identity/,
  );
  assert.equal(store.getAlertById('alert-1').uldId, 'AKE12345CI');
  assert.throws(
    () => createUldStore(createMockUldRecords(), [makeAlert(), makeAlert()]),
    /Duplicate alert ID/,
  );
  store.destroy();
});

test('atomic ULD and alert publications reject stale or malformed batches entirely', () => {
  const { store } = fixture();
  store.upsertAlert(makeAlert());
  const original = store.getUldById('AKE12345CI');
  assert.equal(
    store.applyChanges({
      records: [{ ...original, revision: 2, alertLevel: 'WARNING' }],
      alerts: [makeAlert()],
    }),
    false,
  );
  assert.equal(store.getUldById(original.uldId), original);
  assert.throws(
    () =>
      store.applyChanges({
        records: [{ ...original, revision: 2 }],
        alerts: [makeAlert({ revision: 2, level: 'INVALID' })],
      }),
    TypeError,
  );
  assert.equal(store.getUldById(original.uldId), original);
  assert.throws(
    () => store.applyChanges({ records: [original, original] }),
    /Duplicate identities/,
  );
  store.destroy();
});

test('scenario updates ULD and creates one WARNING movement alert in one consistent notification', () => {
  const { store, scenario } = fixture();
  const events = [];
  const off = store.subscribe((snapshot) => events.push(snapshot));
  assert.equal(scenario.simulateUnauthorizedMovement(), true);
  assert.equal(events.length, 2);
  const record = store.getUldById('AKE12345CI');
  assert.equal(record.zoneId, 'EXIT-A');
  assert.equal(record.operationalStatus, 'MOVING');
  assert.equal(record.alertLevel, 'WARNING');
  assert.equal(record.serviceabilityStatus, 'SERVICEABLE');
  assert.equal(record.positionSource, 'CONFIGURED_DEMO');
  assert.equal(record.revision, 2);
  const [alert] = store.getActiveAlerts();
  assert.equal(alert.type, 'UNAUTHORIZED_MOVEMENT');
  assert.equal(alert.level, 'WARNING');
  assert.equal(alert.uldId, record.uldId);
  assert.equal(alert.occurredAt, '2026-10-28T10:00:00.000Z');
  assert.equal(scenario.simulateUnauthorizedMovement(), false);
  assert.equal(store.getActiveAlerts().length, 1);
  off();
  store.destroy();
});

test('reset restores baseline data and positions, preserves selection, resolves only demo alerts and advances revisions', () => {
  const { store, scenario, initial } = fixture();
  scenario.simulateUnauthorizedMovement();
  const stale = store.getAlertById(DEMO_MOVEMENT_ALERT_ID);
  store.upsertAlert(
    makeAlert({
      alertId: 'unrelated',
      uldId: 'AKE67890CI',
      type: 'DWELL_WARNING',
    }),
  );
  store.selectUld('AKE12345CI');
  assert.equal(scenario.reset(), true);
  for (const raw of initial) {
    const record = store.getUldById(raw.uldId);
    assert.deepEqual({ ...record, revision: raw.revision }, raw);
    assert.ok(record.revision > raw.revision);
  }
  assert.equal(store.getSnapshot().selectedUldId, 'AKE12345CI');
  assert.equal(store.getAlertById(DEMO_MOVEMENT_ALERT_ID).status, 'RESOLVED');
  assert.equal(store.getActiveAlerts()[0].alertId, 'unrelated');
  assert.equal(store.upsertAlert(stale), false);
  assert.equal(scenario.simulateUnauthorizedMovement(), true);
  assert.equal(store.getAlertById(DEMO_MOVEMENT_ALERT_ID).revision, 3);
  scenario.reset();
  scenario.reset();
  assert.equal(store.getAlertById(DEMO_MOVEMENT_ALERT_ID).revision, 4);
  store.destroy();
});

test('scenario/reset repaint markers without replacing DataSource, Entity or PointGraphics', async () => {
  const { store, scenario } = fixture();
  const dataSources = new Cesium.DataSourceCollection();
  const renderer = createUldRenderer(
    { dataSources, scene: { requestRender() {} } },
    createUldSource(store),
  );
  await Promise.resolve();
  const dataSource = dataSources.get(0);
  const entity = dataSource.entities.getById('uld:AKE12345CI');
  const point = entity.point;
  const other = dataSource.entities.getById('uld:AKE67890CI').point;
  const color = () => point.color.getValue().toCssColorString();
  assert.equal(color(), 'rgb(67,217,176)');
  scenario.simulateUnauthorizedMovement();
  assert.equal(color(), 'rgb(255,189,74)');
  assert.equal(entity.point, point);
  const current = store.getUldById('AKE12345CI');
  store.upsertUld({
    ...current,
    revision: current.revision + 1,
    alertLevel: 'CRITICAL',
  });
  assert.equal(color(), 'rgb(255,83,100)');
  scenario.reset();
  assert.equal(color(), 'rgb(67,217,176)');
  assert.equal(dataSources.get(0), dataSource);
  assert.equal(dataSource.entities.getById(entity.id), entity);
  assert.equal(entity.point, point);
  assert.equal(dataSource.entities.getById('uld:AKE67890CI').point, other);
  assert.equal(dataSource.entities.values.length, 3);
  renderer.destroy();
  store.destroy();
});
