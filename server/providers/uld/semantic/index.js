import { randomUUID } from 'node:crypto';
import { inferencePolicy } from './policy.js';
import { createReaderRegistry } from './readerRegistry.js';
import { createEvidenceStore } from './evidenceStore.js';
import { createRecentStore } from './eventStore.js';
import { inferLocation } from './locationInference.js';
import { inferMovement } from './movementInference.js';
import { createOperationalContext } from './operationalContext.js';
import { canonicalEvent } from './model.js';
import { evaluateMovementRules } from '../rules/engine.js';

/** Evidence/context owners and pure inference/rules. ULD projection lives elsewhere. */
export function createSemanticModel({
  getUldById,
  readers = createReaderRegistry(),
  policy: overrides,
  now = () => new Date(),
  idFactory = randomUUID,
}) {
  const policy = inferencePolicy(overrides);
  const evidence = createEvidenceStore({ perUldLimit: policy.evidencePerUld });
  const events = createRecentStore(policy.recentEvents);
  const decisions = createRecentStore(policy.recentDecisions);
  const contexts = createOperationalContext({ getUldById });
  const locations = new Map();
  const id = () => `canonical:${idFactory()}`;
  function invalidateLocationEvidence() {
    evidence.clear();
    locations.clear();
  }
  return Object.freeze({
    observe(observation, uld) {
      const reader = readers.getReaderContext(observation.readerId);
      const item = Object.freeze({
        observationId: observation.observationId,
        uldId: uld.uldId,
        tagId: observation.tagId,
        readerId: observation.readerId,
        stationId: reader?.stationId ?? null,
        zoneId: reader?.zoneId ?? null,
        rssi: observation.rssi,
        observedAt: observation.observedAt,
      });
      if (!evidence.add(item))
        return { location: null, movement: null, decisions: [] };
      events.add(
        canonicalEvent({
          eventId: id(),
          eventType: 'OBSERVED',
          uldId: uld.uldId,
          occurredAt: observation.observedAt,
          source: 'BLE',
          tagId: observation.tagId,
          readerId: observation.readerId,
          stationId: item.stationId,
          zoneId: item.zoneId,
          rssi: item.rssi,
          evidenceObservationIds: [observation.observationId],
        }),
      );
      const previous = locations.get(uld.uldId) ?? null;
      // Keep late evidence for diagnostics, but never use it to rewrite current
      // semantic state after a newer sighting (including an unknown reader).
      if (Date.parse(observation.observedAt) < Date.parse(uld.lastSeenAt))
        return { location: null, movement: null, decisions: [] };
      const location = inferLocation({
        incoming: item,
        evidence: evidence.getForUld(uld.uldId),
        current: previous,
        policy,
      });
      if (!location) return { location: null, movement: null, decisions: [] };
      locations.set(uld.uldId, location);
      const changed =
        !previous ||
        previous.stationId !== location.stationId ||
        previous.zoneId !== location.zoneId;
      if (changed)
        events.add(
          canonicalEvent({
            eventId: id(),
            eventType: 'LOCATED',
            uldId: uld.uldId,
            occurredAt: location.inferredAt,
            source: location.source,
            stationId: location.stationId,
            zoneId: location.zoneId,
            readerId: item.readerId,
            evidenceObservationIds: location.evidenceObservationIds,
          }),
        );
      const movement = changed ? inferMovement(previous, location, id()) : null;
      const output = [];
      if (movement) {
        events.add(movement);
        output.push(
          ...evaluateMovementRules({
            uld,
            event: movement,
            dispatch: contexts.getDispatchContext(uld.uldId),
            evaluatedAt: new Date(now()).toISOString(),
          }),
        );
        for (const decision of output) decisions.add(decision);
      }
      return { location, reader, movement, decisions: output };
    },
    activateDispatch: contexts.activate,
    clearDispatch: (raw) => contexts.clear(raw),
    diagnostics: () =>
      Object.freeze({
        policy,
        events: events.get(),
        ruleDecisions: decisions.get(),
        inferredLocations: Object.freeze([...locations.values()]),
        evidence: evidence.all(),
        dispatchContexts: contexts.all(),
      }),
    invalidateLocationEvidence,
    reset() {
      invalidateLocationEvidence();
      events.clear();
      decisions.clear();
      contexts.reset();
    },
  });
}
