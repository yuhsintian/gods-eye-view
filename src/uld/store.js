import { normalizeUldRecord } from './records.js';

/** One authoritative set of domain records shared by the layer and panel. */
export function createUldStore(initialRecords = []) {
  const records = new Map();
  for (const raw of initialRecords) {
    const record = normalizeUldRecord(raw);
    if (records.has(record.uldId))
      throw new TypeError(`Duplicate ULD ID: ${record.uldId}`);
    records.set(record.uldId, record);
  }
  const listeners = new Set();
  let selectedUldId = null;
  let destroyed = false;
  const getSnapshot = () =>
    Object.freeze({
      records: Object.freeze([...records.values()]),
      selectedUldId,
    });
  const notify = (listener, snapshot, change = null) => {
    try {
      listener(snapshot, change);
    } catch (error) {
      console.error('ULD store listener failed', error);
    }
  };
  const publish = (change) => {
    const snapshot = getSnapshot();
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) notify(listener, snapshot, change);
    }
  };
  return Object.freeze({
    getSnapshot,
    getUldById: (uldId) => records.get(uldId) ?? null,
    selectUld(uldId) {
      if (destroyed || (uldId !== null && !records.has(uldId))) return false;
      selectedUldId = uldId;
      publish(Object.freeze({ type: 'selection' }));
      return true;
    },
    upsertUld(raw) {
      if (destroyed) return false;
      const record = normalizeUldRecord(raw);
      const previous = records.get(record.uldId);
      if (previous && record.revision <= previous.revision) return false;
      records.set(record.uldId, record);
      publish(Object.freeze({ type: 'record-updated', uldId: record.uldId }));
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('ULD listener required');
      if (destroyed) return () => {};
      listeners.add(listener);
      notify(listener, getSnapshot());
      return () => listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  });
}
