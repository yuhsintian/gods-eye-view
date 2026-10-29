#!/usr/bin/env node
/** Synthetic terminal Observation -> real HTTP/WS -> Browser; no BLE hardware. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer';

const run = promisify(execFile);
const index = process.argv.indexOf('--url');
const origin = new URL(
  index >= 0 ? process.argv[index + 1] : 'http://localhost:4173',
).origin;
async function post(path, value) {
  const args = [
    '--noproxy',
    '*',
    '--fail',
    '--silent',
    '--show-error',
    '-X',
    'POST',
  ];
  if (value)
    args.push(
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      JSON.stringify(value),
    );
  const { stdout } = await run('curl', [...args, `${origin}${path}`]);
  const result = JSON.parse(stdout);
  console.log('TERMINAL POST', path, JSON.stringify(result));
  return result;
}
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  await post('/api/uld/demo/reset');
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  const errors = [];
  let documents = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents++;
    if (
      ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(
        new URL(request.url()).hostname,
      )
    )
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
  const before = await page.evaluate(async () => {
    const entry = [...document.scripts].find((script) =>
      /\/src\/main\.js(?:\?|$)/.test(script.src),
    );
    const { application } = await import(entry.src);
    const { data, scene, controls } = application.getComponents();
    scene.viewer.targetFrameRate = 5;
    scene.viewer.resolutionScale = 0.4;
    const store = data.catalog.uldStore;
    store.selectUld('AKE12345CI');
    for (const id of ['uld-alert-panel', 'uld-detail-panel'])
      controls.styleManager.setPanelCollapsed(id, false, {
        persist: false,
        syncShare: false,
      });
    const source = scene.viewer.dataSources.getByName('uld')[0];
    const entity = source.entities.getById('uld:AKE12345CI');
    window.__m5 = {
      application,
      store,
      viewer: scene.viewer,
      source,
      entity,
      point: entity.point,
      token: Math.random(),
    };
    return { record: store.getUldById('AKE12345CI'), token: window.__m5.token };
  });
  await page.click('[data-uld-focus]');
  await page.waitForFunction(
    () => !document.querySelector('[data-uld-focus]').disabled,
    { timeout: 60000 },
  );
  const observation = {
    observationId: `obs-qa-${randomUUID()}`,
    tagId: 'TAG001',
    readerId: 'QA-MANUAL-NO-HARDWARE',
    rssi: -61,
    observedAt: new Date(
      Math.max(Date.now(), Date.parse(before.record.lastSeenAt) + 1000),
    ).toISOString(),
    sourceType: 'BLE',
  };
  const accepted = await post('/api/uld/observations', observation);
  assert.equal(accepted.updated, true);
  assert.equal(accepted.uldId, 'AKE12345CI');
  await page.waitForFunction(
    (time) => window.__m5.store.getUldById('AKE12345CI').lastSeenAt === time,
    { timeout: 30000 },
    observation.observedAt,
  );
  const after = await page.evaluate(async () => {
    const { formatUldValue } = await import('/src/ui/uldPresentation.js');
    const { store, viewer, source, entity, point } = window.__m5;
    const record = store.getUldById('AKE12345CI');
    return {
      record,
      displayed: document.querySelector('[data-uld-field="lastSeenAt"]')
        .textContent,
      expected: formatUldValue('lastSeenAt', record.lastSeenAt),
      stable:
        viewer.dataSources.getByName('uld')[0] === source &&
        source.entities.getById(entity.id) === entity &&
        entity.point === point,
      color: point.color.getValue().toCssColorString(),
      alerts: store.getActiveAlerts().length,
    };
  });
  assert.equal(after.displayed, after.expected);
  assert.equal(after.record.revision, before.record.revision + 1);
  assert.deepEqual(
    {
      ...after.record,
      lastSeenAt: before.record.lastSeenAt,
      revision: before.record.revision,
    },
    before.record,
  );
  assert.equal(after.stable, true);
  assert.equal(after.color, 'rgb(67,217,176)');
  assert.equal(after.alerts, 0);
  const duplicate = await post('/api/uld/observations', observation);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.streamRevision, accepted.streamRevision);
  const older = await post('/api/uld/observations', {
    ...observation,
    observationId: `obs-qa-${randomUUID()}`,
    observedAt: new Date(
      Date.parse(observation.observedAt) - 1000,
    ).toISOString(),
  });
  assert.equal(older.updated, false);
  assert.equal(older.streamRevision, accepted.streamRevision);
  const unknown = await post('/api/uld/observations', {
    ...observation,
    observationId: `obs-qa-${randomUUID()}`,
    tagId: 'UNKNOWN-QA',
  });
  assert.equal(unknown.mapped, false);
  const snapshot = await (await fetch(`${origin}/api/uld/snapshot`)).json();
  assert.equal(
    snapshot.ulds.find((r) => r.uldId === 'AKE12345CI').lastSeenAt,
    observation.observedAt,
  );
  const recent = await (
    await fetch(`${origin}/api/uld/observations/recent`)
  ).json();
  assert.ok(
    recent.observations.some(
      (o) =>
        o.observationId === observation.observationId &&
        o.readerId === 'QA-MANUAL-NO-HARDWARE',
    ),
  );
  await page.$eval('[data-uld-field="lastSeenAt"]', (node) =>
    node.scrollIntoView({ block: 'nearest' }),
  );
  await page.screenshot({ path: join(tmpdir(), 'uld-m5-observation.png') });
  console.log(
    'PASS: terminal Observation -> HTTP/WS/Store/Last Seen; no position/business/alert changes; dedupe/older/unknown protected',
  );

  await post('/api/uld/demo/unauthorized-movement');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-field="zoneId"]')?.textContent ===
        'EXIT-A' && document.querySelector('[data-alert-id]'),
    { timeout: 30000 },
  );
  assert.equal(
    await page.$eval(
      '[data-uld-field="operationalStatus"]',
      (node) => node.textContent,
    ),
    '移動中 MOVING',
  );
  assert.equal(
    await page.evaluate(() =>
      window.__m5.point.color.getValue().toCssColorString(),
    ),
    'rgb(255,189,74)',
  );
  await post('/api/uld/demo/reset');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-field="zoneId"]')?.textContent ===
        'STORAGE-A' && !document.querySelector('[data-alert-id]'),
    { timeout: 30000 },
  );
  assert.equal(
    await page.$eval(
      '[data-uld-field="operationalStatus"]',
      (node) => node.textContent,
    ),
    '可用 AVAILABLE',
  );
  assert.equal(
    await page.evaluate(() =>
      window.__m5.point.color.getValue().toCssColorString(),
    ),
    'rgb(67,217,176)',
  );
  assert.equal(await page.evaluate(() => window.__m5.token), before.token);
  assert.equal(documents, 1, 'no reload during Observation or Demo actions');
  await page.evaluate(() => window.__m5.application.destroy());
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Demo movement/reset still update Browser without reload; PENDING PHYSICAL WINDOWS TEST',
  );
} finally {
  await browser.close();
}
