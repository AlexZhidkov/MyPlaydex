import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTITY_TYPES,
  TWENTY_FOUR_HOURS_MS,
  formatReviewReason,
  toEpochMs,
  isWithinLast24Hours,
  normalizeListingDoc,
  createAdminFirestoreRepository
} from '../public/js/admin-data.js';

test('toEpochMs handles Firestore Timestamps, plain seconds objects, Dates, ISO strings, and numbers', () => {
  const fixedMs = Date.UTC(2026, 10, 27, 10, 0, 0);
  assert.equal(toEpochMs({ toMillis: () => fixedMs }), fixedMs);
  assert.equal(toEpochMs({ toDate: () => new Date(fixedMs) }), fixedMs);
  assert.equal(toEpochMs({ seconds: Math.floor(fixedMs / 1000), nanoseconds: 500_000_000 }), fixedMs + 500);
  assert.equal(toEpochMs({ _seconds: Math.floor(fixedMs / 1000), _nanoseconds: 0 }), fixedMs);
  assert.equal(toEpochMs(new Date(fixedMs)), fixedMs);
  assert.equal(toEpochMs('2026-11-27T10:00:00.000Z'), fixedMs);
  assert.equal(toEpochMs(fixedMs), fixedMs);
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs('not-a-date'), null);
});

test('isWithinLast24Hours enforces strict 24-hour cutoff', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  assert.equal(isWithinLast24Hours(nowMs, nowMs), true);
  assert.equal(isWithinLast24Hours(nowMs - TWENTY_FOUR_HOURS_MS, nowMs), true);
  assert.equal(isWithinLast24Hours(nowMs - TWENTY_FOUR_HOURS_MS - 1, nowMs), false);
  assert.equal(isWithinLast24Hours(null, nowMs), false);
});

test('formatReviewReason formats known and unknown reasons into sentence case', () => {
  assert.equal(formatReviewReason('unmatched_venue'), 'Unmatched venue');
  assert.equal(formatReviewReason('possible_duplicate'), 'Possible duplicate');
  assert.equal(formatReviewReason('custom_crawler_flag'), 'Custom crawler flag');
  assert.equal(formatReviewReason(null), 'Unspecified');
});

test('normalizeListingDoc normalizes activity, organizer, and venue fields', () => {
  const createdMs = Date.UTC(2026, 10, 27, 8, 0, 0);
  const updatedMs = Date.UTC(2026, 10, 27, 9, 0, 0);

  const activity = normalizeListingDoc('activities', 'eventbrite_123', {
    id: 'eventbrite_123',
    title: 'Twilight Social Soccer',
    category: 'sports',
    subcategory: 'soccer',
    source: 'eventbrite',
    source_url: 'https://example.com/soccer',
    verified: true,
    needs_review: true,
    review_reason: 'unmatched_venue',
    organizer: { id: 'org_1', name: 'Perth Social FC' },
    venue: { id: null, name: 'Langley Park' },
    schedule: { start_date: '2026-11-28', start_time: '18:00' },
    created_at: { toMillis: () => createdMs },
    updated_at: { toMillis: () => updatedMs }
  });

  assert.equal(activity.key, 'activities:eventbrite_123');
  assert.equal(activity.entityType, 'activities');
  assert.equal(activity.name, 'Twilight Social Soccer');
  assert.equal(activity.organizerName, 'Perth Social FC');
  assert.equal(activity.venueName, 'Langley Park');
  assert.equal(activity.needsReview, true);
  assert.equal(activity.reviewReason, 'unmatched_venue');
  assert.equal(activity.createdAtMs, createdMs);
  assert.equal(activity.updatedAtMs, updatedMs);
});

test('createAdminFirestoreRepository runs single-field queries and 1-click Approve updateDoc', async () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const calls = {
    collections: [],
    wheres: [],
    queries: [],
    updateDocs: []
  };

  const mockDocsByCollection = {
    activities: [
      {
        id: 'act_1',
        data: () => ({
          id: 'act_1',
          title: 'Morning Yoga',
          needs_review: true,
          review_reason: 'unmatched_organizer',
          created_at: { toMillis: () => nowMs - 3600_000 }
        })
      }
    ],
    organizers: [
      {
        id: 'org_1',
        data: () => ({
          id: 'org_1',
          name: 'Swan River Runners',
          needs_review: true,
          review_reason: 'crawler_created',
          created_at: { toMillis: () => nowMs - TWENTY_FOUR_HOURS_MS - 5000 }
        })
      }
    ],
    venues: []
  };

  const firestoreSdk = {
    collection(db, name) {
      calls.collections.push(name);
      return { db, name };
    },
    where(field, op, value) {
      const w = { field, op, value };
      calls.wheres.push(w);
      return w;
    },
    query(colRef, ...constraints) {
      assert.equal(constraints.length, 1, 'Must use single-field query with no composite index');
      const q = { colRef, constraints };
      calls.queries.push(q);
      return q;
    },
    async getDocs(q) {
      return { docs: mockDocsByCollection[q.colRef.name] || [] };
    },
    doc(db, colName, docId) {
      return { db, colName, docId };
    },
    async updateDoc(docRef, payload) {
      calls.updateDocs.push({ docRef, payload });
    },
    deleteField() {
      return { __type: 'deleteField' };
    },
    serverTimestamp() {
      return { __type: 'serverTimestamp' };
    },
    Timestamp: {
      fromDate(d) {
        return { __type: 'Timestamp', ms: d.getTime() };
      }
    }
  };

  const repo = createAdminFirestoreRepository({
    db: { name: 'mock-db' },
    firestoreSdk,
    now: () => nowMs
  });

  const unreviewed = await repo.fetchUnreviewedListings();
  assert.equal(unreviewed.length, 2);
  assert.deepEqual(
    calls.wheres.slice(0, 3),
    ENTITY_TYPES.map(() => ({ field: 'needs_review', op: '==', value: true }))
  );

  const last24h = await repo.fetchNewListingsLast24h(nowMs);
  assert.equal(last24h.length, 1);
  assert.equal(last24h[0].id, 'act_1');
  assert.deepEqual(
    calls.wheres.slice(3, 6).map((w) => [w.field, w.op, w.value.ms]),
    ENTITY_TYPES.map(() => ['created_at', '>=', nowMs - TWENTY_FOUR_HOURS_MS])
  );

  await repo.approveListing('activities', 'act_1');
  assert.equal(calls.updateDocs.length, 1);
  assert.deepEqual(calls.updateDocs[0], {
    docRef: { db: { name: 'mock-db' }, colName: 'activities', docId: 'act_1' },
    payload: {
      needs_review: false,
      review_reason: null,
      duplicate_candidate_id: { __type: 'deleteField' },
      updated_at: { __type: 'serverTimestamp' }
    }
  });
});

test('createAdminFirestoreRepository.findLinkedActivities queries venue.id and organizer.id deterministically', async () => {
  const calls = { wheres: [] };
  const activitiesDocs = [
    { id: 'act_b', data: () => ({ id: 'act_b', title: 'Zumba Class' }) },
    { id: 'act_a', data: () => ({ id: 'act_a', title: 'Aqua Aerobics' }) }
  ];

  const firestoreSdk = {
    collection(db, name) {
      return { db, name };
    },
    where(field, op, value) {
      const w = { field, op, value };
      calls.wheres.push(w);
      return w;
    },
    query(colRef, ...constraints) {
      assert.equal(constraints.length, 1);
      return { colRef, constraints };
    },
    async getDocs(q) {
      assert.equal(q.colRef.name, 'activities');
      return { docs: activitiesDocs };
    }
  };

  const repo = createAdminFirestoreRepository({ db: { name: 'mock-db' }, firestoreSdk });

  assert.deepEqual(await repo.findLinkedActivities('activities', 'act_a'), []);

  const venueLinked = await repo.findLinkedActivities('venues', 'venue_beatty');
  assert.deepEqual(calls.wheres[0], { field: 'venue.id', op: '==', value: 'venue_beatty' });
  assert.deepEqual(venueLinked, [
    { id: 'act_a', docId: 'act_a', title: 'Aqua Aerobics' },
    { id: 'act_b', docId: 'act_b', title: 'Zumba Class' }
  ]);

  const orgLinked = await repo.findLinkedActivities('organizers', 'org_perth');
  assert.deepEqual(calls.wheres[1], { field: 'organizer.id', op: '==', value: 'org_perth' });
  assert.equal(orgLinked.length, 2);
});

test('createAdminFirestoreRepository.deleteListing deletes Activities, blocks referenced Venues/Organizers, and deletes unreferenced ones', async () => {
  const deletedRefs = [];
  let linkedByField = {
    'venue.id': [{ id: 'act_1', data: () => ({ id: 'act_1', title: 'Saturday Futsal' }) }],
    'organizer.id': []
  };

  const firestoreSdk = {
    collection(db, name) {
      return { db, name };
    },
    where(field, op, value) {
      return { field, op, value };
    },
    query(colRef, constraint) {
      return { colRef, constraint };
    },
    async getDocs(q) {
      return { docs: linkedByField[q.constraint.field] || [] };
    },
    doc(db, colName, docId) {
      return { db, colName, docId };
    },
    async deleteDoc(docRef) {
      deletedRefs.push(docRef);
    }
  };

  const repo = createAdminFirestoreRepository({ db: { name: 'mock-db' }, firestoreSdk });

  // Activity deletes directly without querying linked activities
  const actResult = await repo.deleteListing('activities', 'act_1');
  assert.deepEqual(actResult, { deleted: true, blocked: false, linkedActivities: [] });
  assert.equal(deletedRefs.length, 1);
  assert.deepEqual(deletedRefs[0], { db: { name: 'mock-db' }, colName: 'activities', docId: 'act_1' });

  // Referenced Venue is blocked and deleteDoc is not called
  const blockedVenue = await repo.deleteListing('venues', 'venue_1');
  assert.equal(blockedVenue.deleted, false);
  assert.equal(blockedVenue.blocked, true);
  assert.deepEqual(blockedVenue.linkedActivities, [
    { id: 'act_1', docId: 'act_1', title: 'Saturday Futsal' }
  ]);
  assert.equal(deletedRefs.length, 1);

  // Unreferenced Organizer deletes cleanly
  const orgResult = await repo.deleteListing('organizers', 'org_1');
  assert.deepEqual(orgResult, { deleted: true, blocked: false, linkedActivities: [] });
  assert.equal(deletedRefs.length, 2);
  assert.deepEqual(deletedRefs[1], { db: { name: 'mock-db' }, colName: 'organizers', docId: 'org_1' });
});

import {
  VIEWS,
  createAdminWorkspaceState,
  setActiveView,
  setEntityFilter,
  setReasonFilter,
  getEntityCounts,
  getReviewReasonOptions,
  getVisibleUnreviewedListings,
  getNewListingsLast24hViewModel,
  markApproving,
  applyListingApproved,
  openDeleteDialog,
  setDeleteDialogState,
  closeDeleteDialog,
  markDeleting,
  applyListingDeleted,
  openDuplicateReview,
  setDuplicateReviewState,
  closeDuplicateReview
} from '../public/js/admin-state.js';

test('admin-state defaults to Unreviewed Listings and switches views cleanly', () => {
  let state = createAdminWorkspaceState();
  assert.equal(state.activeView, VIEWS.UNREVIEWED);
  assert.equal(state.entityFilter, 'all');
  assert.equal(state.reasonFilter, 'all');

  state = { ...state, actionError: 'Previous error' };
  state = setActiveView(state, VIEWS.NEW_24H);
  assert.equal(state.activeView, VIEWS.NEW_24H);
  assert.equal(state.actionError, null);
});

test('admin-state filters Unreviewed Listings by entityType and review_reason with live counts', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const sample = [
    { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Basketball', reviewReason: 'unmatched_venue', createdAtMs: nowMs - 1000, updatedAtMs: nowMs - 500 },
    { key: 'activities:a2', docId: 'a2', entityType: 'activities', name: 'Futsal', reviewReason: 'possible_duplicate', createdAtMs: nowMs - 2000, updatedAtMs: nowMs - 200 },
    { key: 'organizers:o1', docId: 'o1', entityType: 'organizers', name: 'Perth Club', reviewReason: 'crawler_created', createdAtMs: nowMs - 3000, updatedAtMs: nowMs - 100 }
  ];

  let state = { ...createAdminWorkspaceState(), unreviewed: sample };
  assert.deepEqual(getEntityCounts(state.unreviewed), { all: 3, activities: 2, organizers: 1, venues: 0 });

  const allReasons = getReviewReasonOptions(state.unreviewed, 'all');
  assert.equal(allReasons.length, 3);

  state = setEntityFilter(state, 'activities');
  state = setReasonFilter(state, 'possible_duplicate');
  const visible = getVisibleUnreviewedListings(state);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].docId, 'a2');

  // Switching entityFilter to organizers resets reasonFilter because possible_duplicate has 0 matches there
  state = setEntityFilter(state, 'organizers');
  assert.equal(state.reasonFilter, 'all');
  assert.equal(getVisibleUnreviewedListings(state).length, 1);
});

test('admin-state groups New (Last 24h) strictly within 24h by Activities, Organizers, Venues with counts', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const state = {
    ...createAdminWorkspaceState(),
    newLast24h: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Fresh Activity', createdAtMs: nowMs - 3600_000 },
      { key: 'activities:a_old', docId: 'a_old', entityType: 'activities', name: 'Stale Activity', createdAtMs: nowMs - TWENTY_FOUR_HOURS_MS - 10 },
      { key: 'venues:v1', docId: 'v1', entityType: 'venues', name: 'Fresh Venue', createdAtMs: nowMs - 1800_000 }
    ]
  };

  const vm = getNewListingsLast24hViewModel(state, nowMs);
  assert.deepEqual(vm.counts, { all: 2, activities: 1, organizers: 0, venues: 1 });
  assert.equal(vm.groups.length, 3);
  assert.equal(vm.groups[0].entityType, 'activities');
  assert.equal(vm.groups[0].count, 1);
  assert.equal(vm.groups[1].entityType, 'organizers');
  assert.equal(vm.groups[1].count, 0);
  assert.equal(vm.groups[2].entityType, 'venues');
  assert.equal(vm.groups[2].count, 1);
});

test('applyListingApproved removes row from unreviewed and updates matching row in newLast24h', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  let state = {
    ...createAdminWorkspaceState(),
    unreviewed: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Yoga', needsReview: true, reviewReason: 'unmatched_venue' }
    ],
    newLast24h: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Yoga', needsReview: true, reviewReason: 'unmatched_venue', duplicateCandidateId: 'a0' }
    ]
  };

  state = { ...state, reasonFilter: 'unmatched_venue' };
  state = markApproving(state, 'activities:a1', true);
  assert.equal(state.approvingKeys.has('activities:a1'), true);

  state = applyListingApproved(state, 'activities', 'a1', nowMs);
  assert.equal(state.unreviewed.length, 0);
  assert.equal(state.reasonFilter, 'all');
  assert.equal(state.approvingKeys.has('activities:a1'), false);
  assert.equal(state.newLast24h[0].needsReview, false);
  assert.equal(state.newLast24h[0].reviewReason, null);
  assert.equal(state.newLast24h[0].duplicateCandidateId, null);
  assert.equal(state.newLast24h[0].updatedAtMs, nowMs);
});

test('admin-state manages deleteDialog lifecycle, markDeleting, and applyListingDeleted', () => {
  let state = {
    ...createAdminWorkspaceState(),
    reasonFilter: 'unmatched_venue',
    unreviewed: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Yoga', reviewReason: 'unmatched_venue' }
    ],
    newLast24h: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Yoga' },
      { key: 'venues:v1', docId: 'v1', entityType: 'venues', name: 'Beatty Park' }
    ]
  };

  assert.equal(state.deleteDialog, null);
  assert.equal(state.deletingKeys.size, 0);

  state = openDeleteDialog(state, { entityType: 'activities', docId: 'a1', entityId: 'a1', name: 'Yoga' }, 'confirm');
  assert.deepEqual(state.deleteDialog, {
    status: 'confirm',
    entityType: 'activities',
    docId: 'a1',
    entityId: 'a1',
    name: 'Yoga',
    linkedActivities: [],
    error: null
  });

  state = setDeleteDialogState(state, { status: 'deleting' });
  assert.equal(state.deleteDialog.status, 'deleting');

  state = markDeleting(state, 'activities:a1', true);
  assert.equal(state.deletingKeys.has('activities:a1'), true);

  state = applyListingDeleted(state, 'activities', 'a1');
  assert.equal(state.unreviewed.length, 0);
  assert.equal(state.newLast24h.length, 1);
  assert.equal(state.newLast24h[0].key, 'venues:v1');
  assert.equal(state.reasonFilter, 'all');
  assert.equal(state.deletingKeys.has('activities:a1'), false);
  assert.equal(state.deleteDialog, null);
  assert.equal(state.actionError, null);

  state = openDeleteDialog(state, { entityType: 'venues', docId: 'v1', entityId: 'v1', name: 'Beatty Park' }, 'checking');
  state = closeDeleteDialog(state);
  assert.equal(state.deleteDialog, null);
});

import { renderWorkspaceHtml, renderDeleteDialogHtml, renderDuplicateReviewDialogHtml } from '../public/js/admin-ui.js';

test('renderWorkspaceHtml renders Unreviewed Listings view with entity tabs, reason select, Approve button, and XSS escaping', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const state = {
    ...createAdminWorkspaceState(),
    unreviewed: [
      {
        key: 'activities:a1',
        docId: 'a1',
        entityType: 'activities',
        name: 'Twilight <script>alert(1)</script> Soccer',
        category: 'sports',
        subcategory: 'soccer',
        source: 'eventbrite',
        sourceUrl: 'https://example.com/soccer',
        needsReview: true,
        reviewReason: 'unmatched_venue',
        organizerName: 'Perth FC',
        venueName: 'Langley Park',
        schedule: { start_date: '2026-11-28', start_time: '18:00' },
        createdAtMs: nowMs - 3600_000,
        updatedAtMs: nowMs - 1800_000
      }
    ],
    newLast24h: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Twilight Soccer', createdAtMs: nowMs - 3600_000 }
    ]
  };

  const html = renderWorkspaceHtml(state, nowMs);
  assert.match(html, /Unreviewed Listings/);
  assert.match(html, /New \(Last 24h\)/);
  assert.match(html, /id="reason-filter"/);
  assert.match(html, /data-action="approve"/);
  assert.match(html, /data-entity-type="activities"/);
  assert.match(html, /data-doc-id="a1"/);
  assert.match(html, /Unmatched venue/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('renderWorkspaceHtml renders New (Last 24h) view grouped by Activities, Organizers, Venues with counts and no time-window toggles', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  let state = {
    ...createAdminWorkspaceState(),
    newLast24h: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Fresh Activity', needsReview: true, reviewReason: 'unmatched_venue', createdAtMs: nowMs - 3600_000 },
      { key: 'organizers:o1', docId: 'o1', entityType: 'organizers', name: 'Fresh Organizer', needsReview: false, createdAtMs: nowMs - 7200_000 }
    ]
  };
  state = setActiveView(state, VIEWS.NEW_24H);

  const html = renderWorkspaceHtml(state, nowMs);
  assert.match(html, /Listings created in the last 24 hours/);
  assert.match(html, /<h2[^>]*>Activities/);
  assert.match(html, /<h2[^>]*>Organizers/);
  assert.match(html, /<h2[^>]*>Venues/);
  assert.doesNotMatch(html, /id="reason-filter"/);
  assert.doesNotMatch(html, /Last 7 days|Last 48 hours|Last 12 hours/i);
  assert.match(html, /Needs review/);
  assert.match(html, /Reviewed/);
  assert.match(html, /data-action="delete"/);
});

test('renderDeleteDialogHtml renders confirm, blocked, checking, and error states with XSS escaping', () => {
  assert.equal(renderDeleteDialogHtml(null), '');

  const checkingHtml = renderDeleteDialogHtml({
    status: 'checking',
    entityType: 'venues',
    docId: 'v1',
    entityId: 'v1',
    name: 'Beatty Park',
    linkedActivities: [],
    error: null
  });
  assert.match(checkingHtml, /<h1 id="delete-dialog-title"/);
  assert.match(checkingHtml, /Checking linked Activities/);
  assert.match(checkingHtml, /data-action="cancel-delete"/);
  assert.match(checkingHtml, /autofocus/);
  assert.doesNotMatch(checkingHtml, /data-action="confirm-delete"/);

  const blockedHtml = renderDeleteDialogHtml({
    status: 'blocked',
    entityType: 'venues',
    docId: 'v1',
    entityId: 'v1',
    name: 'Beatty <script>alert(1)</script> Park',
    linkedActivities: [
      { id: 'act_1', docId: 'act_1', title: 'Aqua <img src=x onerror=alert(1)>' },
      { id: 'act_2', docId: 'act_2', title: 'Lap Swimming' }
    ],
    error: null
  });
  assert.match(blockedHtml, /Cannot delete Venue/);
  assert.match(blockedHtml, /2 Activities/);
  assert.match(blockedHtml, /act_1/);
  assert.match(blockedHtml, /Lap Swimming/);
  assert.match(blockedHtml, /<form method="dialog"/);
  assert.doesNotMatch(blockedHtml, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(blockedHtml, /<img src=x/);
  assert.doesNotMatch(blockedHtml, /data-action="confirm-delete"/);

  const errorHtml = renderDeleteDialogHtml({
    status: 'error',
    entityType: 'organizers',
    docId: 'org_1',
    entityId: 'org_1',
    name: 'Perth Club',
    linkedActivities: [],
    error: 'Unable to check linked Activities right now.'
  });
  assert.match(errorHtml, /Unable to delete Organizer/);
  assert.match(errorHtml, /role="alert"/);
  assert.doesNotMatch(errorHtml, /data-action="confirm-delete"/);

  const confirmVenueHtml = renderDeleteDialogHtml({
    status: 'confirm',
    entityType: 'venues',
    docId: 'v1',
    entityId: 'v1',
    name: 'Beatty Park',
    linkedActivities: [],
    error: null
  });
  assert.match(confirmVenueHtml, /Delete Venue\?/);
  assert.match(confirmVenueHtml, /No linked Activities reference this venue\./);
  assert.match(confirmVenueHtml, /data-action="cancel-delete"[^>]*autofocus|autofocus[^>]*data-action="cancel-delete"/);
  assert.match(confirmVenueHtml, /data-action="confirm-delete"/);
});

import {
  openEditDrawer,
  setEditDrawerState,
  closeEditDrawer,
  markSaving,
  applyListingSaved,
  setCanonicalEntitiesState
} from '../public/js/admin-state.js';
import { renderEditDrawerHtml, renderCanonicalPickerResultsHtml } from '../public/js/admin-ui.js';

test('normalizeListingDoc preserves raw document, sourceId, and curatedFields', () => {
  const raw = {
    id: 'venue_1',
    source: 'google_places',
    source_id: 'ChIJ_1',
    name: 'Beatty Park',
    curated_fields: ['name', 'address']
  };
  const normalized = normalizeListingDoc('venues', 'venue_1', raw);
  assert.equal(normalized.raw, raw);
  assert.equal(normalized.sourceId, 'ChIJ_1');
  assert.deepEqual(normalized.curatedFields, ['name', 'address']);
});

test('createAdminFirestoreRepository.saveListing updates Firestore with curated_fields, derived fields, and auto-approve', async () => {
  const updateCalls = [];
  const firestoreSdk = {
    doc(db, colName, docId) {
      return { db, colName, docId };
    },
    async updateDoc(docRef, payload) {
      updateCalls.push({ docRef, payload });
    },
    deleteField() {
      return { __type: 'deleteField' };
    },
    serverTimestamp() {
      return { __type: 'serverTimestamp' };
    },
    Timestamp: {
      fromDate(d) {
        return { __type: 'Timestamp', iso: d.toISOString() };
      }
    }
  };

  const repo = createAdminFirestoreRepository({ db: { name: 'mock-db' }, firestoreSdk });
  const originalDoc = {
    id: 'venue_1',
    source: 'google_places',
    source_id: 'ChIJ_1',
    name: 'Beatty Park',
    description: '',
    address: '220 Vincent St',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'other',
    subcategories: ['other'],
    coordinates: { lat: -31.937, lng: 115.85 },
    geohash: 'qd66h1234',
    source_url: 'https://beattypark.com.au',
    verified: true,
    needs_review: true,
    review_reason: 'crawler_created',
    curated_fields: ['name'],
    created_at: '2026-11-01T00:00:00.000Z'
  };

  const result = await repo.saveListing('venues', 'venue_1', originalDoc, {
    name: 'Beatty Park Leisure Centre',
    description: 'Pool and gym',
    address: '220 Vincent St',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'other',
    subcategories: ['other'],
    lat: -31.938,
    lng: 115.851,
    source_url: null,
    verified: false
  });

  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].docRef, { db: { name: 'mock-db' }, colName: 'venues', docId: 'venue_1' });
  assert.equal(updateCalls[0].payload.needs_review, false);
  assert.equal(updateCalls[0].payload.review_reason, null);
  assert.equal(updateCalls[0].payload.verified, false);
  assert.equal(updateCalls[0].payload.source_url, null);
  assert.equal(Object.hasOwn(updateCalls[0].payload, 'id'), false);
  assert.equal(Object.hasOwn(updateCalls[0].payload, 'created_at'), false);
  assert.deepEqual(result.curatedFields, ['name', 'description', 'coordinates', 'source_url', 'verified']);
});

test('admin-state manages editDrawer lifecycle, markSaving, and applyListingSaved', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  let state = {
    ...createAdminWorkspaceState(),
    reasonFilter: 'unmatched_venue',
    unreviewed: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Yoga', needsReview: true, reviewReason: 'unmatched_venue' }
    ],
    newLast24h: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Yoga', needsReview: true, reviewReason: 'unmatched_venue' }
    ]
  };

  state = openEditDrawer(state, {
    entityType: 'activities',
    docId: 'a1',
    originalDoc: { id: 'a1', title: 'Yoga' },
    draft: { readOnly: { id: 'a1' }, values: { title: 'Yoga' } }
  });
  assert.equal(state.editDrawer.status, 'editing');
  assert.equal(state.editDrawer.docId, 'a1');

  state = setEditDrawerState(state, { status: 'saving' });
  assert.equal(state.editDrawer.status, 'saving');

  state = markSaving(state, 'activities:a1', true);
  assert.equal(state.savingKeys.has('activities:a1'), true);

  const updatedListing = {
    key: 'activities:a1',
    docId: 'a1',
    entityType: 'activities',
    name: 'Sunrise Yoga',
    needsReview: false,
    reviewReason: null,
    duplicateCandidateId: null,
    updatedAtMs: nowMs
  };
  state = applyListingSaved(state, 'activities', 'a1', updatedListing);
  assert.equal(state.editDrawer, null);
  assert.equal(state.savingKeys.has('activities:a1'), false);
  assert.equal(state.unreviewed.length, 0);
  assert.equal(state.reasonFilter, 'all');
  assert.equal(state.newLast24h[0].name, 'Sunrise Yoga');
  assert.equal(state.newLast24h[0].needsReview, false);

  state = openEditDrawer(state, {
    entityType: 'activities',
    docId: 'a1',
    originalDoc: {},
    draft: { readOnly: {}, values: {} }
  });
  state = closeEditDrawer(state);
  assert.equal(state.editDrawer, null);
});

test('renderWorkspaceHtml renders Edit buttons in both Unreviewed and New (Last 24h) views', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  let state = {
    ...createAdminWorkspaceState(),
    unreviewed: [
      { key: 'activities:a1', docId: 'a1', entityType: 'activities', name: 'Social Tennis', reviewReason: 'crawler_created', createdAtMs: nowMs - 1000 }
    ],
    newLast24h: [
      { key: 'venues:v1', docId: 'v1', entityType: 'venues', name: 'Langley Park', needsReview: false, createdAtMs: nowMs - 1000 }
    ]
  };

  const unreviewedHtml = renderWorkspaceHtml(state, nowMs);
  assert.match(unreviewedHtml, /data-action="edit"/);
  assert.match(unreviewedHtml, /data-doc-id="a1"/);

  state = setActiveView(state, VIEWS.NEW_24H);
  const new24hHtml = renderWorkspaceHtml(state, nowMs);
  assert.match(new24hHtml, /data-action="edit"/);
  assert.match(new24hHtml, /data-doc-id="v1"/);
});

test('renderEditDrawerHtml renders read-only metadata, mutable fields, source_url/verified coupling, field errors, and XSS escaping', () => {
  assert.equal(renderEditDrawerHtml(null), '');

  const html = renderEditDrawerHtml({
    status: 'editing',
    entityType: 'activities',
    docId: 'act_1',
    readOnly: {
      id: 'act_1',
      source: 'eventbrite',
      source_id: '100',
      created_at: '2026-11-20T00:00:00.000Z',
      geohash: 'qd66h1234',
      curated_fields: ['description']
    },
    values: {
      title: 'Twilight <script>alert(1)</script> Soccer',
      description: 'Friendly games',
      region_id: 'perth',
      category: 'sports',
      subcategory: 'soccer',
      source_url: '',
      verified: false,
      organizer_id: 'org_1',
      organizer_name: 'Perth FC',
      venue_id: 'venue_1',
      venue_name: 'Langley Park',
      lat: '-31.9598',
      lng: '115.8693',
      recurrence: 'none',
      start_date: '2026-12-01',
      end_date: '2026-12-01',
      start_time: '18:00',
      end_time: '19:30',
      day_of_week: '2',
      is_free: true,
      display_price: 'Free',
      gender: 'all',
      age: 'adults'
    },
    fieldErrors: {
      title: 'Title is required.'
    },
    error: 'Please fix the highlighted fields.'
  });

  assert.match(html, /<h1 id="edit-dialog-title"[^>]*>Edit Activity<\/h1>/);
  assert.match(html, /act_1/);
  assert.match(html, /eventbrite/);
  assert.match(html, /id="admin-edit-form"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /Title is required\./);
  assert.match(html, /name="verified"[^>]*disabled/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('createAdminFirestoreRepository.fetchListingById returns normalized listing when found and null when missing', async () => {
  const docs = {
    'activities:cand_1': {
      exists: () => true,
      id: 'cand_1',
      data: () => ({
        id: 'cand_1',
        title: 'Social Futsal',
        source: 'eventbrite',
        source_url: 'https://eventbrite.com.au/e/123',
        venue: { id: 'v1', name: 'Loftus Recreation Centre' },
        organizer: { id: 'o1', name: 'Perth Futsal' },
        schedule: { recurrence: 'weekly', start_date: '2026-12-01', start_time: '18:30' },
        needs_review: false
      })
    },
    'activities:missing_1': {
      exists: () => false,
      id: 'missing_1',
      data: () => undefined
    }
  };

  const firestoreSdk = {
    doc(db, colName, docId) {
      return { db, colName, docId };
    },
    async getDoc(docRef) {
      return docs[`${docRef.colName}:${docRef.docId}`] || { exists: () => false };
    }
  };

  const repo = createAdminFirestoreRepository({ db: { name: 'mock-db' }, firestoreSdk });

  const found = await repo.fetchListingById('activities', 'cand_1');
  assert.equal(found.id, 'cand_1');
  assert.equal(found.name, 'Social Futsal');
  assert.equal(found.venueName, 'Loftus Recreation Centre');
  assert.equal(found.organizerName, 'Perth Futsal');
  assert.equal(found.source, 'eventbrite');
  assert.equal(found.sourceUrl, 'https://eventbrite.com.au/e/123');

  const missing = await repo.fetchListingById('activities', 'missing_1');
  assert.equal(missing, null);
});

test('admin-state manages duplicateReview lifecycle', () => {
  let state = createAdminWorkspaceState();
  assert.equal(state.duplicateReview, null);

  const flagged = {
    key: 'activities:act_dup',
    docId: 'act_dup',
    id: 'act_dup',
    entityType: 'activities',
    name: 'Twilight Futsal',
    reviewReason: 'possible_duplicate',
    duplicateCandidateId: 'act_orig'
  };

  state = openDuplicateReview(state, flagged);
  assert.equal(state.duplicateReview.status, 'loading');
  assert.equal(state.duplicateReview.flagged.docId, 'act_dup');
  assert.equal(state.duplicateReview.candidateId, 'act_orig');

  state = setDuplicateReviewState(state, {
    status: 'ready',
    candidate: {
      key: 'activities:act_orig',
      docId: 'act_orig',
      id: 'act_orig',
      entityType: 'activities',
      name: 'Twilight Social Futsal'
    }
  });
  assert.equal(state.duplicateReview.status, 'ready');
  assert.equal(state.duplicateReview.candidate.docId, 'act_orig');

  state = closeDuplicateReview(state);
  assert.equal(state.duplicateReview, null);
});

test('renderWorkspaceHtml renders Compare action for possible_duplicate Activities', () => {
  const nowMs = Date.UTC(2026, 10, 27, 12, 0, 0);
  const state = {
    ...createAdminWorkspaceState(),
    unreviewed: [
      {
        key: 'activities:dup_1',
        docId: 'dup_1',
        id: 'dup_1',
        entityType: 'activities',
        name: 'Social Futsal',
        reviewReason: 'possible_duplicate',
        duplicateCandidateId: 'orig_1',
        createdAtMs: nowMs - 1000,
        updatedAtMs: nowMs - 1000
      },
      {
        key: 'activities:other_1',
        docId: 'other_1',
        id: 'other_1',
        entityType: 'activities',
        name: 'Morning Yoga',
        reviewReason: 'unmatched_venue',
        createdAtMs: nowMs - 2000,
        updatedAtMs: nowMs - 2000
      }
    ]
  };

  const html = renderWorkspaceHtml(state, nowMs);
  assert.match(html, /data-action="review-duplicate"/);
  assert.match(html, /data-doc-id="dup_1"/);
  assert.match(html, />Compare</);
});

test('renderDuplicateReviewDialogHtml renders side-by-side cards, missing-candidate fallback, confirm delete, and XSS escaping', () => {
  assert.equal(renderDuplicateReviewDialogHtml(null), '');

  const flagged = {
    key: 'activities:dup_1',
    docId: 'dup_1',
    id: 'dup_1',
    entityType: 'activities',
    name: 'Twilight <script>alert(1)</script> Futsal',
    schedule: { recurrence: 'weekly', day_of_week: 2, start_date: '2026-12-01', start_time: '18:30', end_time: '19:30' },
    venueName: 'Loftus Centre',
    organizerName: 'Perth Futsal Club',
    source: 'facebook',
    sourceUrl: 'https://facebook.com/events/111',
    verified: false,
    needsReview: true,
    reviewReason: 'possible_duplicate',
    duplicateCandidateId: 'orig_1'
  };

  const candidate = {
    key: 'activities:orig_1',
    docId: 'orig_1',
    id: 'orig_1',
    entityType: 'activities',
    name: 'Twilight Social Futsal',
    schedule: { recurrence: 'weekly', day_of_week: 2, start_date: '2026-12-01', start_time: '18:30', end_time: '20:00' },
    venueName: 'Loftus Recreation Centre',
    organizerName: 'Perth Futsal',
    source: 'eventbrite',
    sourceUrl: 'https://eventbrite.com.au/e/222',
    verified: true,
    needsReview: false,
    reviewReason: null
  };

  const readyHtml = renderDuplicateReviewDialogHtml({
    status: 'ready',
    flagged,
    candidateId: 'orig_1',
    candidate,
    confirmDeleteTarget: null,
    error: null
  });

  assert.match(readyHtml, /id="duplicate-dialog-title"/);
  assert.match(readyHtml, /Loftus Centre/);
  assert.match(readyHtml, /Loftus Recreation Centre/);
  assert.match(readyHtml, /Perth Futsal Club/);
  assert.match(readyHtml, /Perth Futsal/);
  assert.match(readyHtml, /facebook/);
  assert.match(readyHtml, /eventbrite/);
  assert.match(readyHtml, /https:\/\/facebook\.com\/events\/111/);
  assert.match(readyHtml, /https:\/\/eventbrite\.com\.au\/e\/222/);
  assert.match(readyHtml, /18:30/);
  assert.match(readyHtml, /data-action="dismiss-duplicate"/);
  assert.match(readyHtml, /Not a duplicate/);
  assert.match(readyHtml, /data-action="prompt-delete-duplicate"[^>]*data-target="flagged"/);
  assert.match(readyHtml, /data-action="prompt-delete-duplicate"[^>]*data-target="candidate"/);
  assert.doesNotMatch(readyHtml, /<script>alert\(1\)<\/script>/);
  assert.match(readyHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const missingHtml = renderDuplicateReviewDialogHtml({
    status: 'missing_candidate',
    flagged,
    candidateId: 'orig_1',
    candidate: null,
    confirmDeleteTarget: null,
    error: null
  });
  assert.match(missingHtml, /orig_1/);
  assert.match(missingHtml, /no longer exists|already deleted|not found/i);
  assert.match(missingHtml, /data-action="dismiss-duplicate"/);
  assert.match(missingHtml, /data-action="prompt-delete-duplicate"[^>]*data-target="flagged"/);
  assert.doesNotMatch(missingHtml, /data-target="candidate"/);

  const confirmHtml = renderDuplicateReviewDialogHtml({
    status: 'confirm_delete',
    flagged,
    candidateId: 'orig_1',
    candidate,
    confirmDeleteTarget: 'candidate',
    error: null
  });
  assert.match(confirmHtml, /Twilight Social Futsal/);
  assert.match(confirmHtml, /data-action="confirm-delete-duplicate"/);
  assert.match(confirmHtml, /data-action="cancel-delete-duplicate"/);
});

test('createAdminFirestoreRepository.fetchCanonicalEntities fetches, normalizes, and sorts venues/organizers and rejects activities', async () => {
  const docsByCollection = {
    venues: [
      { id: 'v_z', data: () => ({ id: 'v_z', name: 'Zebra Park', address: '1 Z St' }) },
      { id: 'v_a', data: () => ({ id: 'v_a', name: 'Alpha Court', address: '2 A St' }) }
    ],
    organizers: [
      { id: 'o_b', data: () => ({ id: 'o_b', name: 'Bayswater FC' }) },
      { id: 'o_a', data: () => ({ id: 'o_a', name: 'Applecross Tennis' }) }
    ]
  };

  const firestoreSdk = {
    collection(db, name) {
      return { db, name };
    },
    async getDocs(colRef) {
      return { docs: docsByCollection[colRef.name] || [] };
    }
  };

  const repo = createAdminFirestoreRepository({ db: { name: 'mock-db' }, firestoreSdk });

  await assert.rejects(() => repo.fetchCanonicalEntities('activities'), /Invalid canonical entityType/);

  const venues = await repo.fetchCanonicalEntities('venues');
  assert.deepEqual(venues.map((v) => v.id), ['v_a', 'v_z']);
  assert.equal(venues[0].entityType, 'venues');

  const organizers = await repo.fetchCanonicalEntities('organizers');
  assert.deepEqual(organizers.map((o) => o.id), ['o_a', 'o_b']);
});

test('createAdminFirestoreRepository.saveListing batch-cascades Venue and Organizer snapshot edits and skips non-snapshot edits', async () => {
  const updateCalls = [];
  const batchCommits = [];
  const queryCalls = [];

  let linkedDocs = [
    { id: 'act_1', data: () => ({ id: 'act_1', title: 'Soccer' }) },
    { id: 'act_2', data: () => ({ id: 'act_2', title: 'Futsal' }) }
  ];

  const firestoreSdk = {
    collection(db, name) {
      return { db, name };
    },
    where(field, op, value) {
      return { field, op, value };
    },
    query(colRef, constraint) {
      return { colRef, constraint };
    },
    async getDocs(q) {
      queryCalls.push(q);
      return { docs: linkedDocs };
    },
    doc(db, colName, docId) {
      return { db, colName, docId };
    },
    async updateDoc(docRef, payload) {
      updateCalls.push({ docRef, payload });
    },
    writeBatch(db) {
      const ops = [];
      return {
        update(docRef, payload) {
          ops.push({ docRef, payload });
        },
        async commit() {
          batchCommits.push({ db, ops });
        }
      };
    },
    serverTimestamp() {
      return { __type: 'serverTimestamp' };
    },
    deleteField() {
      return { __type: 'deleteField' };
    }
  };

  const repo = createAdminFirestoreRepository({ db: { name: 'mock-db' }, firestoreSdk });

  const originalVenue = {
    id: 'venue_1',
    name: 'Beatty Park',
    description: 'Pool',
    address: '220 Vincent St',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'swimming',
    subcategories: ['swimming'],
    coordinates: { lat: -31.937, lng: 115.85 },
    geohash: 'qd66h1234',
    google_place_id: 'ChIJ_beatty',
    source_url: null,
    verified: false
  };

  // 1. Non-snapshot Venue edit (description only) -> no linked activity query or batch
  const nonSnapshotRes = await repo.saveListing('venues', 'venue_1', originalVenue, {
    name: 'Beatty Park',
    description: 'Updated pool description',
    address: '220 Vincent St',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'swimming',
    subcategories: ['swimming'],
    lat: -31.937,
    lng: 115.85,
    source_url: null,
    verified: false
  });
  assert.equal(nonSnapshotRes.cascadedActivityCount, 0);
  assert.equal(queryCalls.length, 0);
  assert.equal(batchCommits.length, 0);

  // 2. Snapshot Venue edit (name + coordinates) -> batch-updates linked Activities
  const venueCascadeRes = await repo.saveListing('venues', 'venue_1', originalVenue, {
    name: 'Beatty Park Leisure Centre',
    description: 'Pool',
    address: '220 Vincent St',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'swimming',
    subcategories: ['swimming'],
    lat: -31.938,
    lng: 115.851,
    source_url: null,
    verified: false
  });
  assert.equal(venueCascadeRes.cascadedActivityCount, 2);
  assert.deepEqual(venueCascadeRes.cascadedActivityIds, ['act_2', 'act_1']);
  assert.equal(queryCalls.length, 1);
  assert.deepEqual(queryCalls[0].constraint, { field: 'venue.id', op: '==', value: 'venue_1' });
  assert.equal(batchCommits.length, 1);
  assert.equal(batchCommits[0].ops.length, 2);
  assert.equal(batchCommits[0].ops[0].payload.venue.name, 'Beatty Park Leisure Centre');
  assert.equal(batchCommits[0].ops[0].payload.venue.google_place_id, 'ChIJ_beatty');
  assert.deepEqual(batchCommits[0].ops[0].payload.updated_at, { __type: 'serverTimestamp' });

  // 3. Snapshot Organizer edit (name) -> batch-updates linked Activities
  const originalOrg = {
    id: 'org_1',
    name: 'Perth FC',
    description: '',
    address: '',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'soccer',
    subcategories: ['soccer'],
    coordinates: { lat: -31.95, lng: 115.86 },
    geohash: 'qd66hr123',
    website: null,
    contact: { email: null, phone: null, facebook: null },
    cost_description: '',
    demographics: { gender: 'all', age: 'all' },
    source_url: null,
    verified: false
  };
  const orgCascadeRes = await repo.saveListing('organizers', 'org_1', originalOrg, {
    name: 'Perth Social FC',
    description: '',
    address: '',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'soccer',
    subcategories: ['soccer'],
    lat: -31.95,
    lng: 115.86,
    website: null,
    contact_email: null,
    contact_phone: null,
    contact_facebook: null,
    cost_description: '',
    gender: 'all',
    age: 'all',
    source_url: null,
    verified: false
  });
  assert.equal(orgCascadeRes.cascadedActivityCount, 2);
  assert.equal(queryCalls[1].constraint.field, 'organizer.id');
  assert.equal(batchCommits.length, 2);
  assert.deepEqual(batchCommits[1].ops[0].payload.organizer, { id: 'org_1', name: 'Perth Social FC' });

  // 4. Chunking over 500 linked Activities (505 -> 2 batches: 500 + 5)
  linkedDocs = Array.from({ length: 505 }, (_, i) => ({
    id: `act_${String(i).padStart(3, '0')}`,
    data: () => ({ id: `act_${String(i).padStart(3, '0')}`, title: `Activity ${i}` })
  }));
  const chunkedRes = await repo.saveListing('organizers', 'org_1', originalOrg, {
    name: 'Perth United FC',
    description: '',
    address: '',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'soccer',
    subcategories: ['soccer'],
    lat: -31.95,
    lng: 115.86,
    website: null,
    contact_email: null,
    contact_phone: null,
    contact_facebook: null,
    cost_description: '',
    gender: 'all',
    age: 'all',
    source_url: null,
    verified: false
  });
  assert.equal(chunkedRes.cascadedActivityCount, 505);
  assert.equal(batchCommits.length, 4);
  assert.equal(batchCommits[2].ops.length, 500);
  assert.equal(batchCommits[3].ops.length, 5);
});

test('admin-state canonical cache initializes, cascades Venue/Organizer edits to linked Activities, and removes deleted entities', () => {
  let state = createAdminWorkspaceState();
  assert.deepEqual(state.canonicalVenues, []);
  assert.deepEqual(state.canonicalOrganizers, []);
  assert.equal(state.canonicalEntitiesLoaded, false);
  assert.equal(state.canonicalEntitiesLoading, false);
  assert.equal(state.canonicalEntitiesError, null);

  state = setCanonicalEntitiesState(state, {
    canonicalVenues: [
      { key: 'venues:v_1', docId: 'v_1', id: 'v_1', entityType: 'venues', name: 'Old Venue' }
    ],
    canonicalOrganizers: [
      { key: 'organizers:o_1', docId: 'o_1', id: 'o_1', entityType: 'organizers', name: 'Old Org' }
    ],
    canonicalEntitiesLoaded: true,
    canonicalEntitiesLoading: false
  });

  state = {
    ...state,
    unreviewed: [
      {
        key: 'activities:act_1',
        docId: 'act_1',
        id: 'act_1',
        entityType: 'activities',
        name: 'Social Soccer',
        venueName: 'Old Venue',
        organizerName: 'Old Org',
        raw: {
          id: 'act_1',
          title: 'Social Soccer',
          venue: { id: 'v_1', name: 'Old Venue', coordinates: { lat: -31.95, lng: 115.86 }, geohash: 'qd66hr000' },
          organizer: { id: 'o_1', name: 'Old Org' }
        }
      }
    ],
    newLast24h: [
      {
        key: 'activities:act_1',
        docId: 'act_1',
        id: 'act_1',
        entityType: 'activities',
        name: 'Social Soccer',
        venueName: 'Old Venue',
        organizerName: 'Old Org',
        raw: {
          id: 'act_1',
          title: 'Social Soccer',
          venue: { id: 'v_1', name: 'Old Venue', coordinates: { lat: -31.95, lng: 115.86 }, geohash: 'qd66hr000' },
          organizer: { id: 'o_1', name: 'Old Org' }
        }
      }
    ]
  };

  // Cascade Venue edit
  state = applyListingSaved(state, 'venues', 'v_1', {
    key: 'venues:v_1',
    docId: 'v_1',
    id: 'v_1',
    entityType: 'venues',
    name: 'New Venue',
    updatedAtMs: 2000,
    raw: {
      id: 'v_1',
      name: 'New Venue',
      coordinates: { lat: -31.96, lng: 115.87 },
      geohash: 'qd66hr999',
      google_place_id: 'ChIJ_new'
    }
  });

  assert.equal(state.unreviewed[0].venueName, 'New Venue');
  assert.equal(state.unreviewed[0].raw.venue.google_place_id, 'ChIJ_new');
  assert.equal(state.newLast24h[0].venueName, 'New Venue');
  assert.equal(state.canonicalVenues[0].name, 'New Venue');

  // Cascade Organizer edit
  state = applyListingSaved(state, 'organizers', 'o_1', {
    key: 'organizers:o_1',
    docId: 'o_1',
    id: 'o_1',
    entityType: 'organizers',
    name: 'New Org',
    updatedAtMs: 3000,
    raw: { id: 'o_1', name: 'New Org' }
  });
  assert.equal(state.unreviewed[0].organizerName, 'New Org');
  assert.equal(state.newLast24h[0].organizerName, 'New Org');
  assert.equal(state.canonicalOrganizers[0].name, 'New Org');

  // Approve retains canonical entity in cache and marks it reviewed
  const afterApprove = applyListingApproved(
    {
      ...state,
      unreviewed: [{ key: 'venues:v_1', docId: 'v_1', id: 'v_1', entityType: 'venues', name: 'New Venue', needsReview: true }],
      canonicalVenues: [{ key: 'venues:v_1', docId: 'v_1', id: 'v_1', entityType: 'venues', name: 'New Venue', needsReview: true }]
    },
    'venues',
    'v_1',
    4000
  );
  assert.equal(afterApprove.canonicalVenues.length, 1);
  assert.equal(afterApprove.canonicalVenues[0].needsReview, false);

  // Delete removes from canonical cache
  state = applyListingDeleted(state, 'venues', 'v_1');
  assert.equal(state.canonicalVenues.length, 0);
  state = applyListingDeleted(state, 'organizers', 'o_1');
  assert.equal(state.canonicalOrganizers.length, 0);
});

test('renderCanonicalPickerResultsHtml and renderEditDrawerHtml render searchable Venue/Organizer pickers with XSS escaping', () => {
  const loadingHtml = renderCanonicalPickerResultsHtml('venue', [], '', '', { loading: true });
  assert.match(loadingHtml, /Loading canonical venues/i);

  const errorHtml = renderCanonicalPickerResultsHtml('organizer', [], '', '', { error: 'Failed to load' });
  assert.match(errorHtml, /Failed to load/);

  const venues = [
    { id: 'v_1', docId: 'v_1', name: 'Beatty <script>alert(1)</script> Park', address: '220 Vincent St', subcategory: 'swimming' },
    { id: 'v_2', docId: 'v_2', name: 'Langley Park', address: 'Riverside Dr', subcategory: 'soccer' }
  ];
  const resultsHtml = renderCanonicalPickerResultsHtml('venue', venues, 'park', 'v_2');
  assert.match(resultsHtml, /data-action="select-canonical-venue"/);
  assert.match(resultsHtml, /data-entity-id="v_2"/);
  assert.match(resultsHtml, /class="picker-option is-selected"/);
  assert.doesNotMatch(resultsHtml, /<script>alert\(1\)<\/script>/);
  assert.match(resultsHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const activityDrawerHtml = renderEditDrawerHtml(
    {
      status: 'editing',
      entityType: 'activities',
      docId: 'act_1',
      readOnly: { id: 'act_1', geohash: 'qd66hr000', curated_fields: [] },
      values: {
        title: 'Soccer',
        description: '',
        region_id: 'perth',
        category: 'sports',
        subcategory: 'soccer',
        source_url: '',
        verified: false,
        organizer_id: 'o_1',
        organizer_name: 'Perth FC',
        venue_id: 'v_2',
        venue_name: 'Langley Park',
        venue_google_place_id: 'ChIJ_langley',
        lat: '-31.9598',
        lng: '115.8693',
        recurrence: 'none',
        start_date: '2026-12-01',
        end_date: '2026-12-01',
        start_time: '18:00',
        end_time: '19:30',
        day_of_week: '2',
        is_free: true,
        display_price: 'Free',
        gender: 'all',
        age: 'adults'
      },
      fieldErrors: {},
      error: null
    },
    {
      canonicalVenues: venues,
      canonicalOrganizers: [{ id: 'o_1', docId: 'o_1', name: 'Perth FC', subcategory: 'soccer' }],
      loading: false,
      error: null
    }
  );
  assert.match(activityDrawerHtml, /data-role="picker-search"[^>]*data-picker-type="venue"/);
  assert.match(activityDrawerHtml, /data-role="picker-results"[^>]*data-picker-type="venue"/);
  assert.match(activityDrawerHtml, /name="venue_google_place_id"[^>]*value="ChIJ_langley"/);
  assert.match(activityDrawerHtml, /data-role="picker-search"[^>]*data-picker-type="organizer"/);
  assert.match(activityDrawerHtml, /data-role="picker-results"[^>]*data-picker-type="organizer"/);

  const venueDrawerHtml = renderEditDrawerHtml({
    status: 'editing',
    entityType: 'venues',
    docId: 'v_2',
    readOnly: { id: 'v_2', geohash: 'qd66hr000', curated_fields: [] },
    values: {
      name: 'Langley Park',
      description: '',
      address: 'Riverside Dr',
      region_id: 'perth',
      category: 'sports',
      subcategory: 'soccer',
      subcategories: 'soccer',
      lat: '-31.9598',
      lng: '115.8693',
      source_url: '',
      verified: false
    },
    fieldErrors: {},
    error: null
  });
  assert.doesNotMatch(venueDrawerHtml, /data-role="picker-search"/);
});
