import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../i18n/index.js';
import {
  normalizeLocale,
  resolveLocale,
  LOCALE_NAMES,
} from '../i18n/locale.js';
import {
  formatUldTime,
  formatUldValue,
  getUldFields,
  getUldLegend,
  getUldAlertPresentation,
} from './uldPresentation.js';
import { createUldStore } from '../uld/store.js';
import { createMockUldRecords } from '../layers/uld/source.js';

afterEach(() => setLocale('en'));

test('alert enums, title, message and event time use centralized Taiwan presentation', () => {
  setLocale('zh-TW');
  for (const [value, expected] of [
    ['UNAUTHORIZED_MOVEMENT', '未授權移動'],
    ['UNSERVICEABLE', '不可使用'],
    ['DWELL_WARNING', '滯留時間警告'],
    ['LOST_CANDIDATE', '疑似遺失'],
  ])
    assert.equal(formatUldValue('type', value), expected);
  for (const [value, expected] of [
    ['ACTIVE', '啟用中'],
    ['ACKNOWLEDGED', '已確認'],
    ['RESOLVED', '已解除'],
  ])
    assert.equal(formatUldValue('status', value), expected);
  const shown = getUldAlertPresentation({
    type: 'UNAUTHORIZED_MOVEMENT',
    level: 'WARNING',
    status: 'ACTIVE',
    title: 'Unauthorized ULD movement',
    message: 'ULD left STORAGE-A without a valid dispatch.',
    occurredAt: '2026-10-28T10:00:00.000Z',
    fromZoneId: 'STORAGE-A',
    toZoneId: 'EXIT-A',
  });
  assert.equal(shown.title, '未授權 ULD 移動');
  assert.equal(shown.message, '偵測到 ULD 在無有效派遣情境下離開 STORAGE-A');
  assert.equal(shown.englishType, 'Unauthorized Movement');
  assert.equal(shown.transition, 'STORAGE-A → EXIT-A');
  assert.equal(shown.occurredAt, '2026-10-28 18:00:00');
});

test('Taiwan locale resolves Traditional tags and translates primary UI and brand', () => {
  for (const tag of ['zh-TW', 'zh_Hant', 'zh-Hant-HK', 'ZH-tw'])
    assert.equal(normalizeLocale(tag), 'zh-TW');
  assert.equal(LOCALE_NAMES['zh-TW'], '繁體中文（台灣）');
  assert.equal(
    resolveLocale({
      location: { search: '' },
      storage: null,
      languages: ['zh-TW'],
    }),
    'zh-TW',
  );
  setLocale('zh-TW');
  for (const [key, value] of [
    ['DATA LAYERS', '資料圖層'],
    ['SCENES', '場景'],
    ['DISPLAY', '顯示'],
    ['LOCATION', '位置'],
    ['ULD DETAIL', 'ULD 詳細資訊'],
    ['No ULD selected', '尚未選取 ULD'],
    ['Show TPE demo', '顯示桃園機場示範'],
    ['Intelligent ULD Tracking & Management', 'ULD 智慧追蹤管理平台'],
  ])
    assert.equal(t(key), value);
});

test('all ULD field labels use the requested bilingual terminology', () => {
  setLocale('zh-TW');
  assert.deepEqual(
    getUldFields().map(([, label]) => label),
    [
      'ULD 編號 (ULD ID)',
      'ULD 類型 (ULD Type)',
      '站點 (Station)',
      '作業區域 (Zone)',
      '作業狀態 (Operational Status)',
      '可用性狀態 (Serviceability)',
      '航班 (Flight)',
      '目的站 (Destination)',
      '最後偵測時間 (Last Seen)',
      '告警等級 (Alert Level)',
    ],
  );
});

test('status display preserves machine values and nulls, including non-status fields', () => {
  setLocale('zh-TW');
  for (const [field, value, expected] of [
    ['alertLevel', 'NORMAL', '正常 NORMAL'],
    ['alertLevel', 'WARNING', '警告 WARNING'],
    ['alertLevel', 'CRITICAL', '嚴重 CRITICAL'],
    ['operationalStatus', 'AVAILABLE', '可用 AVAILABLE'],
    ['operationalStatus', 'ASSIGNED', '已指派 ASSIGNED'],
    ['operationalStatus', 'MOVING', '移動中 MOVING'],
    ['serviceabilityStatus', 'SERVICEABLE', '可使用 SERVICEABLE'],
    ['serviceabilityStatus', 'UNSERVICEABLE', '不可使用 UNSERVICEABLE'],
    ['serviceabilityStatus', 'UNCONFIRMED', '待確認 UNCONFIRMED'],
    ['positionSource', 'CONFIGURED_DEMO', '示範設定座標 CONFIGURED_DEMO'],
  ])
    assert.equal(formatUldValue(field, value), expected);
  assert.equal(formatUldValue('flight', null), '—');
  assert.equal(formatUldValue('destination', undefined), '—');
  assert.equal(formatUldValue('flight', 'NORMAL'), 'NORMAL');
  assert.equal(formatUldValue('alertLevel', 'FUTURE_VALUE'), 'FUTURE_VALUE');
  assert.equal(
    getUldLegend(),
    '綠色：正常 NORMAL\n黃色：警告 WARNING\n紅色：嚴重 CRITICAL',
  );
  const store = createUldStore(createMockUldRecords());
  const record = store.getUldById('AKE67890CI');
  const before = JSON.stringify(store.getSnapshot());
  for (const [field] of getUldFields()) formatUldValue(field, record[field]);
  assert.equal(JSON.stringify(store.getSnapshot()), before);
  assert.equal(record.operationalStatus, 'ASSIGNED');
  assert.equal(record.lastSeenAt, '2026-10-28T06:00:00.000Z');
  store.destroy();
});

test('Last Seen is always Taipei time with numeric year, including midnight and date rollover', () => {
  assert.equal(
    formatUldTime('2026-10-28T08:00:00.000Z'),
    '2026-10-28 16:00:00',
  );
  assert.equal(
    formatUldTime('2026-10-28T16:00:00.000Z'),
    '2026-10-29 00:00:00',
  );
  assert.equal(
    formatUldTime('2026-10-28T16:00:00+08:00'),
    '2026-10-28 16:00:00',
  );
  for (const value of [null, undefined, '', 'invalid'])
    assert.equal(formatUldTime(value), '—');
});
