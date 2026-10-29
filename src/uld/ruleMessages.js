import { msg } from '../i18n/marker.js';

/** Portable message IDs shared by Backend rule commands and UI catalogs. */
export const ULD_RULE_MESSAGES = Object.freeze({
  unserviceable: msg('ULD is unserviceable for dispatch.'),
  dwellWarning: msg('Station dwell reached 60 days.'),
  lostCandidate: msg('Station dwell reached 180 days.'),
});
