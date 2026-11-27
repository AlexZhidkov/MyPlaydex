/**
 * Pure State & Filtering Helpers for /admin Curation Workspace.
 * Pure Vanilla JS ES2022 module (zero-build, zero side effects).
 */

import {
  ENTITY_TYPES,
  ENTITY_LABELS,
  formatReviewReason,
  isWithinLast24Hours
} from './admin-data.js';

export const VIEWS = Object.freeze({
  UNREVIEWED: 'unreviewed',
  NEW_24H: 'new_24h'
});

const VALID_ENTITY_FILTERS = new Set(['all', ...ENTITY_TYPES]);

/**
 * Creates the initial workspace state defaulting to Unreviewed Listings.
 *
 * @returns {object}
 */
export function createAdminWorkspaceState() {
  return {
    activeView: VIEWS.UNREVIEWED,
    entityFilter: 'all',
    reasonFilter: 'all',
    unreviewed: [],
    newLast24h: [],
    loading: false,
    error: null,
    actionError: null,
    approvingKeys: new Set(),
    lastLoadedAtMs: null
  };
}

/**
 * Switches between Unreviewed Listings and New (Last 24h) views.
 *
 * @param {object} state
 * @param {'unreviewed' | 'new_24h'} view
 * @returns {object}
 */
export function setActiveView(state, view) {
  const nextView = view === VIEWS.NEW_24H ? VIEWS.NEW_24H : VIEWS.UNREVIEWED;
  return {
    ...state,
    activeView: nextView,
    actionError: null
  };
}

/**
 * Sets the active entity-type filter and resets reasonFilter if the new
 * entity slice has zero matches for the previously selected reason.
 *
 * @param {object} state
 * @param {'all' | 'activities' | 'organizers' | 'venues'} entityFilter
 * @returns {object}
 */
export function setEntityFilter(state, entityFilter) {
  const nextEntity = VALID_ENTITY_FILTERS.has(entityFilter) ? entityFilter : 'all';
  let nextReason = state.reasonFilter;

  if (nextReason !== 'all') {
    const options = getReviewReasonOptions(state.unreviewed, nextEntity);
    const hasMatch = options.some((opt) => opt.value === nextReason);
    if (!hasMatch) {
      nextReason = 'all';
    }
  }

  return {
    ...state,
    entityFilter: nextEntity,
    reasonFilter: nextReason,
    actionError: null
  };
}

/**
 * Sets the active review_reason filter.
 *
 * @param {object} state
 * @param {string} reasonFilter
 * @returns {object}
 */
export function setReasonFilter(state, reasonFilter) {
  return {
    ...state,
    reasonFilter: typeof reasonFilter === 'string' && reasonFilter ? reasonFilter : 'all',
    actionError: null
  };
}

/**
 * Computes live counts across all entity types for a listing array.
 *
 * @param {Array<object>} listings
 * @returns {{ all: number, activities: number, organizers: number, venues: number }}
 */
export function getEntityCounts(listings = []) {
  const counts = {
    all: 0,
    activities: 0,
    organizers: 0,
    venues: 0
  };
  for (const item of listings) {
    if (item && typeof item.entityType === 'string' && item.entityType in counts) {
      counts[item.entityType] += 1;
      counts.all += 1;
    }
  }
  return counts;
}

/**
 * Returns sorted review_reason filter options with counts for the active entity slice.
 *
 * @param {Array<object>} unreviewedListings
 * @param {'all' | 'activities' | 'organizers' | 'venues'} [entityFilter='all']
 * @returns {Array<{ value: string, label: string, count: number }>}
 */
export function getReviewReasonOptions(unreviewedListings = [], entityFilter = 'all') {
  const countsByReason = new Map();

  for (const item of unreviewedListings) {
    if (entityFilter !== 'all' && item.entityType !== entityFilter) continue;
    const key = item.reviewReason || 'unspecified';
    countsByReason.set(key, (countsByReason.get(key) || 0) + 1);
  }

  return [...countsByReason.entries()]
    .map(([value, count]) => ({
      value,
      label: formatReviewReason(value === 'unspecified' ? null : value),
      count
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function compareListingsNewestFirst(a, b, preferUpdated = true) {
  const aTime = preferUpdated ? (a.updatedAtMs ?? a.createdAtMs ?? 0) : (a.createdAtMs ?? 0);
  const bTime = preferUpdated ? (b.updatedAtMs ?? b.createdAtMs ?? 0) : (b.createdAtMs ?? 0);
  if (bTime !== aTime) return bTime - aTime;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

/**
 * Filters and sorts Unreviewed Listings by entityFilter and reasonFilter.
 *
 * @param {object} state
 * @returns {Array<object>}
 */
export function getVisibleUnreviewedListings(state) {
  const { unreviewed = [], entityFilter = 'all', reasonFilter = 'all' } = state;
  return unreviewed
    .filter((item) => {
      if (entityFilter !== 'all' && item.entityType !== entityFilter) return false;
      if (reasonFilter !== 'all') {
        const itemReason = item.reviewReason || 'unspecified';
        if (itemReason !== reasonFilter) return false;
      }
      return true;
    })
    .slice()
    .sort((a, b) => compareListingsNewestFirst(a, b, true));
}

/**
 * Builds the strict 24h view model grouped by Activities, Organizers, and Venues.
 *
 * @param {object} state
 * @param {number} [nowMs=Date.now()]
 * @returns {{ counts: { all: number, activities: number, organizers: number, venues: number }, groups: Array<{ entityType: string, label: string, count: number, items: Array<object> }> }}
 */
export function getNewListingsLast24hViewModel(state, nowMs = Date.now()) {
  const fresh = (state.newLast24h || []).filter((item) =>
    isWithinLast24Hours(item.createdAtMs, nowMs)
  );
  const counts = getEntityCounts(fresh);
  const targetTypes = state.entityFilter !== 'all' ? [state.entityFilter] : ENTITY_TYPES;

  const groups = targetTypes.map((entityType) => {
    const items = fresh
      .filter((item) => item.entityType === entityType)
      .slice()
      .sort((a, b) => compareListingsNewestFirst(a, b, false));
    return {
      entityType,
      label: ENTITY_LABELS[entityType],
      count: items.length,
      items
    };
  });

  return { counts, groups };
}

/**
 * Marks a listing key as currently approving (or clears it).
 *
 * @param {object} state
 * @param {string} key
 * @param {boolean} isApproving
 * @returns {object}
 */
export function markApproving(state, key, isApproving) {
  const nextKeys = new Set(state.approvingKeys);
  if (isApproving) {
    nextKeys.add(key);
  } else {
    nextKeys.delete(key);
  }
  return {
    ...state,
    approvingKeys: nextKeys
  };
}

/**
 * Applies a successful 1-click Approve mutation to local state:
 * removes the row from Unreviewed and marks it reviewed in New (Last 24h).
 *
 * @param {object} state
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {string} docId
 * @param {number} [nowMs=Date.now()]
 * @returns {object}
 */
export function applyListingApproved(state, entityType, docId, nowMs = Date.now()) {
  const key = `${entityType}:${docId}`;
  const nextKeys = new Set(state.approvingKeys);
  nextKeys.delete(key);

  const nextUnreviewed = (state.unreviewed || []).filter((item) => item.key !== key);
  let nextReasonFilter = state.reasonFilter;
  if (nextReasonFilter !== 'all') {
    const remainingOptions = getReviewReasonOptions(nextUnreviewed, state.entityFilter);
    if (!remainingOptions.some((opt) => opt.value === nextReasonFilter)) {
      nextReasonFilter = 'all';
    }
  }

  const nextNewLast24h = (state.newLast24h || []).map((item) => {
    if (item.key !== key) return item;
    return {
      ...item,
      needsReview: false,
      reviewReason: null,
      duplicateCandidateId: null,
      updatedAtMs: nowMs
    };
  });

  return {
    ...state,
    unreviewed: nextUnreviewed,
    newLast24h: nextNewLast24h,
    reasonFilter: nextReasonFilter,
    approvingKeys: nextKeys,
    actionError: null
  };
}
