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
  applyListingApproved
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

import { renderWorkspaceHtml } from '../public/js/admin-ui.js';

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
});
