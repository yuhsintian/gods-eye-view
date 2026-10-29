import { canonicalEvent } from './model.js';

/** The initial mock ULD zone is deliberately not a confirmed previous zone. */
export function inferMovement(previous, current, eventId) {
  if (
    !previous ||
    !current ||
    (previous.stationId === current.stationId &&
      previous.zoneId === current.zoneId) ||
    Date.parse(current.inferredAt) <= Date.parse(previous.inferredAt)
  )
    return null;
  return canonicalEvent({
    eventId,
    eventType: 'MOVED',
    uldId: current.uldId,
    fromStationId: previous.stationId,
    fromZoneId: previous.zoneId,
    toStationId: current.stationId,
    toZoneId: current.zoneId,
    occurredAt: current.inferredAt,
    source: 'OBSERVATION_INFERENCE',
    evidenceObservationIds: [
      ...previous.evidenceObservationIds,
      ...current.evidenceObservationIds,
    ],
  });
}
