import test from 'node:test';
import assert from 'node:assert/strict';
import { createUldBackend } from './state.js';
import { createTagRegistry } from './tagRegistry.js';
import { normalizeObservation, normalizeObservedAt } from './observations.js';

const sighting = (overrides = {}) => ({
  observationId: 'obs-test-1',
  tagId: 'TAG001',
  readerId: 'WIN-GW-01',
  rssi: -61,
  observedAt: '2026-10-29T10:00:00Z',
  sourceType: 'BLE',
  ...overrides,
});

test('Observation contract validates calendar/timezone and preserves only a real optional sequence', () => {
  const observation = normalizeObservation(sighting());
  assert.equal(observation.observedAt, '2026-10-29T10:00:00.000Z');
  assert.equal(Object.hasOwn(observation, 'sequence'), false);
  assert.equal(
    normalizeObservation(sighting({ sequence: 1234 })).sequence,
    1234,
  );
  assert.equal(
    normalizeObservedAt('2024-02-29T12:00:00+08:00'),
    '2024-02-29T04:00:00.000Z',
  );
  for (const observedAt of [
    'yesterday',
    '2026-02-30T10:00:00Z',
    '2025-02-29T10:00:00Z',
    '2026-10-29',
    '2026-10-29T10:00:00',
    '2026-10-29T24:00:00Z',
    '2026-10-29T10:60:00Z',
    '2026-10-29T10:00:60Z',
    '2026-10-29T10:00:00+24:00',
    '2026-13-01T10:00:00Z',
    null,
  ])
    assert.throws(
      () => normalizeObservation(sighting({ observedAt })),
      TypeError,
      String(observedAt),
    );
  for (const rssi of [null, '-61', -128, 127, 21, -60.5, NaN, Infinity])
    assert.throws(() => normalizeObservation(sighting({ rssi })), TypeError);
  for (const sequence of [-1, 1.5, null, '1234', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => normalizeObservation(sighting({ sequence })),
      TypeError,
    );
  for (const field of ['observationId', 'tagId', 'readerId', 'sourceType'])
    assert.throws(
      () => normalizeObservation(sighting({ [field]: '' })),
      TypeError,
    );
});

test('Tag Registry is centralized, case-sensitive and independently replaceable', () => {
  const demo = createTagRegistry();
  assert.equal(demo.getUldIdByTagId('TAG001'), 'AKE12345CI');
  assert.equal(demo.getUldIdByTagId('TAG002'), 'AKE67890CI');
  assert.equal(demo.getUldIdByTagId('TAG003'), 'PMC92157CI');
  assert.equal(demo.getUldIdByTagId('tag001'), null);
  const bindings = { 'ACTUAL-TAG': 'AKE67890CI' };
  const registry = createTagRegistry(bindings);
  bindings['ACTUAL-TAG'] = 'AKE12345CI';
  const backend = createUldBackend({ registry });
  const result = backend.observe(sighting({ tagId: 'ACTUAL-TAG' }));
  assert.equal(result.uldId, 'AKE67890CI');
  assert.equal(backend.snapshot().ulds[0].revision, 1);
  backend.close();
});

test('a BLE sighting updates only lastSeenAt and revision, emitting exactly one sequenced ULD_UPSERT', () => {
  const backend = createUldBackend();
  const initial = backend.snapshot();
  const events = [];
  backend.subscribe((event) => events.push(event));
  const result = backend.observe(
    sighting({
      zoneId: 'EXIT-A',
      operationalStatus: 'MOVING',
      alertLevel: 'CRITICAL',
      position: { longitude: 0, latitude: 0 },
    }),
  );
  const after = backend.snapshot();
  assert.deepEqual(result, {
    accepted: true,
    observationId: 'obs-test-1',
    tagId: 'TAG001',
    mapped: true,
    uldId: 'AKE12345CI',
    updated: true,
    duplicate: false,
    streamRevision: 101,
  });
  assert.equal(after.ulds[0].lastSeenAt, '2026-10-29T10:00:00.000Z');
  assert.equal(after.ulds[0].revision, initial.ulds[0].revision + 1);
  assert.deepEqual(
    {
      ...after.ulds[0],
      lastSeenAt: initial.ulds[0].lastSeenAt,
      revision: initial.ulds[0].revision,
    },
    initial.ulds[0],
  );
  assert.deepEqual(after.ulds.slice(1), initial.ulds.slice(1));
  assert.deepEqual(after.alerts, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ULD_UPSERT');
  assert.equal(events[0].streamRevision, 101);
  assert.deepEqual(events[0].payload, after.ulds[0]);
  backend.close();
});

test('unknown tags are accepted without any ULD, alert, revision or event changes', () => {
  const backend = createUldBackend();
  const initial = backend.snapshot();
  let events = 0;
  backend.subscribe(() => events++);
  const result = backend.observe(sighting({ tagId: 'UNREGISTERED' }));
  assert.equal(result.accepted, true);
  assert.equal(result.mapped, false);
  assert.equal(result.updated, false);
  assert.equal(result.streamRevision, 100);
  assert.deepEqual(backend.snapshot().ulds, initial.ulds);
  assert.equal(events, 0);
  backend.close();
});

test('duplicate observationId is idempotent even with another body, while older/equal instants never roll back state', () => {
  const backend = createUldBackend();
  let events = 0;
  backend.subscribe(() => events++);
  backend.observe(sighting());
  const initial = backend.snapshot();
  const duplicate = backend.observe(
    sighting({ tagId: 'TAG002', observedAt: '2026-10-30T10:00:00Z' }),
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.updated, false);
  assert.equal(duplicate.tagId, 'TAG001');
  backend.observe(
    sighting({ observationId: 'old', observedAt: '2026-10-29T09:00:00Z' }),
  );
  backend.observe(
    sighting({
      observationId: 'equal',
      observedAt: '2026-10-29T18:00:00+08:00',
    }),
  );
  assert.deepEqual(backend.snapshot().ulds, initial.ulds);
  assert.equal(backend.snapshot().streamRevision, 101);
  assert.equal(events, 1);
  assert.equal(backend.recentObservations().length, 3);
  assert.equal(backend.recentObservations().at(-1).reason, 'NOT_NEWER');
  backend.close();
});

test('dedupe and diagnostics are bounded and diagnostics cannot mutate backend state', () => {
  const backend = createUldBackend({ dedupeCapacity: 2, recentCapacity: 2 });
  for (let i = 1; i <= 3; i++)
    backend.observe(
      sighting({
        observationId: `id-${i}`,
        observedAt: `2026-10-29T10:00:0${i}Z`,
      }),
    );
  const recent = backend.recentObservations();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].observationId, 'id-2');
  assert.throws(() => {
    recent[0].tagId = 'TAG002';
  }, TypeError);
  assert.equal(
    backend.observe(sighting({ observationId: 'id-2' })).duplicate,
    true,
  );
  const replay = backend.observe(
    sighting({ observationId: 'id-1', observedAt: '2026-10-29T10:00:01Z' }),
  );
  assert.equal(replay.duplicate, false, 'oldest ID was evicted');
  assert.equal(
    replay.updated,
    false,
    'time protection still prevents a replay update',
  );
  assert.equal(backend.snapshot().streamRevision, 103);
  backend.close();
  assert.equal(backend.recentObservations().length, 0);
  assert.throws(() => backend.observe(sighting()), /closed/);
});
