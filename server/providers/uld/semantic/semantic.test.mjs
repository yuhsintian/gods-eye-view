import test from 'node:test';
import assert from 'node:assert/strict';
import { createUldBackend } from '../state.js';
import { createReaderRegistry } from './readerRegistry.js';
import { createEvidenceStore } from './evidenceStore.js';
import { createRecentStore } from './eventStore.js';
import { canonicalEvent, SEMANTIC_RELATIONSHIPS } from './model.js';
import { inferencePolicy } from './policy.js';
import { createMockUldRecords } from '../../../../src/uld/mockData.js';

const BASE = Date.parse('2026-11-01T00:00:00Z');
const STORAGE = 'TPE-STORAGE-GW-01',
  EXIT = 'TPE-EXIT-GW-01';
function fixture(t, options = {}) {
  const backend = createUldBackend({
    now: () => new Date(BASE + 100000),
    ...options,
  });
  t.after(() => backend.close());
  let sequence = 0;
  const raw = (readerId, ms, extra = {}) => ({
    observationId: `unit-${++sequence}`,
    tagId: 'TAG001',
    readerId,
    rssi: -61,
    observedAt: new Date(BASE + ms).toISOString(),
    sourceType: 'BLE',
    ...extra,
  });
  return {
    backend,
    raw,
    observe: (reader, ms, extra) => backend.observe(raw(reader, ms, extra)),
    record: () =>
      backend.snapshot().ulds.find((record) => record.uldId === 'AKE12345CI'),
    diagnostics: backend.semanticDiagnostics,
    events: (type) =>
      backend
        .semanticDiagnostics()
        .events.filter((event) => event.eventType === type),
  };
}

test('known Readers resolve configured station/zone positions; unknown readers remain unknown', () => {
  const registry = createReaderRegistry();
  const reader = registry.getReaderContext(STORAGE);
  assert.equal(reader.stationId, 'TPE');
  assert.equal(reader.zoneId, 'STORAGE-A');
  assert.equal(reader.positionSource, 'CONFIGURED_READER_ZONE');
  assert.ok(Object.isFrozen(reader.position));
  assert.equal(registry.getReaderContext(EXIT).zoneId, 'EXIT-A');
  assert.equal(
    registry.getReaderContext('TPE-STAGING-GW-01').zoneId,
    'STAGING-A',
  );
  assert.equal(registry.getReaderContext('UNKNOWN'), null);
  assert.throws(
    () =>
      createReaderRegistry({ BAD: { stationId: 'TPE', zoneId: 'MISSING' } }),
    TypeError,
  );
});

test('semantic relationships and canonical types are explicit and immutable', () => {
  assert.ok(
    SEMANTIC_RELATIONSHIPS.some(
      ([from, , to]) => from === 'DispatchContext' && to === 'ULDType',
    ),
  );
  const event = {
    eventId: 'canonical:1',
    eventType: 'OBSERVED',
    uldId: 'AKE12345CI',
    occurredAt: new Date(BASE).toISOString(),
    source: 'BLE',
    evidenceObservationIds: ['a', 'a'],
  };
  assert.deepEqual(canonicalEvent(event).evidenceObservationIds, ['a']);
  assert.throws(
    () => canonicalEvent({ ...event, eventType: 'UI moved!' }),
    TypeError,
  );
  assert.throws(() => canonicalEvent({ ...event, source: 'GPS' }), TypeError);
});

test('unknown Reader sightings update only Last Seen, never location, movement or alerts', (t) => {
  const f = fixture(t),
    before = f.record();
  f.observe('WIN-GW-01', 0, { rssi: 20 });
  f.observe('WIN-GW-01', 1000, { rssi: -127 });
  const after = f.record();
  assert.deepEqual(
    { ...after, lastSeenAt: before.lastSeenAt, revision: before.revision },
    before,
  );
  assert.equal(f.events('OBSERVED').length, 2);
  assert.equal(f.events('LOCATED').length, 0);
  assert.equal(f.events('MOVED').length, 0);
  assert.deepEqual(f.backend.snapshot().alerts, []);
  assert.equal(f.diagnostics().evidence[0].zoneId, null);
});

test('single known Reader observation is insufficient even with a strong RSSI', (t) => {
  const f = fixture(t);
  f.observe(EXIT, 0, { rssi: 20 });
  assert.equal(f.record().zoneId, 'STORAGE-A');
  assert.equal(f.record().positionSource, 'CONFIGURED_DEMO');
  assert.equal(f.events('LOCATED').length, 0);
});

test('two observations confirm the first location; initial Mock zone never seeds movement', (t) => {
  const f = fixture(t);
  f.observe(EXIT, 0);
  f.observe(EXIT, 1000);
  assert.equal(f.record().zoneId, 'EXIT-A');
  assert.equal(f.record().positionSource, 'READER_ZONE_INFERENCE');
  assert.deepEqual(
    f.record().position,
    createReaderRegistry().getReaderContext(EXIT).position,
  );
  assert.equal(f.events('LOCATED').length, 1);
  assert.equal(f.events('MOVED').length, 0);
  assert.deepEqual(f.backend.snapshot().alerts, []);
});

test('outside-window evidence cannot confirm; a fresh pair can', (t) => {
  const f = fixture(t);
  f.observe(EXIT, 0);
  f.observe(EXIT, 5001);
  assert.equal(f.events('LOCATED').length, 0);
  f.observe(EXIT, 5002);
  assert.equal(f.events('LOCATED').length, 1);
});

test('the centralized five-second window is inclusive at its boundary', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 5000);
  assert.equal(f.events('LOCATED').length, 1);
  assert.equal(f.diagnostics().policy.minObservations, 2);
});

test('same confirmed zone and changing RSSI never create Movement', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++)
    f.observe(STORAGE, i * 1000, { rssi: i % 2 ? -127 : 20 });
  assert.equal(f.record().zoneId, 'STORAGE-A');
  assert.equal(f.events('MOVED').length, 0);
  assert.equal(f.events('LOCATED').length, 1);
  assert.deepEqual(f.backend.snapshot().alerts, []);
});

test('only confirmed STORAGE to EXIT creates MOVED with both sets of supporting IDs', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.observe(EXIT, 2000);
  assert.equal(f.record().zoneId, 'STORAGE-A');
  assert.equal(f.events('MOVED').length, 0);
  // Observation payload cannot activate a dispatch or inject business truth.
  f.observe(EXIT, 3000, {
    dispatchContext: { active: true },
    operationalStatus: 'MOVING',
  });
  const moved = f.events('MOVED')[0];
  assert.equal(moved.fromStationId, 'TPE');
  assert.equal(moved.toStationId, 'TPE');
  assert.equal(moved.fromZoneId, 'STORAGE-A');
  assert.equal(moved.toZoneId, 'EXIT-A');
  assert.equal(moved.source, 'OBSERVATION_INFERENCE');
  assert.deepEqual(moved.evidenceObservationIds, [
    'unit-1',
    'unit-2',
    'unit-3',
    'unit-4',
  ]);
  assert.equal(
    f.record().operationalStatus,
    'AVAILABLE',
    'location does not silently reassign operational state',
  );
  assert.equal(f.record().alertLevel, 'WARNING');
  const decision = f
    .diagnostics()
    .ruleDecisions.find((item) => item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT');
  assert.equal(decision.matched, true);
  assert.equal(decision.reasonCode, 'NO_ACTIVE_DISPATCH_CONTEXT');
  assert.equal(decision.relatedEventId, moved.eventId);
  assert.equal(f.backend.snapshot().alerts[0].type, 'UNAUTHORIZED_MOVEMENT');
});

test('interleaved Readers break a confirmation candidate rather than creating a packet-switch Movement', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.observe(EXIT, 2000);
  f.observe(STORAGE, 3000);
  f.observe(EXIT, 4000);
  assert.equal(f.events('MOVED').length, 0);
  f.observe(EXIT, 4500);
  assert.equal(f.events('MOVED').length, 1);
});

test('late evidence is recorded but cannot roll back a newer inference or Last Seen', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.observe(EXIT, 2000);
  f.observe(EXIT, 3000);
  const before = f.record(),
    count = f.events('MOVED').length;
  f.observe(STORAGE, 1500);
  f.observe(STORAGE, 2500);
  assert.deepEqual(f.record(), before);
  assert.equal(f.diagnostics().inferredLocations[0].zoneId, 'EXIT-A');
  assert.equal(f.events('MOVED').length, count);
  assert.equal(f.diagnostics().evidence.length, 6);
});

test('evidence older than existing Last Seen does not assert even a first semantic location', (t) => {
  const f = fixture(t);
  const time = Date.parse(f.record().lastSeenAt) - BASE;
  f.observe(EXIT, time - 2000);
  f.observe(EXIT, time - 1000);
  assert.equal(f.events('LOCATED').length, 0);
  assert.equal(f.record().positionSource, 'CONFIGURED_DEMO');
});

test('duplicate IDs do not duplicate evidence, movement, decisions, revisions or stream events', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.observe(EXIT, 2000);
  const last = f.raw(EXIT, 3000);
  f.backend.observe(last);
  const before = f.backend.snapshot(),
    diagnostics = f.diagnostics();
  assert.equal(f.backend.observe(last).duplicate, true);
  assert.deepEqual(f.backend.snapshot().ulds, before.ulds);
  assert.equal(f.backend.snapshot().streamRevision, before.streamRevision);
  assert.deepEqual(f.diagnostics(), diagnostics);
});

test('evidence, event and decision journals stay bounded and immutable', (t) => {
  const f = fixture(t, {
    inferencePolicy: { evidencePerUld: 3, recentEvents: 5, recentDecisions: 2 },
  });
  for (let i = 0; i < 12; i++)
    f.observe(Math.floor(i / 2) % 2 ? EXIT : STORAGE, i * 1000);
  const diagnostics = f.diagnostics();
  assert.equal(diagnostics.evidence.length, 3);
  assert.equal(diagnostics.events.length, 5);
  assert.equal(diagnostics.ruleDecisions.length, 2);
  assert.throws(() => {
    diagnostics.evidence[0].zoneId = 'WRONG';
  }, TypeError);
  assert.throws(() => diagnostics.events.pop(), TypeError);
  assert.throws(() => inferencePolicy({ minObservations: 1 }), TypeError);
  assert.throws(() => createEvidenceStore({ perUldLimit: 0 }), TypeError);
  assert.throws(() => createRecentStore(0), TypeError);
});

test('dispatch context activates/clears independently, with required type from the ULD', (t) => {
  const f = fixture(t),
    before = f.record();
  const context = f.backend.activateDispatch({
    uldId: 'AKE12345CI',
    taskId: 'TASK-CI152-01',
    flight: 'CI152',
    destination: 'KIX',
  });
  assert.equal(context.active, true);
  assert.equal(context.requiredUldType, 'AKE');
  assert.deepEqual(f.record(), before);
  assert.equal(f.backend.clearDispatch({ uldId: 'AKE12345CI' }).active, false);
  assert.equal(f.diagnostics().dispatchContexts.length, 0);
  assert.throws(
    () => f.backend.activateDispatch({ uldId: 'UNKNOWN' }),
    TypeError,
  );
  assert.throws(
    () => f.backend.activateDispatch({ uldId: 'AKE12345CI', taskId: '' }),
    TypeError,
  );
});

test('valid dispatch produces the identical route Movement with no unauthorized alert', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.backend.activateDispatch({
    uldId: 'AKE12345CI',
    taskId: 'TASK-CI152-01',
    flight: 'CI152',
    destination: 'KIX',
  });
  f.observe(EXIT, 2000);
  f.observe(EXIT, 3000);
  assert.equal(f.events('MOVED').length, 1);
  assert.equal(f.record().zoneId, 'EXIT-A');
  assert.equal(f.record().alertLevel, 'NORMAL');
  assert.deepEqual(f.backend.snapshot().alerts, []);
  const decision = f
    .diagnostics()
    .ruleDecisions.find((item) => item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT');
  assert.equal(decision.matched, false);
  assert.equal(decision.reasonCode, 'ACTIVE_DISPATCH_CONTEXT');
  assert.equal(decision.facts.taskId, 'TASK-CI152-01');
});

test('active dispatch with wrong type is not valid authorization', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.backend.activateDispatch({
    uldId: 'AKE12345CI',
    taskId: 'TASK',
    flight: 'CI152',
    destination: 'KIX',
    requiredUldType: 'PMC',
  });
  f.observe(EXIT, 2000);
  f.observe(EXIT, 3000);
  assert.equal(
    f
      .diagnostics()
      .ruleDecisions.find((d) => d.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT')
      .reasonCode,
    'DISPATCH_ULD_TYPE_MISMATCH',
  );
});

test('UNSERVICEABLE is independent from assignment and creates its own alert command/projection', (t) => {
  const initialRecords = createMockUldRecords().map((record, i) =>
    i ? record : { ...record, serviceabilityStatus: 'UNSERVICEABLE' },
  );
  const f = fixture(t, { initialRecords });
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.backend.activateDispatch({
    uldId: 'AKE12345CI',
    taskId: 'TASK',
    flight: 'CI152',
    destination: 'KIX',
  });
  f.observe(EXIT, 2000);
  f.observe(EXIT, 3000);
  assert.ok(
    f.backend
      .snapshot()
      .alerts.some((a) => a.type === 'UNSERVICEABLE' && a.level === 'WARNING'),
  );
  assert.equal(f.record().serviceabilityStatus, 'UNSERVICEABLE');
  assert.equal(
    f.diagnostics().ruleDecisions.find((d) => d.ruleId === 'RULE_UNSERVICEABLE')
      .reasonCode,
    'UNSERVICEABLE_ULD',
  );
});

test('reset clears semantic state, resolves all alerts and keeps global/record revisions monotonic', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.observe(EXIT, 2000);
  f.observe(EXIT, 3000);
  f.backend.activateDispatch({
    uldId: 'AKE12345CI',
    taskId: 'TASK',
    flight: 'CI152',
    destination: 'KIX',
  });
  const before = f.backend.snapshot();
  f.backend.reset();
  const after = f.backend.snapshot(),
    state = f.diagnostics();
  for (const key of [
    'events',
    'ruleDecisions',
    'evidence',
    'inferredLocations',
    'dispatchContexts',
  ])
    assert.deepEqual(state[key], []);
  assert.ok(after.streamRevision > before.streamRevision);
  assert.ok(after.ulds[0].revision > before.ulds[0].revision);
  assert.ok(after.alerts.every((alert) => alert.status === 'RESOLVED'));
  assert.equal(f.record().zoneId, 'STORAGE-A');
  assert.equal(f.record().positionSource, 'CONFIGURED_DEMO');
  f.observe(EXIT, 4000);
  f.observe(EXIT, 5000);
  assert.equal(
    f.events('MOVED').length,
    0,
    'reset never promotes the Mock origin to confirmed evidence',
  );
});

test('unknown Tags do not create semantic facts; separate Readers cannot combine one packet each', (t) => {
  const readers = createReaderRegistry({
    A: { stationId: 'TPE', zoneId: 'STORAGE-A' },
    B: { stationId: 'TPE', zoneId: 'STORAGE-A' },
  });
  const f = fixture(t, { readers });
  f.observe('A', 0, { tagId: 'UNKNOWN' });
  assert.deepEqual(f.diagnostics().events, []);
  f.observe('A', 1000);
  f.observe('B', 2000);
  assert.equal(f.events('LOCATED').length, 0);
  f.observe('B', 3000);
  assert.equal(f.events('LOCATED').length, 1);
});

test('legacy direct Demo invalidates live inferred location without inventing a canonical Movement', (t) => {
  const f = fixture(t);
  f.observe(STORAGE, 0);
  f.observe(STORAGE, 1000);
  f.backend.simulate();
  assert.equal(f.record().operationalStatus, 'MOVING');
  assert.equal(f.record().positionSource, 'CONFIGURED_DEMO');
  assert.deepEqual(f.diagnostics().inferredLocations, []);
  assert.deepEqual(f.diagnostics().evidence, []);
  assert.equal(f.events('MOVED').length, 0);
});
