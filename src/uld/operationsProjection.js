export const ULD_DEMO_TARGET = 'AKE12345CI';
export const ULD_TIMELINE_LIMIT = 15;

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object')
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutable(item)]),
      ),
    );
  return value;
}

/** Read-model envelope only. Canonical event identity/model remain Backend-owned. */
export function normalizeOperationsProjection(raw) {
  if (
    raw?.schemaVersion !== 1 ||
    typeof raw.uldId !== 'string' ||
    !raw.uldId ||
    !Number.isSafeInteger(raw.uldRevision) ||
    raw.uldRevision < 1 ||
    !Number.isSafeInteger(raw.streamRevision) ||
    raw.streamRevision < 0 ||
    raw.task?.uldId !== raw.uldId ||
    !['ACTIVE', 'INACTIVE'].includes(raw.task.status) ||
    !Array.isArray(raw.events) ||
    raw.events.length > 20 ||
    !Number.isSafeInteger(raw.task.requiredQuantity) ||
    raw.task.requiredQuantity < 1 ||
    ['taskId', 'flight', 'destination', 'requiredUldType'].some(
      (field) => typeof raw.task[field] !== 'string' || !raw.task[field],
    ) ||
    typeof raw.presentation?.demoEnabled !== 'boolean'
  )
    throw new TypeError('Invalid ULD operations projection');
  if (
    raw.events.some(
      (event) =>
        event.uldId !== raw.uldId ||
        !event.eventId ||
        !['OBSERVED', 'LOCATED', 'MOVED'].includes(event.eventType) ||
        !Number.isFinite(Date.parse(event.occurredAt)) ||
        !Array.isArray(event.evidenceObservationIds) ||
        !Array.isArray(event.decisions) ||
        event.decisions.some(
          (decision) =>
            decision.relatedUldId !== raw.uldId ||
            decision.relatedEventId !== event.eventId ||
            typeof decision.matched !== 'boolean' ||
            typeof decision.reasonCode !== 'string',
        ),
    ) ||
    new Set(raw.events.map((event) => event.eventId)).size !== raw.events.length
  )
    throw new TypeError('Invalid canonical event projection');
  return immutable({ ...raw, events: raw.events.slice(0, ULD_TIMELINE_LIMIT) });
}
