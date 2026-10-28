import { t } from '../i18n/index.js';

/** Only binds named actions; scenario data and transitions live outside the UI. */
export function mountUldDemoControls({ container, onSimulate, onReset }) {
  const simulate = container.querySelector('[data-uld-simulate]');
  const reset = container.querySelector('[data-uld-reset]');
  const error = container.querySelector('[data-uld-demo-error]');
  let destroyed = false;
  let running = false;
  const run = async (action) => {
    if (running || destroyed) return;
    running = true;
    simulate.disabled = reset.disabled = true;
    error.hidden = true;
    try {
      await action();
    } catch {
      if (!destroyed) {
        error.textContent = t('ULD demo action failed.');
        error.hidden = false;
      }
    } finally {
      running = false;
      if (!destroyed) simulate.disabled = reset.disabled = false;
    }
  };
  const simulateClick = () => run(onSimulate);
  const resetClick = () => run(onReset);
  simulate.addEventListener('click', simulateClick);
  reset.addEventListener('click', resetClick);
  return {
    destroy() {
      destroyed = true;
      simulate.removeEventListener('click', simulateClick);
      reset.removeEventListener('click', resetClick);
    },
  };
}
