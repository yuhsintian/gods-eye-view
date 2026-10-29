import { normalizeUldRecord } from './records.js';
import { normalizeUldAlert } from './alerts.js';
import { normalizeOperationsProjection } from './operationsProjection.js';

export const ULD_CONNECTION_STATUSES = Object.freeze([
  'CONNECTING',
  'CONNECTED',
  'DISCONNECTED',
  'RECONNECTING',
]);

/** One authoritative set of domain records shared by the layer and panel. */
export function createUldStore(initialRecords = [], initialAlerts = []) {
  const records = new Map();
  for (const raw of initialRecords) {
    const record = normalizeUldRecord(raw);
    if (records.has(record.uldId))
      throw new TypeError(`Duplicate ULD ID: ${record.uldId}`);
    records.set(record.uldId, record);
  }
  const alerts = new Map();
  for (const raw of initialAlerts) {
    const alert = normalizeUldAlert(raw);
    if (!records.has(alert.uldId))
      throw new TypeError(`Unknown alert ULD: ${alert.uldId}`);
    if (alerts.has(alert.alertId))
      throw new TypeError(`Duplicate alert ID: ${alert.alertId}`);
    alerts.set(alert.alertId, alert);
  }
  const listeners = new Set();
  const operations = new Map();
  let selectedUldId = null;
  let connectionStatus = 'DISCONNECTED';
  let destroyed = false;
  const getSnapshot = () =>
    Object.freeze({
      records: Object.freeze([...records.values()]),
      alerts: Object.freeze([...alerts.values()]),
      selectedUldId,
      connectionStatus,
      operations: Object.freeze([...operations.values()]),
    });
  const notify = (listener, snapshot, change = null) => {
    try {
      listener(snapshot, change);
    } catch (error) {
      console.error('ULD store listener failed', error);
    }
  };
  const publish = (change) => {
    const snapshot = getSnapshot();
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) notify(listener, snapshot, change);
    }
  };
  // Validate the whole publication before mutating either collection. Transport
  // adapters can use the same atomic path as a local simulation.
  function commitChanges(rawRecords, rawAlerts, change) {
    if (destroyed || (!rawRecords.length && !rawAlerts.length)) return false;
    const nextRecords = rawRecords.map(normalizeUldRecord);
    const nextAlerts = rawAlerts.map(normalizeUldAlert);
    if (
      new Set(nextRecords.map((r) => r.uldId)).size !== nextRecords.length ||
      new Set(nextAlerts.map((a) => a.alertId)).size !== nextAlerts.length
    )
      throw new TypeError('Duplicate identities in ULD update');
    const knownIds = new Set([
      ...records.keys(),
      ...nextRecords.map((r) => r.uldId),
    ]);
    for (const alert of nextAlerts) {
      if (!knownIds.has(alert.uldId))
        throw new TypeError(`Unknown alert ULD: ${alert.uldId}`);
      const previous = alerts.get(alert.alertId);
      if (previous && previous.uldId !== alert.uldId)
        throw new TypeError('An alert cannot change its ULD identity');
    }
    if (
      nextRecords.some(
        (r) =>
          records.has(r.uldId) && r.revision <= records.get(r.uldId).revision,
      ) ||
      nextAlerts.some(
        (a) =>
          alerts.has(a.alertId) && a.revision <= alerts.get(a.alertId).revision,
      )
    )
      return false;
    for (const record of nextRecords) records.set(record.uldId, record);
    for (const alert of nextAlerts) alerts.set(alert.alertId, alert);
    if (change.type === 'record-updated') change.uldId = nextRecords[0].uldId;
    if (change.type === 'alert-updated') change.alertId = nextAlerts[0].alertId;
    publish(Object.freeze(change));
    return true;
  }
  return Object.freeze({
    getSnapshot,
    getOperationsByUldId: (uldId) => operations.get(uldId) ?? null,
    replaceOperations(raw) {
      if (destroyed) return false;
      const projection = normalizeOperationsProjection(raw);
      const record = records.get(projection.uldId);
      if (!record || projection.uldRevision < record.revision) return false;
      if (
        JSON.stringify(operations.get(projection.uldId)) ===
        JSON.stringify(projection)
      )
        return false;
      operations.set(projection.uldId, projection);
      publish(
        Object.freeze({ type: 'operations-updated', uldId: projection.uldId }),
      );
      return true;
    },
    setConnectionStatus(status) {
      if (destroyed) return false;
      if (!ULD_CONNECTION_STATUSES.includes(status))
        throw new TypeError('Invalid ULD connection status');
      if (connectionStatus === status) return true;
      connectionStatus = status;
      publish(Object.freeze({ type: 'connection-status' }));
      return true;
    },
    // Authoritative full replacement after transport sequence validation. Normal
    // upserts below still reject stale record revisions. A fresh server session
    // may restart its in-memory revisions, so snapshots deliberately replace.
    replaceSnapshot({ ulds, alerts: incomingAlerts }) {
      if (destroyed) return false;
      const next = new Map();
      const nextAlerts = new Map();
      for (const raw of ulds) {
        const record = normalizeUldRecord(raw);
        if (next.has(record.uldId))
          throw new TypeError('Duplicate snapshot ULD');
        next.set(record.uldId, record);
      }
      for (const raw of incomingAlerts) {
        const alert = normalizeUldAlert(raw);
        if (nextAlerts.has(alert.alertId) || !next.has(alert.uldId))
          throw new TypeError('Invalid snapshot alert relation');
        nextAlerts.set(alert.alertId, alert);
      }
      records.clear();
      alerts.clear();
      operations.clear();
      for (const [id, record] of next) records.set(id, record);
      for (const [id, alert] of nextAlerts) alerts.set(id, alert);
      if (!records.has(selectedUldId)) selectedUldId = null;
      publish(Object.freeze({ type: 'snapshot-replaced' }));
      return true;
    },
    getUldById: (uldId) => records.get(uldId) ?? null,
    getAlertById: (alertId) => alerts.get(alertId) ?? null,
    // Acknowledged alerts remain ongoing until explicitly resolved.
    getActiveAlerts: () =>
      Object.freeze(
        [...alerts.values()].filter((a) => a.status !== 'RESOLVED'),
      ),
    selectUld(uldId) {
      if (destroyed || (uldId !== null && !records.has(uldId))) return false;
      selectedUldId = uldId;
      publish(Object.freeze({ type: 'selection' }));
      return true;
    },
    upsertUld(raw) {
      return commitChanges([raw], [], {
        type: 'record-updated',
        uldId: raw?.uldId,
      });
    },
    upsertAlert(raw) {
      return commitChanges([], [raw], {
        type: 'alert-updated',
        alertId: raw?.alertId,
      });
    },
    resolveAlert(alertId, { revision } = {}) {
      const previous = alerts.get(alertId);
      if (!previous || previous.status === 'RESOLVED') return false;
      return commitChanges(
        [],
        [
          {
            ...previous,
            // i18n-ignore: domain alert status code; presentation owns translation.
            status: 'RESOLVED',
            revision: revision ?? previous.revision + 1,
          },
        ],
        { type: 'alert-updated', alertId },
      );
    },
    applyChanges({ records: nextRecords = [], alerts: nextAlerts = [] }) {
      return commitChanges(nextRecords, nextAlerts, {
        type: 'records-and-alerts-updated',
      });
    },
    subscribe(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('ULD listener required');
      if (destroyed) return () => {};
      listeners.add(listener);
      notify(listener, getSnapshot());
      return () => listeners.delete(listener);
    },
    destroy() {
      operations.clear();
      connectionStatus = 'DISCONNECTED';
      destroyed = true;
      listeners.clear();
    },
  });
}
