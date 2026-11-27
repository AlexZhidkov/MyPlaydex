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
  assert.match(adminHtml, /<dialog[^>]*id="admin-delete-dialog"[^>]*aria-labelledby="delete-dialog-title"/);
  assert.match(adminHtml, /<dialog[^>]*id="admin-edit-dialog"[^>]*aria-labelledby="edit-dialog-title"/);
  assert.doesNotMatch(adminHtml, /role="dialog"|aria-modal/);
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

test('createAdminWorkspaceController handles Activity deletion, blocked Venue/Organizer deletion, unreferenced deletion, and errors', async () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const deletedCalls = [];
  let linkedByEntity = {
    'venues:v_ref': [{ id: 'a1', docId: 'a1', title: 'Social Netball' }],
    'venues:v_free': [],
    'organizers:o_ref': [{ id: 'a1', docId: 'a1', title: 'Social Netball' }],
    'organizers:o_free': []
  };
  let shouldFailLinkedQuery = false;
  let shouldFailDelete = false;

  const repository = {
    async fetchUnreviewedListings() {
      return [
        { key: 'activities:a1', docId: 'a1', id: 'a1', entityType: 'activities', name: 'Social Netball', needsReview: true, createdAtMs: nowMs - 1000 },
        { key: 'venues:v_ref', docId: 'v_ref', id: 'v_ref', entityType: 'venues', name: 'Referenced Venue', needsReview: true, createdAtMs: nowMs - 2000 },
        { key: 'organizers:o_free', docId: 'o_free', id: 'o_free', entityType: 'organizers', name: 'Empty Club', needsReview: true, createdAtMs: nowMs - 3000 }
      ];
    },
    async fetchNewListingsLast24h() {
      return [
        { key: 'activities:a1', docId: 'a1', id: 'a1', entityType: 'activities', name: 'Social Netball', createdAtMs: nowMs - 1000 },
        { key: 'venues:v_free', docId: 'v_free', id: 'v_free', entityType: 'venues', name: 'Unused Venue', createdAtMs: nowMs - 1500 },
        { key: 'organizers:o_ref', docId: 'o_ref', id: 'o_ref', entityType: 'organizers', name: 'Busy Club', createdAtMs: nowMs - 2500 }
      ];
    },
    async approveListing() {},
    async findLinkedActivities(entityType, entityId) {
      if (shouldFailLinkedQuery) throw new Error('network-error');
      return linkedByEntity[`${entityType}:${entityId}`] || [];
    },
    async deleteListing(entityType, docId) {
      deletedCalls.push({ entityType, docId });
      if (shouldFailDelete) throw new Error('permission-denied');
      return { deleted: true, blocked: false, linkedActivities: [] };
    }
  };

  const controller = createAdminWorkspaceController({ repository, now: () => nowMs });
  await controller.loadAll();

  // 1. Referenced Venue is blocked with linked activities
  await controller.requestDelete('venues', 'v_ref');
  assert.equal(controller.getState().deleteDialog.status, 'blocked');
  assert.equal(controller.getState().deleteDialog.linkedActivities.length, 1);
  assert.equal(deletedCalls.length, 0);
  controller.cancelDelete();
  assert.equal(controller.getState().deleteDialog, null);

  // 2. Referenced Organizer is blocked with linked activities
  await controller.requestDelete('organizers', 'o_ref');
  assert.equal(controller.getState().deleteDialog.status, 'blocked');
  assert.equal(controller.getState().deleteDialog.linkedActivities[0].id, 'a1');
  controller.cancelDelete();

  // 3. Linked-activity query failure surfaces error state
  shouldFailLinkedQuery = true;
  await controller.requestDelete('venues', 'v_free');
  assert.equal(controller.getState().deleteDialog.status, 'error');
  controller.cancelDelete();
  shouldFailLinkedQuery = false;

  // 4. Activity deletion: confirm -> fail once -> succeed and remove from both lists
  await controller.requestDelete('activities', 'a1');
  assert.equal(controller.getState().deleteDialog.status, 'confirm');

  shouldFailDelete = true;
  await controller.confirmDelete();
  assert.equal(controller.getState().deleteDialog.status, 'confirm');
  assert.match(controller.getState().deleteDialog.error, /Unable to delete/i);
  assert.equal(controller.getState().unreviewed.some((item) => item.key === 'activities:a1'), true);

  shouldFailDelete = false;
  await controller.confirmDelete();
  assert.equal(controller.getState().deleteDialog, null);
  assert.equal(controller.getState().unreviewed.some((item) => item.key === 'activities:a1'), false);
  assert.equal(controller.getState().newLast24h.some((item) => item.key === 'activities:a1'), false);

  // 5. Unreferenced Organizer and Venue can be deleted after confirmation
  await controller.requestDelete('organizers', 'o_free');
  assert.equal(controller.getState().deleteDialog.status, 'confirm');
  await controller.confirmDelete();
  assert.equal(controller.getState().unreviewed.some((item) => item.key === 'organizers:o_free'), false);

  await controller.requestDelete('venues', 'v_free');
  assert.equal(controller.getState().deleteDialog.status, 'confirm');
  await controller.confirmDelete();
  assert.equal(controller.getState().newLast24h.some((item) => item.key === 'venues:v_free'), false);
});

test('createAdminWorkspaceController handles openEdit, validation errors, saveEdit failure/success, and closeEdit', async () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const savedCalls = [];
  let shouldFailSave = false;

  const rawVenue = {
    id: 'v1',
    source: 'google_places',
    source_id: 'ChIJ_v1',
    name: 'Langley Park',
    description: '',
    address: 'Riverside Dr',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'soccer',
    subcategories: ['soccer'],
    coordinates: { lat: -31.9598, lng: 115.8693 },
    geohash: 'qd66hr9z1',
    source_url: 'https://perth.wa.gov.au',
    verified: true,
    needs_review: true,
    review_reason: 'crawler_created',
    curated_fields: ['address'],
    created_at: '2026-11-27T00:00:00.000Z'
  };

  const repository = {
    async fetchUnreviewedListings() {
      return [
        {
          key: 'venues:v1',
          docId: 'v1',
          id: 'v1',
          entityType: 'venues',
          name: 'Langley Park',
          needsReview: true,
          reviewReason: 'crawler_created',
          createdAtMs: nowMs - 1000,
          raw: rawVenue
        }
      ];
    },
    async fetchNewListingsLast24h() {
      return [
        {
          key: 'venues:v1',
          docId: 'v1',
          id: 'v1',
          entityType: 'venues',
          name: 'Langley Park',
          needsReview: true,
          reviewReason: 'crawler_created',
          createdAtMs: nowMs - 1000,
          raw: rawVenue
        }
      ];
    },
    async approveListing() {},
    async saveListing(entityType, docId, originalDoc, parsedValues) {
      savedCalls.push({ entityType, docId, parsedValues });
      if (shouldFailSave) {
        throw new Error('permission-denied');
      }
      return {
        nextRawDoc: {
          ...originalDoc,
          ...parsedValues,
          coordinates: { lat: parsedValues.lat, lng: parsedValues.lng },
          geohash: 'qd66hxxxx',
          needs_review: false,
          review_reason: null,
          curated_fields: ['address', 'name', 'source_url', 'verified']
        }
      };
    }
  };

  const controller = createAdminWorkspaceController({ repository, now: () => nowMs });
  await controller.loadAll();

  // Open edit drawer
  controller.openEdit('venues', 'v1');
  assert.equal(controller.getState().editDrawer.status, 'editing');
  assert.equal(controller.getState().editDrawer.values.name, 'Langley Park');

  // Validation error keeps drawer open and does not call repository
  await controller.saveEdit({
    ...controller.getState().editDrawer.values,
    name: ''
  });
  assert.equal(savedCalls.length, 0);
  assert.equal(controller.getState().editDrawer.status, 'editing');
  assert.ok(controller.getState().editDrawer.fieldErrors.name);

  // Repository failure surfaces error in drawer
  shouldFailSave = true;
  await controller.saveEdit({
    ...controller.getState().editDrawer.values,
    name: 'Langley Park Oval',
    source_url: '',
    verified: true
  });
  assert.equal(savedCalls.length, 1);
  assert.equal(savedCalls[0].parsedValues.verified, false);
  assert.equal(controller.getState().editDrawer.status, 'editing');
  assert.match(controller.getState().editDrawer.error, /Unable to save/i);

  // Successful save closes drawer, removes from unreviewed, and updates newLast24h
  shouldFailSave = false;
  await controller.saveEdit({
    ...controller.getState().editDrawer.values,
    name: 'Langley Park Oval',
    source_url: '',
    verified: true
  });
  assert.equal(controller.getState().editDrawer, null);
  assert.equal(controller.getState().unreviewed.length, 0);
  assert.equal(controller.getState().newLast24h[0].name, 'Langley Park Oval');
  assert.equal(controller.getState().newLast24h[0].needsReview, false);
  assert.equal(controller.getState().newLast24h[0].verified, false);

  // Close edit drawer cleanly
  controller.openEdit('venues', 'v1');
  assert.ok(controller.getState().editDrawer);
  controller.closeEdit();
  assert.equal(controller.getState().editDrawer, null);
});
