import { t } from '../i18n/index.js';
import { getUldAlertPresentation } from './uldPresentation.js';

/** Source-independent, keyed view over the shared ULD store. */
export function mountUldAlertPanel({ container, store, onSelectUld }) {
  const documentRef = container.ownerDocument;
  const list = container.querySelector('[data-uld-alert-list]');
  const empty = container.querySelector('[data-uld-alert-empty]');
  const count = container.querySelector('[data-uld-alert-count]');
  const error = container.querySelector('[data-uld-alert-error]');
  const cards = new Map();
  let destroyed = false;
  let selectionGeneration = 0;
  const unsubscribe = store.subscribe(() => {
    const alerts = store
      .getActiveAlerts()
      .slice()
      .sort(
        (a, b) =>
          b.occurredAt.localeCompare(a.occurredAt) ||
          a.alertId.localeCompare(b.alertId),
      );
    const activeIds = new Set(alerts.map((alert) => alert.alertId));
    empty.hidden = alerts.length > 0;
    count.textContent = String(alerts.length);
    for (const [id, card] of cards) {
      if (!activeIds.has(id)) {
        card.button.remove();
        cards.delete(id);
      }
    }
    alerts.forEach((alert, index) => {
      let card = cards.get(alert.alertId);
      if (!card) {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = 'uld-alert-card panel-surface-control';
        button.dataset.alertId = alert.alertId;
        const fields = {};
        for (const name of [
          'level',
          'title',
          'englishType',
          'uldId',
          'transition',
          'occurredAt',
          'status',
          'message',
        ]) {
          fields[name] = documentRef.createElement('span');
          fields[name].dataset.alertField = name;
          if (name === 'englishType')
            fields[name].setAttribute('translate', 'no');
          button.appendChild(fields[name]);
        }
        card = { button, fields };
        cards.set(alert.alertId, card);
      }
      const presentation = {
        ...getUldAlertPresentation(alert),
        uldId: alert.uldId,
      };
      card.button.dataset.alertLevel = alert.level;
      for (const [name, field] of Object.entries(card.fields)) {
        if (field.textContent !== presentation[name])
          field.textContent = presentation[name];
        field.hidden = !presentation[name];
      }
      // Preserve focus and native button identity on ordinary store updates.
      if (list.children[index] !== card.button)
        list.insertBefore(card.button, list.children[index] ?? null);
    });
  });
  const onClick = async (event) => {
    const button = event.target.closest('[data-alert-id]');
    if (!button || !list.contains(button)) return;
    const alert = store.getAlertById(button.dataset.alertId);
    if (!alert || alert.status === 'RESOLVED') return;
    const generation = ++selectionGeneration;
    error.hidden = true;
    try {
      await onSelectUld(alert.uldId);
    } catch {
      if (!destroyed && generation === selectionGeneration) {
        error.textContent = t('Could not focus the alert ULD.');
        error.hidden = false;
      }
    }
  };
  list.addEventListener('click', onClick);
  return {
    destroy() {
      destroyed = true;
      selectionGeneration++;
      unsubscribe();
      list.removeEventListener('click', onClick);
      cards.clear();
    },
  };
}
