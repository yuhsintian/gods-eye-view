#!/usr/bin/env node
/** Terminal-driven WS acceptance plus 1366x768 readability/overflow checks. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const run = promisify(execFile);
const index = process.argv.indexOf('--url');
const origin = new URL(
  index >= 0 ? process.argv[index + 1] : 'http://localhost:4173',
).origin;
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
async function terminalPost(action) {
  const url = `${origin}/api/uld/demo/${action}`;
  const { stdout } = await run('curl', [
    '--noproxy',
    '*',
    '--fail',
    '--silent',
    '--show-error',
    '-X',
    'POST',
    url,
  ]);
  const body = JSON.parse(stdout);
  assert.equal(body.developmentOnly, true);
  console.log(`TERMINAL POST ${action}: streamRevision=${body.streamRevision}`);
  return body;
}
try {
  await terminalPost('reset');
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  const errors = [];
  let navigations = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    // Existing share-state history changes emit frame navigation events too.
    // Count document requests; the runtime token below also proves no reload.
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      navigations++;
  });
  await page.evaluateOnNewDocument(() => {
    const NativeSocket = window.WebSocket;
    window.__qaUldSockets = [];
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (String(args[0]).endsWith('/ws/uld'))
          window.__qaUldSockets.push(this);
      }
    };
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(host))
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
    await application.start();
    const { data, scene, controls } = application.getComponents();
    const source = scene.viewer.dataSources.getByName('uld')[0];
    const entity = source.entities.getById('uld:AKE12345CI');
    window.__m4 = {
      application,
      data,
      viewer: scene.viewer,
      controls,
      source,
      entity,
      point: entity.point,
      token: Math.random(),
    };
    scene.viewer.targetFrameRate = 10;
    scene.viewer.resolutionScale = 0.6;
    for (const id of ['uld-alert-panel', 'uld-detail-panel'])
      controls.styleManager.setPanelCollapsed(id, false, {
        persist: false,
        syncShare: false,
      });
  });
  const token = await page.evaluate(() => window.__m4.token);
  assert.equal(
    await page.$eval('[data-uld-connection]', (el) => el.textContent),
    '已連線',
  );
  console.log('READY: backend snapshot connected; 1366x768');
  await page.click('[data-uld-focus]');
  await page.waitForFunction(
    () => !document.querySelector('[data-uld-focus]').disabled,
    { timeout: 60000 },
  );
  const point = await page.evaluate(async () => {
    const Cesium = await import('/node_modules/.vite/deps/cesium.js');
    const { viewer, entity } = window.__m4;
    await new Promise((resolve) => {
      const off = viewer.scene.postRender.addEventListener(() => {
        off();
        resolve();
      });
      viewer.scene.requestRender();
    });
    const p = Cesium.SceneTransforms.worldToWindowCoordinates(
      viewer.scene,
      entity.position.getValue(viewer.clock.currentTime),
    );
    const rect = viewer.canvas.getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  });
  await page.mouse.click(point.x, point.y, { delay: 120 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-field="uldId"]')?.textContent ===
      'AKE12345CI',
    { timeout: 30000 },
  );
  await terminalPost('unauthorized-movement');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-field="zoneId"]')?.textContent ===
        'EXIT-A' && document.querySelector('[data-alert-id]'),
    { timeout: 30000 },
  );
  assert.equal(
    await page.$eval(
      '[data-uld-field="operationalStatus"]',
      (el) => el.textContent,
    ),
    '移動中 MOVING',
  );
  assert.equal(
    await page.$eval('[data-uld-field="alertLevel"]', (el) => el.textContent),
    '警告 WARNING',
  );
  assert.equal(
    await page.evaluate(() =>
      window.__m4.point.color.getValue().toCssColorString(),
    ),
    'rgb(255,189,74)',
  );
  assert.match(
    await page.$eval('[data-alert-id]', (el) => el.textContent),
    /未授權 ULD 移動/,
  );
  await page.evaluate(() => {
    window.__m4.selectionEvents = 0;
    window.__m4.data.catalog.uldStore.subscribe((_state, change) => {
      if (change?.type === 'selection') window.__m4.selectionEvents++;
    });
  });
  await page.click('[data-alert-id] [data-alert-field="title"]');
  await page.waitForFunction(
    () =>
      window.__m4.selectionEvents >= 1 &&
      !window.__m4.viewer._zoomTarget &&
      window.__m4.viewer.camera.positionCartographic.height < 1600,
    { timeout: 60000 },
  );
  assert.equal(
    await page.evaluate(
      () => window.__m4.data.catalog.uldStore.getSnapshot().selectedUldId,
    ),
    'AKE12345CI',
  );
  assert.ok(
    await page.evaluate(
      () => window.__m4.viewer.camera.positionCartographic.height < 1600,
    ),
  );

  const readability = await page.evaluate(() => {
    const issues = [];
    const minSize = (selector, size, leading) => {
      for (const node of document.querySelectorAll(selector)) {
        const css = getComputedStyle(node),
          font = parseFloat(css.fontSize),
          line = parseFloat(css.lineHeight);
        if (font < size || line / font < leading)
          issues.push(`${selector}: ${font}px/${line}px`);
        if (node.scrollWidth > node.clientWidth + 2)
          issues.push(`${selector}: horizontal text overflow`);
      }
    };
    minSize('#uld-detail-panel h2, #uld-alert-panel h2', 17, 1.35);
    minSize('.uld-detail-fields dt', 13, 1.4);
    minSize('.uld-detail-fields dd', 16, 1.4);
    minSize('[data-uld-focus], [data-uld-simulate], [data-uld-reset]', 14, 1.4);
    minSize('[data-alert-field="title"]', 15, 1.4);
    minSize(
      '[data-alert-field="occurredAt"], [data-alert-field="message"]',
      13,
      1.4,
    );
    const boxes = [
      ...document.querySelectorAll('#uld-detail-panel, #uld-alert-panel'),
    ].map((node) => {
      const r = node.getBoundingClientRect();
      if (
        r.left < -1 ||
        r.right > innerWidth + 1 ||
        r.top < -1 ||
        r.bottom > innerHeight + 1
      )
        issues.push(`${node.id}: outside viewport`);
      return {
        id: node.id,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      };
    });
    if (boxes[0].left < boxes[1].right && boxes[0].right > boxes[1].left)
      issues.push('ULD panels overlap horizontally');
    return { issues, boxes };
  });
  console.log('READABILITY', JSON.stringify(readability));
  assert.deepEqual(readability.issues, []);
  await page.$eval('[data-uld-field="alertLevel"]', (el) =>
    el.scrollIntoView({ block: 'nearest' }),
  );
  await page.screenshot({ path: join(tmpdir(), 'uld-m4-1366-warning.png') });
  console.log(
    'PASS: terminal WS update -> stable marker/detail/alert; alert selection/focus; readability',
  );

  await terminalPost('reset');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-uld-field="zoneId"]')?.textContent ===
        'STORAGE-A' && !document.querySelector('[data-alert-id]'),
    { timeout: 30000 },
  );
  assert.equal(
    await page.$eval(
      '[data-uld-field="operationalStatus"]',
      (el) => el.textContent,
    ),
    '可用 AVAILABLE',
  );
  assert.equal(
    await page.evaluate(() =>
      window.__m4.point.color.getValue().toCssColorString(),
    ),
    'rgb(67,217,176)',
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__m4.viewer.dataSources.getByName('uld')[0] ===
          window.__m4.source && window.__m4.entity.point === window.__m4.point,
    ),
    true,
  );
  await page.evaluate(() => {
    window.__m4.connectionHistory = [];
    window.__m4.data.catalog.uldStore.subscribe((state) =>
      window.__m4.connectionHistory.push(state.connectionStatus),
    );
    window.__qaUldSockets.at(-1).close(4000, 'QA reconnect');
  });
  await page.waitForFunction(
    () =>
      window.__qaUldSockets.length >= 2 &&
      document.querySelector('[data-uld-connection]').dataset
        .connectionStatus === 'CONNECTED',
    { timeout: 30000 },
  );
  const history = await page.evaluate(() => window.__m4.connectionHistory);
  assert.ok(history.includes('DISCONNECTED'));
  assert.ok(history.includes('RECONNECTING'));
  assert.equal(await page.evaluate(() => window.__m4.token), token);
  assert.equal(navigations, 1, 'no page reload during posts or reconnect');
  await page.evaluate(() =>
    window.__m4.controls.styleManager.setHudLayout('cyber'),
  );
  await page.evaluate(() => {
    for (const id of ['uld-alert-panel', 'uld-detail-panel'])
      window.__m4.controls.styleManager.setPanelCollapsed(id, false, {
        persist: false,
        syncShare: false,
      });
  });
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('#uld-detail-panel');
      const body = panel.querySelector('[data-panel-body]');
      const siblings = [...panel.parentElement.children].filter(
        (node) => node !== panel && node.matches('[data-panel-id].collapsed'),
      );
      return (
        document.documentElement.dataset.uiTheme === 'cyber' &&
        body.clientHeight >= 150 &&
        siblings.every((node) => getComputedStyle(node).display === 'none')
      );
    },
    { timeout: 30000 },
  );
  await page.$eval('#uld-detail-panel [data-panel-body]', (el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: join(tmpdir(), 'uld-m4-1366-cyber.png') });
  await page.evaluate(() =>
    window.__m4.controls.styleManager.setPanelCollapsed(
      'uld-detail-panel',
      true,
      {
        persist: false,
        syncShare: false,
      },
    ),
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('#pp-toggles')).display !==
      'none',
    { timeout: 10000 },
  );
  await page.evaluate(() => window.__m4.application.destroy());
  await page.waitForFunction(
    () =>
      window.__qaUldSockets.every(
        (socket) => socket.readyState === WebSocket.CLOSED,
      ),
    { timeout: 10000 },
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: terminal reset, real reconnect, no reload, Cyber view and socket cleanup',
  );
} finally {
  await browser.close();
}
