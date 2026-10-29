/** DEMO mappings only. Replace these entries after inspecting actual tags. */
export const DEMO_TAG_BINDINGS = Object.freeze({
  TAG001: 'AKE12345CI',
  TAG002: 'AKE67890CI',
  TAG003: 'PMC92157CI',
});

export function createTagRegistry(bindings = DEMO_TAG_BINDINGS) {
  const entries = new Map(Object.entries(bindings));
  for (const [tagId, uldId] of entries) {
    if (!tagId.trim() || typeof uldId !== 'string' || !uldId.trim())
      throw new TypeError('Tag registry requires non-empty tag and ULD IDs');
  }
  return Object.freeze({
    getUldIdByTagId: (tagId) => entries.get(tagId) ?? null,
  });
}
