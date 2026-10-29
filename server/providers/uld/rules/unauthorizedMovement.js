import { msg } from '../../../../src/i18n/marker.js';
import { dispatchEligibility, ruleDecision } from './decision.js';

export function unauthorizedMovement({ uld, event, dispatch, evaluatedAt }) {
  const transition =
    event?.eventType === 'MOVED' &&
    event.fromZoneId === 'STORAGE-A' &&
    event.toZoneId === 'EXIT-A';
  const eligibility = dispatchEligibility(uld, dispatch);
  const reasonCode = !transition ? 'NOT_STORAGE_EXIT_TRANSITION' : eligibility;
  const matched = transition && eligibility !== 'ACTIVE_DISPATCH_CONTEXT';
  return ruleDecision({
    ruleId: 'RULE_UNAUTHORIZED_MOVEMENT',
    matched,
    reasonCode,
    uld,
    event,
    dispatch,
    evaluatedAt,
    alert: {
      type: 'UNAUTHORIZED_MOVEMENT',
      level: 'WARNING',
      title: msg('Unauthorized ULD movement'),
      message: msg('ULD left STORAGE-A without a valid dispatch.'),
    },
  });
}
