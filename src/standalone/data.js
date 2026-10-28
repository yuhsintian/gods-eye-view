import { createApplicationData } from '../app/data.js';
import { getStandaloneCatalog } from './catalog.js';
import { mountUldDetailPanel } from '../ui/uldDetailPanel.js';
export async function createStandaloneData(options) {
  const catalog = options?.catalog ?? getStandaloneCatalog();
  const data = createApplicationData({
    catalog,
    ...options,
  });
  if (catalog.uldStore) {
    const {
      signal,
      defer,
      controls: { styleManager },
    } = options;
    let disposed = false;
    const panel = mountUldDetailPanel({
      container: document.getElementById('uld-detail-panel'),
      store: catalog.uldStore,
      openPanel: () =>
        styleManager.setPanelCollapsed('uld-detail-panel', false, {
          persist: false,
          syncShare: false,
        }),
      focusDemo: async () => {
        const enabled = await data.dataManager.setEnabled('uld', true, {
          signal,
        });
        if (disposed || signal.aborted) return;
        if (!enabled) throw new Error('ULD layer could not be enabled');
        await catalog.get('uld').focus();
      },
    });
    defer(() => {
      disposed = true;
      panel.destroy();
    });
    const enabled = await data.dataManager.setEnabled('uld', true, { signal });
    signal.throwIfAborted();
    if (!enabled) throw new Error('ULD layer could not be enabled');
  }
  return data;
}
