/** Development diagnostics/context routes; body parsing remains provider-owned. */
export function createSemanticRoutes({
  backend,
  demoEnabled,
  json,
  receiveJson,
}) {
  const actions = new Map([
    ['/api/uld/demo/context/dispatch/activate', backend.activateDispatch],
    ['/api/uld/demo/context/dispatch/clear', backend.clearDispatch],
  ]);
  return (req, res, path) => {
    if (path === '/api/uld/events/recent') {
      if (!demoEnabled) json(res, 404, { error: 'Unknown ULD route' });
      else if (req.method !== 'GET') json(res, 405, { error: 'GET required' });
      else
        json(res, 200, {
          developmentOnly: true,
          ...backend.semanticDiagnostics(),
        });
      return true;
    }
    const action = actions.get(path);
    if (!action) return false;
    if (!demoEnabled)
      json(res, 403, { error: 'DEMO / DEVELOPMENT ONLY' }, true);
    else if (req.method !== 'POST')
      json(res, 405, { error: 'POST required' }, true);
    else if (
      !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
    ) {
      req.resume();
      json(res, 415, { error: 'application/json required' }, true);
    } else
      void receiveJson(
        req,
        res,
        (body) => ({
          developmentOnly: true,
          dispatchContext: action(body),
          streamRevision: backend.snapshot().streamRevision,
        }),
        true,
      );
    return true;
  };
}
