import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIREBASE_AUTH_CONFIG, runLoginController } from '../public/js/login.js';

function createMockUser({ uid = 'user-1', claims = {} } = {}) {
  return {
    uid,
    async getIdTokenResult() {
      return { claims };
    }
  };
}

function createDeps(overrides = {}) {
  const calls = {
    setPersistence: [],
    getRedirectResult: 0,
    signInWithRedirect: [],
    signOut: 0,
    navigate: [],
    statuses: []
  };

  const persistenceToken = { type: 'LOCAL' };
  const googleProvider = { providerId: 'google.com' };
  const auth = overrides.auth || {
    currentUser: null,
    async authStateReady() {}
  };

  const deps = {
    auth,
    provider: googleProvider,
    browserLocalPersistence: persistenceToken,
    async setPersistence(authInstance, persistence) {
      calls.setPersistence.push({ authInstance, persistence });
    },
    async getRedirectResult() {
      calls.getRedirectResult += 1;
      return null;
    },
    async signInWithRedirect(authInstance, provider) {
      calls.signInWithRedirect.push({ authInstance, provider });
    },
    async signOut() {
      calls.signOut += 1;
    },
    navigate(url) {
      calls.navigate.push(url);
    },
    setStatus(message) {
      calls.statuses.push(message);
    },
    ...overrides
  };

  return { deps, calls, auth, persistenceToken, googleProvider };
}

test('FIREBASE_AUTH_CONFIG uses same-origin myplaydex.web.app authDomain', () => {
  assert.equal(FIREBASE_AUTH_CONFIG.authDomain, 'myplaydex.web.app');
  assert.equal(FIREBASE_AUTH_CONFIG.projectId, 'myplaydex');
});

test('runLoginController triggers signInWithRedirect with browserLocalPersistence when unauthenticated', async () => {
  const { deps, calls, auth, persistenceToken, googleProvider } = createDeps();

  const result = await runLoginController(deps);

  assert.equal(result.status, 'redirecting-to-login');
  assert.deepEqual(calls.setPersistence, [{ authInstance: auth, persistence: persistenceToken }]);
  assert.equal(calls.getRedirectResult, 1);
  assert.deepEqual(calls.signInWithRedirect, [{ authInstance: auth, provider: googleProvider }]);
  assert.equal(calls.signOut, 0);
  assert.deepEqual(calls.navigate, []);
});

test('runLoginController redirects already-authenticated Admin straight to /admin', async () => {
  const adminUser = createMockUser({ uid: 'admin-1', claims: { admin: true } });
  const { deps, calls } = createDeps({
    auth: {
      currentUser: adminUser,
      async authStateReady() {}
    }
  });

  const result = await runLoginController(deps);

  assert.equal(result.status, 'redirected-admin');
  assert.deepEqual(calls.navigate, ['/admin']);
  assert.deepEqual(calls.signInWithRedirect, []);
  assert.equal(calls.signOut, 0);
});

test('runLoginController redirects returning Admin from Google redirect to /admin', async () => {
  const adminUser = createMockUser({ uid: 'admin-2', claims: { admin: true } });
  const { deps, calls } = createDeps({
    async getRedirectResult() {
      return { user: adminUser };
    }
  });

  const result = await runLoginController(deps);

  assert.equal(result.status, 'redirected-admin');
  assert.deepEqual(calls.navigate, ['/admin']);
  assert.deepEqual(calls.signInWithRedirect, []);
  assert.equal(calls.signOut, 0);
});

test('runLoginController signs out returning non-admin and shows "Access denied." without looping', async () => {
  const nonAdminUser = createMockUser({ uid: 'user-2', claims: { admin: false } });
  const { deps, calls } = createDeps({
    async getRedirectResult() {
      return { user: nonAdminUser };
    }
  });

  const result = await runLoginController(deps);

  assert.equal(result.status, 'access-denied');
  assert.equal(calls.signOut, 1);
  assert.deepEqual(calls.navigate, []);
  assert.deepEqual(calls.signInWithRedirect, []);
  assert.equal(calls.statuses.at(-1), 'Access denied.');
});

test('runLoginController signs out already-authenticated non-admin and shows "Access denied."', async () => {
  const nonAdminUser = createMockUser({ uid: 'user-3', claims: {} });
  const { deps, calls } = createDeps({
    auth: {
      currentUser: nonAdminUser,
      async authStateReady() {}
    }
  });

  const result = await runLoginController(deps);

  assert.equal(result.status, 'access-denied');
  assert.equal(calls.signOut, 1);
  assert.deepEqual(calls.navigate, []);
  assert.deepEqual(calls.signInWithRedirect, []);
  assert.equal(calls.statuses.at(-1), 'Access denied.');
});

test('runLoginController handles auth errors gracefully without redirecting or retrying', async () => {
  const { deps, calls } = createDeps({
    async getRedirectResult() {
      throw new Error('auth/network-request-failed');
    }
  });

  const result = await runLoginController(deps);

  assert.equal(result.status, 'error');
  assert.equal(result.error.message, 'auth/network-request-failed');
  assert.deepEqual(calls.navigate, []);
  assert.deepEqual(calls.signInWithRedirect, []);
  assert.ok(calls.statuses.at(-1).length > 0);
});

test('public/login.html includes noindex/nofollow, status container, and zero-click login module', () => {
  const loginHtml = fs.readFileSync(path.resolve('public/login.html'), 'utf8');
  assert.match(loginHtml, /<meta\s+name="robots"\s+content="noindex,\s*nofollow"\s*\/?>/i);
  assert.match(loginHtml, /id="login-status"/);
  assert.match(loginHtml, /<script\s+type="module"\s+src="\.\/js\/login\.js"><\/script>/);
  assert.ok(!loginHtml.includes('<button'), 'Zero-click /login page must not render a manual login button');
});

test('public / HTML and app scripts remain free of Firebase Auth SDK', () => {
  const indexHtml = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.resolve('public/js/app.js'), 'utf8');
  const analyticsJs = fs.readFileSync(path.resolve('public/js/analytics.js'), 'utf8');

  assert.ok(!indexHtml.includes('firebase-auth'), 'index.html must not load firebase-auth');
  assert.ok(!appJs.includes('firebase-auth'), 'app.js must not load firebase-auth');
  assert.ok(!analyticsJs.includes('firebase-auth'), 'analytics.js must not load firebase-auth');
});

test('firebase.json rewrites /login and /admin before ** and scopes Auth CSP strictly to /login and /admin', () => {
  const config = JSON.parse(fs.readFileSync(path.resolve('firebase.json'), 'utf8'));
  const rewrites = config.hosting.rewrites;

  const loginIndex = rewrites.findIndex((r) => r.source === '/login' && r.destination === '/login.html');
  const adminIndex = rewrites.findIndex((r) => r.source === '/admin' && r.destination === '/admin.html');
  const wildcardIndex = rewrites.findIndex((r) => r.source === '**' && r.destination === '/index.html');

  assert.ok(loginIndex >= 0, 'Must rewrite /login to /login.html');
  assert.ok(adminIndex >= 0, 'Must rewrite /admin to /admin.html');
  assert.ok(wildcardIndex > loginIndex && wildcardIndex > adminIndex, '/login and /admin rewrites must precede **');

  const wildcardHeaderRule = config.hosting.headers.find((h) => h.source === '**');
  const wildcardCsp = wildcardHeaderRule.headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.ok(!wildcardCsp.includes('identitytoolkit.googleapis.com'), 'Strict ** CSP must not include Firebase Auth origins');
  assert.ok(!wildcardCsp.includes('accounts.google.com'), 'Strict ** CSP must not include accounts.google.com');

  const authHeaderRule = config.hosting.headers.find((h) => h.source === '/+(login|admin)?(.html)');
  assert.ok(authHeaderRule, 'Must scope Auth CSP header to /+(login|admin)?(.html)');
  const authCsp = authHeaderRule.headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.ok(authCsp.includes('https://identitytoolkit.googleapis.com'));
  assert.ok(authCsp.includes('https://securetoken.googleapis.com'));
  assert.ok(authCsp.includes('https://accounts.google.com'));
});
