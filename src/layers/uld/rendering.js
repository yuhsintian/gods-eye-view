import * as Cesium from 'cesium';

export const ULD_MARKER_COLORS = Object.freeze({
  NORMAL: '#43d9b0',
  WARNING: '#ffbd4a',
  CRITICAL: '#ff5364',
});

/** Cesium resources are a projection of the store, never a domain-data cache. */
export function createUldRenderer(viewer, source) {
  const dataSource = new Cesium.CustomDataSource('uld');
  dataSource.show = false;
  viewer.dataSources.add(dataSource);
  const renderedVersions = new Map();
  const repaint = ({ records, selectedUldId }, change) => {
    // An authoritative snapshot may restart record revisions after a server
    // restart. Repaint properties while retaining every existing Cesium owner.
    if (change?.type === 'snapshot-replaced') renderedVersions.clear();
    const ids = new Set();
    dataSource.entities.suspendEvents();
    try {
      for (const record of records) {
        const id = `uld:${record.uldId}`;
        ids.add(id);
        const entity = dataSource.entities.getOrCreateEntity(id);
        const selected = selectedUldId === record.uldId;
        const previous = renderedVersions.get(id);
        if (
          previous?.revision === record.revision &&
          previous.selected === selected
        )
          continue;
        entity.position = Cesium.Cartesian3.fromDegrees(
          record.position.longitude,
          record.position.latitude,
          record.position.height,
        );
        entity.point ||= new Cesium.PointGraphics({
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        entity.point.pixelSize = selected ? 24 : 18;
        entity.point.color = Cesium.Color.fromCssColorString(
          ULD_MARKER_COLORS[record.alertLevel],
        );
        entity.point.outlineColor = selected
          ? Cesium.Color.WHITE
          : Cesium.Color.BLACK;
        entity.point.outlineWidth = selected ? 4 : 2;
        renderedVersions.set(id, { revision: record.revision, selected });
      }
      for (const entity of [...dataSource.entities.values]) {
        if (!ids.has(entity.id)) {
          dataSource.entities.remove(entity);
          renderedVersions.delete(entity.id);
        }
      }
    } finally {
      dataSource.entities.resumeEvents();
    }
    viewer.scene.requestRender();
  };
  const unsubscribe = source.subscribe(repaint);
  return {
    setVisible(visible) {
      dataSource.show = visible;
      viewer.scene.requestRender();
    },
    focus(uldId) {
      const target = uldId
        ? dataSource.entities.getById(`uld:${uldId}`)
        : dataSource;
      if (!target) return Promise.resolve(false);
      return viewer.flyTo(target, {
        duration: 1.2,
        offset: new Cesium.HeadingPitchRange(
          0,
          -Math.PI / 2,
          uldId ? 850 : 2200,
        ),
      });
    },
    destroy() {
      unsubscribe();
      renderedVersions.clear();
      viewer.dataSources.remove(dataSource, true);
      viewer.scene.requestRender();
    },
  };
}
