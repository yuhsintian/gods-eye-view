import { ULD_DEMO_TARGET } from './operationsProjection.js';

/** One Store cache for Backend-owned task/events. Reconnect replaces, never appends. */
export function createOperationsClient({
  store,
  api,
  pollMs = 2000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let running = false,
    generation = 0,
    controller = null,
    timer = null,
    unsubscribe = null;
  function cancel() {
    generation++;
    controller?.abort();
    controller = null;
    clearTimer(timer);
    timer = null;
  }
  function schedule(delay = pollMs) {
    clearTimer(timer);
    if (running && store.getSnapshot().connectionStatus === 'CONNECTED')
      timer = setTimer(() => {
        timer = null;
        void refresh().catch(() => {});
      }, delay);
  }
  let pending = null;
  async function read() {
    if (!running || store.getSnapshot().connectionStatus !== 'CONNECTED')
      return;
    cancel();
    const token = generation;
    controller = new AbortController();
    const signal = controller.signal;
    const ids = [
      ...new Set([ULD_DEMO_TARGET, store.getSnapshot().selectedUldId]),
    ].filter((id) => id && store.getUldById(id));
    try {
      const models = await Promise.all(ids.map((id) => api.read(id, signal)));
      if (!running || token !== generation || signal.aborted) return;
      for (let i = 0; i < models.length; i++) {
        if (models[i].uldId !== ids[i])
          throw new TypeError('Operations ULD mismatch');
        store.replaceOperations(models[i]);
      }
    } finally {
      if (running && token === generation) {
        controller = null;
        schedule();
      }
    }
  }
  // Explicit action refreshes serialize behind an existing poll. A periodic
  // refresh must never abort the read an operator action is waiting for.
  async function refresh() {
    if (pending) {
      try {
        await pending;
      } catch {
        /* A following read can recover. */
      }
      return refresh();
    }
    const request = read();
    pending = request;
    try {
      return await request;
    } finally {
      if (pending === request) pending = null;
    }
  }
  return Object.freeze({
    refresh,
    start() {
      if (running) return;
      running = true;
      unsubscribe = store.subscribe((_snapshot, change) => {
        if (store.getSnapshot().connectionStatus !== 'CONNECTED') {
          cancel();
          return;
        }
        if (
          !change ||
          [
            'selection',
            'connection-status',
            'snapshot-replaced',
            'record-updated',
            'records-and-alerts-updated',
            'alert-updated',
          ].includes(change.type)
        )
          schedule(30);
      });
    },
    stop() {
      running = false;
      cancel();
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}
