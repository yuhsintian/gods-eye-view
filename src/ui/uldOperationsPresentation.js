import { msg, t } from '../i18n/index.js';
import { formatUldTime } from './uldPresentation.js';

const taskStates = {
  ACTIVE: msg('Dispatch active ACTIVE'),
  INACTIVE: msg('Dispatch inactive INACTIVE'),
};
const eventTypes = {
  OBSERVED: msg('Observed OBSERVED'),
  LOCATED: msg('Location confirmed LOCATED'),
  MOVED: msg('Moved MOVED'),
};
const reasons = {
  NO_ACTIVE_DISPATCH_CONTEXT: msg('No valid dispatch task'),
  ACTIVE_DISPATCH_CONTEXT: msg('Valid dispatch task'),
  DISPATCH_ULD_TYPE_MISMATCH: msg('Dispatch ULD type mismatch'),
  ULD_NOT_SERVICEABLE: msg('ULD is not serviceable'),
  NOT_STORAGE_EXIT_TRANSITION: msg('Not a storage-to-exit movement'),
};
const steps = {
  READY: msg('Ready for demonstration'),
  PREPARING: msg('Preparing demo'),
  CONFIRMING_STORAGE: msg('Confirming STORAGE-A'),
  DISPATCH_ACTIVE: msg('Dispatch task activated'),
  MOVING_EXIT: msg('Moving to EXIT-A'),
  COMPLETED_NORMAL: msg('Normal dispatch complete'),
  COMPLETED_WARNING: msg('Unauthorized movement WARNING'),
  RESET_COMPLETE: msg('Demo reset complete'),
  ERROR: msg('Operation failed. Check connection and retry.'),
};
export const formatDispatchStatus = (value) =>
  t(taskStates[value] ?? taskStates.INACTIVE);
export const formatOperationsStep = (value) => t(steps[value] ?? steps.READY);
export function getTaskFields(task) {
  return [
    [t('Task ID'), task.taskId],
    [t('Flight', { context: 'uld' }), task.flight],
    [t('Destination', { context: 'uld' }), task.destination],
    [t('Required ULD type'), task.requiredUldType],
    [t('Required quantity'), String(task.requiredQuantity)],
  ];
}
/** Presentation of the Backend decision only; no rule evaluation in the UI. */
export function presentCanonicalEvent(event) {
  return {
    time: formatUldTime(event.occurredAt),
    type: t(eventTypes[event.eventType] ?? event.eventType),
    location:
      event.eventType === 'MOVED'
        ? `${event.fromZoneId ?? '—'} → ${event.toZoneId ?? '—'}`
        : [event.readerId, event.stationId, event.zoneId]
            .filter(Boolean)
            .join(' · '),
    evidence: t('Evidence: {count} observations', {
      count: event.evidenceObservationIds.length,
    }),
    decisions: event.decisions
      .filter(
        (item) => item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT' || item.matched,
      )
      .map((item) => ({
        rule:
          item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT'
            ? t('Unauthorized ULD movement')
            : item.ruleId,
        reason: t(reasons[item.reasonCode] ?? item.reasonCode),
        code: item.reasonCode,
        outcome: item.matched ? t('Rule matched') : t('Rule not matched'),
        level: item.alert?.level ?? null,
      })),
  };
}
