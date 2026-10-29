const sameReaderZone = (a, b) =>
  a.readerId === b.readerId &&
  a.stationId === b.stationId &&
  a.zoneId === b.zoneId;

/** Pure, consecutive-reader confirmation. RSSI is intentionally never read. */
export function inferLocation({ incoming, evidence, current, policy }) {
  if (!incoming.stationId || !incoming.zoneId) return null;
  const time = Date.parse(incoming.observedAt);
  if (evidence.some((item) => Date.parse(item.observedAt) > time)) return null;
  if (
    current &&
    time <= Date.parse(current.inferredAt) &&
    (current.stationId !== incoming.stationId ||
      current.zoneId !== incoming.zoneId)
  )
    return null;
  const window = evidence.filter((item) => {
    const age = time - Date.parse(item.observedAt);
    return age >= 0 && age <= policy.confirmationWindowMs;
  });
  const supporting = [];
  for (let i = window.length - 1; i >= 0; i--) {
    if (!sameReaderZone(window[i], incoming)) break;
    // A transition requires fresh evidence after the previous confirmed zone.
    if (
      current &&
      (current.stationId !== incoming.stationId ||
        current.zoneId !== incoming.zoneId) &&
      Date.parse(window[i].observedAt) <= Date.parse(current.inferredAt)
    )
      break;
    supporting.unshift(window[i]);
  }
  const ids = [...new Set(supporting.map((item) => item.observationId))];
  if (ids.length < policy.minObservations) return null;
  return Object.freeze({
    uldId: incoming.uldId,
    stationId: incoming.stationId,
    zoneId: incoming.zoneId,
    inferredAt: incoming.observedAt,
    source: 'READER_ZONE_INFERENCE',
    evidenceObservationIds: Object.freeze(ids),
  });
}
