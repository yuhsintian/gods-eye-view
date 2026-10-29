export function dispatchEligibility(uld, dispatch) {
  if (!dispatch?.active || dispatch.uldId !== uld.uldId)
    return 'NO_ACTIVE_DISPATCH_CONTEXT';
  if (dispatch.requiredUldType !== uld.uldType)
    return 'DISPATCH_ULD_TYPE_MISMATCH';
  if (uld.serviceabilityStatus !== 'SERVICEABLE') return 'ULD_NOT_SERVICEABLE';
  return 'ACTIVE_DISPATCH_CONTEXT';
}

export function ruleDecision({
  ruleId,
  matched,
  reasonCode,
  uld,
  event,
  evaluatedAt,
  dispatch,
  alert,
  facts = {},
}) {
  if (!Number.isFinite(Date.parse(evaluatedAt)))
    throw new TypeError('Rule evaluation time required');
  return Object.freeze({
    ruleId,
    matched,
    reasonCode,
    evaluatedAt,
    relatedUldId: uld.uldId,
    relatedEventId: event?.eventId ?? null,
    facts: Object.freeze({
      ...facts,
      dispatchActive: Boolean(dispatch?.active),
      taskId: dispatch?.taskId ?? null,
      requiredUldType: dispatch?.requiredUldType ?? null,
      uldType: uld.uldType,
      serviceabilityStatus: uld.serviceabilityStatus,
    }),
    ...(matched && alert ? { alert: Object.freeze(alert) } : {}),
  });
}
