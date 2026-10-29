const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new TypeError(`Invalid dispatch ${name}`);
  return value.trim();
};

export function createOperationalContext({ getUldById }) {
  const contexts = new Map();
  function known(uldId) {
    const record = getUldById(text(uldId, 'uldId'));
    if (!record) throw new TypeError('Unknown dispatch ULD');
    return record;
  }
  return Object.freeze({
    getDispatchContext(uldId) {
      return (
        contexts.get(uldId) ??
        Object.freeze({
          uldId,
          active: false,
          taskId: null,
          flight: null,
          destination: null,
          requiredUldType: null,
        })
      );
    },
    activate(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new TypeError('Dispatch object required');
      const uld = known(raw.uldId);
      const context = Object.freeze({
        uldId: uld.uldId,
        active: true,
        taskId: text(raw.taskId, 'taskId'),
        flight: text(raw.flight, 'flight'),
        destination: text(raw.destination, 'destination'),
        requiredUldType: text(
          raw.requiredUldType ?? uld.uldType,
          'requiredUldType',
        ),
      });
      contexts.set(uld.uldId, context);
      return context;
    },
    clear(raw) {
      const uld = known(raw?.uldId);
      contexts.delete(uld.uldId);
      return this.getDispatchContext(uld.uldId);
    },
    all: () => Object.freeze([...contexts.values()]),
    reset() {
      contexts.clear();
    },
  });
}
