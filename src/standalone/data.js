import { createApplicationData } from '../app/data.js';
import { getStandaloneCatalog } from './catalog.js';
import { mountUldDetailPanel } from '../ui/uldDetailPanel.js';
import { createUldRealtimeClient } from '../uld/realtimeClient.js';
import { createUldDemoApi } from '../uld/demoApi.js';
import { mountUldConnectionStatus } from '../ui/uldConnectionStatus.js';
import { mountUldAlertPanel } from '../ui/uldAlertPanel.js';
import { mountUldDemoControls } from '../ui/uldDemoControls.js';
import { createOperationsApi } from '../uld/operationsApi.js';
import { createOperationsClient } from '../uld/operationsClient.js';
import { createOperationsDemo } from '../uld/operationsDemo.js';
import { ULD_DEMO_TARGET } from '../uld/operationsProjection.js';
import { mountUldOperationsPanel } from '../ui/uldOperationsPanel.js';
import { mountUldTimeline, mountUldContextTabs } from '../ui/uldTimeline.js';
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
    const contextContainer = document.getElementById('uld-detail-panel');
    const tabs = mountUldContextTabs({ container: contextContainer });
    const timeline = mountUldTimeline({ container: contextContainer, store });
    const operationsApi = createOperationsApi();
    const operationsClient = createOperationsClient({
      store,
      api: operationsApi,
    });
    let operationsPanel;
    const operationsDemo = createOperationsDemo({
      api: operationsApi,
      store,
      refresh: operationsClient.refresh,
      onStep: (step) => operationsPanel?.setStep(step),
    });
    const focusTarget = async () => {
      const enabled = await data.dataManager.setEnabled('uld', true, {
        signal,
      });
      signal.throwIfAborted();
      if (!enabled) throw new Error('ULD layer could not be enabled');
      store.selectUld(ULD_DEMO_TARGET);
      await catalog.get('uld').focus(ULD_DEMO_TARGET);
    };
    const showDemoResult = (warning = false) => {
      if (disposed || signal.aborted) return;
      tabs.show('timeline');
      contextContainer
        .querySelector('.uld-rule-decision')
        ?.scrollIntoView({ block: 'nearest' });
      if (warning)
        document
          .querySelector('[data-uld-alert-list] [data-alert-id]')
          ?.scrollIntoView({ block: 'start' });
    };
    operationsPanel = mountUldOperationsPanel({
      container: document.querySelector('[data-uld-operations]'),
      store,
      onActivate: async (task) => {
        await operationsApi.activate(task, signal);
        await operationsClient.refresh();
      },
      onClear: async () => {
        await operationsApi.clear(ULD_DEMO_TARGET, signal);
        await operationsClient.refresh();
      },
      onNormal: async () => {
        await focusTarget();
        await operationsDemo.run('NORMAL');
        showDemoResult();
      },
      onUnauthorized: async () => {
        await focusTarget();
        await operationsDemo.run('UNAUTHORIZED');
        showDemoResult(true);
      },
      onReset: () => operationsDemo.reset(),
    });
    const stopOperations = () => {
      operationsDemo.destroy();
      operationsClient.stop();
    };
    signal.addEventListener('abort', stopOperations, { once: true });
    defer(() => {
      signal.removeEventListener('abort', stopOperations);
      stopOperations();
      operationsPanel.destroy();
      timeline.destroy();
      tabs.destroy();
    });
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
        tabs.show('detail');
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
      alertContainer.querySelector('[data-uld-legacy-demo]').hidden = true;
    defer(() => demoControls.destroy());
    const enabled = await data.dataManager.setEnabled('uld', true, { signal });
    signal.throwIfAborted();
    if (!enabled) throw new Error('ULD layer could not be enabled');
    operationsClient.start();
    realtime.start();
  }
  return data;
}
