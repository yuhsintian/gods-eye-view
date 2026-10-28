import { createUldRenderer } from './rendering.js';
import { bindUldSelection } from './selection.js';

/** Formal business layer; LayerLifecycle owns all Cesium resource cleanup. */
export function createUldLayer({ source }) {
  let renderer = null;
  let unbind = null;
  let viewer = null;
  let enabled = false;
  const layer = {
    id: 'uld',
    name: 'ULD EYE · Mock ULDs',
    icon: '▣',
    source: 'CONFIGURED_DEMO · NOT LIVE',
    updateInterval: 0,
    init(nextViewer) {
      viewer = nextViewer;
      renderer = createUldRenderer(viewer, source);
    },
    enable() {
      unbind ||= bindUldSelection(viewer, source);
      enabled = true;
      renderer.setVisible(true);
    },
    disable() {
      unbind?.();
      unbind = null;
      enabled = false;
      renderer?.setVisible(false);
      source.selectUld(null);
    },
    update() {
      return true;
    },
    focus(uldId) {
      return enabled ? renderer.focus(uldId) : Promise.resolve(false);
    },
    getStats() {
      return {
        count: enabled ? source.getSnapshot().records.length : 0,
        lastUpdate: null,
      };
    },
    destroy() {
      layer.disable();
      renderer?.destroy();
      renderer = null;
      viewer = null;
    },
  };
  return layer;
}
