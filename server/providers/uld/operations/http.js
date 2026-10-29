/** Public read routes are available in dev and preview; writes keep M6's gate. */
export function createOperationsRoutes({ backend, demoEnabled, json }) {
  return (req, res, path) => {
    if (!['/api/uld/events', '/api/uld/operations'].includes(path))
      return false;
    if (req.method !== 'GET') {
      json(res, 405, { error: 'GET required' });
      return true;
    }
    const query = new URL(req.url, 'http://localhost').searchParams;
    const uldId = query.get('uldId');
    const limit = query.has('limit') ? Number(query.get('limit')) : 15;
    if (
      !uldId?.trim() ||
      uldId.length > 200 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    ) {
      json(res, 400, { error: 'uldId and event limit 1..20 required' });
      return true;
    }
    const model = backend.readOperations(uldId.trim(), limit);
    if (!model) {
      json(res, 404, { error: 'Unknown ULD' });
      return true;
    }
    json(
      res,
      200,
      path === '/api/uld/events'
        ? {
            schemaVersion: 1,
            uldId: model.uldId,
            streamRevision: model.streamRevision,
            events: model.events,
          }
        : { ...model, presentation: { ...model.presentation, demoEnabled } },
    );
    return true;
  };
}
