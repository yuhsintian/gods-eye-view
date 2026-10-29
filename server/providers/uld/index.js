import { WebSocketServer, WebSocket } from 'ws';
import { createUldBackend } from './state.js';
import { admitSameSiteKeyless } from '../common/same-site.js';
import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';
import { readRequestBody } from '../common/request.js';
import { createSemanticRoutes } from './semantic/http.js';
import { createOperationsRoutes } from './operations/http.js';

/** Bind HTTP + WS to an existing server. Demo writes are DEVELOPMENT ONLY. */
export function installUldProvider(
  server,
  {
    demoEnabled = false,
    backend = createUldBackend(),
    heartbeatMs = 30000,
    observationTimeoutMs = 5000,
  } = {},
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const requests = new Set();
  const json = (res, status, body, demo = false) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-ULD-Source': 'MEMORY-MOCK',
      ...(demo ? { 'X-ULD-Demo': 'DEVELOPMENT-ONLY' } : {}),
    });
    res.end(JSON.stringify(body));
  };
  const middleware = (req, res, next) => {
    if (closed) return next();
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!path.startsWith('/api/uld/')) return next();
    if (admitSameSiteKeyless(req, res)) return;
    if (operationsRoutes(req, res, path)) return;
    if (semanticRoutes(req, res, path)) return;
    if (path === '/api/uld/observations/recent') {
      if (!demoEnabled) return json(res, 404, { error: 'Unknown ULD route' });
      if (req.method !== 'GET')
        return json(res, 405, { error: 'GET required' });
      return json(res, 200, {
        developmentOnly: true,
        observations: backend.recentObservations(),
      });
    }
    if (path === '/api/uld/observations') {
      if (req.method !== 'POST')
        return json(res, 405, { error: 'POST required' });
      if (
        !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
      ) {
        req.resume();
        return json(res, 415, { error: 'application/json required' });
      }
      void receiveJson(req, res, backend.observe);
      return;
    }
    if (path === '/api/uld/snapshot') {
      if (req.method !== 'GET')
        return json(res, 405, { error: 'GET required' });
      return json(res, 200, backend.snapshot());
    }
    if (
      ['/api/uld/demo/unauthorized-movement', '/api/uld/demo/reset'].includes(
        path,
      )
    ) {
      if (!demoEnabled)
        return json(res, 403, { error: 'DEMO / DEVELOPMENT ONLY' }, true);
      if (req.method !== 'POST')
        return json(res, 405, { error: 'POST required' }, true);
      // No request body or command payload is accepted by this fixed demo API.
      req.resume();
      const changed = path.endsWith('/reset')
        ? backend.reset()
        : backend.simulate();
      return json(
        res,
        200,
        {
          demo: true,
          developmentOnly: true,
          changed,
          streamRevision: backend.snapshot().streamRevision,
        },
        true,
      );
    }
    json(res, 404, { error: 'Unknown ULD route' });
  };
  const semanticRoutes = createSemanticRoutes({
    backend,
    demoEnabled,
    json,
    receiveJson,
  });
  const operationsRoutes = createOperationsRoutes({
    backend,
    demoEnabled,
    json,
  });
  async function receiveJson(req, res, handle, demo = false) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('Observation body timed out')),
      observationTimeoutMs,
    );
    timeout.unref?.();
    const disconnect = () => {
      if (!res.writableEnded)
        controller.abort(new Error('Request disconnected'));
    };
    res.once('close', disconnect);
    try {
      const body = await readRequestBody(req, 16 * 1024, controller.signal);
      if (closed || controller.signal.aborted)
        throw new Error('Observation request closed');
      const result = handle(JSON.parse(body));
      if (!res.destroyed) json(res, 200, result, demo);
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const status = closed
          ? 503
          : error.code === 'BODY_TOO_LARGE'
            ? 413
            : controller.signal.aborted
              ? 408
              : error instanceof TypeError || error instanceof SyntaxError
                ? 400
                : 500;
        if (status === 500)
          console.error('ULD observation processing failed', error);
        res.setHeader('Connection', 'close');
        json(
          res,
          status,
          {
            error:
              status === 400
                ? error instanceof TypeError
                  ? error.message
                  : 'Invalid Observation JSON'
                : status === 413
                  ? 'Observation exceeds 16 KiB'
                  : 'Observation request unavailable',
          },
          demo,
        );
      }
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
      res.off('close', disconnect);
    }
  }
  server.middlewares.use(middleware);
  const upgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws/uld') return;
    const verdict = admitSameSiteRequest({
      hostHeader: req.headers.host,
      protocol: req.socket.encrypted ? 'https:' : 'http:',
      origin: req.headers.origin,
      secFetchSite: req.headers['sec-fetch-site'],
      proxyHeaders: {},
    });
    if (!verdict.ok) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit('connection', ws, req),
    );
  };
  server.httpServer.on('upgrade', upgrade);
  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('error', () => {});
    ws.send(
      JSON.stringify({
        type: 'HELLO',
        schemaVersion: 1,
        streamRevision: backend.snapshot().streamRevision,
      }),
    );
  });
  const off = backend.subscribe((event) => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > 1024 * 1024) {
        ws.send(
          JSON.stringify({
            type: 'SNAPSHOT_REQUIRED',
            eventId: `resync:${event.eventId}`,
            streamRevision: event.streamRevision,
            occurredAt: event.occurredAt,
            payload: { reason: 'backpressure' },
          }),
        );
        ws.close(1013, 'Snapshot resync required');
        continue;
      }
      ws.send(JSON.stringify(event));
    }
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const request of requests)
      request.abort(new Error('ULD provider closed'));
    requests.clear();
    clearInterval(heartbeat);
    off();
    backend.close();
    server.httpServer.removeListener('upgrade', upgrade);
    server.httpServer.removeListener('close', close);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  server.httpServer.once('close', close);
  return { close, backend };
}

export function uldProvider({ development = true } = {}) {
  let service;
  return {
    name: 'uld-provider',
    configureServer(server) {
      service = installUldProvider(server, { demoEnabled: development });
    },
    configurePreviewServer(server) {
      service = installUldProvider(server);
    },
    closeBundle() {
      service?.close();
    },
  };
}
