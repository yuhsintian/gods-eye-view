/** Fixed TPE demo configuration, not GPS or live BLE observations. */
export function createMockUldRecords() {
  const common = {
    stationId: 'TPE',
    serviceabilityStatus: 'SERVICEABLE',
    lastSeenAt: '2026-10-28T06:00:00.000Z',
    positionSource: 'CONFIGURED_DEMO',
    revision: 1,
  };
  return [
    {
      ...common,
      uldId: 'AKE12345CI',
      uldType: 'AKE',
      zoneId: 'STORAGE-A',
      operationalStatus: 'AVAILABLE',
      flight: null,
      destination: null,
      alertLevel: 'NORMAL',
      position: { longitude: 121.228, latitude: 25.071, height: 55 },
    },
    {
      ...common,
      uldId: 'AKE67890CI',
      uldType: 'AKE',
      zoneId: 'STAGING-A',
      operationalStatus: 'ASSIGNED',
      flight: 'CI152',
      destination: 'KIX',
      alertLevel: 'NORMAL',
      position: { longitude: 121.232, latitude: 25.073, height: 55 },
    },
    {
      ...common,
      uldId: 'PMC92157CI',
      uldType: 'PMC',
      zoneId: 'GATE-A',
      operationalStatus: 'MOVING',
      flight: 'CI152',
      destination: 'KIX',
      alertLevel: 'WARNING',
      position: { longitude: 121.236, latitude: 25.071, height: 55 },
    },
  ];
}

/** Portable adapter over the supplied store; owns no second record cache. */
export function createUldSource(store) {
  return Object.freeze({
    getSnapshot: store.getSnapshot,
    getUldById: store.getUldById,
    selectUld: store.selectUld,
    subscribe: store.subscribe,
  });
}
