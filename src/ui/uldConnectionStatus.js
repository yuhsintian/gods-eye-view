import { formatUldValue } from './uldPresentation.js';

export function mountUldConnectionStatus({ container, store }) {
  const unsubscribe = store.subscribe(({ connectionStatus }) => {
    container.textContent = formatUldValue(
      'connectionStatus',
      connectionStatus,
    );
    container.dataset.connectionStatus = connectionStatus;
  });
  return { destroy: unsubscribe };
}
