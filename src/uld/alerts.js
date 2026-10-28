import { ULD_ALERT_LEVELS } from './records.js';

export const ULD_ALERT_TYPES = Object.freeze([
  'UNAUTHORIZED_MOVEMENT',
  'UNSERVICEABLE',
  'DWELL_WARNING',
  'LOST_CANDIDATE',
]);
export const ULD_ALERT_STATUSES = Object.freeze([
  'ACTIVE',
  'ACKNOWLEDGED',
  'RESOLVED',
]);

const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`Alert ${field} must be a non-empty string`);
  return value.trim();
};

/** Immutable transport/domain data, independent from UI and data acquisition. */
export function normalizeUldAlert(raw) {
  if (!raw || typeof raw !== 'object')
    throw new TypeError('Alert record required');
  if (!ULD_ALERT_TYPES.includes(raw.type))
    throw new TypeError('Invalid alert type');
  if (!ULD_ALERT_LEVELS.includes(raw.level))
    throw new TypeError('Invalid alert level');
  if (!ULD_ALERT_STATUSES.includes(raw.status))
    throw new TypeError('Invalid alert status');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0)
    throw new TypeError('Invalid alert revision');
  const occurredAt = text(raw.occurredAt, 'occurredAt');
  if (!Number.isFinite(Date.parse(occurredAt)))
    throw new TypeError('Invalid alert occurredAt');
  return Object.freeze({
    alertId: text(raw.alertId, 'alertId'),
    uldId: text(raw.uldId, 'uldId'),
    type: raw.type,
    level: raw.level,
    title: text(raw.title, 'title'),
    message: text(raw.message, 'message'),
    occurredAt: new Date(occurredAt).toISOString(),
    status: raw.status,
    revision: raw.revision,
    // Optional transition context is data, never inferred from localized prose.
    ...(raw.fromZoneId == null
      ? {}
      : { fromZoneId: text(raw.fromZoneId, 'fromZoneId') }),
    ...(raw.toZoneId == null
      ? {}
      : { toZoneId: text(raw.toZoneId, 'toZoneId') }),
  });
}
