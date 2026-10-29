import { msg } from '../../../../src/i18n/marker.js';
import { ruleDecision } from './decision.js';
import { ULD_RULE_MESSAGES } from '../../../../src/uld/ruleMessages.js';

export const STATION_DWELL_POLICY = Object.freeze({
  warningDays: 60,
  lostCandidateDays: 180,
  dayMs: 86400000,
});

/** Caller supplies station entry and current time; Last Seen is NOT station entry. */
export function evaluateDwellRules({
  uld,
  stationEnteredAt,
  now,
  event = null,
}) {
  const entered = Date.parse(stationEnteredAt),
    current = new Date(now).getTime();
  if (!Number.isFinite(entered) || !Number.isFinite(current))
    throw new TypeError('Explicit station entry and evaluation time required');
  const elapsed = current - entered,
    evaluatedAt = new Date(current).toISOString();
  return Object.freeze(
    [
      {
        ruleId: 'RULE_DWELL_WARNING',
        days: STATION_DWELL_POLICY.warningDays,
        type: 'DWELL_WARNING',
        level: 'WARNING',
        title: msg('Dwell warning'),
        message: ULD_RULE_MESSAGES.dwellWarning,
      },
      {
        ruleId: 'RULE_LOST_CANDIDATE',
        days: STATION_DWELL_POLICY.lostCandidateDays,
        type: 'LOST_CANDIDATE',
        level: 'CRITICAL',
        title: msg('Lost candidate'),
        message: ULD_RULE_MESSAGES.lostCandidate,
      },
    ].map(({ ruleId, days, ...alert }) => {
      const matched = elapsed >= days * STATION_DWELL_POLICY.dayMs;
      return ruleDecision({
        ruleId,
        matched,
        reasonCode: matched
          ? `STATION_DWELL_${days}_DAYS`
          : 'DWELL_BELOW_THRESHOLD',
        uld,
        event,
        evaluatedAt,
        alert,
        facts: {
          stationId: uld.stationId,
          stationEnteredAt: new Date(entered).toISOString(),
          elapsedMs: elapsed,
          thresholdDays: days,
        },
      });
    }),
  );
}
