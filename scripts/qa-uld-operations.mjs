#!/usr/bin/env node
/** Operator-only synthetic Observation presentation QA. No Windows BLE hardware. */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const index = process.argv.indexOf('--url');
const origin = new URL(
  index >= 0 ? process.argv[index + 1] : 'http://localhost:4173',
).origin;
const uid = 'AKE12345CI';
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  let documents = 0;
  const errors = [],
    requests = [],
    observations = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    // Exercise the secure-random fallback available on plain-HTTP VM origins.
    Object.defineProperty(window.crypto, 'randomUUID', { value: undefined });
    window.__operationsSockets = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (String(args[0]).endsWith('/ws/uld'))
          window.__operationsSockets.push(this);
      }
    };
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents++;
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/uld/')) requests.push(url.pathname);
    if (url.pathname === '/api/uld/observations' && request.method() === 'POST')
      observations.push(JSON.parse(request.postData()));
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname))
      request.abort();
    else request.continue();
  });
  await page.goto(`${origin}/?lang=zh-TW&welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-connection]')?.dataset
        .connectionStatus === 'CONNECTED' && window.__godsEyeView,
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const entry = [...document.scripts].find((script) =>
      /\/src\/main\.js(?:\?|$)/.test(script.src),
    );
    const { application } = await import(entry.src);
    const { data, scene, controls } = application.getComponents();
    scene.viewer.targetFrameRate = 5;
    scene.viewer.resolutionScale = 0.4;
    for (const id of ['uld-alert-panel', 'uld-detail-panel'])
      controls.styleManager.setPanelCollapsed(id, false, {
        persist: false,
        syncShare: false,
      });
    const source = scene.viewer.dataSources.getByName('uld')[0];
    window.__m7 = {
      application,
      store: data.catalog.uldStore,
      viewer: scene.viewer,
      source,
      entity: source.entities.getById('uld:AKE12345CI'),
      token: Math.random(),
    };
  });
  const token = await page.evaluate(() => window.__m7.token);
  const ready = () =>
    page.waitForFunction(
      () => !document.querySelector('[data-uld-ops-normal]').disabled,
      { timeout: 60000 },
    );
  async function click(selector) {
    await page.$eval(selector, (element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    // The existing rail clips partially visible rows; wait for the real hit
    // target and use physical pointer input after scrolling has settled.
    await page.waitForFunction(
      (query) => {
        const element = document.querySelector(query);
        if (!element || element.disabled) return false;
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return hit && element.contains(hit);
      },
      { timeout: 30000 },
      selector,
    );
    const point = await page.$eval(selector, (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y);
  }
  async function reset() {
    await ready();
    await click('[data-uld-ops-reset]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-uld-ops-progress]').dataset.demoStep ===
          'RESET_COMPLETE' &&
        !document.querySelector('[data-uld-ops-reset]').disabled,
      { timeout: 30000 },
    );
    assert.equal(
      await page.evaluate(
        () => window.__m7.store.getUldById('AKE12345CI').zoneId,
      ),
      'STORAGE-A',
    );
    assert.equal(
      await page.$$eval('[data-event-id]', (items) => items.length),
      0,
    );
    assert.equal(await page.$('[data-alert-id]'), null);
  }
  await ready();
  await reset();
  await click('.uld-task-details summary');
  await click('[data-uld-ops-activate]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-ops-task-status]').dataset
        .taskStatus === 'ACTIVE' &&
      !document.querySelector('[data-uld-ops-clear]').disabled,
  );
  await click('[data-uld-ops-clear]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-ops-task-status]').dataset
        .taskStatus === 'INACTIVE' &&
      !document.querySelector('[data-uld-ops-activate]').disabled,
  );
  await click('.uld-task-details summary');
  console.log('PASS task activate/clear: Backend context -> Store -> UI');
  await click('[data-uld-focus]');
  await page.waitForFunction(
    () => !document.querySelector('[data-uld-focus]').disabled,
    { timeout: 60000 },
  );
  for (const mode of ['normal', 'unauthorized', 'normal', 'unauthorized']) {
    await ready();
    await click(`[data-uld-ops-${mode}]`);
    await page.waitForFunction(
      (warning) => {
        const progress = document.querySelector('[data-uld-ops-progress]');
        return (
          progress.dataset.demoStep ===
            (warning ? 'COMPLETED_WARNING' : 'COMPLETED_NORMAL') &&
          !document.querySelector('[data-uld-ops-normal]').disabled &&
          !document.querySelector('[data-uld-view="timeline"]').hidden
        );
      },
      { timeout: 60000 },
      mode === 'unauthorized',
    );
    const state = await page.evaluate(() => {
      const { store, source, entity, viewer } = window.__m7;
      const model = store.getOperationsByUldId('AKE12345CI');
      return {
        record: store.getUldById('AKE12345CI'),
        task: model.task,
        events: model.events,
        alerts: store.getActiveAlerts(),
        timeline: document.querySelector('[data-uld-view="timeline"]')
          .textContent,
        color: entity.point.color.getValue().toCssColorString(),
        stable:
          source === viewer.dataSources.getByName('uld')[0] &&
          entity === source.entities.getById(entity.id),
        count: document.querySelectorAll('[data-event-id]').length,
      };
    });
    const warning = mode === 'unauthorized';
    assert.equal(state.record.zoneId, 'EXIT-A');
    assert.equal(state.record.positionSource, 'READER_ZONE_INFERENCE');
    assert.equal(state.record.alertLevel, warning ? 'WARNING' : 'NORMAL');
    assert.equal(state.task.status, warning ? 'INACTIVE' : 'ACTIVE');
    assert.equal(
      state.alerts.some((alert) => alert.type === 'UNAUTHORIZED_MOVEMENT'),
      warning,
    );
    const movement = state.events.find((event) => event.eventType === 'MOVED');
    const decision = movement.decisions.find(
      (item) => item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT',
    );
    assert.equal(decision.matched, warning);
    assert.match(state.timeline, warning ? /無有效派遣任務/ : /有效派遣任務/);
    assert.match(state.timeline, new RegExp(decision.reasonCode));
    assert.equal(state.count, state.events.length);
    assert.ok(state.count <= 15);
    assert.equal(state.stable, true);
    assert.equal(state.color, warning ? 'rgb(255,189,74)' : 'rgb(67,217,176)');
    await page.$eval('.uld-rule-decision', (node) =>
      node.scrollIntoView({ block: 'nearest' }),
    );
    if (warning)
      await page.$eval('[data-alert-id]', (node) =>
        node.scrollIntoView({ block: 'start' }),
      );
    await page.screenshot({ path: join(tmpdir(), `uld-m7-${mode}.png`) });
    console.log(
      `PASS ${mode}: MOVED, ${decision.reasonCode}, ${state.count} canonical events, stable marker, no reload`,
    );
  }
  assert.equal(observations.length, 16);
  assert.equal(
    new Set(observations.map((item) => item.observationId)).size,
    16,
  );
  assert.equal(
    observations.some((item) => item.sequence !== undefined),
    false,
  );
  await click('[data-alert-id]');
  await page.waitForFunction(
    () => !document.querySelector('[data-uld-view="detail"]').hidden,
  );
  assert.equal(
    await page.$eval('[data-uld-field="zoneId"]', (node) => node.textContent),
    'EXIT-A',
  );
  await click('[data-uld-tab="timeline"]');
  await page.evaluate(() => {
    window.__m7.oldTimelineIds = [
      ...document.querySelectorAll('[data-event-id]'),
    ].map((node) => node.dataset.eventId);
    window.__m7.oldSocketCount = window.__operationsSockets.length;
    window.__operationsSockets.at(-1).close();
  });
  await page.waitForFunction(
    () =>
      window.__operationsSockets.length > window.__m7.oldSocketCount &&
      window.__m7.store.getSnapshot().connectionStatus === 'CONNECTED' &&
      window.__m7.store.getOperationsByUldId('AKE12345CI')?.events.length > 0,
    { timeout: 30000 },
  );
  assert.deepEqual(
    await page.$$eval('[data-event-id]', (items) =>
      items.map((item) => item.dataset.eventId),
    ),
    await page.evaluate(() => window.__m7.oldTimelineIds),
  );
  await page.evaluate(() => window.__m7.store.selectUld('AKE67890CI'));
  await page.waitForFunction(
    () => document.querySelectorAll('[data-event-id]').length === 0,
  );
  await page.evaluate(() => window.__m7.store.selectUld('AKE12345CI'));
  await page.waitForFunction(
    () => document.querySelectorAll('[data-event-id]').length > 0,
  );
  const layout = await page.evaluate(() => {
    const boxes = ['uld-alert-panel', 'uld-detail-panel'].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    const selectors = [
      '[data-uld-ops-normal]',
      '[data-uld-ops-task-status]',
      '.uld-system-status',
      '.uld-timeline-card > strong',
      '.uld-timeline-card time',
    ];
    const typography = selectors.map((selector) => {
      const node = document.querySelector(selector);
      const s = getComputedStyle(node);
      return {
        selector,
        size: parseFloat(s.fontSize),
        leading: parseFloat(s.lineHeight) / parseFloat(s.fontSize),
        overflow: node.scrollWidth > node.clientWidth + 2,
      };
    });
    return {
      boxes,
      typography,
      bodyOverflow: document.body.scrollWidth > innerWidth,
    };
  });
  for (const box of layout.boxes)
    assert.ok(
      box.left >= 0 && box.right <= 1366 && box.top >= 0 && box.bottom <= 768,
      JSON.stringify(box),
    );
  assert.ok(layout.boxes[0].right <= layout.boxes[1].left);
  assert.equal(layout.bodyOverflow, false);
  for (const typography of layout.typography) {
    assert.ok(
      typography.size >= 14 && typography.leading >= 1.4,
      JSON.stringify(typography),
    );
    assert.equal(typography.overflow, false, typography.selector);
  }
  assert.equal(
    requests.includes('/api/uld/events/recent'),
    false,
    'UI never reads dev diagnostics',
  );
  assert.equal(
    requests.includes('/api/uld/demo/unauthorized-movement'),
    false,
    'new demos use inference path',
  );
  assert.match(
    await page.$eval('.uld-system-status', (node) => node.textContent),
    /模擬 Observation · DEMO OBSERVATION/,
  );
  await reset();
  assert.equal(await page.evaluate(() => window.__m7.token), token);
  assert.equal(documents, 1);
  await page.evaluate(() => window.__m7.application.destroy());
  assert.deepEqual(errors, []);
  console.log(
    'PASS reset, repeat IDs, reconnect without duplicates, selected ULD filter, 1366x768 readability, no overlap, no reload. PENDING PHYSICAL WINDOWS TEST.',
  );
} catch (error) {
  const page = (await browser.pages()).at(-1);
  console.error(
    'BROWSER STATE',
    await page.evaluate(() => ({
      step: document.querySelector('[data-uld-ops-progress]')?.outerHTML,
      error: document.querySelector('[data-uld-ops-error]')?.outerHTML,
      task: document.querySelector('[data-uld-ops-task-status]')?.outerHTML,
    })),
  );
  await page.screenshot({ path: join(tmpdir(), 'uld-m7-failure.png') });
  throw error;
} finally {
  await browser.close();
}
