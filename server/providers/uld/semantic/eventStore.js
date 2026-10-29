/** Bounded diagnostic journal. Canonical IDs are distinct from WS stream IDs. */
export function createRecentStore(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new TypeError('Positive journal capacity required');
  const records = [];
  return Object.freeze({
    add(record) {
      records.push(Object.freeze(record));
      if (records.length > capacity) records.shift();
      return record;
    },
    get: () => Object.freeze([...records]),
    clear() {
      records.length = 0;
    },
  });
}
