/** Same-origin read projections and existing Backend actions. No local mutations. */
export function createOperationsApi({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  async function request(path, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(path, {
        method,
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      });
      if (!response.ok)
        throw new Error(`ULD operations HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  const post = (path, body, signal) =>
    request(path, { method: 'POST', body, signal });
  return Object.freeze({
    read: (uldId, signal) =>
      request(`/api/uld/operations?uldId=${encodeURIComponent(uldId)}`, {
        signal,
      }),
    snapshot: (signal) => request('/api/uld/snapshot', { signal }),
    activate: (task, signal) =>
      post(
        '/api/uld/demo/context/dispatch/activate',
        {
          uldId: task.uldId,
          taskId: task.taskId,
          flight: task.flight,
          destination: task.destination,
          requiredUldType: task.requiredUldType,
        },
        signal,
      ),
    clear: (uldId, signal) =>
      post('/api/uld/demo/context/dispatch/clear', { uldId }, signal),
    reset: (signal) => post('/api/uld/demo/reset', null, signal),
    observe: (observation, signal) =>
      post('/api/uld/observations', observation, signal),
  });
}
