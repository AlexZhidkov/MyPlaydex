/**
 * Zero-click Google Sign-In Controller for MyPlaydex /login
 * Pure Vanilla JS ES2022 module (zero-build, CDN modular ESM).
 * Uses same-origin authDomain (myplaydex.web.app) and browserLocalPersistence.
 */

import {
  FIREBASE_SDK_VERSION,
  FIREBASE_APP_CDN_URL,
  FIREBASE_WEB_CONFIG,
  isBrowserEnvironment
} from './analytics.js';

export const FIREBASE_AUTH_CDN_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`;
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
async function resolveCurrentUser(auth, onAuthStateChanged) {
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
 * Executes the zero-click /login authentication state machine.
 *
 * @param {object} deps
 * @returns {Promise<{ status: string, error?: unknown }>}
 */
export async function runLoginController(deps) {
  const {
    auth,
    provider,
    browserLocalPersistence,
    setPersistence,
    getRedirectResult,
    signInWithRedirect,
    signOut,
    onAuthStateChanged,
    navigate = (url) => {
      if (typeof window !== 'undefined' && window.location) {
        window.location.replace(url);
      }
    },
    setStatus = () => {}
  } = deps;

  try {
    await setPersistence(auth, browserLocalPersistence);

    const redirectResult = await getRedirectResult(auth);
    const user = redirectResult?.user ?? await resolveCurrentUser(auth, onAuthStateChanged);

    if (user) {
      const tokenResult = await user.getIdTokenResult();
      if (tokenResult?.claims?.admin === true) {
        setStatus('Redirecting to admin...');
        navigate(ADMIN_ROUTE);
        return { status: 'redirected-admin' };
      }

      await signOut(auth);
      setStatus('Access denied.');
      return { status: 'access-denied' };
    }

    setStatus('Redirecting to Google Sign-In...');
    await signInWithRedirect(auth, provider);
    return { status: 'redirecting-to-login' };
  } catch (error) {
    setStatus('Unable to sign in right now. Please try again.');
    return { status: 'error', error };
  }
}

/**
 * Loads Firebase App and Auth modular SDKs from the official CDN.
 *
 * @returns {Promise<{ appSdk: object, authSdk: object }>}
 */
async function loadFirebaseAuthSdk() {
  const [appSdk, authSdk] = await Promise.all([
    import(FIREBASE_APP_CDN_URL),
    import(FIREBASE_AUTH_CDN_URL)
  ]);
  return { appSdk, authSdk };
}

/**
 * Initializes the /login page in the browser.
 *
 * @param {object} [options={}]
 * @returns {Promise<{ status: string, error?: unknown }>}
 */
export async function initLoginPage(options = {}) {
  const statusEl = options.statusEl ?? (typeof document !== 'undefined' ? document.getElementById('login-status') : null);
  const setStatus = options.setStatus ?? ((message) => {
    if (statusEl) {
      statusEl.textContent = message;
    }
  });
  const loadSdk = options.loadSdk ?? loadFirebaseAuthSdk;

  try {
    const { appSdk, authSdk } = await loadSdk();
    const existingApps = typeof appSdk.getApps === 'function' ? appSdk.getApps() : [];
    const app = existingApps.length > 0 ? existingApps[0] : appSdk.initializeApp(FIREBASE_AUTH_CONFIG);
    const auth = authSdk.getAuth(app);
    const provider = new authSdk.GoogleAuthProvider();

    return await runLoginController({
      auth,
      provider,
      browserLocalPersistence: authSdk.browserLocalPersistence,
      setPersistence: authSdk.setPersistence,
      getRedirectResult: authSdk.getRedirectResult,
      signInWithRedirect: authSdk.signInWithRedirect,
      signOut: authSdk.signOut,
      onAuthStateChanged: authSdk.onAuthStateChanged,
      navigate: options.navigate,
      setStatus
    });
  } catch (error) {
    setStatus('Unable to sign in right now. Please try again.');
    return { status: 'error', error };
  }
}

if (isBrowserEnvironment()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initLoginPage());
  } else {
    initLoginPage();
  }
}
