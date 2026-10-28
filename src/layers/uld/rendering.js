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
  const repaint = ({ records, selectedUldId }) => {
    const ids = new Set();
    dataSource.entities.suspendEvents();
    try {
      for (const record of records) {
        const id = `uld:${record.uldId}`;
        ids.add(id);
        const entity = dataSource.entities.getOrCreateEntity(id);
        const selected = selectedUldId === record.uldId;
        entity.position = Cesium.Cartesian3.fromDegrees(
          record.position.longitude,
          record.position.latitude,
          record.position.height,
        );
        entity.point = new Cesium.PointGraphics({
          pixelSize: selected ? 24 : 18,
          color: Cesium.Color.fromCssColorString(
            ULD_MARKER_COLORS[record.alertLevel],
          ),
          outlineColor: selected ? Cesium.Color.WHITE : Cesium.Color.BLACK,
          outlineWidth: selected ? 4 : 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      }
      for (const entity of [...dataSource.entities.values]) {
        if (!ids.has(entity.id)) dataSource.entities.remove(entity);
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
    focus() {
      return viewer.flyTo(dataSource, {
        duration: 1.2,
        offset: new Cesium.HeadingPitchRange(0, -Math.PI / 2, 2200),
      });
    },
    destroy() {
      unsubscribe();
      viewer.dataSources.remove(dataSource, true);
      viewer.scene.requestRender();
    },
  };
}
