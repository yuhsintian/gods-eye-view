export const DEMO_DISPATCH_TASK = Object.freeze({
  uldId: 'AKE12345CI',
  taskId: 'TASK-CI152-01',
  flight: 'CI152',
  destination: 'KIX',
  requiredUldType: 'AKE',
  requiredQuantity: 1,
});

const eventFields = [
  'eventId',
  'eventType',
  'uldId',
  'occurredAt',
  'source',
  'readerId',
  'stationId',
  'zoneId',
  'fromStationId',
  'fromZoneId',
  'toStationId',
  'toZoneId',
];
const decisionFields = [
  'ruleId',
  'matched',
  'reasonCode',
  'evaluatedAt',
  'relatedUldId',
  'relatedEventId',
];
const pick = (value, fields) =>
  Object.fromEntries(
    fields
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );

/** Public, ULD-scoped projection of M6 canonical events, not diagnostic objects. */
export function projectEvents(diagnostics, uldId, limit = 15) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new TypeError('Event limit must be 1..20');
  return diagnostics.events
    .filter((event) => event.uldId === uldId)
    .slice(-limit)
    .reverse()
    .map((event) => ({
      ...pick(event, eventFields),
      evidenceObservationIds: [...event.evidenceObservationIds],
      decisions: diagnostics.ruleDecisions
        .filter(
          (decision) =>
            decision.relatedUldId === uldId &&
            decision.relatedEventId === event.eventId,
        )
        .map((decision) => ({
          ...pick(decision, decisionFields),
          ...(decision.alert
            ? { alert: pick(decision.alert, ['type', 'level']) }
            : {}),
        })),
    }));
}

export function createOperationsReadModel({
  store,
  semantic,
  getStreamRevision,
}) {
  return (uldId, limit = 15) => {
    const record = store.getUldById(uldId);
    if (!record) return null;
    const diagnostic = semantic.diagnostics();
    const context = diagnostic.dispatchContexts.find(
      (item) => item.uldId === uldId,
    );
    const task = {
      ...DEMO_DISPATCH_TASK,
      uldId,
      ...(context
        ? pick(context, ['taskId', 'flight', 'destination', 'requiredUldType'])
        : {}),
      status: context?.active ? 'ACTIVE' : 'INACTIVE',
    };
    return {
      schemaVersion: 1,
      uldId,
      uldRevision: record.revision,
      streamRevision: getStreamRevision(),
      task,
      events: projectEvents(diagnostic, uldId, limit),
      presentation: {
        dataSource: 'DEMO_OBSERVATION',
        locationMode: 'READER_ZONE_INFERENCE',
        rulesEnabled: true,
      },
    };
  };
}
