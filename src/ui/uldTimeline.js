import { t } from '../i18n/index.js';
import { ULD_TIMELINE_LIMIT } from '../uld/operationsProjection.js';
import { presentCanonicalEvent } from './uldOperationsPresentation.js';

/** Keyed, bounded canonical event projection. Refresh/reconnect never append duplicates. */
export function mountUldTimeline({ container, store }) {
  const doc = container.ownerDocument;
  const list = container.querySelector('[data-uld-timeline-list]');
  const empty = container.querySelector('[data-uld-timeline-empty]');
  const selected = container.querySelector('[data-uld-timeline-selected]');
  const cards = new Map();
  const unsubscribe = store.subscribe(({ selectedUldId }) => {
    selected.textContent = selectedUldId ?? '—';
    const model = store.getOperationsByUldId(selectedUldId);
    const events = (model?.events ?? [])
      .filter((event) => event.uldId === selectedUldId)
      .slice(0, ULD_TIMELINE_LIMIT);
    empty.hidden = events.length > 0;
    empty.textContent = selectedUldId
      ? t('No recent events for this ULD')
      : t('No ULD selected');
    const ids = new Set(events.map((event) => event.eventId));
    for (const [id, card] of cards)
      if (!ids.has(id)) {
        card.element.remove();
        cards.delete(id);
      }
    events.forEach((event, index) => {
      let card = cards.get(event.eventId);
      if (!card) {
        const element = doc.createElement('li');
        element.className = 'uld-timeline-card';
        element.dataset.eventId = event.eventId;
        card = { element, signature: null };
        cards.set(event.eventId, card);
      }
      const signature = JSON.stringify(event);
      if (card.signature !== signature) {
        card.signature = signature;
        card.element.replaceChildren();
        const view = presentCanonicalEvent(event);
        for (const [tag, text] of [
          ['strong', view.type],
          ['time', view.time],
          ['p', view.location],
          ['small', view.evidence],
        ]) {
          const node = doc.createElement(tag);
          node.textContent = text;
          if (tag === 'time') node.setAttribute('datetime', event.occurredAt);
          card.element.appendChild(node);
        }
        for (const decision of view.decisions) {
          const block = doc.createElement('div');
          block.className = 'uld-rule-decision';
          if (decision.level) block.dataset.alertLevel = decision.level;
          for (const text of [
            decision.rule,
            decision.outcome,
            decision.reason,
            decision.code,
          ]) {
            const line = doc.createElement('span');
            line.textContent = text;
            block.appendChild(line);
          }
          card.element.appendChild(block);
        }
      }
      if (list.children[index] !== card.element)
        list.insertBefore(card.element, list.children[index] ?? null);
    });
  });
  return {
    destroy() {
      unsubscribe();
      cards.clear();
    },
  };
}

export function mountUldContextTabs({ container }) {
  const buttons = ['detail', 'timeline'].map((name) =>
    container.querySelector(`[data-uld-tab="${name}"]`),
  );
  const views = ['detail', 'timeline'].map((name) =>
    container.querySelector(`[data-uld-view="${name}"]`),
  );
  function show(name) {
    buttons.forEach((button, index) => {
      const active = button.dataset.uldTab === name;
      button.setAttribute('aria-pressed', String(active));
      views[index].hidden = !active;
    });
  }
  const clicks = buttons.map((button) => () => show(button.dataset.uldTab));
  buttons.forEach((button, index) =>
    button.addEventListener('click', clicks[index]),
  );
  show('detail');
  return {
    show,
    destroy() {
      buttons.forEach((button, index) =>
        button.removeEventListener('click', clicks[index]),
      );
    },
  };
}
