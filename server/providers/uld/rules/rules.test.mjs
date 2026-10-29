import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMovementRules, evaluateDwellRules } from './engine.js';
import { inferMovement } from '../semantic/movementInference.js';
import { createMockUldRecords } from '../../../../src/uld/mockData.js';

const uld = createMockUldRecords()[0];
const evaluatedAt = '2026-11-01T00:00:10.000Z';
const location = (zoneId, inferredAt, ids) => ({
  uldId: uld.uldId,
  stationId: 'TPE',
  zoneId,
  inferredAt,
  evidenceObservationIds: ids,
});
const event = inferMovement(
  location('STORAGE-A', '2026-11-01T00:00:01Z', ['s1', 's2']),
  location('EXIT-A', '2026-11-01T00:00:03Z', ['e1', 'e2']),
  'canonical:movement-1',
);
const dispatch = {
  uldId: uld.uldId,
  active: true,
  taskId: 'TASK-CI152-01',
  flight: 'CI152',
  destination: 'KIX',
  requiredUldType: 'AKE',
};
const unauthorized = (input = {}) =>
  evaluateMovementRules({ uld, event, evaluatedAt, ...input }).find(
    (d) => d.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT',
  );

test('no active dispatch matches unauthorized movement with an auditable explanation', () => {
  const decision = unauthorized();
  assert.equal(decision.matched, true);
  assert.equal(decision.reasonCode, 'NO_ACTIVE_DISPATCH_CONTEXT');
  assert.equal(decision.relatedEventId, event.eventId);
  assert.equal(decision.relatedUldId, uld.uldId);
  assert.equal(decision.evaluatedAt, evaluatedAt);
  assert.equal(decision.alert.type, 'UNAUTHORIZED_MOVEMENT');
  assert.equal(decision.alert.level, 'WARNING');
});

test('same Movement with active, compatible and serviceable dispatch produces no unauthorized command', () => {
  const decision = unauthorized({ dispatch });
  assert.equal(decision.matched, false);
  assert.equal(decision.reasonCode, 'ACTIVE_DISPATCH_CONTEXT');
  assert.equal(Object.hasOwn(decision, 'alert'), false);
});

test('wrong type, different ULD and inactive context cannot authorize this ULD', () => {
  assert.equal(
    unauthorized({ dispatch: { ...dispatch, requiredUldType: 'PMC' } })
      .reasonCode,
    'DISPATCH_ULD_TYPE_MISMATCH',
  );
  assert.equal(
    unauthorized({ dispatch: { ...dispatch, uldId: 'ANOTHER' } }).reasonCode,
    'NO_ACTIVE_DISPATCH_CONTEXT',
  );
  assert.equal(
    unauthorized({ dispatch: { ...dispatch, active: false } }).matched,
    true,
  );
});

test('non-target transitions and non-Movement events never match unauthorized movement', () => {
  assert.equal(
    unauthorized({ event: { ...event, fromZoneId: 'STAGING-A' } }).matched,
    false,
  );
  assert.equal(
    unauthorized({ event: { ...event, eventType: 'OBSERVED' } }).matched,
    false,
  );
});

test('unserviceability stays a separate dimension and can emit its own command despite active dispatch', () => {
  const decisions = evaluateMovementRules({
    uld: { ...uld, serviceabilityStatus: 'UNSERVICEABLE' },
    event,
    dispatch,
    evaluatedAt,
  });
  const decision = decisions.find((d) => d.ruleId === 'RULE_UNSERVICEABLE');
  assert.equal(decision.matched, true);
  assert.equal(decision.reasonCode, 'UNSERVICEABLE_ULD');
  assert.equal(decision.alert.type, 'UNSERVICEABLE');
  assert.equal(decision.facts.dispatchActive, true);
});

test('59 days is below dwell thresholds; exactly 60 days matches WARNING', () => {
  const start = Date.parse('2026-01-01T00:00:00Z'),
    day = 86400000;
  assert.ok(
    evaluateDwellRules({
      uld,
      stationEnteredAt: new Date(start).toISOString(),
      now: start + 60 * day - 1,
    }).every((d) => !d.matched),
  );
  const decisions = evaluateDwellRules({
    uld,
    stationEnteredAt: new Date(start).toISOString(),
    now: start + 60 * day,
  });
  assert.equal(decisions[0].matched, true);
  assert.equal(decisions[0].reasonCode, 'STATION_DWELL_60_DAYS');
  assert.equal(decisions[0].alert.type, 'DWELL_WARNING');
  assert.equal(decisions[0].facts.thresholdDays, 60);
  assert.equal(
    decisions[0].facts.stationEnteredAt,
    new Date(start).toISOString(),
  );
  assert.equal(decisions[0].facts.elapsedMs, 60 * day);
  assert.equal(decisions[1].matched, false);
});

test('exactly 180 days matches LOST_CANDIDATE without declaring actual loss or changing ULD', () => {
  const start = Date.parse('2026-01-01T00:00:00Z'),
    before = structuredClone(uld);
  const decisions = evaluateDwellRules({
    uld,
    stationEnteredAt: new Date(start).toISOString(),
    now: start + 180 * 86400000,
  });
  assert.equal(decisions[1].matched, true);
  assert.equal(decisions[1].reasonCode, 'STATION_DWELL_180_DAYS');
  assert.equal(decisions[1].alert.type, 'LOST_CANDIDATE');
  assert.equal(decisions[1].relatedEventId, null);
  assert.deepEqual(uld, before);
  assert.throws(
    () => evaluateDwellRules({ uld, stationEnteredAt: 'unknown', now: start }),
    TypeError,
  );
});

test('rule decisions are deterministic, immutable and always contain the audit contract', () => {
  const input = { uld, event, dispatch, evaluatedAt };
  assert.deepEqual(evaluateMovementRules(input), evaluateMovementRules(input));
  for (const decision of evaluateMovementRules(input)) {
    for (const key of [
      'ruleId',
      'matched',
      'reasonCode',
      'evaluatedAt',
      'relatedUldId',
      'relatedEventId',
    ])
      assert.ok(Object.hasOwn(decision, key));
    assert.throws(() => {
      decision.reasonCode = 'guessed';
    }, TypeError);
  }
});

test('same zones or non-increasing confirmation time do not create canonical Movement', () => {
  const previous = location('STORAGE-A', evaluatedAt, ['a', 'b']);
  assert.equal(inferMovement(previous, previous, 'id'), null);
  assert.equal(inferMovement(null, previous, 'id'), null);
  assert.equal(
    inferMovement(previous, location('EXIT-A', evaluatedAt, ['c', 'd']), 'id'),
    null,
  );
});
