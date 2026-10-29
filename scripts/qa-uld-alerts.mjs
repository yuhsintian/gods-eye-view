#!/usr/bin/env node
/** Real-browser acceptance for the local movement scenario and shared alert UI. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const urlArg = process.argv.indexOf('--url');
const baseUrl =
  urlArg >= 0 ? process.argv[urlArg + 1] : 'http://localhost:4173';
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /ULD store listener failed/.test(message.text())
    )
      errors.push(message.text());
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    // Fonts are irrelevant to domain/UI behavior and may block offline QA.
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(host))
      request.abort();
    else request.continue();
  });
  await page.goto(`${baseUrl}/?lang=zh-TW&welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager?.isEnabled('uld') &&
      document.querySelector('[data-uld-connection]')?.dataset
        .connectionStatus === 'CONNECTED',
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const script = [...document.scripts].find((s) =>
      /\/src\/main\.js(?:\?|$)/.test(s.src),
    );
    const { application } = await import(script.src);
    await application.start();
    const { data, scene, controls } = application.getComponents();
    window.__uldAlertQa = {
      application,
      data,
      viewer: scene.viewer,
      styleManager: controls.styleManager,
    };
    scene.viewer.targetFrameRate = 10;
    scene.viewer.resolutionScale = 0.6;
    for (const id of ['uld-alert-panel', 'uld-detail-panel'])
      controls.styleManager.setPanelCollapsed(id, false, {
        persist: false,
        syncShare: false,
      });
    const source = scene.viewer.dataSources.getByName('uld')[0];
    const entity = source.entities.getById('uld:AKE12345CI');
    window.__uldAlertQa.resources = { source, entity, point: entity.point };
  });
  const state = () =>
    page.evaluate(() => {
      const { data, viewer, resources } = window.__uldAlertQa;
      const store = data.catalog.uldStore;
      const source = viewer.dataSources.getByName('uld')[0];
      const entity = source.entities.getById('uld:AKE12345CI');
      return {
        uld: store.getUldById('AKE12345CI'),
        active: store.getActiveAlerts(),
        selected: store.getSnapshot().selectedUldId,
        color: entity.point.color.getValue().toCssColorString(),
        sameResources:
          source === resources.source &&
          entity === resources.entity &&
          entity.point === resources.point,
        layerEnabled: data.dataManager.isEnabled('uld'),
      };
    });
  assert.equal((await state()).active.length, 0);
  assert.match(
    await page.$eval('[data-uld-alert-empty]', (el) => el.textContent),
    /目前無啟用中的告警/,
  );
  await page.click('[data-uld-focus]');
  await page.waitForFunction(
    () => !document.querySelector('[data-uld-focus]').disabled,
    { timeout: 60000 },
  );
  await page.click('[data-uld-simulate]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-alert-id]').length === 1,
  );
  let snapshot = await state();
  assert.equal(snapshot.uld.zoneId, 'EXIT-A');
  assert.equal(snapshot.uld.operationalStatus, 'MOVING');
  assert.equal(snapshot.color, 'rgb(255,189,74)');
  assert.equal(snapshot.sameResources, true);
  assert.equal(snapshot.active[0].type, 'UNAUTHORIZED_MOVEMENT');
  const cardText = await page.$eval('[data-alert-id]', (el) => el.textContent);
  for (const text of [
    '警告 WARNING',
    '未授權 ULD 移動',
    'Unauthorized Movement',
    'AKE12345CI',
    'STORAGE-A → EXIT-A',
  ])
    assert.ok(cardText.includes(text), text);
  await page.evaluate(() => {
    window.__uldAlertQa.oldAlert =
      window.__uldAlertQa.data.catalog.uldStore.getActiveAlerts()[0];
  });
  await page.click('[data-uld-simulate]');
  assert.equal((await state()).active.length, 1);
  await page.click('[data-alert-id]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-field="uldId"]')?.textContent ===
      'AKE12345CI',
  );
  assert.equal((await state()).selected, 'AKE12345CI');
  assert.equal(
    await page.$eval('[data-uld-field="zoneId"]', (el) => el.textContent),
    'EXIT-A',
  );
  assert.equal(
    await page.$eval('[data-uld-field="alertLevel"]', (el) => el.textContent),
    '警告 WARNING',
  );
  console.log(
    'PASS: simulate, WARNING card, selected ULD/detail and stable Cesium resources',
  );

  await page.click('[data-uld-reset]');
  await page.waitForFunction(
    () => !document.querySelector('[data-uld-alert-empty]').hidden,
  );
  snapshot = await state();
  assert.equal(snapshot.active.length, 0);
  assert.equal(snapshot.uld.zoneId, 'STORAGE-A');
  assert.equal(snapshot.uld.operationalStatus, 'AVAILABLE');
  assert.equal(snapshot.color, 'rgb(67,217,176)');
  assert.equal(snapshot.sameResources, true);
  assert.equal(snapshot.selected, 'AKE12345CI');
  assert.equal(
    await page.$eval('[data-uld-field="zoneId"]', (el) => el.textContent),
    'STORAGE-A',
  );
  assert.equal(
    await page.evaluate(() =>
      window.__uldAlertQa.data.catalog.uldStore.upsertAlert(
        window.__uldAlertQa.oldAlert,
      ),
    ),
    false,
  );
  console.log(
    'PASS: reset without reload, green marker, current detail and stale-alert rejection',
  );

  await page.click('[data-uld-simulate]');
  await page.evaluate(() =>
    window.__uldAlertQa.data.dataManager.setEnabled('uld', false),
  );
  assert.equal(
    (await state()).active.length,
    1,
    'alerts do not depend on marker visibility',
  );
  await page.click('[data-alert-id]');
  await page.waitForFunction(
    () =>
      window.__uldAlertQa.data.dataManager.isEnabled('uld') &&
      window.__uldAlertQa.data.catalog.uldStore.getSnapshot().selectedUldId ===
        'AKE12345CI',
  );
  assert.equal((await state()).layerEnabled, true);
  await page.click('[data-uld-reset]');
  const detachedSimulate = await page.$('[data-uld-simulate]');
  await page.evaluate(() => window.__uldAlertQa.application.destroy());
  assert.equal(
    await page.evaluate(() => window.__uldAlertQa.viewer.isDestroyed()),
    true,
  );
  await detachedSimulate.evaluate((button) => button.click());
  assert.deepEqual(errors, []);
  console.log(
    'PASS: alert re-enables hidden layer; application cleanup; no uncaught browser errors',
  );
} finally {
  await browser.close();
}
