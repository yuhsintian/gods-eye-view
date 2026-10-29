export { createMockUldRecords } from '../../uld/mockData.js';

/** Portable adapter over the supplied store; owns no second record cache. */
export function createUldSource(store) {
  return Object.freeze({
    getSnapshot: store.getSnapshot,
    getUldById: store.getUldById,
    selectUld: store.selectUld,
    subscribe: store.subscribe,
  });
}
