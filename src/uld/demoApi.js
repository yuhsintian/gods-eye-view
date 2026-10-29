/** Explicit DEVELOPMENT-only actions. No local model mutation or generation. */
export function createUldDemoApi({ fetchImpl = globalThis.fetch } = {}) {
  async function post(path) {
    const response = await fetchImpl(path, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('ULD development demo unavailable');
    return response.json();
  }
  return Object.freeze({
    simulate: () => post('/api/uld/demo/unauthorized-movement'),
    reset: () => post('/api/uld/demo/reset'),
  });
}
