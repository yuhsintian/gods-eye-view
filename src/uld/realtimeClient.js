import {
  isStreamRevision,
  validateEvent,
  validateSnapshot,
} from './protocol.js';

export function uldWebSocketUrl(location) {
  const url = new URL('/ws/uld', location.href);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new TypeError('HTTP location required');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** WS-first synchronization. This controller owns transport; views only read Store. */
export function createUldRealtimeClient({
  store,
  location = globalThis.location,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryMs = 1000,
  maxRetryMs = 30000,
  timeoutMs = 10000,
  maxBufferedEvents = 1000,
}) {
  const wsUrl = uldWebSocketUrl(location);
  const snapshotUrl = new URL('/api/uld/snapshot', location.href).href;
  let running = false;
  let socket = null;
  let generation = 0;
  let syncGeneration = 0;
  let controller = null;
  let retryTimer = null;
  let timeoutTimer = null;
  let fetchTimer = null;
  let detach = () => {};
  let helloRevision = null;
  let cursor = null;
  let buffered = [];
  let syncing = false;
  let everConnected = false;
  let retries = 0;

  function cancelSync() {
    syncGeneration++;
    controller?.abort();
    controller = null;
    clearTimer(fetchTimer);
    fetchTimer = null;
    syncing = false;
  }
  function discardSocket() {
    generation++;
    detach();
    detach = () => {};
    const previous = socket;
    socket = null;
    clearTimer(timeoutTimer);
    timeoutTimer = null;
    cancelSync();
    buffered = [];
    cursor = null;
    helloRevision = null;
    try {
      previous?.close();
    } catch {
      /* already closed */
    }
  }
  function disconnected() {
    if (!running) return;
    discardSocket();
    store.setConnectionStatus('DISCONNECTED');
    clearTimer(retryTimer);
    retryTimer = setTimer(
      () => {
        retryTimer = null;
        connect(true);
      },
      Math.min(maxRetryMs, retryMs * 2 ** Math.min(retries++, 10)),
    );
  }
  function applyEvent(event) {
    if (event.streamRevision <= cursor) return true;
    if (event.streamRevision !== cursor + 1) return false;
    if (event.type === 'ULD_UPSERT') store.upsertUld(event.payload);
    else {
      if (
        event.type === 'ALERT_RESOLVED' &&
        event.payload.status !== 'RESOLVED'
      )
        throw new TypeError('Resolved alert payload required');
      store.upsertAlert(event.payload);
    }
    // A valid but stale record revision is ignored by Store; the stream event
    // was still observed, so its global sequence is consumed.
    cursor = event.streamRevision;
    return true;
  }
  async function synchronize() {
    if (!running || !socket || helloRevision === null) return;
    cancelSync();
    syncing = true;
    const token = syncGeneration;
    const connection = generation;
    const request = new AbortController();
    controller = request;
    store.setConnectionStatus(everConnected ? 'RECONNECTING' : 'CONNECTING');
    fetchTimer = setTimer(() => request.abort(), timeoutMs);
    try {
      const response = await fetchImpl(snapshotUrl, {
        signal: request.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('ULD snapshot unavailable');
      const snapshot = validateSnapshot(await response.json());
      if (
        !running ||
        token !== syncGeneration ||
        connection !== generation ||
        request.signal.aborted
      )
        return;
      if (
        snapshot.streamRevision < helloRevision ||
        (cursor !== null && snapshot.streamRevision < cursor)
      )
        throw new Error('Stale snapshot sequence');
      clearTimer(fetchTimer);
      fetchTimer = null;
      store.replaceSnapshot(snapshot);
      cursor = snapshot.streamRevision;
      // Keep syncing true during replay, including synchronous Store callbacks.
      while (buffered.length) {
        const event = buffered.shift();
        if (!applyEvent(event)) {
          buffered.unshift(event);
          void synchronize();
          return;
        }
      }
      syncing = false;
      controller = null;
      everConnected = true;
      retries = 0;
      store.setConnectionStatus('CONNECTED');
    } catch {
      if (running && token === syncGeneration && connection === generation)
        disconnected();
    }
  }
  function receive(raw) {
    try {
      const value = JSON.parse(raw);
      if (value?.type === 'HELLO') {
        if (
          !isStreamRevision(value.streamRevision) ||
          (value.schemaVersion != null && value.schemaVersion !== 1)
        )
          throw new TypeError('Invalid ULD hello');
        helloRevision = value.streamRevision;
        clearTimer(timeoutTimer);
        timeoutTimer = null;
        void synchronize();
        return;
      }
      const event = validateEvent(value);
      if (event.type === 'SNAPSHOT_REQUIRED') {
        void synchronize();
        return;
      }
      if (cursor !== null && event.streamRevision <= cursor) return;
      if (syncing || cursor === null) {
        buffered.push(event);
        if (buffered.length > maxBufferedEvents) {
          buffered = [];
          // Invalidate the old HTTP result; a newer snapshot must cover loss.
          void synchronize();
        }
        return;
      }
      if (!applyEvent(event)) {
        buffered.push(event);
        void synchronize();
      }
    } catch {
      if (helloRevision === null) disconnected();
      else {
        buffered = [];
        void synchronize();
      }
    }
  }
  function connect(reconnecting = false) {
    if (!running) return;
    store.setConnectionStatus(reconnecting ? 'RECONNECTING' : 'CONNECTING');
    const token = ++generation;
    try {
      socket = new WebSocketImpl(wsUrl);
    } catch {
      disconnected();
      return;
    }
    const current = socket;
    const message = (event) => {
      if (running && generation === token) receive(event.data);
    };
    const close = () => {
      if (running && generation === token) disconnected();
    };
    current.addEventListener('message', message);
    current.addEventListener('close', close);
    current.addEventListener('error', close);
    detach = () => {
      current.removeEventListener('message', message);
      current.removeEventListener('close', close);
      current.removeEventListener('error', close);
    };
    timeoutTimer = setTimer(close, timeoutMs);
  }
  return Object.freeze({
    start() {
      if (!running) {
        running = true;
        retries = 0;
        everConnected = false;
        connect();
      }
    },
    resync() {
      return synchronize();
    },
    stop() {
      running = false;
      clearTimer(retryTimer);
      retryTimer = null;
      discardSocket();
      store.setConnectionStatus('DISCONNECTED');
    },
    getState: () => ({
      running,
      syncing,
      streamRevision: cursor,
      bufferedEvents: buffered.length,
    }),
  });
}
