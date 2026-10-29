/** Explainable DEMO policy, not an aviation standard or positioning guarantee. */
export const DEMO_INFERENCE_POLICY = Object.freeze({
  minObservations: 2,
  confirmationWindowMs: 5000,
  evidencePerUld: 32,
  recentEvents: 250,
  recentDecisions: 250,
});

export function inferencePolicy(overrides = {}) {
  const policy = { ...DEMO_INFERENCE_POLICY, ...overrides };
  for (const key of Object.keys(DEMO_INFERENCE_POLICY))
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1)
      throw new TypeError(`Invalid inference policy: ${key}`);
  if (
    policy.minObservations < 2 ||
    policy.evidencePerUld < policy.minObservations
  )
    throw new TypeError(
      'Confirmation requires at least two retained observations',
    );
  return Object.freeze(policy);
}
