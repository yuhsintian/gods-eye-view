import { msg } from '../../../../src/i18n/marker.js';
import { ruleDecision } from './decision.js';
import { ULD_RULE_MESSAGES } from '../../../../src/uld/ruleMessages.js';

export function serviceability({ uld, event, dispatch, evaluatedAt }) {
  const matched =
    uld.serviceabilityStatus === 'UNSERVICEABLE' &&
    (dispatch?.active === true || event?.eventType === 'MOVED');
  return ruleDecision({
    ruleId: 'RULE_UNSERVICEABLE',
    matched,
    reasonCode: matched
      ? 'UNSERVICEABLE_ULD'
      : 'NO_UNSERVICEABLE_DISPATCH_OR_MOVEMENT',
    uld,
    event,
    dispatch,
    evaluatedAt,
    alert: {
      type: 'UNSERVICEABLE',
      level: 'WARNING',
      title: msg('Unserviceable alert'),
      message: ULD_RULE_MESSAGES.unserviceable,
    },
  });
}
