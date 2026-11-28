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

test('createAdminWorkspaceController handles duplicate review: side-by-side load, missing candidate, dismiss, and deleting flagged or candidate', async () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const approvedIds = [];
  const deletedIds = [];

  const candidateDoc = {
    key: 'activities:cand_1',
    docId: 'cand_1',
    id: 'cand_1',
    entityType: 'activities',
    name: 'Twilight Social Futsal',
    needsReview: false,
    reviewReason: null,
    duplicateCandidateId: null
  };

  let unreviewedDocs = [
    {
      key: 'activities:dup_1',
      docId: 'dup_1',
      id: 'dup_1',
      entityType: 'activities',
      name: 'Twilight Futsal',
      needsReview: true,
      reviewReason: 'possible_duplicate',
      duplicateCandidateId: 'cand_1',
      createdAtMs: nowMs - 1000,
      updatedAtMs: nowMs - 1000
    },
    {
      key: 'activities:dup_missing',
      docId: 'dup_missing',
      id: 'dup_missing',
      entityType: 'activities',
      name: 'Orphaned Duplicate',
      needsReview: true,
      reviewReason: 'possible_duplicate',
      duplicateCandidateId: 'gone_1',
      createdAtMs: nowMs - 2000,
      updatedAtMs: nowMs - 2000
    },
    {
      key: 'activities:dup_2',
      docId: 'dup_2',
      id: 'dup_2',
      entityType: 'activities',
      name: 'Sunday Netball',
      needsReview: true,
      reviewReason: 'possible_duplicate',
      duplicateCandidateId: 'cand_2',
      createdAtMs: nowMs - 3000,
      updatedAtMs: nowMs - 3000
    }
  ];

  const candidatesById = {
    cand_1: candidateDoc,
    cand_2: {
      key: 'activities:cand_2',
      docId: 'cand_2',
      id: 'cand_2',
      entityType: 'activities',
      name: 'Sunday Social Netball',
      needsReview: false,
      reviewReason: null,
      duplicateCandidateId: null
    }
  };

  const repository = {
    async fetchUnreviewedListings() {
      return unreviewedDocs;
    },
    async fetchNewListingsLast24h() {
      return unreviewedDocs;
    },
    async fetchListingById(entityType, docId) {
      assert.equal(entityType, 'activities');
      return candidatesById[docId] || null;
    },
    async approveListing(entityType, docId) {
      assert.equal(entityType, 'activities');
      approvedIds.push(docId);
    },
    async deleteListing(entityType, docId) {
      assert.equal(entityType, 'activities');
      deletedIds.push(docId);
      return { deleted: true, blocked: false, linkedActivities: [] };
    }
  };

  const controller = createAdminWorkspaceController({ repository, now: () => nowMs });
  await controller.loadAll();

  // 1. Open possible_duplicate -> loads candidate side-by-side, then dismiss ("Not a duplicate")
  await controller.openDuplicateReview('dup_1');
  assert.equal(controller.getState().duplicateReview.status, 'ready');
  assert.equal(controller.getState().duplicateReview.candidate.docId, 'cand_1');

  await controller.dismissDuplicateFlag();
  assert.deepEqual(approvedIds, ['dup_1']);
  assert.equal(controller.getState().duplicateReview, null);
  assert.equal(controller.getState().unreviewed.some((item) => item.docId === 'dup_1'), false);
  assert.equal(controller.getState().newLast24h.find((item) => item.docId === 'dup_1').needsReview, false);

  // 2. Missing candidate fallback
  await controller.openDuplicateReview('dup_missing');
  assert.equal(controller.getState().duplicateReview.status, 'missing_candidate');
  assert.equal(controller.getState().duplicateReview.candidate, null);

  // Delete flagged from missing_candidate state
  controller.promptDuplicateDelete('flagged');
  assert.equal(controller.getState().duplicateReview.status, 'confirm_delete');
  assert.equal(controller.getState().duplicateReview.confirmDeleteTarget, 'flagged');
  await controller.confirmDuplicateDelete();
  assert.deepEqual(deletedIds, ['dup_missing']);
  assert.equal(controller.getState().duplicateReview, null);
  assert.equal(controller.getState().unreviewed.some((item) => item.docId === 'dup_missing'), false);

  // 3. Delete candidate Activity -> deletes candidate and clears duplicate flag on surviving flagged Activity
  await controller.openDuplicateReview('dup_2');
  assert.equal(controller.getState().duplicateReview.status, 'ready');
  controller.promptDuplicateDelete('candidate');
  assert.equal(controller.getState().duplicateReview.confirmDeleteTarget, 'candidate');
  await controller.confirmDuplicateDelete();
  assert.deepEqual(deletedIds, ['dup_missing', 'cand_2']);
  assert.deepEqual(approvedIds, ['dup_1', 'dup_2']);
  assert.equal(controller.getState().duplicateReview, null);
  assert.equal(controller.getState().unreviewed.some((item) => item.docId === 'dup_2'), false);
  assert.equal(controller.getState().newLast24h.find((item) => item.docId === 'dup_2').needsReview, false);
});

test('createAdminWorkspaceController lazily loads canonical Venues/Organizers, applies picker selections, and cascades Venue/Organizer edits', async () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const fetchCanonicalCalls = [];
  const savedCalls = [];

  const canonicalVenue = {
    key: 'venues:venue_loftus',
    docId: 'venue_loftus',
    id: 'venue_loftus',
    entityType: 'venues',
    name: 'Loftus Recreation Centre',
    address: '99 Loftus St',
    raw: {
      id: 'venue_loftus',
      name: 'Loftus Recreation Centre',
      address: '99 Loftus St',
      coordinates: { lat: -31.9369, lng: 115.8473 },
      geohash: 'qd66hx000',
      google_place_id: 'ChIJ_loftus_123'
    }
  };
  const canonicalOrg = {
    key: 'organizers:org_perth_futsal',
    docId: 'org_perth_futsal',
    id: 'org_perth_futsal',
    entityType: 'organizers',
    name: 'Perth Futsal Club',
    raw: {
      id: 'org_perth_futsal',
      name: 'Perth Futsal Club',
      coordinates: { lat: -31.9369, lng: 115.8473 },
      geohash: 'qd66hx000'
    }
  };
  const unlinkedActivityRaw = {
    id: 'act_unlinked',
    title: 'Friday Futsal',
    description: 'Indoor 5-a-side',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'futsal',
    source_url: 'https://example.com/futsal',
    verified: true,
    organizer: { id: null, name: 'Perth Futsal' },
    venue: { id: null, name: 'Loftus', coordinates: { lat: -31.95, lng: 115.86 }, geohash: 'qd66hr000' },
    schedule: { recurrence: 'weekly', start_date: '2026-12-04', day_of_week: 5 },
    cost: { is_free: false, display_price: '$15' },
    demographics: { gender: 'all', age: 'adults' },
    needs_review: true,
    review_reason: 'unmatched_venue',
    created_at: '2026-11-27T00:00:00.000Z'
  };

  const repository = {
    async fetchUnreviewedListings() {
      return [
        {
          key: 'activities:act_unlinked',
          docId: 'act_unlinked',
          id: 'act_unlinked',
          entityType: 'activities',
          name: 'Friday Futsal',
          venueName: 'Loftus',
          organizerName: 'Perth Futsal',
          needsReview: true,
          reviewReason: 'unmatched_venue',
          createdAtMs: nowMs - 1000,
          raw: unlinkedActivityRaw
        },
        {
          key: 'venues:venue_loftus',
          docId: 'venue_loftus',
          id: 'venue_loftus',
          entityType: 'venues',
          name: 'Loftus Recreation Centre',
          needsReview: true,
          reviewReason: 'crawler_created',
          createdAtMs: nowMs - 2000,
          raw: canonicalVenue.raw
        },
        {
          key: 'organizers:org_perth_futsal',
          docId: 'org_perth_futsal',
          id: 'org_perth_futsal',
          entityType: 'organizers',
          name: 'Perth Futsal Club',
          needsReview: true,
          reviewReason: 'crawler_created',
          createdAtMs: nowMs - 3000,
          raw: canonicalOrg.raw
        }
      ];
    },
    async fetchNewListingsLast24h() {
      return [];
    },
    async fetchCanonicalEntities(entityType) {
      fetchCanonicalCalls.push(entityType);
      return entityType === 'venues' ? [canonicalVenue] : [canonicalOrg];
    },
    async saveListing(entityType, docId, originalDoc, parsedValues) {
      savedCalls.push({ entityType, docId, parsedValues });
      if (entityType === 'activities') {
        return {
          nextRawDoc: {
            ...originalDoc,
            title: parsedValues.title,
            venue: {
              id: parsedValues.venue_id,
              name: parsedValues.venue_name,
              coordinates: { lat: parsedValues.lat, lng: parsedValues.lng },
              geohash: 'qd66hx000',
              ...(parsedValues.venue_google_place_id ? { google_place_id: parsedValues.venue_google_place_id } : {})
            },
            organizer: {
              id: parsedValues.organizer_id,
              name: parsedValues.organizer_name
            },
            needs_review: false,
            review_reason: null,
            updated_at: nowMs
          }
        };
      }
      if (entityType === 'venues') {
        return {
          nextRawDoc: {
            ...originalDoc,
            name: parsedValues.name,
            coordinates: { lat: parsedValues.lat, lng: parsedValues.lng },
            geohash: 'qd66hx111',
            needs_review: false,
            review_reason: null,
            updated_at: nowMs
          }
        };
      }
      return {
        nextRawDoc: {
          ...originalDoc,
          name: parsedValues.name,
          needs_review: false,
          review_reason: null,
          updated_at: nowMs
        }
      };
    }
  };

  const controller = createAdminWorkspaceController({ repository, now: () => nowMs });
  await controller.loadAll();

  // Opening Activity edit drawer triggers canonical fetch once
  controller.openEdit('activities', 'act_unlinked');
  await controller.loadCanonicalEntities();
  assert.deepEqual(fetchCanonicalCalls.sort(), ['organizers', 'venues']);
  assert.equal(controller.getState().canonicalEntitiesLoaded, true);
  assert.equal(controller.getState().canonicalVenues.length, 1);

  // Selecting canonical Venue & Organizer preserves in-progress form edits
  const inProgressValues = {
    ...controller.getState().editDrawer.values,
    title: 'Friday Night Futsal'
  };
  controller.selectCanonicalVenue('venue_loftus', inProgressValues);
  assert.equal(controller.getState().editDrawer.values.title, 'Friday Night Futsal');
  assert.equal(controller.getState().editDrawer.values.venue_id, 'venue_loftus');
  assert.equal(controller.getState().editDrawer.values.venue_name, 'Loftus Recreation Centre');
  assert.equal(controller.getState().editDrawer.values.venue_google_place_id, 'ChIJ_loftus_123');
  assert.equal(controller.getState().editDrawer.values.lat, '-31.9369');
  assert.equal(controller.getState().editDrawer.readOnly.geohash, 'qd66hx000');

  controller.selectCanonicalOrganizer('org_perth_futsal', controller.getState().editDrawer.values);
  assert.equal(controller.getState().editDrawer.values.organizer_id, 'org_perth_futsal');
  assert.equal(controller.getState().editDrawer.values.organizer_name, 'Perth Futsal Club');

  // Save Activity -> persists linked Venue + Organizer
  await controller.saveEdit(controller.getState().editDrawer.values);
  assert.equal(savedCalls[0].entityType, 'activities');
  assert.equal(savedCalls[0].parsedValues.venue_id, 'venue_loftus');
  assert.equal(savedCalls[0].parsedValues.venue_google_place_id, 'ChIJ_loftus_123');
  assert.equal(savedCalls[0].parsedValues.organizer_id, 'org_perth_futsal');
});
