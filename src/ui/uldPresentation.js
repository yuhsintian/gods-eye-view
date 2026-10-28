import { msg, t } from '../i18n/index.js';

/** Display messages only: domain enum values and field names never change. */
const STATUS_MESSAGES = Object.freeze({
  NORMAL: msg('Normal NORMAL'),
  WARNING: msg('Warning WARNING'),
  CRITICAL: msg('Critical CRITICAL'),
  AVAILABLE: msg('Available AVAILABLE'),
  ASSIGNED: msg('Assigned ASSIGNED'),
  MOVING: msg('Moving MOVING'),
  SERVICEABLE: msg('Serviceable SERVICEABLE'),
  UNSERVICEABLE: msg('Unserviceable UNSERVICEABLE'),
  UNCONFIRMED: msg('Unconfirmed UNCONFIRMED'),
  CONFIGURED_DEMO: msg('CONFIGURED_DEMO'),
});
const STATUS_FIELDS = new Set([
  'operationalStatus',
  'serviceabilityStatus',
  'alertLevel',
  'positionSource',
]);
const taipeiClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Stable Taiwan wall time, independent of the workstation/VM time zone. */
export function formatUldTime(value) {
  if (value == null || value === '') return '—';
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return '—';
  const parts = Object.fromEntries(
    taipeiClock.formatToParts(time).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatUldValue(field, value) {
  if (value == null) return '—';
  if (field === 'lastSeenAt') return formatUldTime(value);
  if (STATUS_FIELDS.has(field) && Object.hasOwn(STATUS_MESSAGES, value))
    return t(STATUS_MESSAGES[value]);
  return String(value);
}

export function getUldFields() {
  return [
    ['uldId', t('ULD ID', { context: 'uld' })],
    ['uldType', t('ULD Type', { context: 'uld' })],
    ['stationId', t('Station', { context: 'uld' })],
    ['zoneId', t('Zone', { context: 'uld' })],
    ['operationalStatus', t('Operational Status', { context: 'uld' })],
    ['serviceabilityStatus', t('Serviceability Status', { context: 'uld' })],
    ['flight', t('Flight', { context: 'uld' })],
    ['destination', t('Destination', { context: 'uld' })],
    ['lastSeenAt', t('Last Seen', { context: 'uld' })],
    ['alertLevel', t('Alert Level', { context: 'uld' })],
  ];
}

export function getUldLegend() {
  return [
    t('Green: {status}', { status: formatUldValue('alertLevel', 'NORMAL') }),
    t('Yellow: {status}', { status: formatUldValue('alertLevel', 'WARNING') }),
    t('Red: {status}', { status: formatUldValue('alertLevel', 'CRITICAL') }),
  ].join('\n');
}
