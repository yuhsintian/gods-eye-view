import { createZoneRegistry } from './zoneRegistry.js';

export const DEMO_READER_BINDINGS = Object.freeze({
  'TPE-STORAGE-GW-01': Object.freeze({ stationId: 'TPE', zoneId: 'STORAGE-A' }),
  'TPE-EXIT-GW-01': Object.freeze({ stationId: 'TPE', zoneId: 'EXIT-A' }),
  'TPE-STAGING-GW-01': Object.freeze({ stationId: 'TPE', zoneId: 'STAGING-A' }),
});

export function createReaderRegistry(
  bindings = DEMO_READER_BINDINGS,
  zones = createZoneRegistry(),
) {
  const readers = new Map();
  for (const [readerId, binding] of Object.entries(bindings)) {
    const zone = zones.getZoneContext(binding.stationId, binding.zoneId);
    if (!readerId.trim() || !zone)
      throw new TypeError('Reader must reference a configured zone');
    readers.set(
      readerId,
      Object.freeze({
        readerId,
        ...zone,
        positionSource: 'CONFIGURED_READER_ZONE',
      }),
    );
  }
  return Object.freeze({
    getReaderContext: (readerId) => readers.get(readerId) ?? null,
  });
}
