import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAdminController, createAdminWorkspaceController } from '../public/js/admin.js';

function createMockUser({ uid = 'user-1', email = 'admin@myplaydex.com', claims = {} } = {}) {
  return {
    uid,
    email,
    async getIdTokenResult() {
      return { claims };
    }
  };
}

function createDeps(overrides = {}) {
  const calls = {
    setPersistence: [],
    signOut: 0,
    navigate: [],
    statuses: [],
    renderedAdmins: [],
    signedOutCallbacks: 0
  };

  const persistenceToken = { type: 'LOCAL' };
  const auth = overrides.auth || {
    currentUser: null,
    async authStateReady() {}
  };

  const deps = {
    auth,
    browserLocalPersistence: persistenceToken,
    async setPersistence(authInstance, persistence) {
      calls.setPersistence.push({ authInstance, persistence });
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
    onAuthorized(adminUser) {
      calls.renderedAdmins.push(adminUser);
    },
    onSignedOut() {
      calls.signedOutCallbacks += 1;
    },
    ...overrides
  };

  return { deps, calls, auth, persistenceToken };
}

test('runAdminController redirects unauthenticated visitors to /login', async () => {
  const { deps, calls, auth, persistenceToken } = createDeps();

  const result = await runAdminController(deps);

  assert.equal(result.status, 'redirected-to-login');
  assert.deepEqual(calls.setPersistence, [{ authInstance: auth, persistence: persistenceToken }]);
  assert.deepEqual(calls.navigate, ['/login']);
  assert.equal(calls.signOut, 0);
  assert.deepEqual(calls.renderedAdmins, []);
});

test('runAdminController signs out authenticated non-admin and shows "Access denied."', async () => {
  const nonAdminUser = createMockUser({ uid: 'user-2', email: 'visitor@example.com', claims: { admin: false } });
  const { deps, calls } = createDeps({
    auth: {
      currentUser: nonAdminUser,
      async authStateReady() {}
    }
  });

  const result = await runAdminController(deps);

  assert.equal(result.status, 'access-denied');
  assert.equal(calls.signOut, 1);
  assert.deepEqual(calls.navigate, []);
  assert.deepEqual(calls.renderedAdmins, []);
  assert.equal(calls.statuses.at(-1), 'Access denied.');
});

test('runAdminController authorizes verified Admin, surfaces email, and handles sign-out action', async () => {
  const adminUser = createMockUser({ uid: 'admin-1', email: 'alex@myplaydex.com', claims: { admin: true } });
  const { deps, calls } = createDeps({
    auth: {
      currentUser: adminUser,
      async authStateReady() {}
    }
  });

  const result = await runAdminController(deps);

  assert.equal(result.status, 'authorized');
  assert.equal(result.email, 'alex@myplaydex.com');
  assert.deepEqual(calls.renderedAdmins, [{ email: 'alex@myplaydex.com' }]);
  assert.equal(calls.signOut, 0);
  assert.deepEqual(calls.navigate, []);

  await result.handleSignOut();

  assert.equal(calls.signOut, 1);
  assert.equal(calls.signedOutCallbacks, 1);
  assert.equal(calls.statuses.at(-1), 'Signed out.');
});

test('runAdminController handles auth errors gracefully without rendering workspace', async () => {
  const { deps, calls } = createDeps({
    async setPersistence() {
      throw new Error('auth/network-request-failed');
    }
  });

  const result = await runAdminController(deps);

  assert.equal(result.status, 'error');
  assert.equal(result.error.message, 'auth/network-request-failed');
  assert.deepEqual(calls.renderedAdmins, []);
  assert.deepEqual(calls.navigate, []);
  assert.ok(calls.statuses.at(-1).length > 0);
});

test('public/admin.html includes noindex/nofollow, email display, Sign out button, admin-curation container, admin.css, and admin module', () => {
  const adminHtml = fs.readFileSync(path.resolve('public/admin.html'), 'utf8');
  assert.match(adminHtml, /<meta\s+name="robots"\s+content="noindex,\s*nofollow"\s*\/?>/i);
  assert.match(adminHtml, /<link\s+rel="stylesheet"\s+href="\.\/admin\.css"\s*\/?>/);
  assert.match(adminHtml, /id="admin-status"/);
  assert.match(adminHtml, /id="admin-workspace"[^>]*hidden/);
  assert.match(adminHtml, /id="admin-email"/);
  assert.match(adminHtml, /<button[^>]*id="sign-out-btn"[^>]*>Sign out<\/button>/);
  assert.match(adminHtml, /id="admin-curation"/);
  assert.match(adminHtml, /<script\s+type="module"\s+src="\.\/js\/admin\.js"><\/script>/);
});

test('createAdminWorkspaceController hydrates both views, switches without reload, and handles Approve + errors', async () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const snapshots = [];
  let shouldFailApprove = false;
  const approvedCalls = [];

  const repository = {
    async fetchUnreviewedListings() {
      return [
        { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Social Netball', needsReview: true, reviewReason: 'unmatched_venue', createdAtMs: nowMs - 1000 }
      ];
    },
    async fetchNewListingsLast24h() {
      return [
        { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Social Netball', needsReview: true, reviewReason: 'unmatched_venue', createdAtMs: nowMs - 1000 }
      ];
    },
    async approveListing(entityType, docId) {
      approvedCalls.push({ entityType, docId });
      if (shouldFailApprove) {
        throw new Error('permission-denied');
      }
    }
  };

  const controller = createAdminWorkspaceController({
    repository,
    onStateChange: (state) => snapshots.push(state),
    now: () => nowMs
  });

  assert.equal(controller.getState().activeView, 'unreviewed');
  await controller.loadAll();
  assert.equal(controller.getState().unreviewed.length, 1);
  assert.equal(controller.getState().newLast24h.length, 1);

  controller.selectView('new_24h');
  assert.equal(controller.getState().activeView, 'new_24h');

  controller.selectView('unreviewed');
  shouldFailApprove = true;
  await controller.approve('activities', 'a1');
  assert.match(controller.getState().actionError, /Unable to approve/i);
  assert.equal(controller.getState().unreviewed.length, 1);

  shouldFailApprove = false;
  await controller.approve('activities', 'a1');
  assert.equal(controller.getState().actionError, null);
  assert.equal(controller.getState().unreviewed.length, 0);
  assert.equal(controller.getState().newLast24h[0].needsReview, false);
  assert.equal(approvedCalls.length, 2);
  assert.ok(snapshots.length >= 4);
});
