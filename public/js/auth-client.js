/**
 * Shared Firebase Authentication client helpers for /login and /admin.
 * Pure Vanilla JS ES2022 module (zero-build, CDN modular ESM).
 * Uses same-origin authDomain (myplaydex.web.app) and browserLocalPersistence.
 */

import {
  FIREBASE_SDK_VERSION,
  FIREBASE_APP_CDN_URL,
  FIREBASE_WEB_CONFIG
} from './analytics.js';

export const FIREBASE_AUTH_CDN_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`;
export const LOGIN_ROUTE = '/login';
export const ADMIN_ROUTE = '/admin';

export const FIREBASE_AUTH_CONFIG = Object.freeze({
  ...FIREBASE_WEB_CONFIG,
  authDomain: 'myplaydex.web.app'
});

/**
 * Resolves the currently signed-in Firebase Auth user, waiting for initial
 * auth state hydration when available.
 *
 * @param {object} auth
 * @param {Function} [onAuthStateChanged]
 * @returns {Promise<object | null>}
 */
export async function resolveCurrentUser(auth, onAuthStateChanged) {
  if (!auth) return null;

  if (typeof auth.authStateReady === 'function') {
    await auth.authStateReady();
    return auth.currentUser ?? null;
  }

  if (auth.currentUser) {
    return auth.currentUser;
  }

  if (typeof onAuthStateChanged === 'function') {
    return new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        if (typeof unsubscribe === 'function') unsubscribe();
        resolve(user ?? null);
      });
    });
  }

  return null;
}

/**
 * Loads Firebase App and Auth modular SDKs from the official CDN and
 * returns the initialized Auth instance.
 *
 * @returns {Promise<{ appSdk: object, authSdk: object, auth: object }>}
 */
export async function loadFirebaseAuthClient() {
  const [appSdk, authSdk] = await Promise.all([
    import(FIREBASE_APP_CDN_URL),
    import(FIREBASE_AUTH_CDN_URL)
  ]);
  const existingApps = typeof appSdk.getApps === 'function' ? appSdk.getApps() : [];
  const app = existingApps.length > 0 ? existingApps[0] : appSdk.initializeApp(FIREBASE_AUTH_CONFIG);
  const auth = authSdk.getAuth(app);
  return { appSdk, authSdk, auth };
}

/**
 * Default browser navigation helper using location.replace so redirects
 * do not pollute history.
 *
 * @param {string} url
 */
export function defaultNavigate(url) {
  if (typeof window !== 'undefined' && window.location) {
    window.location.replace(url);
  }
}

/**
 * Schedules a callback to run once the DOM is ready.
 *
 * @param {() => void} callback
 */
export function onDomReady(callback) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback);
  } else {
    callback();
  }
}
