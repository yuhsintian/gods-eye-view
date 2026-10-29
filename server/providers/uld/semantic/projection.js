const severity = { NORMAL: 0, WARNING: 1, CRITICAL: 2 };

/** Only this adapter turns semantic results/commands into existing domain records. */
export function createSemanticProjection({ store, semantic, initialRecords }) {
  return Object.freeze({
    observe(observation, record) {
      const result = semantic.observe(observation, record);
      const patch = {};
      if (Date.parse(observation.observedAt) > Date.parse(record.lastSeenAt))
        patch.lastSeenAt = observation.observedAt;
      if (result.location) {
        const { stationId, zoneId } = result.location;
        const position = result.reader.position;
        if (
          record.stationId !== stationId ||
          record.zoneId !== zoneId ||
          record.positionSource !== 'READER_ZONE_INFERENCE' ||
          ['longitude', 'latitude', 'height'].some(
            (key) => record.position[key] !== position[key],
          )
        )
          Object.assign(patch, {
            stationId,
            zoneId,
            position,
            positionSource: 'READER_ZONE_INFERENCE',
          });
      }
      const alerts = result.decisions
        .filter((decision) => decision.matched && decision.alert)
        .map((decision) => {
          const alertId = `semantic:${decision.alert.type}:${record.uldId}`;
          const previous = store.getAlertById(alertId);
          return {
            ...decision.alert,
            alertId,
            uldId: record.uldId,
            status: 'ACTIVE',
            occurredAt: result.movement.occurredAt,
            revision: (previous?.revision ?? 0) + 1,
            fromZoneId: result.movement.fromZoneId,
            toZoneId: result.movement.toZoneId,
          };
        });
      for (const alert of alerts)
        if (
          severity[alert.level] >
          severity[patch.alertLevel ?? record.alertLevel]
        )
          patch.alertLevel = alert.level;
      if (!Object.keys(patch).length && !alerts.length) return false;
      return store.applyChanges({
        records: Object.keys(patch).length
          ? [{ ...record, ...patch, revision: record.revision + 1 }]
          : [],
        alerts,
      });
    },
    reset() {
      semantic.reset();
      return store.applyChanges({
        records: initialRecords.map((record) => ({
          ...record,
          revision: store.getUldById(record.uldId).revision + 1,
        })),
        alerts: store
          .getSnapshot()
          .alerts.filter((alert) => alert.status !== 'RESOLVED')
          .map((alert) => ({
            ...alert,
            status: 'RESOLVED',
            revision: alert.revision + 1,
          })),
      });
    },
  });
}
