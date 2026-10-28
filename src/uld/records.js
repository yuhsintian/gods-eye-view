export const ULD_ALERT_LEVELS = Object.freeze([
  'NORMAL',
  'WARNING',
  'CRITICAL',
]);

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`ULD ${field} must be a non-empty string`);
  return value.trim();
};

/** Validated, immutable domain record. Coordinates are configured, not inferred. */
export function normalizeUldRecord(raw) {
  if (!raw || typeof raw !== 'object')
    throw new TypeError('ULD record required');
  const position = raw.position;
  if (
    !position ||
    !Number.isFinite(position.longitude) ||
    Math.abs(position.longitude) > 180 ||
    !Number.isFinite(position.latitude) ||
    Math.abs(position.latitude) > 90 ||
    !Number.isFinite(position.height)
  )
    throw new TypeError('Invalid ULD position');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0)
    throw new TypeError('Invalid ULD revision');
  if (!ULD_ALERT_LEVELS.includes(raw.alertLevel))
    throw new TypeError('Invalid ULD alertLevel');
  const lastSeenAt = requiredText(raw.lastSeenAt, 'lastSeenAt');
  if (!Number.isFinite(Date.parse(lastSeenAt)))
    throw new TypeError('Invalid ULD lastSeenAt');
  return Object.freeze({
    uldId: requiredText(raw.uldId, 'uldId'),
    uldType: requiredText(raw.uldType, 'uldType'),
    stationId: requiredText(raw.stationId, 'stationId'),
    zoneId: requiredText(raw.zoneId, 'zoneId'),
    operationalStatus: requiredText(raw.operationalStatus, 'operationalStatus'),
    serviceabilityStatus: requiredText(
      raw.serviceabilityStatus,
      'serviceabilityStatus',
    ),
    flight: raw.flight == null ? null : requiredText(raw.flight, 'flight'),
    destination:
      raw.destination == null
        ? null
        : requiredText(raw.destination, 'destination'),
    lastSeenAt: new Date(lastSeenAt).toISOString(),
    alertLevel: raw.alertLevel,
    position: Object.freeze({
      longitude: position.longitude,
      latitude: position.latitude,
      height: position.height,
    }),
    positionSource: requiredText(raw.positionSource, 'positionSource'),
    revision: raw.revision,
  });
}
