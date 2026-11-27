/**
 * Firebase Web SDK Analytics Client for MyPlaydex
 * Pure Vanilla JS ES2022 module (zero-build, CDN modular ESM).
 * Lazily loads Firebase App & Analytics SDKs, guards with `isSupported()`,
 * buffers early events, and degrades silently on unsupported or blocked environments.
 */

export const FIREBASE_SDK_VERSION = '13.4.0';
export const FIREBASE_APP_CDN_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`;
export const FIREBASE_ANALYTICS_CDN_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-analytics.js`;

export const FIREBASE_WEB_CONFIG = Object.freeze({
  apiKey: 'AIzaSyCqAPPxKk0ZprjC7r0fIun2WiESu9GBbR8',
  authDomain: 'myplaydex.firebaseapp.com',
  projectId: 'myplaydex',
  storageBucket: 'myplaydex.firebasestorage.app',
  messagingSenderId: '433584288021',
  appId: '1:433584288021:web:5f3acbcfbc09cfc6ea391c',
  measurementId: 'G-MWYT7HQWRC'
});

const MAX_PARAM_STRING_LENGTH = 100;

/**
 * Sanitizes event parameters to match GA4 / Firebase Analytics constraints.
 *
 * @param {object} [params={}]
 * @returns {Record<string, string | number | boolean>}
 */
export function sanitizeAnalyticsParams(params = {}) {
  if (!params || typeof params !== 'object') {
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      const joined = value
        .filter((item) => (
          typeof item === 'string' ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item))
        ))
        .map((item) => String(item))
        .join(',');
      sanitized[key] = joined.slice(0, MAX_PARAM_STRING_LENGTH);
    } else if (typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        sanitized[key] = value;
      }
    } else if (typeof value === 'string') {
      sanitized[key] = value.slice(0, MAX_PARAM_STRING_LENGTH);
    }
  }

  return sanitized;
}

/**
 * Returns true only in a real browser environment (excluding Node.js test mocks).
 *
 * @returns {boolean}
 */
export function isBrowserEnvironment() {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    !(typeof process !== 'undefined' && Boolean(process.versions?.node))
  );
}

/**
 * Creates a silent no-op analytics client for Node tests or disabled environments.
 *
 * @returns {{ track: Function, isEnabled: () => boolean, ready: Promise<boolean> }}
 */
export function createNoopAnalyticsClient() {
  return {
    track: () => {},
    isEnabled: () => false,
    ready: Promise.resolve(false)
  };
}

function defaultLoadSdk() {
  return Promise.all([
    import(FIREBASE_APP_CDN_URL),
    import(FIREBASE_ANALYTICS_CDN_URL)
  ]).then(([appSdk, analyticsSdk]) => ({ appSdk, analyticsSdk }));
}

/**
 * Creates a Firebase Web SDK analytics client with lazy CDN loading,
 * `isSupported()` guarding, pre-init event buffering, and silent fallback.
 *
 * @param {object} [options={}]
 * @param {object} [options.config=FIREBASE_WEB_CONFIG]
 * @param {Function} [options.loadSdk]
 * @param {boolean} [options.isBrowser=isBrowserEnvironment()]
 * @param {number} [options.maxBufferSize=50]
 * @returns {{ track: Function, isEnabled: () => boolean, ready: Promise<boolean> }}
 */
export function createAnalyticsClient(options = {}) {
  const {
    config = FIREBASE_WEB_CONFIG,
    loadSdk = defaultLoadSdk,
    isBrowser = isBrowserEnvironment(),
    maxBufferSize = 50
  } = options;

  if (!isBrowser) {
    return createNoopAnalyticsClient();
  }

  let initialized = false;
  let enabled = false;
  let analyticsInstance = null;
  let logEventFn = null;
  const buffer = [];

  const ready = (async () => {
    try {
      const { appSdk, analyticsSdk } = await loadSdk();
      if (!appSdk || !analyticsSdk) {
        throw new Error('Firebase SDK modules missing');
      }

      const supported = typeof analyticsSdk.isSupported === 'function'
        ? await analyticsSdk.isSupported()
        : true;

      if (!supported) {
        enabled = false;
        initialized = true;
        buffer.length = 0;
        return false;
      }

      const app = typeof appSdk.getApps === 'function' && appSdk.getApps().length > 0
        ? appSdk.getApp()
        : appSdk.initializeApp(config);

      analyticsInstance = analyticsSdk.getAnalytics(app);
      logEventFn = analyticsSdk.logEvent;
      enabled = Boolean(analyticsInstance && typeof logEventFn === 'function');
      initialized = true;

      if (enabled) {
        for (const item of buffer) {
          try {
            logEventFn(analyticsInstance, item.eventName, item.params);
          } catch {
            // Silently ignore individual event dispatch failures
          }
        }
      }
      buffer.length = 0;
      return enabled;
    } catch {
      enabled = false;
      initialized = true;
      buffer.length = 0;
      return false;
    }
  })();

  function track(eventName, params = {}) {
    if (typeof eventName !== 'string' || !eventName.trim()) {
      return;
    }

    const cleanName = eventName.trim();
    const sanitized = sanitizeAnalyticsParams(params);

    if (!initialized) {
      if (buffer.length < maxBufferSize) {
        buffer.push({ eventName: cleanName, params: sanitized });
      }
      return;
    }

    if (!enabled || !analyticsInstance || typeof logEventFn !== 'function') {
      return;
    }

    try {
      logEventFn(analyticsInstance, cleanName, sanitized);
    } catch {
      // Silently ignore analytics runtime errors
    }
  }

  return {
    track,
    isEnabled: () => enabled,
    ready
  };
}
