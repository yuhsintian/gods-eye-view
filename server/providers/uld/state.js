import { randomUUID } from 'node:crypto';
import { createUldStore } from '../../../src/uld/store.js';
import { createMockUldRecords } from '../../../src/uld/mockData.js';
import { createUldDemoScenario } from '../../../src/uld/demoScenario.js';
import { createObservationProcessor } from './observations.js';
import { createSemanticModel } from './semantic/index.js';
import { createSemanticProjection } from './semantic/projection.js';
import { createOperationsReadModel } from './operations/readModel.js';

/** Process-local DEVELOPMENT mock authority. No acquisition starts on import. */
export function createUldBackend({
  now = () => new Date(),
  registry,
  dedupeCapacity,
  recentCapacity,
  initialRecords = createMockUldRecords(),
  readers,
  inferencePolicy,
} = {}) {
  const store = createUldStore(initialRecords);
  const scenario = createUldDemoScenario({
    store,
    initialRecords: store.getSnapshot().records,
    now,
  });
  const listeners = new Set();
  const streamId = randomUUID();
  let streamRevision = 100;
  let previous = store.getSnapshot();
  const unsubscribe = store.subscribe((snapshot, change) => {
    if (!change) return;
    const oldUlds = new Map(previous.records.map((r) => [r.uldId, r]));
    const oldAlerts = new Map(previous.alerts.map((a) => [a.alertId, a]));
    const updates = [
      ...snapshot.records
        .filter((r) => oldUlds.get(r.uldId) !== r)
        .map((payload) => ({ type: 'ULD_UPSERT', payload })),
      ...snapshot.alerts
        .filter((a) => oldAlerts.get(a.alertId) !== a)
        .map((payload) => ({
          type:
            payload.status === 'RESOLVED' ? 'ALERT_RESOLVED' : 'ALERT_UPSERT',
          payload,
        })),
    ];
    previous = snapshot;
    for (const update of updates) {
      const event = Object.freeze({
        ...update,
        eventId: `${streamId}:${++streamRevision}`,
        streamRevision,
        occurredAt: new Date(now()).toISOString(),
      });
      for (const listener of listeners) listener(event);
    }
  });
  const semantic = createSemanticModel({
    getUldById: store.getUldById,
    readers,
    policy: inferencePolicy,
    now,
  });
  const projection = createSemanticProjection({
    store,
    semantic,
    initialRecords: store.getSnapshot().records,
  });
  const readOperations = createOperationsReadModel({
    store,
    semantic,
    getStreamRevision: () => streamRevision,
  });
  const observations = createObservationProcessor({
    store,
    registry,
    now,
    dedupeCapacity,
    recentCapacity,
    getStreamRevision: () => streamRevision,
    projectObservation: projection.observe,
  });
  return {
    snapshot: () => ({
      schemaVersion: 1,
      streamRevision,
      generatedAt: new Date(now()).toISOString(),
      ulds: store.getSnapshot().records,
      alerts: store.getSnapshot().alerts,
    }),
    simulate() {
      const changed = scenario.simulateUnauthorizedMovement();
      if (changed) semantic.invalidateLocationEvidence();
      return changed;
    },
    reset: projection.reset,
    observe: observations.accept,
    recentObservations: observations.recent,
    readOperations,
    semanticDiagnostics: semantic.diagnostics,
    activateDispatch: semantic.activateDispatch,
    clearDispatch: semantic.clearDispatch,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      semantic.reset();
      observations.close();
      unsubscribe();
      listeners.clear();
      store.destroy();
    },
  };
}
