import { createApplicationData } from '../app/data.js';
import { getStandaloneCatalog } from './catalog.js';
import { mountUldDetailPanel } from '../ui/uldDetailPanel.js';
import { createUldRealtimeClient } from '../uld/realtimeClient.js';
import { createUldDemoApi } from '../uld/demoApi.js';
import { mountUldConnectionStatus } from '../ui/uldConnectionStatus.js';
import { mountUldAlertPanel } from '../ui/uldAlertPanel.js';
import { mountUldDemoControls } from '../ui/uldDemoControls.js';
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
        if (catalog.uldStore.getSnapshot().connectionStatus !== 'CONNECTED')
          throw new Error('ULD snapshot has not connected');
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
    const store = catalog.uldStore;
    const realtime = createUldRealtimeClient({ store });
    const stopRealtime = () => realtime.stop();
    signal.addEventListener('abort', stopRealtime, { once: true });
    defer(() => {
      signal.removeEventListener('abort', stopRealtime);
      realtime.stop();
    });
    const connection = mountUldConnectionStatus({
      container: document.querySelector('[data-uld-connection]'),
      store,
    });
    defer(() => connection.destroy());
    const alertContainer = document.getElementById('uld-alert-panel');
    const alerts = mountUldAlertPanel({
      container: alertContainer,
      store,
      onSelectUld: async (uldId) => {
        const enabled = await data.dataManager.setEnabled('uld', true, {
          signal,
        });
        if (disposed || signal.aborted) return;
        if (!enabled) throw new Error('ULD layer could not be enabled');
        store.selectUld(uldId);
        await catalog.get('uld').focus(uldId);
      },
    });
    defer(() => alerts.destroy());
    const demo = createUldDemoApi();
    const demoControls = mountUldDemoControls({
      container: alertContainer,
      onSimulate: demo.simulate,
      onReset: demo.reset,
    });
    if (!import.meta.env.DEV)
      alertContainer.querySelector('.uld-demo-controls').hidden = true;
    defer(() => demoControls.destroy());
    const enabled = await data.dataManager.setEnabled('uld', true, { signal });
    signal.throwIfAborted();
    if (!enabled) throw new Error('ULD layer could not be enabled');
    realtime.start();
  }
  return data;
}
