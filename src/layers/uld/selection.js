import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
  pickContact,
  resolvePickId,
} from '../../data/pickRegistry.js';

/** Respect tool pointer leases and sibling-layer pick ownership. */
export function bindUldSelection(viewer, source) {
  const owns = (id) =>
    typeof id === 'string' &&
    id.startsWith('uld:') &&
    Boolean(source.getUldById(id.slice(4)));
  registerPickOwner('uld', owns);
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    if (!isPointerFree()) return;
    const id = resolvePickId(pickContact(viewer.scene, click.position));
    if (owns(id)) source.selectUld(id.slice(4));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  return () => {
    handler.destroy();
    unregisterPickOwner('uld');
  };
}
