import { normalizeUldRecord } from './records.js';
import { msg } from '../i18n/marker.js';

export const DEMO_MOVEMENT_ALERT_ID = 'demo:unauthorized-movement:AKE12345CI';
export const DEMO_MOVEMENT_ULD_ID = 'AKE12345CI';

/** Explicit local scenario, not a production rule engine or location detector. */
export function createUldDemoScenario({
  store,
  initialRecords,
  now = () => new Date(),
}) {
  const baseline = initialRecords.map(normalizeUldRecord);
  if (!baseline.some((r) => r.uldId === DEMO_MOVEMENT_ULD_ID))
    throw new TypeError('ULD demo target is missing');
  return Object.freeze({
    simulateUnauthorizedMovement() {
      const current = store.getUldById(DEMO_MOVEMENT_ULD_ID);
      const previous = store.getAlertById(DEMO_MOVEMENT_ALERT_ID);
      if (previous && previous.status !== 'RESOLVED') return false;
      const occurredAt = new Date(now()).toISOString();
      return store.applyChanges({
        records: [
          {
            ...current,
            zoneId: 'EXIT-A',
            operationalStatus: 'MOVING',
            alertLevel: 'WARNING',
            lastSeenAt: occurredAt,
            revision: current.revision + 1,
            position: { longitude: 121.226, latitude: 25.074, height: 55 },
          },
        ],
        alerts: [
          {
            alertId: DEMO_MOVEMENT_ALERT_ID,
            uldId: DEMO_MOVEMENT_ULD_ID,
            type: 'UNAUTHORIZED_MOVEMENT',
            level: 'WARNING',
            // i18n-ignore: domain alert status code; presentation owns translation.
            status: 'ACTIVE',
            title: msg('Unauthorized ULD movement'),
            message: msg('ULD left STORAGE-A without a valid dispatch.'),
            occurredAt,
            revision: (previous?.revision ?? 0) + 1,
            fromZoneId: 'STORAGE-A',
            toZoneId: 'EXIT-A',
          },
        ],
      });
    },
    reset() {
      const alert = store.getAlertById(DEMO_MOVEMENT_ALERT_ID);
      return store.applyChanges({
        records: baseline.map((record) => ({
          ...record,
          revision: store.getUldById(record.uldId).revision + 1,
        })),
        alerts:
          alert && alert.status !== 'RESOLVED'
            ? // i18n-ignore: domain alert status code; presentation owns translation.
              [{ ...alert, status: 'RESOLVED', revision: alert.revision + 1 }]
            : [],
      });
    },
  });
}
