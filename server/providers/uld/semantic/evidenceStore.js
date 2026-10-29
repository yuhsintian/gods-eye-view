export function createEvidenceStore({ perUldLimit }) {
  if (!Number.isSafeInteger(perUldLimit) || perUldLimit < 1)
    throw new TypeError('Positive evidence limit required');
  const records = new Map();
  return Object.freeze({
    add(evidence) {
      const previous = records.get(evidence.uldId) ?? [];
      if (
        previous.some((item) => item.observationId === evidence.observationId)
      )
        return false;
      const next = [...previous, Object.freeze({ ...evidence })];
      next.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
      records.set(evidence.uldId, next.slice(-perUldLimit));
      return true;
    },
    getForUld: (uldId) => Object.freeze([...(records.get(uldId) ?? [])]),
    all: () => Object.freeze([...records.values()].flat()),
    clear() {
      records.clear();
    },
  });
}
