/**
 * Zero-click Google Sign-In Controller for MyPlaydex /login
 * Pure Vanilla JS ES2022 module (zero-build, CDN modular ESM).
 * Uses same-origin authDomain (myplaydex.web.app) and browserLocalPersistence.
 */

import { isBrowserEnvironment } from './analytics.js';
import {
  FIREBASE_AUTH_CDN_URL,
  FIREBASE_AUTH_CONFIG,
  ADMIN_ROUTE,
  resolveCurrentUser,
  loadFirebaseAuthClient,
  defaultNavigate,
  onDomReady
} from './auth-client.js';

export { FIREBASE_AUTH_CDN_URL, FIREBASE_AUTH_CONFIG, ADMIN_ROUTE };

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
    navigate = defaultNavigate,
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

export async function initLoginPage(options = {}) {
  const statusEl = options.statusEl ?? (typeof document !== 'undefined' ? document.getElementById('login-status') : null);
  const setStatus = options.setStatus ?? ((message) => {
    if (statusEl) {
      statusEl.textContent = message;
    }
  });
  const loadClient = options.loadClient ?? loadFirebaseAuthClient;

  try {
    const { authSdk, auth } = await loadClient();
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
  onDomReady(() => initLoginPage());
}
