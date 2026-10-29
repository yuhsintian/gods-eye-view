#!/usr/bin/env node
/** Synthetic HTTP + Browser A/B acceptance. PENDING PHYSICAL WINDOWS TEST. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const run = promisify(execFile);
const index = process.argv.indexOf('--url');
const origin = new URL(
  index >= 0 ? process.argv[index + 1] : 'http://localhost:4173',
).origin;
async function post(path, body) {
  const args = [
    '--noproxy',
    '*',
    '--fail',
    '--silent',
    '--show-error',
    '-X',
    'POST',
  ];
  if (body)
    args.push(
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      JSON.stringify(body),
    );
  const { stdout } = await run('curl', [...args, `${origin}${path}`]);
  const result = JSON.parse(stdout);
  console.log('TERMINAL POST', path, JSON.stringify(result));
  return result;
}
async function get(path) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, path);
  return response.json();
}
const diagnostic = () => get('/api/uld/events/recent');
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  console.log(
    'SYNTHETIC HTTP ONLY. No Windows adapter or nRF hardware is exercised.',
  );
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
    const entity = source.entities.getById('uld:AKE12345CI');
    window.__m6 = {
      application,
      store: data.catalog.uldStore,
      viewer: scene.viewer,
      source,
      entity,
      point: entity.point,
      token: Math.random(),
    };
    data.catalog.uldStore.selectUld('AKE12345CI');
  });
  const token = await page.evaluate(() => window.__m6.token);
  await page.click('[data-uld-focus]');
  await page.waitForFunction(
    () => !document.querySelector('[data-uld-focus]').disabled,
    { timeout: 60000 },
  );

  async function scenario(authorized, label) {
    await post('/api/uld/demo/reset');
    await page.waitForFunction(
      () =>
        window.__m6.store.getUldById('AKE12345CI').positionSource ===
          'CONFIGURED_DEMO' && !document.querySelector('[data-alert-id]'),
      { timeout: 30000 },
    );
    const clean = await diagnostic();
    for (const key of [
      'events',
      'evidence',
      'inferredLocations',
      'ruleDecisions',
      'dispatchContexts',
    ])
      assert.deepEqual(clean[key], []);
    assert.equal(clean.policy.minObservations, 2);
    assert.equal(clean.policy.confirmationWindowMs, 5000);
    // Synthetic, ordered sighting times in the recent past: no device clock/sequence invented.
    let time = Date.now() - 5000;
    async function send(readerId, rssi) {
      time += 1000;
      return post('/api/uld/observations', {
        observationId: `synth-m6-${label}-${randomUUID()}`,
        tagId: 'TAG001',
        readerId,
        rssi,
        observedAt: new Date(time).toISOString(),
        sourceType: 'BLE',
      });
    }
    await send('TPE-STORAGE-GW-01', -45);
    assert.equal((await diagnostic()).inferredLocations.length, 0);
    await send('TPE-STORAGE-GW-01', -90);
    await page.waitForFunction(
      () =>
        window.__m6.store.getUldById('AKE12345CI').positionSource ===
        'READER_ZONE_INFERENCE',
      { timeout: 30000 },
    );
    const before = await page.evaluate(() => ({
      position: { ...window.__m6.store.getUldById('AKE12345CI').position },
      cartesian: {
        ...window.__m6.entity.position.getValue(
          window.__m6.viewer.clock.currentTime,
        ),
      },
    }));
    assert.equal(
      (await diagnostic()).events.filter((event) => event.eventType === 'MOVED')
        .length,
      0,
    );
    if (authorized) {
      const result = await post('/api/uld/demo/context/dispatch/activate', {
        uldId: 'AKE12345CI',
        taskId: 'TASK-CI152-01',
        flight: 'CI152',
        destination: 'KIX',
      });
      assert.equal(result.dispatchContext.requiredUldType, 'AKE');
    }
    await send('TPE-EXIT-GW-01', -45);
    assert.equal(
      (await get('/api/uld/snapshot')).ulds.find(
        (record) => record.uldId === 'AKE12345CI',
      ).zoneId,
      'STORAGE-A',
    );
    assert.equal(
      (await diagnostic()).events.filter((event) => event.eventType === 'MOVED')
        .length,
      0,
    );
    const accepted = await send('TPE-EXIT-GW-01', -90);
    await page.waitForFunction(
      (warning) => {
        const record = window.__m6.store.getUldById('AKE12345CI');
        return (
          record.zoneId === 'EXIT-A' &&
          record.alertLevel === (warning ? 'WARNING' : 'NORMAL') &&
          window.__m6.store
            .getActiveAlerts()
            .some((alert) => alert.type === 'UNAUTHORIZED_MOVEMENT') === warning
        );
      },
      { timeout: 30000 },
      !authorized,
    );
    const state = await diagnostic();
    const moved = state.events.filter((event) => event.eventType === 'MOVED');
    assert.equal(moved.length, 1);
    assert.equal(moved[0].fromZoneId, 'STORAGE-A');
    assert.equal(moved[0].toZoneId, 'EXIT-A');
    assert.equal(moved[0].source, 'OBSERVATION_INFERENCE');
    assert.equal(moved[0].evidenceObservationIds.length, 4);
    const decision = state.ruleDecisions.find(
      (item) => item.ruleId === 'RULE_UNAUTHORIZED_MOVEMENT',
    );
    assert.equal(decision.matched, !authorized);
    assert.equal(
      decision.reasonCode,
      authorized ? 'ACTIVE_DISPATCH_CONTEXT' : 'NO_ACTIVE_DISPATCH_CONTEXT',
    );
    assert.equal(decision.relatedEventId, moved[0].eventId);
    const display = await page.evaluate(() => {
      const { store, viewer, source, entity, point } = window.__m6;
      return {
        record: store.getUldById('AKE12345CI'),
        zone: document.querySelector('[data-uld-field="zoneId"]').textContent,
        provenance: document.querySelector('[data-uld-position-source]')
          .textContent,
        alerts: store.getActiveAlerts(),
        stable:
          viewer.dataSources.getByName('uld')[0] === source &&
          source.entities.getById(entity.id) === entity &&
          entity.point === point,
        color: point.color.getValue().toCssColorString(),
        cartesian: { ...entity.position.getValue(viewer.clock.currentTime) },
      };
    });
    assert.equal(display.zone, 'EXIT-A');
    assert.equal(display.provenance, '讀取器區域推論');
    assert.equal(display.record.positionSource, 'READER_ZONE_INFERENCE');
    assert.notDeepEqual(display.record.position, before.position);
    assert.notDeepEqual(
      display.cartesian,
      before.cartesian,
      'Cesium marker position updates with the Store',
    );
    assert.deepEqual(display.record.position, {
      longitude: 121.226,
      latitude: 25.074,
      height: 55,
    });
    assert.equal(display.stable, true);
    assert.equal(
      display.color,
      authorized ? 'rgb(67,217,176)' : 'rgb(255,189,74)',
    );
    if (!authorized)
      assert.match(
        await page.$eval('[data-alert-id]', (node) => node.textContent),
        /未授權 ULD 移動/,
      );
    else assert.equal(await page.$('[data-alert-id]'), null);
    const snapshot = await get('/api/uld/snapshot');
    assert.deepEqual(
      snapshot.ulds.find((record) => record.uldId === 'AKE12345CI'),
      display.record,
    );
    const boxes = await page.evaluate(() =>
      ['uld-detail-panel', 'uld-alert-panel'].map((id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
    for (const box of boxes)
      assert.ok(
        box.left >= 0 && box.right <= 1366 && box.top >= 0 && box.bottom <= 768,
      );
    assert.ok(
      boxes[0].left >= boxes[1].right || boxes[1].left >= boxes[0].right,
    );
    await page.$eval('[data-uld-field="zoneId"]', (node) =>
      node.scrollIntoView({ block: 'nearest' }),
    );
    if (!authorized)
      await page.$eval('[data-alert-field="title"]', (node) =>
        node.scrollIntoView({ block: 'nearest' }),
      );
    await page.screenshot({
      path: join(tmpdir(), `uld-m6-scenario-${label.toLowerCase()}.png`),
    });
    console.log(
      `PASS Scenario ${label}: MOVED STORAGE-A -> EXIT-A; unauthorized=${decision.matched}; reason=${decision.reasonCode}; stream=${accepted.streamRevision}`,
    );
    return { moved: moved[0], revision: snapshot.streamRevision };
  }
  const a = await scenario(false, 'A');
  const b = await scenario(true, 'B');
  assert.ok(
    b.revision > a.revision,
    'reset never rewinds the transport stream',
  );
  for (const key of [
    'eventType',
    'fromStationId',
    'fromZoneId',
    'toStationId',
    'toZoneId',
    'source',
  ])
    assert.equal(a.moved[key], b.moved[key]);
  const finalReset = await post('/api/uld/demo/reset');
  assert.ok(finalReset.streamRevision > b.revision);
  await page.waitForFunction(
    () =>
      window.__m6.store.getUldById('AKE12345CI').positionSource ===
        'CONFIGURED_DEMO' && !document.querySelector('[data-alert-id]'),
    { timeout: 30000 },
  );
  const final = await diagnostic();
  for (const key of [
    'events',
    'evidence',
    'inferredLocations',
    'ruleDecisions',
    'dispatchContexts',
  ])
    assert.deepEqual(final[key], []);
  assert.equal(await page.evaluate(() => window.__m6.token), token);
  assert.equal(
    documents,
    1,
    'no reload across scenarios, context changes and resets',
  );
  await page.evaluate(() => window.__m6.application.destroy());
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 1366x768, stable Cesium resources, honest source, both scenarios, reset, no reload. PENDING PHYSICAL WINDOWS TEST.',
  );
} finally {
  await browser.close();
}
