/**
 * Protected /admin Workspace Controller for MyPlaydex.
 * Pure Vanilla JS ES2022 module (zero-build, CDN modular ESM).
 */

import { isBrowserEnvironment } from './analytics.js';
import {
  LOGIN_ROUTE,
  resolveCurrentUser,
  loadFirebaseAuthClient,
  defaultNavigate,
  onDomReady
} from './auth-client.js';

/**
 * Executes the /admin session guard and wires the sign-out action.
 *
 * @param {object} deps
 * @returns {Promise<{ status: string, email?: string, handleSignOut?: () => Promise<void>, error?: unknown }>}
 */
export async function runAdminController(deps) {
  const {
    auth,
    browserLocalPersistence,
    setPersistence,
    signOut,
    onAuthStateChanged,
    navigate = defaultNavigate,
    setStatus = () => {},
    onAuthorized = () => {},
    onSignedOut = () => {}
  } = deps;

  try {
    await setPersistence(auth, browserLocalPersistence);
    const user = await resolveCurrentUser(auth, onAuthStateChanged);

    if (!user) {
      setStatus('Redirecting to sign in...');
      navigate(LOGIN_ROUTE);
      return { status: 'redirected-to-login' };
    }

    const tokenResult = await user.getIdTokenResult();
    if (tokenResult?.claims?.admin !== true) {
      await signOut(auth);
      setStatus('Access denied.');
      return { status: 'access-denied' };
    }

    const email = user.email ?? '';
    setStatus('');
    onAuthorized({ email });

    const handleSignOut = async () => {
      try {
        await signOut(auth);
        onSignedOut();
        setStatus('Signed out.');
      } catch {
        setStatus('Unable to sign out right now. Please try again.');
      }
    };

    return { status: 'authorized', email, handleSignOut };
  } catch (error) {
    setStatus('Unable to verify admin session right now. Please try again.');
    return { status: 'error', error };
  }
}

/**
 * Initializes the /admin page in the browser.
 *
 * @param {object} [options={}]
 * @returns {Promise<{ status: string, email?: string, handleSignOut?: () => Promise<void>, error?: unknown }>}
 */
export async function initAdminPage(options = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  const statusEl = options.statusEl ?? doc?.getElementById('admin-status') ?? null;
  const workspaceEl = options.workspaceEl ?? doc?.getElementById('admin-workspace') ?? null;
  const emailEl = options.emailEl ?? doc?.getElementById('admin-email') ?? null;
  const signOutBtn = options.signOutBtn ?? doc?.getElementById('sign-out-btn') ?? null;

  const setStatus = options.setStatus ?? ((message) => {
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.hidden = message.length === 0;
    }
  });
  const loadClient = options.loadClient ?? loadFirebaseAuthClient;

  try {
    const { authSdk, auth } = await loadClient();

    const result = await runAdminController({
      auth,
      browserLocalPersistence: authSdk.browserLocalPersistence,
      setPersistence: authSdk.setPersistence,
      signOut: authSdk.signOut,
      onAuthStateChanged: authSdk.onAuthStateChanged,
      navigate: options.navigate,
      setStatus,
      onAuthorized: ({ email }) => {
        if (emailEl) emailEl.textContent = email;
        if (workspaceEl) workspaceEl.hidden = false;
      },
      onSignedOut: () => {
        if (workspaceEl) workspaceEl.hidden = true;
        if (emailEl) emailEl.textContent = '';
      }
    });

    if (result.status === 'authorized' && signOutBtn && typeof result.handleSignOut === 'function') {
      signOutBtn.addEventListener('click', async () => {
        signOutBtn.disabled = true;
        await result.handleSignOut();
        signOutBtn.disabled = false;
      });
    }

    return result;
  } catch (error) {
    setStatus('Unable to verify admin session right now. Please try again.');
    return { status: 'error', error };
  }
}

if (isBrowserEnvironment()) {
  onDomReady(() => initAdminPage());
}
