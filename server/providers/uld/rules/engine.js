import { unauthorizedMovement } from './unauthorizedMovement.js';
import { serviceability } from './serviceability.js';
export { evaluateDwellRules } from './dwell.js';

/** Pure decisions/commands only. No Store, transport, clock acquisition or DOM. */
export function evaluateMovementRules(input) {
  return Object.freeze([unauthorizedMovement(input), serviceability(input)]);
}
