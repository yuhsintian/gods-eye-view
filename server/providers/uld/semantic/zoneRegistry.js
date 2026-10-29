const configured = [
  ['TPE', 'STORAGE-A', 121.228, 25.071, 55],
  ['TPE', 'EXIT-A', 121.226, 25.074, 55],
  ['TPE', 'STAGING-A', 121.232, 25.073, 55],
  ['TPE', 'GATE-A', 121.236, 25.071, 55],
];

/** Configured representative zone points. Never GPS measurements. */
export function createZoneRegistry() {
  const zones = new Map(
    configured.map(([stationId, zoneId, longitude, latitude, height]) => [
      `${stationId}:${zoneId}`,
      Object.freeze({
        stationId,
        zoneId,
        position: Object.freeze({ longitude, latitude, height }),
      }),
    ]),
  );
  return Object.freeze({
    getZoneContext: (stationId, zoneId) =>
      zones.get(`${stationId}:${zoneId}`) ?? null,
  });
}
