import { createSurfaceServices } from '../app/surfaceServices.js';
import { createApplicationRequestServices } from '../services/requests.js';
import { createApplicationCatalog } from '../app/constructCatalog.js';
import { createStandaloneLayerSources } from './layerSources.js';
import { createLayerCatalog } from '../app/catalog.js';
import { createUldStore } from '../uld/store.js';
import { createUldSource } from '../layers/uld/source.js';
import { createUldLayer } from '../layers/uld/index.js';
export { createStandaloneReferenceSources } from './layerSources.js';

/** Create fresh layer instances using the existing standalone source choices. */
export function createStandaloneCatalog({
  nepalBoundaryResolver,
  sources = {},
  uldInitialRecords = [],
  streetLevelProviders,
  signal = new AbortController().signal,
  surface = createSurfaceServices({
    terrainSource: createApplicationRequestServices().terrain,
    signal,
  }),
} = {}) {
  const base = createApplicationCatalog({
    nepalBoundaryResolver,
    surface,
    sources: createStandaloneLayerSources(sources),
    streetLevelProviders,
    signal,
    vesselOptions: {
      maxRows: import.meta.env?.VITE_AIS_LIVE_MAX_ROWS,
      maxLabels: import.meta.env?.VITE_AIS_LIVE_LABEL_MAX_ROWS,
    },
  });
  const uldStore = createUldStore(uldInitialRecords);
  signal.addEventListener('abort', () => uldStore.destroy(), { once: true });
  const uld = createUldLayer({ source: createUldSource(uldStore) });
  // Mock configuration is page-local; do not publish it in durable/share state.
  const catalog = createLayerCatalog(
    [...base.layers, uld],
    [...base.metadata, { id: 'uld', disposition: 'local-only' }],
  );
  return Object.freeze({
    ...base,
    ...catalog,
    uldStore,
    getSourceAvailability: (id) =>
      id === 'uld' ? { available: true } : base.getSourceAvailability(id),
  });
}

// Direct compatibility callers share one catalog; application startup supplies its own.
let compatibilityCatalog;
export function getStandaloneCatalog() {
  return (compatibilityCatalog ||= createStandaloneCatalog());
}
