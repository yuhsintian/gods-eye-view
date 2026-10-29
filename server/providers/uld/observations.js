import { createTagRegistry } from './tagRegistry.js';

const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new TypeError(
      `Observation ${field} must be non-empty text (max 200)`,
    );
  return value.trim();
};

/** A timezone-bearing ISO instant, with calendar validation before Date.parse. */
export function normalizeObservedAt(value) {
  if (typeof value !== 'string') throw new TypeError('Invalid observedAt');
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match)
    throw new TypeError(
      'observedAt requires an ISO-8601 instant with timezone',
    );
  const [, y, m, d, h, minute, second, , tzHour = '0', tzMinute = '0'] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(h) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(tzHour) > 23 ||
    Number(tzMinute) > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new TypeError('Invalid observedAt calendar or time');
  return new Date(value).toISOString();
}

/** BLE sighting only: no position, movement or business-state inference. */
export function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new TypeError('One Observation object required');
  if (raw.sourceType !== 'BLE') throw new TypeError('sourceType must be BLE');
  if (!Number.isInteger(raw.rssi) || raw.rssi < -127 || raw.rssi > 20)
    throw new TypeError('rssi must be an integer from -127 to 20 dBm');
  if (
    raw.sequence !== undefined &&
    (!Number.isSafeInteger(raw.sequence) || raw.sequence < 0)
  )
    throw new TypeError(
      'sequence must be an optional non-negative safe integer',
    );
  return Object.freeze({
    observationId: text(raw.observationId, 'observationId'),
    tagId: text(raw.tagId, 'tagId'),
    readerId: text(raw.readerId, 'readerId'),
    rssi: raw.rssi,
    observedAt: normalizeObservedAt(raw.observedAt),
    sourceType: 'BLE',
    ...(raw.sequence === undefined ? {} : { sequence: raw.sequence }),
  });
}

export function createObservationProcessor({
  store,
  registry = createTagRegistry(),
  getStreamRevision,
  now = () => new Date(),
  dedupeCapacity = 10000,
  recentCapacity = 50,
}) {
  for (const capacity of [dedupeCapacity, recentCapacity])
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new TypeError('Observation capacities must be positive integers');
  const seen = new Map();
  const recent = [];
  let closed = false;
  return Object.freeze({
    accept(raw) {
      if (closed) throw new Error('Observation processor closed');
      const observation = normalizeObservation(raw);
      const previous = seen.get(observation.observationId);
      if (previous)
        return {
          ...previous,
          duplicate: true,
          updated: false,
          streamRevision: getStreamRevision(),
        };
      const uldId = registry.getUldIdByTagId(observation.tagId);
      const record = uldId ? store.getUldById(uldId) : null;
      // Compare instants, not offset-bearing strings. Equal times are no-ops too.
      const updated = Boolean(
        record &&
        Date.parse(observation.observedAt) > Date.parse(record.lastSeenAt),
      );
      if (updated)
        store.upsertUld({
          ...record,
          lastSeenAt: observation.observedAt,
          revision: record.revision + 1,
        });
      const result = Object.freeze({
        accepted: true,
        observationId: observation.observationId,
        tagId: observation.tagId,
        mapped: Boolean(record),
        ...(record ? { uldId } : {}),
        updated,
        duplicate: false,
        streamRevision: getStreamRevision(),
      });
      seen.set(observation.observationId, result);
      if (seen.size > dedupeCapacity) seen.delete(seen.keys().next().value);
      recent.push(
        Object.freeze({
          ...observation,
          receivedAt: new Date(now()).toISOString(),
          mapped: result.mapped,
          ...(record ? { uldId } : {}),
          updated,
          reason: !record
            ? 'UNMAPPED_TAG'
            : updated
              ? 'LAST_SEEN_UPDATED'
              : 'NOT_NEWER',
        }),
      );
      if (recent.length > recentCapacity) recent.shift();
      return result;
    },
    recent: () => Object.freeze([...recent]),
    close() {
      closed = true;
      seen.clear();
      recent.length = 0;
    },
  });
}
