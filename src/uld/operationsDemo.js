import { ULD_DEMO_TARGET } from './operationsProjection.js';

function uniqueObservationId() {
  if (globalThis.crypto?.randomUUID) return `demo-ops-${crypto.randomUUID()}`;
  if (!globalThis.crypto?.getRandomValues)
    throw new Error('Secure random IDs unavailable');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `demo-ops-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Demo cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Presentation-only orchestration. Every business mutation goes through HTTP. */
export function createOperationsDemo({
  api,
  store,
  refresh = async () => {},
  onStep = () => {},
  idFactory = uniqueObservationId,
  now = Date.now,
  timeoutMs = 12000,
  pollMs = 100,
}) {
  let controller = null,
    destroyed = false;
  async function waitFor(check, signal) {
    const deadline = Date.now() + timeoutMs;
    while (!signal.aborted) {
      const result = await check();
      if (result) return result;
      if (Date.now() >= deadline) throw new Error('ULD demo state deadline');
      await delay(pollMs, signal);
    }
    throw new DOMException('Demo cancelled', 'AbortError');
  }
  async function execute(action) {
    if (destroyed || controller)
      throw new Error('ULD demo unavailable or busy');
    controller = new AbortController();
    const signal = controller.signal;
    try {
      return await action(signal);
    } catch (error) {
      if (!destroyed) onStep('ERROR');
      throw error;
    } finally {
      controller = null;
    }
  }
  async function resetBackend(signal) {
    onStep('PREPARING');
    await api.reset(signal);
    await waitFor(async () => {
      const model = await api.read(ULD_DEMO_TARGET, signal);
      const snapshot = await api.snapshot(signal);
      const record = snapshot.ulds.find(
        (item) => item.uldId === ULD_DEMO_TARGET,
      );
      return (
        model.events.length === 0 &&
        model.task.status === 'INACTIVE' &&
        record?.zoneId === 'STORAGE-A' &&
        !snapshot.alerts.some(
          (alert) =>
            alert.uldId === ULD_DEMO_TARGET && alert.status !== 'RESOLVED',
        )
      );
    }, signal);
    await refresh();
    await waitFor(() => {
      const record = store.getUldById(ULD_DEMO_TARGET);
      return (
        record?.zoneId === 'STORAGE-A' &&
        record.positionSource === 'CONFIGURED_DEMO' &&
        !store
          .getActiveAlerts()
          .some((alert) => alert.uldId === ULD_DEMO_TARGET)
      );
    }, signal);
  }
  return Object.freeze({
    reset: () =>
      execute(async (signal) => {
        await resetBackend(signal);
        onStep('RESET_COMPLETE');
      }),
    run: (mode) =>
      execute(async (signal) => {
        if (!['NORMAL', 'UNAUTHORIZED'].includes(mode))
          throw new TypeError('Unknown demo mode');
        await resetBackend(signal);
        let model = await api.read(ULD_DEMO_TARGET, signal);
        if (!model.presentation.demoEnabled)
          throw new Error('Development demo disabled');
        let timestamp = Math.max(
          now() - 100,
          Date.parse(store.getUldById(ULD_DEMO_TARGET)?.lastSeenAt ?? 0),
        );
        async function send(readerId) {
          timestamp += 1;
          await api.observe(
            {
              observationId: idFactory(),
              tagId: 'TAG001',
              readerId,
              rssi: -61,
              observedAt: new Date(timestamp).toISOString(),
              sourceType: 'BLE',
            },
            signal,
          );
        }
        onStep('CONFIRMING_STORAGE');
        await send('TPE-STORAGE-GW-01');
        await send('TPE-STORAGE-GW-01');
        await waitFor(async () => {
          const value = await api.read(ULD_DEMO_TARGET, signal);
          return value.events.some(
            (event) =>
              event.eventType === 'LOCATED' && event.zoneId === 'STORAGE-A',
          );
        }, signal);
        if (mode === 'NORMAL') {
          await api.activate(model.task, signal);
          await waitFor(
            async () =>
              (await api.read(ULD_DEMO_TARGET, signal)).task.status ===
              'ACTIVE',
            signal,
          );
          await refresh();
          onStep('DISPATCH_ACTIVE');
        }
        onStep('MOVING_EXIT');
        await send('TPE-EXIT-GW-01');
        await send('TPE-EXIT-GW-01');
        await waitFor(async () => {
          model = await api.read(ULD_DEMO_TARGET, signal);
          const moved = model.events.find(
            (event) =>
              event.eventType === 'MOVED' &&
              event.fromZoneId === 'STORAGE-A' &&
              event.toZoneId === 'EXIT-A',
          );
          const decision = moved?.decisions.find(
            (item) => item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT',
          );
          const snapshot = await api.snapshot(signal);
          const warning = snapshot.alerts.some(
            (alert) =>
              alert.uldId === ULD_DEMO_TARGET &&
              alert.type === 'UNAUTHORIZED_MOVEMENT' &&
              alert.status !== 'RESOLVED',
          );
          return (
            decision &&
            (mode === 'NORMAL'
              ? decision.matched === false &&
                decision.reasonCode === 'ACTIVE_DISPATCH_CONTEXT' &&
                !warning
              : decision.matched === true &&
                decision.reasonCode === 'NO_ACTIVE_DISPATCH_CONTEXT' &&
                warning)
          );
        }, signal);
        await refresh();
        await waitFor(() => {
          const record = store.getUldById(ULD_DEMO_TARGET);
          const warning = store
            .getActiveAlerts()
            .some(
              (alert) =>
                alert.uldId === ULD_DEMO_TARGET &&
                alert.type === 'UNAUTHORIZED_MOVEMENT',
            );
          return (
            record?.zoneId === 'EXIT-A' && warning === (mode === 'UNAUTHORIZED')
          );
        }, signal);
        onStep(mode === 'NORMAL' ? 'COMPLETED_NORMAL' : 'COMPLETED_WARNING');
        return model;
      }),
    destroy() {
      destroyed = true;
      controller?.abort();
    },
  });
}
