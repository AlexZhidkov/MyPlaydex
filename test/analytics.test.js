import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIREBASE_WEB_CONFIG,
  sanitizeAnalyticsParams,
  isBrowserEnvironment,
  createNoopAnalyticsClient,
  createAnalyticsClient
} from '../public/js/analytics.js';

test('sanitizeAnalyticsParams strips nullish/nested values, joins arrays, and truncates strings to 100 chars', () => {
  const longString = 'a'.repeat(120);
  const longArray = Array.from({ length: 20 }, (_, i) => `category_${i}`);

  const result = sanitizeAnalyticsParams({
    nullVal: null,
    undefVal: undefined,
    nestedObj: { foo: 'bar' },
    fnVal: () => {},
    nanVal: Number.NaN,
    infVal: Number.POSITIVE_INFINITY,
    boolVal: true,
    numVal: 42,
    strVal: longString,
    arrVal: longArray,
    mixedArr: ['soccer', null, 5, false, { skip: true }]
  });

  assert.deepEqual(Object.keys(result).sort(), ['arrVal', 'boolVal', 'mixedArr', 'numVal', 'strVal']);
  assert.equal(result.boolVal, true);
  assert.equal(result.numVal, 42);
  assert.equal(result.strVal.length, 100);
  assert.equal(result.arrVal.length, 100);
  assert.equal(result.mixedArr, 'soccer,5,false');
  assert.deepEqual(sanitizeAnalyticsParams(null), {});
});

test('createAnalyticsClient initializes when isSupported() is true, flushes buffered events, and tracks subsequent events', async () => {
  const loggedEvents = [];
  let initializedConfig = null;
  let resolveSdk;
  const sdkPromise = new Promise((resolve) => {
    resolveSdk = resolve;
  });

  const client = createAnalyticsClient({
    isBrowser: true,
    loadSdk: () => sdkPromise
  });

  // Track before SDK finishes loading (should buffer in order)
  client.track('location_selected', { method: 'preset', suburb: 'Perth' });
  client.track('tab_switched', { tab: 'organizers' });
  assert.equal(client.isEnabled(), false);

  const fakeApp = { name: '[DEFAULT]' };
  const fakeAnalytics = { app: fakeApp };
  resolveSdk({
    appSdk: {
      getApps: () => [],
      initializeApp: (cfg) => {
        initializedConfig = cfg;
        return fakeApp;
      }
    },
    analyticsSdk: {
      isSupported: async () => true,
      getAnalytics: (app) => {
        assert.equal(app, fakeApp);
        return fakeAnalytics;
      },
      logEvent: (instance, name, params) => {
        loggedEvents.push({ instance, name, params });
      }
    }
  });

  const enabled = await client.ready;
  assert.equal(enabled, true);
  assert.equal(client.isEnabled(), true);
  assert.deepEqual(initializedConfig, FIREBASE_WEB_CONFIG);

  // Subsequent track call
  client.track('radius_changed', { radius: '25', source: 'pill' });

  assert.deepEqual(
    loggedEvents.map((e) => ({ name: e.name, params: e.params })),
    [
      { name: 'location_selected', params: { method: 'preset', suburb: 'Perth' } },
      { name: 'tab_switched', params: { tab: 'organizers' } },
      { name: 'radius_changed', params: { radius: '25', source: 'pill' } }
    ]
  );
  assert.equal(loggedEvents[0].instance, fakeAnalytics);
});

test('createAnalyticsClient reuses existing Firebase App when getApps() is non-empty', async () => {
  const existingApp = { name: '[DEFAULT]', existing: true };
  let initializeCalled = false;
  let passedApp = null;

  const client = createAnalyticsClient({
    isBrowser: true,
    loadSdk: async () => ({
      appSdk: {
        getApps: () => [existingApp],
        getApp: () => existingApp,
        initializeApp: () => {
          initializeCalled = true;
          return {};
        }
      },
      analyticsSdk: {
        isSupported: async () => true,
        getAnalytics: (app) => {
          passedApp = app;
          return { ok: true };
        },
        logEvent: () => {}
      }
    })
  });

  const enabled = await client.ready;
  assert.equal(enabled, true);
  assert.equal(initializeCalled, false);
  assert.equal(passedApp, existingApp);
});

test('createAnalyticsClient degrades to silent no-op and drops buffer when isSupported() resolves false', async () => {
  const loggedEvents = [];
  let getAnalyticsCalled = false;

  const client = createAnalyticsClient({
    isBrowser: true,
    loadSdk: async () => ({
      appSdk: {
        getApps: () => [],
        initializeApp: () => ({})
      },
      analyticsSdk: {
        isSupported: async () => false,
        getAnalytics: () => {
          getAnalyticsCalled = true;
          return {};
        },
        logEvent: (instance, name, params) => {
          loggedEvents.push({ instance, name, params });
        }
      }
    })
  });

  client.track('location_selected', { method: 'gps', suburb: 'Near Me' });
  const enabled = await client.ready;

  assert.equal(enabled, false);
  assert.equal(client.isEnabled(), false);
  assert.equal(getAnalyticsCalled, false);

  client.track('tab_switched', { tab: 'venues' });
  assert.deepEqual(loggedEvents, []);
});

test('createAnalyticsClient degrades to silent no-op without throwing when loadSdk rejects', async () => {
  const client = createAnalyticsClient({
    isBrowser: true,
    loadSdk: async () => {
      throw new Error('Blocked by ad blocker');
    }
  });

  client.track('location_selected', { method: 'preset', suburb: 'Scarborough' });
  const enabled = await client.ready;

  assert.equal(enabled, false);
  assert.equal(client.isEnabled(), false);
  assert.doesNotThrow(() => client.track('tab_switched', { tab: 'activities' }));
});

test('createAnalyticsClient with isBrowser: false returns no-op without calling loadSdk', async () => {
  assert.equal(isBrowserEnvironment(), false);

  let loadSdkCalled = false;
  const client = createAnalyticsClient({
    isBrowser: false,
    loadSdk: async () => {
      loadSdkCalled = true;
      return {};
    }
  });

  const enabled = await client.ready;
  assert.equal(enabled, false);
  assert.equal(client.isEnabled(), false);
  assert.equal(loadSdkCalled, false);
  assert.doesNotThrow(() => client.track('tab_switched', { tab: 'venues' }));

  const noop = createNoopAnalyticsClient();
  assert.equal(await noop.ready, false);
  assert.equal(noop.isEnabled(), false);
});
