import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { normalizeUldRecord } from './records.js';
import { createUldStore } from './store.js';
import { createMockUldRecords, createUldSource } from '../layers/uld/source.js';
import { createUldRenderer } from '../layers/uld/rendering.js';
import { createStandaloneCatalog } from '../standalone/catalog.js';
import { LayerLifecycle } from '../data/lifecycle.js';

test('mock records have unique stable IDs, separated demo positions and immutable contracts', () => {
  const records = createMockUldRecords().map(normalizeUldRecord);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => r.uldId),
    ['AKE12345CI', 'AKE67890CI', 'PMC92157CI'],
  );
  assert.equal(new Set(records.map((r) => JSON.stringify(r.position))).size, 3);
  for (const record of records) {
    assert.equal(record.positionSource, 'CONFIGURED_DEMO');
    assert.equal(record.stationId, 'TPE');
    assert.ok(Object.isFrozen(record));
    assert.ok(Object.isFrozen(record.position));
  }
  assert.equal(records[0].flight, null);
  assert.equal(records[1].flight, 'CI152');
  assert.equal(records[2].alertLevel, 'WARNING');
});

test('invalid coordinates, identity, revision, time and alert levels are rejected', () => {
  const raw = createMockUldRecords()[0];
  for (const patch of [
    { uldId: '' },
    { position: { longitude: 181, latitude: 25, height: 0 } },
    { revision: -1 },
    { lastSeenAt: 'not a date' },
    { alertLevel: 'UNKNOWN' },
  ])
    assert.throws(() => normalizeUldRecord({ ...raw, ...patch }), TypeError);
  for (const alertLevel of ['NORMAL', 'WARNING', 'CRITICAL'])
    assert.equal(
      normalizeUldRecord({ ...raw, alertLevel }).alertLevel,
      alertLevel,
    );
  assert.throws(() => createUldStore([raw, raw]), /Duplicate ULD ID/);
});

test('selection and versioned updates use the same immutable record, with unsubscribe and cleanup', () => {
  const records = createMockUldRecords();
  const store = createUldStore(records);
  const source = createUldSource(store);
  const events = [];
  const unsubscribe = source.subscribe((snapshot) => events.push(snapshot));
  assert.equal(events.length, 1);
  assert.equal(store.selectUld('unknown'), false);
  assert.equal(source.selectUld(records[0].uldId), true);
  assert.equal(events.at(-1).selectedUldId, records[0].uldId);
  const beforeReselect = events.length;
  source.selectUld(records[0].uldId);
  assert.equal(
    events.length,
    beforeReselect + 1,
    'reselection can reopen a collapsed detail panel',
  );
  assert.equal(events.at(-1).records[0], store.getUldById(records[0].uldId));
  assert.equal(
    source.getUldById(records[0].uldId),
    store.getUldById(records[0].uldId),
  );
  assert.equal(
    store.upsertUld({ ...records[0], revision: 2, alertLevel: 'CRITICAL' }),
    true,
  );
  assert.equal(source.getUldById(records[0].uldId).alertLevel, 'CRITICAL');
  assert.equal(
    store.upsertUld(records[0]),
    false,
    'stale update cannot overwrite newer data',
  );
  assert.equal(store.selectUld(null), true);
  unsubscribe();
  const count = events.length;
  store.selectUld(records[1].uldId);
  assert.equal(events.length, count);
  store.destroy();
  assert.equal(store.selectUld(records[2].uldId), false);
  assert.equal(store.upsertUld({ ...records[0], revision: 3 }), false);
});

test('standalone registers ULD through the sealed production catalog without changing legacy layers', () => {
  const controller = new AbortController();
  try {
    const catalog = createStandaloneCatalog({ signal: controller.signal });
    const lifecycle = new LayerLifecycle({});
    for (const layer of catalog.layers) lifecycle.register(layer);
    lifecycle.finalizeRegistrations(catalog.metadata);
    assert.equal(lifecycle.registrationsFinalized, true);
    assert.ok(catalog.get('flights'));
    assert.ok(catalog.get('ais-live-vessels'));
    assert.ok(catalog.get('uld'));
    assert.equal(catalog.layers.length, 34);
    assert.deepEqual(
      catalog.metadata.find(({ id }) => id === 'uld'),
      {
        id: 'uld',
        disposition: 'local-only',
      },
    );
    assert.equal(catalog.uldStore.getSnapshot().records.length, 3);
    controller.abort();
    assert.equal(catalog.uldStore.selectUld('AKE12345CI'), false);
  } finally {
    controller.abort();
  }
});

test('Cesium entities retain identity, react to store changes, and release subscriptions and resources', async () => {
  const records = createMockUldRecords();
  const store = createUldStore(records);
  const dataSources = new Cesium.DataSourceCollection();
  let renderRequests = 0;
  const renderer = createUldRenderer(
    {
      dataSources,
      scene: {
        requestRender() {
          renderRequests++;
        },
      },
      flyTo() {
        return Promise.resolve(true);
      },
    },
    createUldSource(store),
  );
  await Promise.resolve();
  assert.equal(dataSources.length, 1);
  const dataSource = dataSources.get(0);
  assert.equal(dataSource.entities.values.length, 3);
  const entity = dataSource.entities.getById('uld:AKE12345CI');
  assert.equal(entity.label, undefined, 'no Cesium text labels');
  store.selectUld('AKE12345CI');
  assert.equal(dataSource.entities.getById(entity.id), entity);
  assert.equal(entity.point.pixelSize.getValue(), 24);
  store.upsertUld({ ...records[0], revision: 2, alertLevel: 'CRITICAL' });
  assert.equal(dataSource.entities.getById(entity.id), entity);
  assert.equal(
    entity.point.color.getValue().toCssColorString(),
    'rgb(255,83,100)',
  );
  renderer.setVisible(true);
  assert.equal(dataSource.show, true);
  renderer.setVisible(false);
  assert.equal(dataSource.show, false);
  renderer.destroy();
  assert.equal(dataSources.length, 0);
  const afterDestroy = renderRequests;
  store.selectUld('AKE67890CI');
  assert.equal(
    renderRequests,
    afterDestroy,
    'renderer subscription is released',
  );
  store.destroy();
});
