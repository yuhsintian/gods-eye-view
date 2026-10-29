/** Relationship inventory; these relations do not assert a sighting is a fact. */
export const SEMANTIC_RELATIONSHIPS = Object.freeze(
  [
    ['Tag', 'tracks', 'ULD'],
    ['ULD', 'hasType', 'ULDType'],
    ['Reader', 'configuredIn', 'OperationalZone'],
    ['OperationalZone', 'belongsTo', 'Station'],
    ['Observation', 'observes', 'Tag'],
    ['Observation', 'receivedBy', 'Reader'],
    ['LocationEvidenceConfirmed', 'supportedBy', 'Observation'],
    ['MovementEvent', 'moves', 'ULD'],
    ['MovementEvent', 'supportedBy', 'Observation'],
    ['DispatchContext', 'assigns', 'ULD'],
    ['DispatchContext', 'requires', 'ULDType'],
    ['Alert', 'concerns', 'ULD'],
    ['RuleDecision', 'evaluates', 'MovementEvent'],
  ].map((relationship) => Object.freeze(relationship)),
);

export const CANONICAL_EVENT_TYPES = Object.freeze([
  'OBSERVED',
  'LOCATED',
  'MOVED',
]);
export const CANONICAL_EVENT_SOURCES = Object.freeze([
  'BLE',
  'READER_ZONE_INFERENCE',
  'OBSERVATION_INFERENCE',
]);

export function canonicalEvent({
  eventId,
  eventType,
  uldId,
  occurredAt,
  source,
  evidenceObservationIds,
  ...details
}) {
  if (
    !CANONICAL_EVENT_TYPES.includes(eventType) ||
    !CANONICAL_EVENT_SOURCES.includes(source) ||
    !eventId ||
    !uldId ||
    !Number.isFinite(Date.parse(occurredAt)) ||
    !Array.isArray(evidenceObservationIds) ||
    !evidenceObservationIds.length
  )
    throw new TypeError('Invalid canonical event');
  return Object.freeze({
    eventId,
    eventType,
    uldId,
    occurredAt,
    source,
    ...details,
    evidenceObservationIds: Object.freeze([...new Set(evidenceObservationIds)]),
  });
}
