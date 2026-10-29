import { t } from '../i18n/index.js';
import {
  formatUldValue,
  getUldFields,
  getUldLegend,
} from './uldPresentation.js';

/** DOM-only view subscribed to the exact store used by the ULD layer. */
export function mountUldDetailPanel({
  container,
  store,
  focusDemo,
  openPanel,
}) {
  const documentRef = container.ownerDocument;
  const button = container.querySelector('[data-uld-focus]');
  const content = container.querySelector('[data-uld-detail]');
  const error = container.querySelector('[data-uld-error]');
  const positionSource = container.querySelector('[data-uld-position-source]');
  container.querySelector('[data-uld-legend]').textContent = getUldLegend();
  let destroyed = false;
  const unsubscribe = store.subscribe(({ selectedUldId }, change) => {
    const record = store.getUldById(selectedUldId);
    if (positionSource)
      positionSource.textContent = formatUldValue(
        'positionSource',
        record?.positionSource ?? 'CONFIGURED_DEMO',
      );
    content.replaceChildren();
    if (!record) {
      const empty = documentRef.createElement('p');
      empty.textContent = t('No ULD selected');
      content.appendChild(empty);
    } else {
      const fields = documentRef.createElement('dl');
      fields.className = 'uld-detail-fields';
      for (const [key, label] of getUldFields()) {
        const term = documentRef.createElement('dt');
        term.textContent = label;
        const value = documentRef.createElement('dd');
        value.dataset.uldField = key;
        value.textContent = formatUldValue(key, record[key]);
        if (
          ['operationalStatus', 'serviceabilityStatus', 'alertLevel'].includes(
            key,
          )
        )
          value.classList.add('uld-status-badge');
        if (key === 'alertLevel') value.dataset.alertLevel = record.alertLevel;
        fields.append(term, value);
      }
      const provenance = documentRef.createElement('p');
      provenance.className = 'uld-demo-notice';
      provenance.textContent = formatUldValue(
        'positionSource',
        record.positionSource,
      );
      content.append(fields, provenance);
    }
    if (selectedUldId && change?.type === 'selection') openPanel();
  });
  const onFocus = async () => {
    button.disabled = true;
    error.hidden = true;
    try {
      await focusDemo();
    } catch {
      if (!destroyed) {
        error.textContent = t('Could not show ULD demo.');
        error.hidden = false;
      }
    } finally {
      if (!destroyed) button.disabled = false;
    }
  };
  button.addEventListener('click', onFocus);
  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      button.removeEventListener('click', onFocus);
    },
  };
}
