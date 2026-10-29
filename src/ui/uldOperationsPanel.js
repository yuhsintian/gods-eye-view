import { t } from '../i18n/index.js';
import { ULD_DEMO_TARGET } from '../uld/operationsProjection.js';
import { formatUldValue } from './uldPresentation.js';
import {
  formatDispatchStatus,
  formatOperationsStep,
  getTaskFields,
} from './uldOperationsPresentation.js';

/** UI owns pending interaction state only. Task/context come from Backend read models. */
export function mountUldOperationsPanel({
  container,
  store,
  onActivate,
  onClear,
  onNormal,
  onUnauthorized,
  onReset,
}) {
  const doc = container.ownerDocument;
  const find = (name) => container.querySelector(`[data-uld-ops-${name}]`);
  const taskFields = find('task-fields'),
    status = find('task-status'),
    progress = find('progress');
  const connection = find('connection'),
    error = find('error');
  const actions = {
    activate: onActivate,
    clear: onClear,
    normal: onNormal,
    unauthorized: onUnauthorized,
    reset: onReset,
  };
  const buttons = Object.fromEntries(
    Object.keys(actions).map((name) => [name, find(name)]),
  );
  const listeners = [];
  let busy = false,
    destroyed = false,
    step = 'READY',
    previousTask = null;
  function render() {
    if (destroyed) return;
    const snapshot = store.getSnapshot();
    const model = store.getOperationsByUldId(ULD_DEMO_TARGET);
    const task = model?.task;
    find('task-id').textContent = task?.taskId ?? '—';
    connection.textContent = formatUldValue(
      'connectionStatus',
      snapshot.connectionStatus,
    );
    connection.dataset.connectionStatus = snapshot.connectionStatus;
    status.textContent = task ? formatDispatchStatus(task.status) : '—';
    status.dataset.taskStatus = task?.status ?? '';
    if (task && JSON.stringify(task) !== previousTask) {
      previousTask = JSON.stringify(task);
      taskFields.replaceChildren();
      for (const [label, value] of getTaskFields(task)) {
        const term = doc.createElement('dt'),
          description = doc.createElement('dd');
        term.textContent = label;
        description.textContent = value ?? '—';
        taskFields.append(term, description);
      }
    }
    const disabled =
      busy ||
      !model?.presentation.demoEnabled ||
      snapshot.connectionStatus !== 'CONNECTED';
    for (const button of Object.values(buttons)) button.disabled = disabled;
    buttons.activate.disabled ||= task?.status === 'ACTIVE';
    buttons.clear.disabled ||= task?.status !== 'ACTIVE';
    container.setAttribute('aria-busy', String(busy));
    progress.textContent = formatOperationsStep(step);
    progress.dataset.demoStep = step;
  }
  for (const [name, action] of Object.entries(actions)) {
    const click = async () => {
      if (busy || destroyed || buttons[name].disabled) return;
      busy = true;
      error.hidden = true;
      render();
      try {
        await action(store.getOperationsByUldId(ULD_DEMO_TARGET)?.task);
      } catch {
        if (!destroyed) {
          step = 'ERROR';
          error.textContent = formatOperationsStep('ERROR');
          error.hidden = false;
        }
      } finally {
        busy = false;
        render();
      }
    };
    buttons[name].addEventListener('click', click);
    listeners.push(() => buttons[name].removeEventListener('click', click));
  }
  const unsubscribe = store.subscribe(render);
  return {
    setStep(value) {
      step = value;
      render();
    },
    destroy() {
      destroyed = true;
      unsubscribe();
      listeners.forEach((remove) => remove());
    },
  };
}
