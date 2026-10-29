export const ULD_SCHEMA_VERSION = 1;
export const ULD_EVENT_TYPES = Object.freeze([
  'ULD_UPSERT',
  'ALERT_UPSERT',
  'ALERT_RESOLVED',
  'SNAPSHOT_REQUIRED',
]);

export function isStreamRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
export function validateSnapshot(value) {
  if (
    value?.schemaVersion !== ULD_SCHEMA_VERSION ||
    !isStreamRevision(value.streamRevision) ||
    typeof value.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !Array.isArray(value.ulds) ||
    !Array.isArray(value.alerts)
  )
    throw new TypeError('Invalid ULD snapshot envelope');
  return value;
}
export function validateEvent(value) {
  if (
    !ULD_EVENT_TYPES.includes(value?.type) ||
    !isStreamRevision(value.streamRevision) ||
    typeof value.eventId !== 'string' ||
    !value.eventId ||
    typeof value.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    !value.payload ||
    typeof value.payload !== 'object'
  )
    throw new TypeError('Invalid ULD stream event');
  return value;
}
